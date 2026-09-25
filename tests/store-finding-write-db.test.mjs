/**
 * @fileoverview Live-Postgres transaction-abort assertions for
 * docs/plans/runs-findings-write-boundary-hardening.md Phases 7-8 — the class
 * of behaviour a fake client cannot produce (`tests/store-finding-write.test.mjs`
 * proves `applyFindingWrite`'s own contract with a fake client; this proves the
 * REAL Postgres transaction actually aborts and rolls back a sibling statement
 * when it does).
 *
 * Gated on `assertDisposableDbUrl`, never on "is AUDIT_DB_TEST_URL set"
 * (INC-002, docs/security-strategy.md — the 2026-07-14 production wipe).
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

const TEST_URL = process.env.AUDIT_DB_TEST_URL;
const skip = TEST_URL ? false : 'AUDIT_DB_TEST_URL not set (integration block)';

describe('write-boundary transaction abort (DB integration)', { skip }, () => {
  let q, withTx, applyFindingWrite, persistKeptEmbeddings, applyRemediationVerificationResults;
  let repoId, runId;

  before(async () => {
    const { assertDisposableDbUrl, _resetForTest } = await import('../scripts/lib/db/client.mjs');
    assertDisposableDbUrl(TEST_URL, { productionUrl: process.env.AUDIT_DB_URL });
    process.env.AUDIT_DB_URL = TEST_URL;
    _resetForTest?.();
    q = await import('../scripts/lib/db/query.mjs');
    withTx = q.withTx;
    ({ applyFindingWrite } = await import('../scripts/lib/store/finding-write.mjs'));
    ({ persistKeptEmbeddings, applyRemediationVerificationResults } = await import('../scripts/lib/store/runs-findings.mjs'));

    repoId = crypto.randomUUID();
    runId = crypto.randomUUID();
    await q.query(`INSERT INTO audit_repos (id, name) VALUES ($1, $2)`, [repoId, `test-${repoId.slice(0, 8)}`]);
    await q.query(
      `INSERT INTO audit_runs (id, repo_id, plan_file, mode) VALUES ($1, $2, 'docs/plans/test-fixture.md', 'code')`,
      [runId, repoId]);
  });

  after(async () => {
    if (!q) return;
    await q.query('DELETE FROM finding_embeddings WHERE finding_id IN (SELECT id FROM audit_findings WHERE run_id = $1)', [runId]);
    await q.query('DELETE FROM finding_adjudication_events WHERE finding_id IN (SELECT id FROM audit_findings WHERE run_id = $1)', [runId]);
    await q.query('DELETE FROM audit_findings WHERE run_id = $1', [runId]);
    await q.query('DELETE FROM audit_runs WHERE id = $1', [runId]);
    await q.query('DELETE FROM audit_repos WHERE id = $1', [repoId]);
    const { closePool } = await import('../scripts/lib/db/client.mjs');
    await closePool();
  });

  // ── Phase 7: persistKeptEmbeddings' isCallerTx contract ──────────────────

  test('isCallerTx:true — a thrown DB error rolls back a SIBLING statement in the same transaction', async () => {
    const fp = `pke-tx-${crypto.randomUUID().slice(0, 8)}`;
    await assert.rejects(
      withTx(async (client) => {
        // Statement 1: a real, otherwise-valid INSERT that would succeed on its own.
        const ins = await client.query(
          `INSERT INTO audit_findings (run_id, finding_fingerprint, pass_name, severity, category)
           VALUES ($1, $2, 'merged', 'HIGH', 'test') RETURNING id`,
          [runId, fp]
        );
        const findingId = ins.rows[0].id;
        // Statement 2: persistKeptEmbeddings, forced to fail — finding_embeddings.embedding
        // is VECTOR(768); a 3-element vector is a genuine pgvector dimension-mismatch error,
        // not a JS-level throw. isCallerTx:true means this must RETHROW.
        const f = { _hash: fp, detail: 'x' };
        await persistKeptEmbeddings(
          client, [f], new Map([[f, [0.1, 0.2, 0.3]]]), new Map([[fp, findingId]]),
          runId, { provenanceId: 'test-model', dim: 3 }, true
        );
      }),
      /dimensions|expected 768/i
    );
    // The whole transaction — INCLUDING the otherwise-valid statement 1 — must
    // have rolled back. This is the confirmed bug: before this fix, the thrown
    // error was swallowed inside persistKeptEmbeddings even when `exec` was the
    // caller's open transaction client, so the caller's later COMMIT silently
    // degraded to ROLLBACK with no signal — or worse, kept going and committed
    // a batch it believed was complete but wasn't.
    const row = await q.one(`SELECT id FROM audit_findings WHERE run_id = $1 AND finding_fingerprint = $2`, [runId, fp]);
    assert.equal(row, null, 'the sibling INSERT must have rolled back with the failed embedding write');
  });

  test('isCallerTx:false (standalone pool connection) — the same failure is caught and does not abort anything', async () => {
    const fp = `pke-pool-${crypto.randomUUID().slice(0, 8)}`;
    const ins = await q.one(
      `INSERT INTO audit_findings (run_id, finding_fingerprint, pass_name, severity, category)
       VALUES ($1, $2, 'merged', 'HIGH', 'test') RETURNING id`,
      [runId, fp]
    );
    const f = { _hash: fp, detail: 'x' };
    const pool = await (await import('../scripts/lib/db/client.mjs')).getPool();
    const result = await persistKeptEmbeddings(
      pool, [f], new Map([[f, [0.1, 0.2, 0.3]]]), new Map([[fp, ins.id]]),
      runId, { provenanceId: 'test-model', dim: 3 }, false
    );
    assert.equal(result.failed, 1);
    assert.equal(result.persisted, 0);
    // No enclosing transaction, so the sibling row (inserted independently,
    // above, outside any withTx) is completely unaffected.
    const row = await q.one(`SELECT id FROM audit_findings WHERE run_id = $1 AND finding_fingerprint = $2`, [runId, fp]);
    assert.ok(row, 'the independently-committed sibling row must be untouched');
  });

  // ── Phase 8: projectRemediationState's (terminal write + throttle stamp)
  //    transaction grouping — the mechanism the Phase 8 fix depends on ────────

  test('a failure elsewhere in projectRemediationState\'s transaction rolls back the terminal remediation_state write', async () => {
    const fp = `prs-tx-${crypto.randomUUID().slice(0, 8)}`;
    const ins = await q.one(
      `INSERT INTO audit_findings (run_id, finding_fingerprint, pass_name, severity, category, adjudication_outcome)
       VALUES ($1, $2, 'merged', 'HIGH', 'test', 'accepted') RETURNING id`,
      [runId, fp]
    );
    await q.query(
      `INSERT INTO finding_adjudication_events (finding_id, adjudication_outcome, remediation_state, round) VALUES ($1, 'accepted', 'pending', 1)`,
      [ins.id]
    );
    // applyRemediationVerificationResults' 'resolved' path calls
    // projectRemediationState(id, 'verified', {resolvedRound, throttleStamp}) —
    // all three statements (terminal state, adjudication event, throttle stamp)
    // now run inside ONE withTx. `resolvedRound` out of int4 range forces a
    // REAL Postgres error on the second statement — proving that when ANY
    // statement in this group fails, the FIRST (the terminal write) rolls back
    // too, which is exactly the property the Phase 8 fix's third (throttle)
    // statement now also depends on.
    const { withTx: wtx } = q;
    await assert.rejects(
      wtx(async () => {
        await q.many(
          `UPDATE audit_findings SET remediation_state = 'verified' WHERE id = $1 RETURNING id`,
          [ins.id]
        );
        await q.many(
          `UPDATE finding_adjudication_events SET remediation_state = $1, round = $2 WHERE finding_id = $3`,
          ['verified', 99999999999, ins.id]
        );
      }),
      /out of range/i
    );
    const row = await q.one(`SELECT remediation_state FROM audit_findings WHERE id = $1`, [ins.id]);
    assert.equal(row.remediation_state, null, 'the terminal write must have rolled back alongside the later statement\'s failure');
  });

  test('applyRemediationVerificationResults "resolved" — the terminal write AND the throttle stamp land atomically on success', async () => {
    const fp = `arvr-ok-${crypto.randomUUID().slice(0, 8)}`;
    const ins = await q.one(
      `INSERT INTO audit_findings (run_id, finding_fingerprint, pass_name, severity, category, adjudication_outcome)
       VALUES ($1, $2, 'merged', 'HIGH', 'test', 'accepted') RETURNING id`,
      [runId, fp]
    );
    await q.query(
      `INSERT INTO finding_adjudication_events (finding_id, adjudication_outcome, remediation_state, round) VALUES ($1, 'accepted', 'pending', 1)`,
      [ins.id]
    );
    const res = await applyRemediationVerificationResults(repoId, [
      { findingId: ins.id, outcome: 'resolved', checkedAtCommit: 'deadbeef' },
    ]);
    assert.equal(res.updated, 1);
    const row = await q.one(
      `SELECT remediation_state, remediation_last_checked_at, remediation_last_checked_commit FROM audit_findings WHERE id = $1`,
      [ins.id]
    );
    assert.equal(row.remediation_state, 'verified');
    assert.ok(row.remediation_last_checked_at, 'the throttle stamp must have landed in the SAME call');
    assert.equal(row.remediation_last_checked_commit, 'deadbeef');
  });
});
