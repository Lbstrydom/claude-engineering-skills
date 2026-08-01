/**
 * Is the realization guard actually LIVE?
 *
 * The unit tier proves the guard's logic; it cannot prove the guard runs. This plan's own
 * remediation round produced two defects that made it silently inert while every unit test
 * stayed green:
 *
 *   1. `resolveMigrationsDir()`'s default parameter called an undefined `defaultRepoRoot` —
 *      a plain ReferenceError, swallowed by the write path's fail-open, so the guard never
 *      executed at all;
 *   2. it asked the pool for a SECOND connection, deadlocking a `max: 1` pool against the
 *      transaction already holding the only one, and the connect timeout was then caught as
 *      "indeterminate" and the write allowed.
 *
 * Both were invisible to unit tests and to a full multi-pass code audit. The only thing that
 * catches this class is driving the real `_exec` path against a real database — the repo's
 * own pre-ship empirical-verify doctrine, applied to the guard that enforces it.
 *
 * Env-gated on `AUDIT_DB_TEST_URL`, which `assertDisposableDbUrl` proves is disposable
 * before anything here writes. Runs in the DESTRUCTIVE suite tier: it removes a migration
 * ledger row to construct a behind schema, then puts it back.
 *
 * Plan: docs/plans/green-but-unrealized.md (Cluster A, Phase 1).
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';

import { getPool, closePool, _resetForTest, assertDisposableDbUrl } from '../scripts/lib/db/client.mjs';
import { query, withTx } from '../scripts/lib/db/query.mjs';
import {
  ERR_SCHEMA_BEHIND, resolveMigrationsDir, listBundledMigrations, REALIZATION_TTL_MS,
  _resetRealizationCache,
} from '../scripts/lib/db/schema-realization.mjs';

const TEST_URL = process.env.AUDIT_DB_TEST_URL;
const skip = TEST_URL ? false : 'AUDIT_DB_TEST_URL not set';

const TMP_TABLE = 'schema_realization_live_tmp';
let savedUrl, savedPoolMax, evicted;

/** Delete the ledger row for the LAST bundled migration, returning it for restoration. */
async function evictNewestLedgerRow(pool) {
  const bundled = listBundledMigrations(resolveMigrationsDir());
  assert.ok(bundled && bundled.length, 'the source repo must bundle migrations');
  const newest = bundled[bundled.length - 1];
  const { rows } = await pool.query(
    'DELETE FROM public.audit_loop_migrations WHERE filename = $1 RETURNING *', [newest],
  );
  assert.equal(rows.length, 1, `${newest} must be applied in the test database before this runs`);
  return rows[0];
}

describe('schema realization is LIVE on the real write path', { skip }, () => {
  before(async () => {
    savedUrl = process.env.AUDIT_DB_URL;
    assertDisposableDbUrl(TEST_URL, { productionUrl: savedUrl });
    await _resetForTest();
    savedPoolMax = process.env.AUDIT_DB_POOL_MAX;
    process.env.AUDIT_DB_URL = TEST_URL;
    // max=1 reproduces the deadlock shape: a guard that checks out its own connection
    // cannot complete while a transaction holds the only one.
    process.env.AUDIT_DB_POOL_MAX = '1';

    const pool = await getPool();
    assert.ok(pool, 'pool must exist');
    await pool.query(`CREATE TABLE IF NOT EXISTS ${TMP_TABLE} (id SERIAL PRIMARY KEY, label TEXT NOT NULL)`);
  });

  after(async () => {
    try {
      const pool = await getPool();
      if (pool) {
        if (evicted) {
          await pool.query(
            `INSERT INTO public.audit_loop_migrations (filename, sha256, applied_at)
             VALUES ($1, $2, $3) ON CONFLICT (filename) DO NOTHING`,
            [evicted.filename, evicted.sha256, evicted.applied_at],
          );
          evicted = null;
        }
        try { await pool.query(`DROP TABLE IF EXISTS ${TMP_TABLE}`); } catch { /* best-effort */ }
      }
    } finally {
      if (savedUrl === undefined) delete process.env.AUDIT_DB_URL;
      else process.env.AUDIT_DB_URL = savedUrl;
      if (savedPoolMax === undefined) delete process.env.AUDIT_DB_POOL_MAX;
      else process.env.AUDIT_DB_POOL_MAX = savedPoolMax;
      await closePool();
      await _resetForTest();
    }
  });

  it('a write inside a transaction does not deadlock and does not hang', async () => {
    // Defect 2, directly: with max=1 a guard that opens its own connection blocks until the
    // connect timeout. Bounded here so a regression fails in seconds rather than stalling.
    const done = withTx(async () => {
      await query(`INSERT INTO ${TMP_TABLE} (label) VALUES ($1)`, ['inside-tx']);
      return 'ok';
    });
    const verdict = await Promise.race([
      done,
      new Promise((r) => setTimeout(() => r('DEADLOCK'), 8000)),
    ]);
    assert.equal(verdict, 'ok', 'the guard must read through the transaction it is inside');
  });

  it('a genuinely behind schema REFUSES the write — the guard is not merely present', async () => {
    // The assertion the unit tier structurally cannot make. Both defects above left the
    // guard passing every unit test while never refusing anything.
    const pool = await getPool();
    evicted = await evictNewestLedgerRow(pool);
    // The previous test's write cached a VERIFIED result for this pool. Clear it rather than
    // cycling the pool: a cycled pool changes two things at once, and this assertion is about
    // the guard, not about pool lifecycle. (It also exercises the reset seam, which returned
    // `true` while clearing nothing until the consolidated gate caught it.)
    _resetRealizationCache();

    await assert.rejects(
      () => query(`INSERT INTO ${TMP_TABLE} (label) VALUES ($1)`, ['must-not-land']),
      (err) => err.code === ERR_SCHEMA_BEHIND && /--migrate/.test(err.message),
      'a database missing a bundled migration must refuse an application write',
    );

    // And READS keep working — the fail-open read posture is deliberate, not collateral.
    const readBack = await query(`SELECT count(*)::int AS n FROM ${TMP_TABLE}`);
    assert.equal(readBack.rows[0].n, 1, 'only the in-tx row from the previous test');
  });

  it('restoring the ledger row lets writes through again', async () => {
    const pool = await getPool();
    await pool.query(
      `INSERT INTO public.audit_loop_migrations (filename, sha256, applied_at)
       VALUES ($1, $2, $3) ON CONFLICT (filename) DO NOTHING`,
      [evicted.filename, evicted.sha256, evicted.applied_at],
    );
    evicted = null;
    // The refusal above cached nothing (only a VERIFIED result is cached), so the very next
    // write re-checks. If this needed a TTL wait, the guard would be caching its own
    // failures — which would make a fixed database stay blocked for REALIZATION_TTL_MS.
    assert.equal(typeof REALIZATION_TTL_MS, 'number');
    await query(`INSERT INTO ${TMP_TABLE} (label) VALUES ($1)`, ['after-repair']);
    const { rows } = await query(`SELECT count(*)::int AS n FROM ${TMP_TABLE}`);
    assert.equal(rows[0].n, 2);
  });
});
