/**
 * @fileoverview `getFinalReviewStats`'s keyset-paged `pendingQueue` against a
 * REAL Postgres (docs/plans/backlog-tooling-honesty.md §7, audit-plan R1 M2).
 *
 * A fake-store test cannot prove the UNION projection (`f.id AS
 * audit_finding_id`), the fourth bind, or the row-value comparison that makes a
 * cursor page continue exactly where the last one stopped. So this suite seeds
 * both UNION branches — including two rows ONE MICROSECOND apart and a
 * tied-severity pair — and walks the whole queue by cursor, asserting every row
 * is seen exactly once, that a deletion mid-walk (the adjudication that drains
 * this queue) skips nothing, and that `actionablePairs` is identical on every
 * page.
 *
 * Env-gated on `AUDIT_DB_TEST_URL` (disposable DSN; `assertDisposableDbUrl`
 * refuses anything else) and ENROLLED in both `ISOLATED_SUITE_FILES`
 * (scripts/db-test-container.mjs) and `.github/workflows/postgres-parity.yml`
 * — a DB suite no runner names has never run (AGENTS.md §Testing).
 *
 * @module tests/final-review-pending-db
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

const TEST_URL = process.env.AUDIT_DB_TEST_URL;
const skip = TEST_URL ? false : 'AUDIT_DB_TEST_URL not set (integration block)';

describe('getFinalReviewStats — contract (no DB required)', () => {
  it('accepts an `after` cursor option and defaults it to null', async () => {
    const mod = await import('../scripts/lib/store/runs-findings.mjs');
    assert.equal(typeof mod.getFinalReviewStats, 'function');
    const prior = process.env.AUDIT_DB_URL;
    process.env.AUDIT_DB_URL = '';
    try {
      const res = await mod.getFinalReviewStats('nobody/nothing', { queueLimit: 2, after: null });
      assert.equal(res.cloud, false);
      assert.deepEqual(res.pendingQueue, []);
    } finally {
      if (prior === undefined) delete process.env.AUDIT_DB_URL;
      else process.env.AUDIT_DB_URL = prior;
    }
  });
});

describe('getFinalReviewStats — keyset cursor walk (integration)', { skip }, () => {
  let mod, q, repoId, repoName, runA, runB;
  // The seeded population, in the order the queue must return it:
  //   severity_rank DESC, created_at DESC, finding_fingerprint ASC, run_id ASC
  const T0 = '2026-09-13 10:00:00.000000+00';
  const T0_PLUS_1US = '2026-09-13 10:00:00.000001+00';
  const T1 = '2026-09-13 09:00:00.000000+00';

  before(async () => {
    const { assertDisposableDbUrl, _resetForTest } = await import('../scripts/lib/db/client.mjs');
    const savedUrl = process.env.AUDIT_DB_URL;
    assertDisposableDbUrl(TEST_URL, { productionUrl: savedUrl });
    process.env.AUDIT_DB_URL = TEST_URL;
    _resetForTest?.();
    q = await import('../scripts/lib/db/query.mjs');
    mod = await import('../scripts/lib/store/runs-findings.mjs');

    repoId = crypto.randomUUID();
    repoName = `test-pending-${repoId.slice(0, 8)}`;
    // Fresh ids per invocation (audit-code cluster B R1 M9): a fixed id with
    // ON CONFLICT DO NOTHING would silently adopt a pre-existing run of another
    // owner. Sorted so run_id ASC tie-breaking below is deterministic.
    [runA, runB] = [crypto.randomUUID(), crypto.randomUUID()].sort();
    await q.query(`INSERT INTO audit_repos (id, name) VALUES ($1, $2)`, [repoId, repoName]);
    for (const runId of [runA, runB]) {
      await q.query(`INSERT INTO audit_runs (id, repo_id, plan_file, mode) VALUES ($1, $2, 'docs/plans/test-fixture.md', 'code')`, [runId, repoId]);
    }
    const owned = await q.many(`SELECT id FROM audit_runs WHERE repo_id = $1`, [repoId]);
    assert.deepEqual(owned.map((r) => r.id).sort(), [runA, runB], 'the fixture owns exactly its two runs');
    const ins = (runId, fp, severity, createdAt, { bucket = 'shadow-only', remediation = null } = {}) => q.query(
      `INSERT INTO audit_findings (run_id, finding_fingerprint, pass_name, severity, category, bucket, remediation_state, created_at)
       VALUES ($1, $2, 'final-review', $3, 'test', $4, $5, $6::timestamptz)`,
      [runId, fp, severity, bucket, remediation, createdAt]);
    // shadow branch (bucket = 'shadow-only'):
    await ins(runA, 'fp-h1', 'HIGH', T0);              // HIGH, T0
    await ins(runA, 'fp-h2', 'HIGH', T0_PLUS_1US);     // HIGH, T0+1µs  (newer → first)
    await ins(runA, 'fp-tie', 'HIGH', T1);             // HIGH, T1, run A  ┐ same fingerprint, two runs:
    await ins(runB, 'fp-tie', 'HIGH', T1);             // HIGH, T1, run B  ┘ tie broken by run_id ASC
    await ins(runA, 'fp-m1', 'MEDIUM', T0);            // MEDIUM
    // primary label-gap branch (bucket NULL, fixed, unadjudicated):
    await ins(runB, 'fp-p1', 'LOW', T0, { bucket: null, remediation: 'fixed' });
    await ins(runB, 'fp-p2', 'LOW', T1, { bucket: null, remediation: 'verified' });
  });

  after(async () => {
    if (!q) return;
    await q.query('DELETE FROM audit_findings WHERE run_id = ANY($1::uuid[])', [[runA, runB]]);
    await q.query('DELETE FROM audit_runs WHERE id = ANY($1::uuid[])', [[runA, runB]]);
    await q.query('DELETE FROM audit_repos WHERE id = $1', [repoId]);
    const { closePool } = await import('../scripts/lib/db/client.mjs');
    await closePool();
  });

  const key = (r) => `${r.finding_fingerprint}@${r.run_id === runA ? 'a' : 'b'}`;
  const cursorOf = (r) => ({ severityRank: Number(r.severity_rank), createdAt: r.created_at_cursor, fingerprint: r.finding_fingerprint, runId: r.run_id });

  it('both UNION branches project audit_finding_id and created_at_cursor, in the documented total order', async () => {
    const res = await mod.getFinalReviewStats(repoName, { queueLimit: 50 });
    assert.equal(res.ok, true);
    assert.deepEqual(res.pendingQueue.map(key), ['fp-h2@a', 'fp-h1@a', 'fp-tie@a', 'fp-tie@b', 'fp-m1@a', 'fp-p1@b', 'fp-p2@b']);
    for (const r of res.pendingQueue) {
      assert.match(String(r.audit_finding_id), /^[0-9a-f-]{36}$/, 'every row carries the audit_findings.id the grouper keys on');
      assert.equal(typeof r.created_at_cursor, 'string');
    }
    // the microsecond survives the text projection (a JS Date would have lost it)
    assert.match(res.pendingQueue[0].created_at_cursor, /\.000001/);
  });

  it('walking by cursor with queueLimit 2 sees every row exactly once, including the µs-tied and same-fingerprint pairs', async () => {
    const seen = [];
    let after = null;
    for (let page = 0; page < 10; page += 1) {
      const res = await mod.getFinalReviewStats(repoName, { queueLimit: 2, after });
      assert.equal(res.ok, true);
      if (res.pendingQueue.length === 0) break;
      seen.push(...res.pendingQueue.map(key));
      if (res.pendingQueue.length < 2) break;
      after = cursorOf(res.pendingQueue[res.pendingQueue.length - 1]);
    }
    assert.deepEqual(seen, ['fp-h2@a', 'fp-h1@a', 'fp-tie@a', 'fp-tie@b', 'fp-m1@a', 'fp-p1@b', 'fp-p2@b']);
    assert.equal(new Set(seen).size, seen.length, 'no row twice');
  });

  it('actionablePairs is page-independent, and a cursor past the end returns an empty page', async () => {
    const first = await mod.getFinalReviewStats(repoName, { queueLimit: 2 });
    const last = first.pendingQueue[first.pendingQueue.length - 1];
    const next = await mod.getFinalReviewStats(repoName, { queueLimit: 2, after: cursorOf(last) });
    assert.deepEqual(next.actionablePairs, first.actionablePairs);
    const all = await mod.getFinalReviewStats(repoName, { queueLimit: 50 });
    const end = all.pendingQueue[all.pendingQueue.length - 1];
    const beyond = await mod.getFinalReviewStats(repoName, { queueLimit: 2, after: cursorOf(end) });
    assert.deepEqual(beyond.pendingQueue, []);
  });

  it('a row adjudicated (deleted from the queue) mid-walk skips nothing — the defect an offset would have', async () => {
    const p1 = await mod.getFinalReviewStats(repoName, { queueLimit: 2 });
    assert.deepEqual(p1.pendingQueue.map(key), ['fp-h2@a', 'fp-h1@a']);
    // The first two rows leave the queue's population (the shadow branch has no
    // user_action filter — a dismissed shadow row is filtered JS-side — so the
    // store-level departure this test needs is a DELETE). An offset of 2 would
    // now skip fp-tie@a / fp-tie@b.
    await q.query(`DELETE FROM audit_findings WHERE run_id = $1 AND finding_fingerprint IN ('fp-h1', 'fp-h2')`, [runA]);
    try {
      const p2 = await mod.getFinalReviewStats(repoName, { queueLimit: 2, after: cursorOf(p1.pendingQueue[1]) });
      assert.deepEqual(p2.pendingQueue.map(key), ['fp-tie@a', 'fp-tie@b'], 'the cursor continues from where the walk stopped, not from a shifted offset');
    } finally {
      await q.query(`INSERT INTO audit_findings (run_id, finding_fingerprint, pass_name, severity, category, bucket, created_at)
                     VALUES ($1, 'fp-h1', 'final-review', 'HIGH', 'test', 'shadow-only', $2::timestamptz),
                            ($1, 'fp-h2', 'final-review', 'HIGH', 'test', 'shadow-only', $3::timestamptz)`, [runA, T0, T0_PLUS_1US]);
    }
  });
});
