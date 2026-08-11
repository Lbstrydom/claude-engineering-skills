/**
 * @fileoverview DB-integration coverage for the repo-scoping + race-safety
 * fixes in `scripts/lib/store/arch/refresh-runs.mjs`
 * (docs/plans/symbol-index-pipeline-reliability-hardening.md, Cluster A /
 * Theme 1 + 1b95d1e7).
 *
 * `abortRefreshRun`/`getRefreshRun`/`heartbeatRefreshRun` used to scope by
 * `id` alone in a schema that is otherwise multi-repo-capable — a caller
 * with the wrong `repoId` for a real `refreshId` could read or mutate
 * another tenant's run. This suite proves the widened predicates are both
 * cross-repo-safe AND make the abort/publish race safe at the database
 * layer (the actual correctness boundary; the in-process AbortController
 * signal in refresh.mjs is only a cost-saving optimization on top of it).
 *
 * The DB round-trip is the whole point here — a pure unit test would just
 * re-implement the SQL predicate and prove nothing about the real
 * constraint/RPC behavior. Gated on `AUDIT_DB_TEST_URL`.
 */
import { describe, it, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

const TEST_URL = process.env.AUDIT_DB_TEST_URL;
const skip = TEST_URL ? false : 'AUDIT_DB_TEST_URL not set (integration block)';

describe('refresh-runs.mjs — repo-scoping + abort/publish race safety (integration)', { skip }, () => {
  let mod, q, repoIdA, repoIdB;

  before(async () => {
    const { assertDisposableDbUrl, _resetForTest } = await import('../scripts/lib/db/client.mjs');
    const savedUrl = process.env.AUDIT_DB_URL;
    assertDisposableDbUrl(TEST_URL, { productionUrl: savedUrl });
    process.env.AUDIT_DB_URL = TEST_URL;
    _resetForTest?.();
    q = await import('../scripts/lib/db/query.mjs');
    mod = await import('../scripts/lib/store/arch/refresh-runs.mjs');

    repoIdA = crypto.randomUUID();
    repoIdB = crypto.randomUUID();
    await q.query(`INSERT INTO audit_repos (id, name) VALUES ($1, $2), ($3, $4)
                   ON CONFLICT (id) DO NOTHING`,
      [repoIdA, `test-a-${repoIdA.slice(0, 8)}`, repoIdB, `test-b-${repoIdB.slice(0, 8)}`]);
  });

  after(async () => {
    if (!q) return;
    await q.query('DELETE FROM refresh_runs WHERE repo_id = ANY($1)', [[repoIdA, repoIdB]]);
    await q.query('DELETE FROM audit_repos WHERE id = ANY($1)', [[repoIdA, repoIdB]]);
    const { closePool } = await import('../scripts/lib/db/client.mjs');
    await closePool();
  });

  // Unlike its sibling suites, `running` IS the subject here — these cases are
  // about abort/publish races on a live run, so the status cannot be softened.
  // `idx_refresh_runs_repo_running` permits at most ONE running row per repo,
  // and no case terminates the row it inserts, so every case after the first
  // collided on it. Isolation per case is the fix; weakening the index would
  // delete the invariant this suite exists to prove. (Enrolled in no runner
  // until 2026-08-11, so it had never run to discover this.)
  beforeEach(async () => {
    await q.query('DELETE FROM refresh_runs WHERE repo_id = ANY($1)', [[repoIdA, repoIdB]]);
  });

  const insertRunning = async (repoId) => {
    const row = await q.one(
      `INSERT INTO refresh_runs (repo_id, mode) VALUES ($1, 'incremental') RETURNING id`,
      [repoId]
    );
    return row.id;
  };

  it('getRefreshRun returns null for a real refreshId under the WRONG repoId', async () => {
    const refreshId = await insertRunning(repoIdA);
    const wrongRepo = await mod.getRefreshRun(refreshId, { repoId: repoIdB, select: ['id', 'status'] });
    assert.equal(wrongRepo, null, 'a cross-repo read must return null, never leak another tenant\'s row');
    const rightRepo = await mod.getRefreshRun(refreshId, { repoId: repoIdA, select: ['id', 'status'] });
    assert.equal(rightRepo.id, refreshId);
  });

  it('abortRefreshRun is a no-op under the WRONG repoId — the row stays running, and says so via its return value', async () => {
    const refreshId = await insertRunning(repoIdA);
    const result = await mod.abortRefreshRun({ refreshId, repoId: repoIdB, reason: 'cross-tenant attempt' });
    assert.equal(result.aborted, false, 'the caller must be able to tell a no-op happened, not just infer it from silence');
    const row = await q.one('SELECT status FROM refresh_runs WHERE id = $1', [refreshId]);
    assert.equal(row.status, 'running', 'a cross-repo abort must be a silent no-op, never a cross-tenant mutation');
  });

  it('heartbeatRefreshRun returns false under the WRONG repoId (does not falsely report "still running")', async () => {
    const refreshId = await insertRunning(repoIdA);
    const result = await mod.heartbeatRefreshRun({ refreshId, repoId: repoIdB });
    assert.equal(result, false);
  });

  it('abortRefreshRun succeeds, returns aborted:true, and moves the row to a terminal state under the RIGHT repoId', async () => {
    const refreshId = await insertRunning(repoIdA);
    const result = await mod.abortRefreshRun({ refreshId, repoId: repoIdA, reason: 'normal abort' });
    assert.equal(result.aborted, true);
    const row = await q.one('SELECT status, error FROM refresh_runs WHERE id = $1', [refreshId]);
    assert.equal(row.status, 'aborted');
    assert.equal(row.error, 'normal abort');
  });

  it('heartbeatRefreshRun returns true under the RIGHT repoId while running', async () => {
    const refreshId = await insertRunning(repoIdA);
    const result = await mod.heartbeatRefreshRun({ refreshId, repoId: repoIdA });
    assert.equal(result, true);
  });

  it('DETERMINISTIC RACE — publish-then-abort: a stale abort after publish is a no-op (status stays published)', async () => {
    const refreshId = await insertRunning(repoIdA);
    await mod.publishRefreshRun({ repoId: repoIdA, refreshId, activeEmbeddingModel: 'test-model', activeEmbeddingDim: 768 });
    const publishedRow = await q.one('SELECT status FROM refresh_runs WHERE id = $1', [refreshId]);
    assert.equal(publishedRow.status, 'published');

    const result = await mod.abortRefreshRun({ refreshId, repoId: repoIdA, reason: 'stale abort arriving late' });
    assert.equal(result.aborted, false, 'a stale abort on an already-published row must report aborted:false');
    const afterAbortAttempt = await q.one('SELECT status FROM refresh_runs WHERE id = $1', [refreshId]);
    assert.equal(afterAbortAttempt.status, 'published', 'a stale abort must never flip an already-published run back to aborted');
  });

  it('DETERMINISTIC RACE — abort-then-publish: publishRefreshRun rejects a non-running row (the RPC\'s own atomic guard)', async () => {
    const refreshId = await insertRunning(repoIdA);
    await mod.abortRefreshRun({ refreshId, repoId: repoIdA, reason: 'aborted before publish' });
    const abortedRow = await q.one('SELECT status FROM refresh_runs WHERE id = $1', [refreshId]);
    assert.equal(abortedRow.status, 'aborted');

    await assert.rejects(
      () => mod.publishRefreshRun({ repoId: repoIdA, refreshId, activeEmbeddingModel: 'test-model', activeEmbeddingDim: 768 }),
      /publish_refresh_run RPC failed/,
      'publishing an already-aborted run must fail — the RPC\'s own status guard, not application-level logic',
    );
    const finalRow = await q.one('SELECT status FROM refresh_runs WHERE id = $1', [refreshId]);
    assert.equal(finalRow.status, 'aborted', 'a rejected publish attempt must never leave the row in an ambiguous state');
  });

  it('abortRefreshRun is idempotent — aborting an already-aborted row is a harmless no-op reporting aborted:false', async () => {
    const refreshId = await insertRunning(repoIdA);
    const first = await mod.abortRefreshRun({ refreshId, repoId: repoIdA, reason: 'first abort' });
    assert.equal(first.aborted, true);
    // Second call must not throw, must report aborted:false, and must not overwrite the first reason.
    const second = await mod.abortRefreshRun({ refreshId, repoId: repoIdA, reason: 'second abort attempt' });
    assert.equal(second.aborted, false);
    const row = await q.one('SELECT status, error FROM refresh_runs WHERE id = $1', [refreshId]);
    assert.equal(row.status, 'aborted');
    assert.equal(row.error, 'first abort', 'a second abort on an already-terminal row must be a no-op, not silently re-write it');
  });
});
