/**
 * DB-integration test for scripts/lib/store/arch/coverage.mjs — the one leg
 * of the extraction->refresh->store->render lineage that
 * tests/graph-coverage-lineage.test.mjs does not cover (it exercises the
 * render/gate boundary via fixture files, never a real Postgres round-trip).
 *
 * Plan: docs/plans/arch-audit-pipeline-observability-hardening.md item 6.
 *
 * Env-gated: requires AUDIT_DB_TEST_URL (the DISPOSABLE container, never
 * AUDIT_DB_URL). Skips cleanly when absent — mirrors the pattern in
 * tests/symbol-file-imports.test.mjs's DB-gated suite.
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

import { getPool, closePool, _resetForTest, assertDisposableDbUrl } from '../scripts/lib/db/client.mjs';
import { upsertRepoByUuid } from '../scripts/lib/store/repo.mjs';
import { recordGraphCoverage, getGraphCoverage, copyForwardCoverage } from '../scripts/lib/store/arch/coverage.mjs';

const TEST_URL = process.env.AUDIT_DB_TEST_URL;
const dbSkip = TEST_URL ? false : 'AUDIT_DB_TEST_URL not set';

function verifiedCoverageRecord(refreshId) {
  return {
    schemaVersion: 1,
    verdict: { status: 'verified', reason: null },
    measuredAt: new Date().toISOString(),
    refreshId,
    stale: false,
    extraction: {
      outcome: 'ok', eligible: 10, cruised: 10, ratio: 1, elapsedMs: 100,
      edges: { external: 0, selfEdge: 0, escaping: 0, persisted: 5 },
      samples: { uncruised: [] },
    },
    attribution: null,
  };
}

describe('coverage.mjs — recordGraphCoverage/getGraphCoverage/copyForwardCoverage against a real DB', { skip: dbSkip }, () => {
  let savedUrl, repoId, refreshIdA, refreshIdB;
  const REPO_UUID = `test-graph-coverage-${crypto.randomUUID()}`;

  before(async () => {
    savedUrl = process.env.AUDIT_DB_URL;
    assertDisposableDbUrl(TEST_URL, { productionUrl: savedUrl });
    await _resetForTest();
    process.env.AUDIT_DB_URL = TEST_URL;
    if (/@(127\.0\.0\.1|localhost|\[::1\])[:/]/.test(TEST_URL)) {
      process.env.AUDIT_DB_SSL_MODE = 'disable';
    }
    const repo = await upsertRepoByUuid({ repoUuid: REPO_UUID, name: 'graph-coverage-db-test-repo', fingerprint: null });
    repoId = repo.id;
    const pool = await getPool();
    refreshIdA = (await pool.query(
      // Seeded 'published', not 'running': idx_refresh_runs_repo_running is a
      // UNIQUE partial index allowing at most ONE running refresh per repo, so
      // two seeded 'running' rows for one repo collide before any assertion
      // runs. Nothing here reads refresh_runs.status — these rows exist only to
      // satisfy the refresh_id FK — so a terminal status is both collision-free
      // and the more truthful shape (you copy coverage FORWARD from a finished
      // refresh). The suites were enrolled in no runner, so this never surfaced.
      `INSERT INTO refresh_runs (repo_id, mode, status) VALUES ($1, 'full', 'published') RETURNING id`,
      [repoId],
    )).rows[0].id;
    refreshIdB = (await pool.query(
      `INSERT INTO refresh_runs (repo_id, mode, status) VALUES ($1, 'incremental', 'published') RETURNING id`,
      [repoId],
    )).rows[0].id;
  });

  after(async () => {
    const errors = [];
    try {
      const pool = await getPool();
      if (pool) {
        for (const [sql, params] of [
          [`DELETE FROM symbol_refresh_coverage WHERE refresh_id = ANY($1)`, [[refreshIdA, refreshIdB]]],
          [`DELETE FROM refresh_runs WHERE repo_id = $1`, [repoId]],
          [`DELETE FROM audit_repos WHERE id = $1`, [repoId]],
        ]) {
          try { await pool.query(sql, params); } catch (err) { errors.push(new Error(`${sql}: ${err?.message || err}`)); }
        }
      }
    } finally {
      if (savedUrl === undefined) delete process.env.AUDIT_DB_URL;
      else process.env.AUDIT_DB_URL = savedUrl;
      try { await closePool(); } catch { /* env already restored */ }
    }
    if (errors.length > 0) throw new AggregateError(errors, 'teardown failed — disposable DB may have residual rows');
  });

  /**
   * A destination refresh nobody else has written to. Cases that copy coverage
   * FORWARD need one: the shared refreshIdB deliberately carries a fresh
   * measurement by the time they run, and copy-forward is meant to refuse
   * that. Cleaned up with the rest of the repo's rows in `after`.
   */
  const freshRefresh = async () => {
    const pool = await getPool();
    const { rows } = await pool.query(
      `INSERT INTO refresh_runs (repo_id, mode, status) VALUES ($1, 'incremental', 'published') RETURNING id`,
      [repoId],
    );
    return rows[0].id;
  };

  it('recordGraphCoverage writes a row; getGraphCoverage reads the same payload back', async () => {
    const record = verifiedCoverageRecord(refreshIdA);
    const res = await recordGraphCoverage(refreshIdA, record);
    assert.equal(res.recorded, true);

    const read = await getGraphCoverage(refreshIdA);
    assert.ok(read, 'a row was persisted, so a read must find it');
    assert.equal(read.verdict.status, 'verified');
    assert.equal(read.extraction.cruised, 10);
  });

  it('getGraphCoverage returns null for a refresh with no coverage row', async () => {
    const read = await getGraphCoverage(refreshIdB);
    assert.equal(read, null, 'no row yet for refreshIdB — must read null, never a fabricated clean result');
  });

  it('recordGraphCoverage REFUSES to persist a record that violates CoverageSchema (round-2 audit M2/M4 — the write boundary must enforce the schema, not just declare it)', async () => {
    // Uses its OWN fresh refresh_id (round-3 audit M3) — reusing refreshIdA
    // (already holding a VALID row from the earlier "writes a row" test)
    // would make `getGraphCoverage(refreshIdA) === null` pass vacuously
    // whether or not the invalid write actually got rejected, since a prior
    // valid row already occupies that key. This test never ran against a
    // real DB before (AUDIT_DB_TEST_URL unset in the implementing session),
    // so the order-dependency bug wasn't caught until a real audit round
    // against real Postgres semantics flagged it.
    const pool = await getPool();
    const refreshIdInvalid = (await pool.query(
      `INSERT INTO refresh_runs (repo_id, mode, status) VALUES ($1, 'incremental', 'published') RETURNING id`,
      [repoId],
    )).rows[0].id;
    try {
      // A structurally-valid-looking object whose fields CONTRADICT each
      // other per the cross-field precedence check: stale=true paired with
      // verdict.status='verified' can never be true (item 4's superRefine).
      const contradictory = { ...verifiedCoverageRecord(refreshIdInvalid), stale: true };
      const res = await recordGraphCoverage(refreshIdInvalid, contradictory);
      assert.equal(res.recorded, false);
      assert.equal(res.reason, 'schema-invalid');

      const read = await getGraphCoverage(refreshIdInvalid);
      assert.equal(read, null, 'the invalid record must not have reached the table — this key never had a valid write to fall back to');
    } finally {
      await pool.query(`DELETE FROM refresh_runs WHERE id = $1`, [refreshIdInvalid]);
    }
  });

  it('copyForwardCoverage REFUSES to clobber a destination that already holds a FRESH measurement', async () => {
    // The guard is an `ON CONFLICT … WHERE stale IS TRUE` predicate, not a
    // read-then-write check: an earlier version read the destination first, which
    // leaves a window where a concurrent writer lands a real measurement between
    // the read and the upsert. Downgrading genuine evidence to "we don't know" is
    // the overclaim-in-reverse this whole module exists to prevent.
    await recordGraphCoverage(refreshIdA, verifiedCoverageRecord(refreshIdA));
    await recordGraphCoverage(refreshIdB, verifiedCoverageRecord(refreshIdB));

    const refused = await copyForwardCoverage({ fromRefreshId: refreshIdA, toRefreshId: refreshIdB });
    assert.equal(refused.copied, false);
    assert.equal(refused.reason, 'destination-has-fresh-measurement');

    const dest = await getGraphCoverage(refreshIdB);
    assert.notEqual(dest.stale, true, 'the fresh destination measurement must survive');
    assert.equal(dest.refreshId, refreshIdB, 'and must still be its OWN measurement');
  });

  it('copyForwardCoverage copies the prior payload onto a new refresh, forced stale + unknown', async () => {
    // Arrange this test's own prior row rather than depending on execution
    // order (item 6 round-1 audit M15) — refreshIdA is seeded here, not
    // assumed left over from an earlier `it`.
    const record = verifiedCoverageRecord(refreshIdA);
    await recordGraphCoverage(refreshIdA, record);

    // ...and its own DESTINATION, which that earlier fix did not do. The test
    // above deliberately leaves a FRESH measurement on refreshIdB to prove
    // copy-forward refuses to clobber one, so reusing refreshIdB here means
    // this case is refused for that reason and can never pass. Arranging only
    // the source is a one-direction fix; the destination is state too. (Never
    // observed until 2026-08-11 — the suite was enrolled in no runner.)
    const destId = await freshRefresh();

    const copyRes = await copyForwardCoverage({ fromRefreshId: refreshIdA, toRefreshId: destId });
    assert.equal(copyRes.copied, true);

    const copied = await getGraphCoverage(destId);
    assert.ok(copied, 'copy-forward must persist a row for the destination refresh');
    assert.equal(copied.stale, true, 'a copied-forward record is always marked stale');
    assert.equal(copied.verdict.status, 'unknown', 'a SUCCESSFUL prior measurement going stale forces unknown, never the copied-from verdict');
    assert.equal(copied.verdict.reason, 'stale_measurement');
    // Numbers are preserved from the original measurement (display value),
    // even though the verdict itself is forced to unknown.
    assert.equal(copied.extraction.cruised, 10);
  });

  it('copyForwardCoverage preserves an UNVERIFIED verdict from a prior extraction that never succeeded, rather than laundering it into unknown/stale_measurement (item 6 round-1 audit H2)', async () => {
    const failedRecord = {
      ...verifiedCoverageRecord(refreshIdA),
      verdict: { status: 'unverified', reason: 'extraction_failed' },
      extraction: { outcome: 'failed', eligible: null, cruised: null, ratio: null, elapsedMs: null, edges: null, samples: { uncruised: [] } },
    };
    await recordGraphCoverage(refreshIdA, failedRecord);

    // Its own destination, for the same reason as the case above.
    const destId = await freshRefresh();
    const copyRes = await copyForwardCoverage({ fromRefreshId: refreshIdA, toRefreshId: destId });
    assert.equal(copyRes.copied, true);

    const copied = await getGraphCoverage(destId);
    assert.equal(copied.stale, true, 'still marked stale — it IS from an earlier run');
    assert.equal(copied.verdict.status, 'unverified', 'a measurement that never succeeded stays unverified, not unknown');
    assert.equal(copied.verdict.reason, 'extraction_failed');
  });

  it('copyForwardCoverage reports failure when there is no prior coverage to copy', async () => {
    const pool = await getPool();
    // Two DISTINCT fresh ids — neither has a coverage row. (Previously this
    // test reused one id for both from/to, which after round-4's same-id
    // guard would short-circuit to invalid-input before ever reaching the
    // no-prior-coverage path this test exists to cover.)
    const refreshIdC = (await pool.query(
      `INSERT INTO refresh_runs (repo_id, mode, status) VALUES ($1, 'incremental', 'published') RETURNING id`,
      [repoId],
    )).rows[0].id;
    const refreshIdD = (await pool.query(
      `INSERT INTO refresh_runs (repo_id, mode, status) VALUES ($1, 'incremental', 'published') RETURNING id`,
      [repoId],
    )).rows[0].id;
    try {
      const res = await copyForwardCoverage({ fromRefreshId: refreshIdC, toRefreshId: refreshIdD });
      assert.equal(res.copied, false);
      assert.equal(res.reason, 'no-prior-coverage');
    } finally {
      await pool.query(`DELETE FROM refresh_runs WHERE id = ANY($1)`, [[refreshIdC, refreshIdD]]);
    }
  });

  it('copyForwardCoverage refuses to copy a refresh onto itself (round-4 audit H2/M3)', async () => {
    const record = verifiedCoverageRecord(refreshIdA);
    await recordGraphCoverage(refreshIdA, record);

    const res = await copyForwardCoverage({ fromRefreshId: refreshIdA, toRefreshId: refreshIdA });
    assert.equal(res.copied, false);
    assert.equal(res.reason, 'invalid-input');

    // The original row must survive completely unchanged — never marked
    // stale, never overwritten by the rejected self-copy attempt.
    const stillThere = await getGraphCoverage(refreshIdA);
    assert.equal(stillThere.stale, false);
    assert.equal(stillThere.verdict.status, 'verified');
  });
});

// Pure argument-validation behavior — no DB needed, never gated (round-1
// audit L2): copyForwardCoverage destructured its parameter in the function
// signature, so calling it with no argument threw a raw destructuring
// TypeError before the documented `invalid-input` guard could ever run.
describe('copyForwardCoverage — invalid-input guard runs before any destructuring throw', () => {
  it('returns the documented invalid-input result for a missing argument, not a raw TypeError', async () => {
    const res = await copyForwardCoverage();
    assert.deepEqual(res, { copied: false, reason: 'invalid-input' });
  });

  it('returns invalid-input for a partial argument (only one id present)', async () => {
    const res = await copyForwardCoverage({ fromRefreshId: 'r1' });
    assert.deepEqual(res, { copied: false, reason: 'invalid-input' });
  });
});
