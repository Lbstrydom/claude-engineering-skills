/**
 * @fileoverview Harness retro store against a real Postgres
 * (docs/plans/harness-retro.md §2 c14; migration 20261116120000_harness_retro.sql).
 *
 * Enrolled in scripts/db-test-container.mjs ISOLATED_SUITE_FILES AND
 * .github/workflows/postgres-parity.yml — two edits, always.
 * INC-002: gated on `assertDisposableDbUrl`, never on "is the URL set".
 *
 * What only a real database can show: the freshness-guarded upsert really
 * refuses an older snapshot, the replace really removes a vanished occurrence,
 * a failing insert really rolls the session row back, and an unmigrated table
 * really surfaces as an error (not a decline).
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

const TEST_URL = process.env.AUDIT_DB_TEST_URL;
const skip = TEST_URL ? false : 'AUDIT_DB_TEST_URL not set (integration block)';

describe('harness_retro store (DB integration)', { skip }, () => {
  let q; let store;
  const repo = crypto.randomUUID();
  const key = () => crypto.randomBytes(16).toString('hex');
  const ACCT = 'ab'.repeat(8);
  const FP1 = '1'.repeat(16); const FP2 = '2'.repeat(16);
  const snap = (sessionKey, observedUntil, occ) => ({
    session_key: sessionKey, repo_uuid: repo, account_key: ACCT, origin: 'interactive',
    started_at: '2026-11-10T10:00:00.000Z', fingerprint_version: 1, signal_count: occ.length,
    last_scan_id: `scan-${observedUntil}`, observed_until: observedUntil,
    occurrences: occ.map(([fingerprint, n]) => ({ fingerprint, kind: 'tool_error', tool: 'Bash', occurrences: n, first_at: null, last_at: null })),
  });
  const occRows = (k) => q.many('SELECT fingerprint, occurrences FROM harness_retro_occurrences WHERE session_key = $1 ORDER BY fingerprint', [k]);

  before(async () => {
    const { assertDisposableDbUrl, _resetForTest } = await import('../scripts/lib/db/client.mjs');
    assertDisposableDbUrl(TEST_URL, { productionUrl: process.env.AUDIT_DB_URL });
    process.env.AUDIT_DB_URL = TEST_URL;
    _resetForTest?.();
    q = await import('../scripts/lib/db/query.mjs');
    store = await import('../scripts/lib/store/harness-retro.mjs');
  });

  after(async () => {
    if (!q) return;
    await q.query('DELETE FROM harness_retro_sessions WHERE repo_uuid = $1', [repo]);
    await q.query('DELETE FROM harness_retro_scans WHERE repo_uuid = $1', [repo]);
    const { closePool } = await import('../scripts/lib/db/client.mjs');
    await closePool();
  });

  it('a rescan REPLACES the occurrence set (a vanished fingerprint is removed)', async () => {
    const k = key();
    assert.equal((await store.writeSessionSnapshot(snap(k, '2026-11-11T00:00:00.000Z', [[FP1, 2], [FP2, 1]]))).applied, true);
    const r = await store.writeSessionSnapshot(snap(k, '2026-11-12T00:00:00.000Z', [[FP1, 3]]));
    assert.deepEqual(r, { applied: true, rows: 2 });
    assert.deepEqual(await occRows(k), [{ fingerprint: FP1, occurrences: 3 }]);
  });

  it('a delayed OLDER snapshot is superseded and changes nothing', async () => {
    const k = key();
    await store.writeSessionSnapshot(snap(k, '2026-11-12T00:00:00.000Z', [[FP1, 3]]));
    const r = await store.writeSessionSnapshot(snap(k, '2026-11-11T00:00:00.000Z', [[FP1, 2], [FP2, 1]]));
    assert.deepEqual(r, { applied: true, rows: 0, reason: 'superseded' });
    assert.deepEqual(await occRows(k), [{ fingerprint: FP1, occurrences: 3 }]);
  });

  it('an EQUAL cutoff is a replay: superseded, never a replacement', async () => {
    const k = key();
    await store.writeSessionSnapshot(snap(k, '2026-11-12T00:00:00.000Z', [[FP1, 3]]));
    const r = await store.writeSessionSnapshot(snap(k, '2026-11-12T00:00:00.000Z', [[FP2, 9]]));
    assert.deepEqual(r, { applied: true, rows: 0, reason: 'superseded' });
    assert.deepEqual(await occRows(k), [{ fingerprint: FP1, occurrences: 3 }]);
  });

  it('two concurrent snapshots end with the newer one', async () => {
    const k = key();
    await Promise.all([
      store.writeSessionSnapshot(snap(k, '2026-11-13T00:00:00.000Z', [[FP2, 5]])),
      store.writeSessionSnapshot(snap(k, '2026-11-11T00:00:00.000Z', [[FP1, 1]])),
    ]);
    const row = await q.one('SELECT observed_until FROM harness_retro_sessions WHERE session_key = $1', [k]);
    assert.equal(new Date(row.observed_until).toISOString(), '2026-11-13T00:00:00.000Z');
    assert.deepEqual(await occRows(k), [{ fingerprint: FP2, occurrences: 5 }]);
  });

  it('a failing occurrence insert rolls the session row back (no denominator without numerator)', async () => {
    const k = key();
    const bad = snap(k, '2026-11-11T00:00:00.000Z', [[FP1, 1], [FP1, 1]]);   // duplicate PK inside one snapshot
    const r = await store.writeSessionSnapshot(bad);
    assert.equal(r.applied, false);
    assert.ok(r.error);
    assert.equal(await q.one('SELECT count(*)::int AS n FROM harness_retro_sessions WHERE session_key = $1', [k]).then((x) => x.n), 0);
  });

  it('scan rows round-trip through the window readers', async () => {
    await store.writeScanRow({
      scan_id: `t-${key()}`, account_key: ACCT, repo_uuid: repo, fingerprint_version: 1,
      requested_since: '2026-11-01T00:00:00.000Z', requested_until: '2026-11-20T00:00:00.000Z',
      files_listed: 3, files_read: 3, read_errors: 0, completed: true,
    });
    const scans = await store.readRetroScans({ repoUuid: repo });
    assert.equal(scans.length, 1); assert.equal(scans[0].completed, true);
    const sessions = await store.readRetroWindow({ repoUuid: repo, fromTs: '2026-11-01T00:00:00Z', toTs: '2026-11-30T00:00:00Z' });
    assert.ok(sessions.length >= 3);
    assert.ok(sessions.every((s) => s.accountKey === ACCT));
  });

  it('an unmigrated store is an ERROR, never a decline', async () => {
    await q.withTx(async (client) => {
      await client.query('SAVEPOINT pre');
      await client.query('ALTER TABLE harness_retro_occurrences RENAME TO harness_retro_occurrences_hidden');
      // the writer joins this transaction (withTx is re-entrant), so the rename is visible to it
      const r = await store.writeSessionSnapshot(snap(key(), '2026-11-11T00:00:00.000Z', [[FP1, 1]]));
      assert.equal(r.applied, false);
      assert.equal(r.error?.code, '42P01');
      assert.notEqual(r.reason, 'cloud-off');
      await client.query('ROLLBACK TO SAVEPOINT pre');
    });
  });
});
