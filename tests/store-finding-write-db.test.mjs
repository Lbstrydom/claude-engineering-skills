/**
 * @fileoverview Live-Postgres assertions for
 * docs/plans/runs-findings-write-boundary-hardening.md — transaction-abort
 * behaviour for Phase 8 and savepoint-isolation behaviour for Phase 7 (the
 * class a fake client cannot produce; `tests/store-finding-write.test.mjs`
 * proves `applyFindingWrite`'s own contract with a fake client, this proves
 * the REAL Postgres transaction actually rolls back a sibling statement when
 * `applyFindingWrite` itself throws under `isCallerTx:true` (Phase 8), and
 * that `persistKeptEmbeddings`' own SAVEPOINT nesting isolates an optional
 * embedding failure from a sibling statement rather than poisoning it
 * (round-5 audit M1) — plus round-1 audit regressions for `recordFindings`'
 * validate-then-dedup ordering (H5) and severity-domain guard (H18).
 *
 * Gated on `assertDisposableDbUrl`, never on "is AUDIT_DB_TEST_URL set"
 * (INC-002, docs/security-strategy.md — the 2026-07-14 production wipe).
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { findingKeyString } from '../scripts/lib/store/finding-identity.mjs';

const TEST_URL = process.env.AUDIT_DB_TEST_URL;
const skip = TEST_URL ? false : 'AUDIT_DB_TEST_URL not set (integration block)';

describe('write-boundary transaction abort (DB integration)', { skip }, () => {
  let q, withTx, applyFindingWrite, persistKeptEmbeddings, applyRemediationVerificationResults, recordFindings, markFindingsRemediation, updateRunMeta;
  let repoId, runId, otherRepoId;

  before(async () => {
    const { assertDisposableDbUrl, _resetForTest } = await import('../scripts/lib/db/client.mjs');
    assertDisposableDbUrl(TEST_URL, { productionUrl: process.env.AUDIT_DB_URL });
    process.env.AUDIT_DB_URL = TEST_URL;
    _resetForTest?.();
    q = await import('../scripts/lib/db/query.mjs');
    withTx = q.withTx;
    ({ applyFindingWrite } = await import('../scripts/lib/store/finding-write.mjs'));
    ({ persistKeptEmbeddings, applyRemediationVerificationResults, recordFindings, markFindingsRemediation, updateRunMeta } = await import('../scripts/lib/store/runs-findings.mjs'));

    repoId = crypto.randomUUID();
    runId = crypto.randomUUID();
    otherRepoId = crypto.randomUUID();
    await q.query(`INSERT INTO audit_repos (id, name) VALUES ($1, $2), ($3, $4)`,
      [repoId, `test-${repoId.slice(0, 8)}`, otherRepoId, `test-other-${otherRepoId.slice(0, 8)}`]);
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
    await q.query('DELETE FROM audit_repos WHERE id = ANY($1)', [[repoId, otherRepoId]]);
    const { closePool } = await import('../scripts/lib/db/client.mjs');
    await closePool();
  });

  // ── Phase 7: persistKeptEmbeddings' isCallerTx contract ──────────────────

  test('isCallerTx:true — a thrown DB error is isolated via SAVEPOINT and does NOT roll back a sibling statement (round-5 audit M1)', async () => {
    const fp = `pke-tx-${crypto.randomUUID().slice(0, 8)}`;
    let embedResult;
    await withTx(async (client) => {
      // Statement 1: a real, otherwise-valid INSERT that would succeed on its own.
      const ins = await client.query(
        `INSERT INTO audit_findings (run_id, finding_fingerprint, pass_name, severity, category)
         VALUES ($1, $2, 'merged', 'HIGH', 'test') RETURNING id`,
        [runId, fp]
      );
      const findingId = ins.rows[0].id;
      // Statement 2: persistKeptEmbeddings, forced to fail — finding_embeddings.embedding
      // is VECTOR(768); a 3-element vector is a genuine pgvector dimension-mismatch error,
      // not a JS-level throw.
      const f = { _hash: fp, detail: 'x' };
      embedResult = await persistKeptEmbeddings(
        client, [f], new Map([[f, [0.1, 0.2, 0.3]]]), new Map([[findingKeyString({ fingerprint: fp }), findingId]]),
        runId, { provenanceId: 'test-model', dim: 3 }, true
      );
    });
    // round-5 audit M1: embeddings are explicitly BEST-EFFORT — a genuine write
    // failure must cost ONLY the embedding, isolated via a nested SAVEPOINT
    // (persistKeptEmbeddings wraps its own write in withTx, which auto-detects
    // the active transaction and nests rather than propagating), never the
    // primary finding already inserted earlier in the SAME transaction. This
    // replaces the Phase-7-era contract (rethrow → poison the whole tx): that
    // fix correctly stopped the error being SILENT, but over-corrected into
    // letting an optional index write discard real primary findings — the
    // exact "one bad field costs the whole batch" failure this file's other
    // guards all exist to prevent, just one level removed. Loud reporting
    // (result.failed, the stderr log) is preserved either way.
    assert.deepEqual(embedResult, { persisted: 0, failed: 1 });
    const row = await q.one(`SELECT id FROM audit_findings WHERE run_id = $1 AND finding_fingerprint = $2`, [runId, fp]);
    assert.ok(row, 'the sibling INSERT must survive — the embedding failure is isolated via savepoint, not the outer transaction');
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
      pool, [f], new Map([[f, [0.1, 0.2, 0.3]]]), new Map([[findingKeyString({ fingerprint: fp }), ins.id]]),
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

  test('a failure elsewhere in projectRemediationState\'s transaction rolls back the terminal remediation_state write (via the real markFindingsRemediation — round-1 audit M4)', async () => {
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
    // Through the REAL public entry point, not hand-rolled SQL (round-1 audit
    // M4 — the original version of this test reenacted the UPDATE statements
    // instead of exercising production code). markFindingsRemediation resolves
    // the row by (repoId, fingerprint) — the seeded audit_runs row for `runId`
    // belongs to `repoId` — then calls projectRemediationState(id, 'verified',
    // {resolvedRound}), whose two statements (terminal state, adjudication
    // event) run inside ONE withTx. An out-of-int4-range resolvedRound forces
    // a REAL Postgres error on the SECOND statement — proving the FIRST (the
    // terminal write) rolls back too, the exact grouping property Phase 8's
    // throttle-stamp addition (a third statement in that same group, exercised
    // by the "lands atomically on success" test above) depends on.
    // markFindingsRemediation is fail-open per row (never throws to its
    // caller), so the proof is in its return value and the DB state, not a
    // rejection.
    const res = await markFindingsRemediation(repoId, [
      { findingFingerprint: fp, state: 'verified', resolvedRound: 99999999999 },
    ]);
    assert.equal(res.updated, 0, 'the per-row failure must not be counted as updated');
    assert.equal(res.attempted, 1);
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

  // ── round-1 audit regressions: recordFindings' validate-then-dedup order ──

  test('H5: an invalid FIRST entry sharing a key with a later VALID entry does not suppress the valid one', async () => {
    const hash = `h5-${crypto.randomUUID().slice(0, 8)}`;
    const findings = [
      // Invalid: no severity — must be dropped, and must NOT claim the dedup
      // slot ahead of the valid entry below sharing the same (fingerprint,
      // bucket) key (both use the same explicit _hash and _bucket).
      { _hash: hash, _bucket: null, category: 'test', section: 'x', detail: 'invalid — no severity' },
      { _hash: hash, _bucket: null, severity: 'HIGH', category: 'test', section: 'x', detail: 'valid' },
    ];
    const res = await recordFindings(runId, findings, 'merged', 1);
    assert.equal(res.rows, 1, 'exactly the valid entry must persist');
    assert.equal(res.droppedCount, 1, 'exactly the invalid entry must be dropped');
    const row = await q.one(
      `SELECT severity FROM audit_findings WHERE run_id = $1 AND finding_fingerprint = $2`,
      [runId, hash]
    );
    assert.ok(row, 'the valid entry must actually be queryable — not silently lost alongside the invalid one');
    assert.equal(row.severity, 'HIGH');
  });

  test('H18: an out-of-domain severity is dropped, not persisted or sent to the CHECK constraint', async () => {
    const hash = `h18-${crypto.randomUUID().slice(0, 8)}`;
    const res = await recordFindings(
      runId,
      [{ _hash: hash, severity: 'CRITICAL', category: 'test', section: 'x', detail: 'out-of-domain severity' }],
      'merged', 1
    );
    assert.equal(res.rows, 0, 'a truthy but out-of-domain severity must be dropped, same as a falsy one');
    assert.equal(res.droppedCount, 1);
    const row = await q.one(
      `SELECT id FROM audit_findings WHERE run_id = $1 AND finding_fingerprint = $2`,
      [runId, hash]
    );
    assert.equal(row, null, 'no row — the CHECK constraint was never even reached');
  });

  // ── round-3 audit regressions ─────────────────────────────────────────────

  test('H1: an out-of-domain bucket is DROPPED, not silently coerced to null (which is itself a real, different identity)', async () => {
    const hash = `r3h1-${crypto.randomUUID().slice(0, 8)}`;
    const res = await recordFindings(
      runId,
      [{ _hash: hash, _bucket: 'not-a-real-bucket', severity: 'HIGH', category: 'test', section: 'x', detail: 'bad bucket' }],
      'final-review', 0
    );
    assert.equal(res.rows, 0, 'an out-of-domain bucket must be dropped, same treatment as an out-of-domain severity');
    assert.equal(res.droppedCount, 1);
    const row = await q.one(
      `SELECT id FROM audit_findings WHERE run_id = $1 AND finding_fingerprint = $2`,
      [runId, hash]
    );
    assert.equal(row, null, 'no row — must NOT have been silently written with bucket coerced to null');
  });

  test('H1 (positive control): a VALID bucket persists normally, and a null bucket is still accepted (not flagged as invalid)', async () => {
    const hashValid = `r3h1-valid-${crypto.randomUUID().slice(0, 8)}`;
    const hashNull = `r3h1-null-${crypto.randomUUID().slice(0, 8)}`;
    const res = await recordFindings(
      runId,
      [
        { _hash: hashValid, _bucket: 'primary-only', severity: 'HIGH', category: 'test', section: 'x', detail: 'valid bucket' },
        { _hash: hashNull, _bucket: null, severity: 'HIGH', category: 'test', section: 'x', detail: 'null bucket' },
      ],
      'final-review', 0
    );
    assert.equal(res.rows, 2);
    assert.equal(res.droppedCount, 0);
    const rows = await q.many(
      `SELECT finding_fingerprint, bucket FROM audit_findings WHERE run_id = $1 AND finding_fingerprint = ANY($2) ORDER BY finding_fingerprint`,
      [runId, [hashValid, hashNull]]
    );
    assert.equal(rows.find((r) => r.finding_fingerprint === hashValid).bucket, 'primary-only');
    assert.equal(rows.find((r) => r.finding_fingerprint === hashNull).bucket, null);
  });

  test('H1 (mixed batch): a bucket-invalid entry does not suppress a valid entry sharing its (post-coercion) identity slot', async () => {
    // Before this fix, an invalid bucket coerced to null — colliding with a
    // genuinely null-bucket finding sharing the same fingerprint. Prove the
    // invalid one is dropped and the real null-bucket one survives untouched.
    const hash = `r3h1-mixed-${crypto.randomUUID().slice(0, 8)}`;
    const res = await recordFindings(
      runId,
      [
        { _hash: hash, _bucket: 'garbage', severity: 'HIGH', category: 'test', section: 'x', detail: 'invalid — would collide if coerced' },
        { _hash: hash, _bucket: null, severity: 'MEDIUM', category: 'test', section: 'x', detail: 'the real null-bucket finding' },
      ],
      'final-review', 0
    );
    assert.equal(res.rows, 1, 'exactly the valid (null-bucket) entry must persist');
    assert.equal(res.droppedCount, 1, 'exactly the bucket-invalid entry must be dropped');
    const row = await q.one(
      `SELECT severity, bucket FROM audit_findings WHERE run_id = $1 AND finding_fingerprint = $2`,
      [runId, hash]
    );
    assert.ok(row, 'the valid null-bucket entry must be queryable');
    assert.equal(row.severity, 'MEDIUM', 'must be the REAL null-bucket finding, not a coerced-then-collided one');
    assert.equal(row.bucket, null);
  });

  // ── round-2 audit regressions ─────────────────────────────────────────────

  test('H1: updateRunMeta reports {ok:false} for a runId that matches no row, instead of {ok:true} on a query that simply threw nothing', async () => {
    const res = await updateRunMeta(crypto.randomUUID(), { geminiVerdict: 'APPROVE' });
    assert.deepEqual(res, { ok: false }, 'a 0-row UPDATE must not read as success just because nothing threw');
  });

  test('H2/H3: markFindingsRemediation\'s row-id path rejects an id owned by a DIFFERENT repo (write-predicate ownership, not a prior SELECT)', async () => {
    const fp = `h2-cross-repo-${crypto.randomUUID().slice(0, 8)}`;
    const otherRunId = crypto.randomUUID();
    await q.query(
      `INSERT INTO audit_runs (id, repo_id, plan_file, mode) VALUES ($1, $2, 'docs/plans/test-fixture.md', 'code')`,
      [otherRunId, otherRepoId]);
    const ins = await q.one(
      `INSERT INTO audit_findings (run_id, finding_fingerprint, pass_name, severity, category)
       VALUES ($1, $2, 'merged', 'HIGH', 'test') RETURNING id`,
      [otherRunId, fp]
    );
    // Addressed by id, but under `repoId` — the finding actually belongs to `otherRepoId`.
    const res = await markFindingsRemediation(repoId, [
      { id: ins.id, findingFingerprint: fp, state: 'fixed' },
    ]);
    assert.equal(res.updated, 0, 'a cross-repo id must not be updated, even though the id itself is real');
    const row = await q.one(`SELECT remediation_state FROM audit_findings WHERE id = $1`, [ins.id]);
    assert.equal(row.remediation_state, null, 'the cross-repo row must be untouched');
    await q.query('DELETE FROM audit_findings WHERE run_id = $1', [otherRunId]);
    await q.query('DELETE FROM audit_runs WHERE id = $1', [otherRunId]);
  });

  test('H3: markFindingsRemediation\'s row-id path rejects an id whose ACTUAL fingerprint does not match the supplied one, even though the id is owned by the right repo', async () => {
    const realFp = `h3-real-${crypto.randomUUID().slice(0, 8)}`;
    const wrongFp = `h3-wrong-${crypto.randomUUID().slice(0, 8)}`;
    const ins = await q.one(
      `INSERT INTO audit_findings (run_id, finding_fingerprint, pass_name, severity, category)
       VALUES ($1, $2, 'merged', 'HIGH', 'test') RETURNING id`,
      [runId, realFp]
    );
    // Same repo, real id — but the caller's fingerprint doesn't match the row's.
    const res = await markFindingsRemediation(repoId, [
      { id: ins.id, findingFingerprint: wrongFp, state: 'fixed' },
    ]);
    assert.equal(res.updated, 0, 'a fingerprint mismatch must block the write even with a valid, repo-owned id');
    const row = await q.one(`SELECT remediation_state FROM audit_findings WHERE id = $1`, [ins.id]);
    assert.equal(row.remediation_state, null, 'the mismatched-fingerprint row must be untouched');
  });

  test('H2/H3 (positive control): the SAME row-id path succeeds when repo AND fingerprint both match', async () => {
    const fp = `h2h3-ok-${crypto.randomUUID().slice(0, 8)}`;
    const ins = await q.one(
      `INSERT INTO audit_findings (run_id, finding_fingerprint, pass_name, severity, category)
       VALUES ($1, $2, 'merged', 'HIGH', 'test') RETURNING id`,
      [runId, fp]
    );
    const res = await markFindingsRemediation(repoId, [
      { id: ins.id, findingFingerprint: fp, state: 'fixed' },
    ]);
    assert.equal(res.updated, 1);
    const row = await q.one(`SELECT remediation_state FROM audit_findings WHERE id = $1`, [ins.id]);
    assert.equal(row.remediation_state, 'fixed');
  });
});
