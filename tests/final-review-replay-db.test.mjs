/**
 * @fileoverview `recordFinalReviewFindings` replay semantics against a REAL
 * Postgres (docs/plans/final-review-credit-projection.md Seam 3, audit-plan
 * R1 H2/H3/M1). Until 2026-09-14 every re-run DELETEd all 'final-review' /
 * 'final-review-shadow' rows for the run before re-inserting — erasing any
 * `user_action`/`adjudication_outcome` a human or agent had written. This
 * suite pins the replacement it became: upsert the new snapshot, then prune
 * only the rows the snapshot dropped that carry NO completed ruling and NO
 * recorded remediation on either axis.
 *
 * A fake-store/unit test cannot prove any of this — the identity comparison
 * (`IS NOT DISTINCT FROM` on a nullable `bucket`), the advisory-lock
 * serialisation, or the real `ON CONFLICT` upsert. Env-gated on
 * `AUDIT_DB_TEST_URL` (disposable DSN; `assertDisposableDbUrl` refuses
 * anything else) and ENROLLED in both `ISOLATED_SUITE_FILES`
 * (scripts/db-test-container.mjs) and `.github/workflows/postgres-parity.yml`
 * (job list + both trigger `paths:` filters) — a DB suite no runner names has
 * never run (AGENTS.md §Testing).
 *
 * @module tests/final-review-replay-db
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

const TEST_URL = process.env.AUDIT_DB_TEST_URL;
const skip = TEST_URL ? false : 'AUDIT_DB_TEST_URL not set (integration block)';

describe('recordFinalReviewFindings — replay preserves rulings (integration)', { skip }, () => {
  let mod, q, repoId, repoName;

  before(async () => {
    const { assertDisposableDbUrl, _resetForTest } = await import('../scripts/lib/db/client.mjs');
    const savedUrl = process.env.AUDIT_DB_URL;
    assertDisposableDbUrl(TEST_URL, { productionUrl: savedUrl });
    process.env.AUDIT_DB_URL = TEST_URL;
    _resetForTest?.();
    q = await import('../scripts/lib/db/query.mjs');
    mod = await import('../scripts/lib/store/runs-findings.mjs');

    repoId = crypto.randomUUID();
    repoName = `test-replay-${repoId.slice(0, 8)}`;
    await q.query(`INSERT INTO audit_repos (id, name) VALUES ($1, $2)`, [repoId, repoName]);
  });

  after(async () => {
    if (!q) return;
    await q.query(`DELETE FROM audit_findings WHERE run_id IN (SELECT id FROM audit_runs WHERE repo_id = $1)`, [repoId]);
    await q.query('DELETE FROM audit_runs WHERE repo_id = $1', [repoId]);
    await q.query('DELETE FROM audit_repos WHERE id = $1', [repoId]);
    const { closePool } = await import('../scripts/lib/db/client.mjs');
    await closePool();
  });

  /** A fresh run row, owned by this suite's repo. */
  async function freshRun() {
    const runId = crypto.randomUUID();
    await q.query(`INSERT INTO audit_runs (id, repo_id, plan_file, mode) VALUES ($1, $2, 'docs/plans/test-fixture.md', 'code')`, [runId, repoId]);
    return runId;
  }

  /** A finding object shaped for buildFindingRow — _hash is the fingerprint. */
  const finding = (hash, over = {}) => ({
    _hash: hash, severity: 'MEDIUM', category: 'Test',
    section: `src/${hash}.mjs:1`, detail: `finding ${hash}`,
    _bucket: null, ...over,
  });

  async function rowsFor(runId, passName) {
    return q.many(
      `SELECT finding_fingerprint AS fp, bucket, adjudication_outcome, user_action, remediation_state
         FROM audit_findings WHERE run_id = $1 AND pass_name = $2 ORDER BY finding_fingerprint, bucket`,
      [runId, passName]
    );
  }

  it('a snapshot replaces the population; a labelled absentee survives, an unlabelled one is pruned, and a re-record is idempotent', async () => {
    const runId = await freshRun();
    // round-2 audit M1: this test's own title claims "an unlabelled one is
    // pruned", but the original body only ever dropped fp-a — which is ruled
    // below — so nothing here actually exercised pruning an UNRULED primary
    // absentee (the shadow-side test at line ~151 covers that case for
    // 'final-review-shadow', but nothing covered it for 'final-review').
    // fp-x is added specifically to be that case: unruled in round 1, absent
    // from round 2's snapshot, and asserted pruned below.
    await mod.recordFinalReviewFindings(runId, {
      primary: [finding('fp-a'), finding('fp-b'), finding('fp-x')], shadow: [], shadowRan: false,
    });
    let rows = await rowsFor(runId, 'final-review');
    assert.deepEqual(rows.map((r) => r.fp), ['fp-a', 'fp-b', 'fp-x']);

    // Human/agent rules on fp-a; fp-b and fp-x stay unruled.
    await q.query(
      `UPDATE audit_findings SET adjudication_outcome = 'accepted', user_action = 'accepted-permanent', remediation_state = 'fixed'
         WHERE run_id = $1 AND pass_name = 'final-review' AND finding_fingerprint = 'fp-a'`,
      [runId]
    );

    // Round 2: fp-a (ruled) and fp-x (unruled) both drop out of the new
    // snapshot; fp-c is new. fp-b repeats.
    await mod.recordFinalReviewFindings(runId, {
      primary: [finding('fp-b'), finding('fp-c')], shadow: [], shadowRan: false,
    });
    rows = await rowsFor(runId, 'final-review');
    assert.deepEqual(rows.map((r) => r.fp).sort(), ['fp-a', 'fp-b', 'fp-c'],
      'fp-a (ruled) must survive being dropped from the snapshot — the old DELETE-based replace would have erased it — while fp-x (unruled) must be pruned');
    const a = rows.find((r) => r.fp === 'fp-a');
    assert.equal(a.adjudication_outcome, 'accepted');
    assert.equal(a.user_action, 'accepted-permanent');
    assert.equal(a.remediation_state, 'fixed');

    // Round 3: identical to round 2 — idempotent, no row-count change, fp-a still intact.
    await mod.recordFinalReviewFindings(runId, {
      primary: [finding('fp-b'), finding('fp-c')], shadow: [], shadowRan: false,
    });
    rows = await rowsFor(runId, 'final-review');
    assert.deepEqual(rows.map((r) => r.fp).sort(), ['fp-a', 'fp-b', 'fp-c']);
    assert.equal(rows.find((r) => r.fp === 'fp-a').adjudication_outcome, 'accepted', 're-recording the same snapshot must not disturb a surviving ruling');
  });

  it('identity is the COMPLETE (fingerprint, bucket) pair — dropping one bucket variant of a fingerprint prunes only that bucket, and a NULL bucket compares null-safely', async () => {
    const runId = await freshRun();
    // Pre-existing state: the SAME fingerprint under 'final-review-shadow' in
    // two different buckets, both unruled.
    await q.query(
      `INSERT INTO audit_findings (run_id, finding_fingerprint, pass_name, severity, category, bucket)
       VALUES ($1, 'fp-multi', 'final-review-shadow', 'MEDIUM', 'test', 'both'),
              ($1, 'fp-multi', 'final-review-shadow', 'MEDIUM', 'test', 'shadow-only')`,
      [runId]
    );
    // New snapshot keeps ONLY the 'both'-bucket variant.
    await mod.recordFinalReviewFindings(runId, {
      primary: [], shadow: [finding('fp-multi', { _bucket: 'both' })], shadowRan: true,
    });
    const rows = await rowsFor(runId, 'final-review-shadow');
    assert.deepEqual(rows.map((r) => `${r.fp}/${r.bucket}`), ['fp-multi/both'],
      'a fingerprint-only prune (ignoring bucket) would have wrongly kept BOTH rows, since the fingerprint IS in keptKeys');

    // NULL-bucket round-trip: a primary finding with no bucket, kept across two rounds.
    await mod.recordFinalReviewFindings(runId, { primary: [finding('fp-null', { _bucket: null })], shadow: [], shadowRan: false });
    await mod.recordFinalReviewFindings(runId, { primary: [finding('fp-null', { _bucket: null })], shadow: [], shadowRan: false });
    const primaryRows = await rowsFor(runId, 'final-review');
    assert.deepEqual(primaryRows.map((r) => [r.fp, r.bucket]), [['fp-null', null]]);
  });

  it('a prune never touches rows of a DIFFERENT pass_name, even with the same fingerprint', async () => {
    const runId = await freshRun();
    // A row from the regular (non-final-review) audit, unruled, same fingerprint.
    await q.query(
      `INSERT INTO audit_findings (run_id, finding_fingerprint, pass_name, severity, category)
       VALUES ($1, 'fp-shared', 'merged', 'MEDIUM', 'test')`,
      [runId]
    );
    await mod.recordFinalReviewFindings(runId, { primary: [], shadow: [], shadowRan: true });
    const merged = await rowsFor(runId, 'merged');
    assert.deepEqual(merged.map((r) => r.fp), ['fp-shared'], 'an empty final-review snapshot must not prune a different pass_name');
  });

  it('shadowRan:false leaves PRIOR shadow rows untouched; shadowRan:true with shadow:[] prunes only the unruled ones', async () => {
    const runId = await freshRun();
    await mod.recordFinalReviewFindings(runId, {
      primary: [], shadow: [finding('fp-s1'), finding('fp-s2', { _bucket: 'shadow-only' })], shadowRan: true,
    });
    await q.query(
      `UPDATE audit_findings SET adjudication_outcome = 'dismissed', user_action = 'dismissed'
         WHERE run_id = $1 AND pass_name = 'final-review-shadow' AND finding_fingerprint = 'fp-s2'`,
      [runId]
    );

    // A round where the shadow did NOT run — both prior rows must survive untouched.
    await mod.recordFinalReviewFindings(runId, { primary: [], shadow: [], shadowRan: false });
    let rows = await rowsFor(runId, 'final-review-shadow');
    assert.deepEqual(rows.map((r) => r.fp).sort(), ['fp-s1', 'fp-s2'], 'shadowRan:false must not prune — the shadow was not measured this round');

    // A round where the shadow DID run and found nothing — the unruled one is pruned, the dismissed one survives.
    await mod.recordFinalReviewFindings(runId, { primary: [], shadow: [], shadowRan: true });
    rows = await rowsFor(runId, 'final-review-shadow');
    assert.deepEqual(rows.map((r) => r.fp), ['fp-s2'], 'shadowRan:true with an empty shadow must prune the unruled absentee and keep the dismissed one');
  });

  it('a shadow-side write failure leaves the primary transaction committed (Gemini G1/G2, still true under upsert+prune)', async () => {
    const runId = await freshRun();
    const res = await mod.recordFinalReviewFindings(runId, {
      primary: [finding('fp-p1')],
      // An out-of-domain source_kind (chk_source_kind) — a genuine constraint
      // violation, not a fabricated failure injection.
      shadow: [{ ...finding('fp-bad'), classification: { sourceKind: 'NOT-A-REAL-KIND' } }],
      shadowRan: true,
    });
    const primary = await rowsFor(runId, 'final-review');
    assert.deepEqual(primary.map((r) => r.fp), ['fp-p1'], 'the primary batch must commit even though the shadow batch failed');
    const shadow = await rowsFor(runId, 'final-review-shadow');
    assert.deepEqual(shadow, [], 'the failed shadow write must not have partially applied');
    // round-5 audit H1: shadowDroppedCount alone (0 here) is indistinguishable
    // from a clean, empty shadow — shadowWriteFailed is what actually tells a
    // caller the shadow observation was LOST, not merely quiet.
    assert.equal(res.shadowDroppedCount, 0);
    assert.equal(res.shadowWriteFailed, true, 'a thrown shadow-tx error must be surfaced, not silently indistinguishable from a clean run');
  });

  it('two concurrent replacements of the SAME run/pass with disjoint sets leave ONE complete snapshot, never their union (advisory lock)', async () => {
    const runId = await freshRun();
    const setA = [finding('fp-conc-a1'), finding('fp-conc-a2')];
    const setB = [finding('fp-conc-b1'), finding('fp-conc-b2')];
    await Promise.all([
      mod.recordFinalReviewFindings(runId, { primary: setA, shadow: [], shadowRan: false }),
      mod.recordFinalReviewFindings(runId, { primary: setB, shadow: [], shadowRan: false }),
    ]);
    const rows = await rowsFor(runId, 'final-review');
    const fps = rows.map((r) => r.fp).sort();
    const aFps = setA.map((f) => f._hash).sort();
    const bFps = setB.map((f) => f._hash).sort();
    assert.ok(
      JSON.stringify(fps) === JSON.stringify(aFps) || JSON.stringify(fps) === JSON.stringify(bFps),
      `expected exactly one snapshot (${JSON.stringify(aFps)} or ${JSON.stringify(bFps)}), got the union or something else: ${JSON.stringify(fps)}`,
    );
  });

  it('H16 (round-1 audit): a batch where EVERY primary finding is dropped by a producer defect does not persist a verdict', async () => {
    const runId = await freshRun();
    // Every finding lacks severity — recordFindings' own guard drops all of
    // them (applied:true, rows:0, droppedCount:primary.length), which does
    // NOT throw. Before this fix, control fell through to the metadata write
    // and persisted `gemini_verdict` for a run with zero recorded findings —
    // the same orphan-verdict shape the tx1-failure path already prevented.
    const res = await mod.recordFinalReviewFindings(runId, {
      primary: [finding('fp-h16-a', { severity: null }), finding('fp-h16-b', { severity: null })],
      shadow: [], shadowRan: false, verdict: 'APPROVE',
    });
    // round-3 audit H4: the return shape now also names HOW MANY were dropped
    // per side, so a caller can tell an all-dropped batch (this case) from a
    // partial one without re-deriving it.
    assert.deepEqual(res, { findingsRecorded: false, verdictPersisted: false, primaryDroppedCount: 2, shadowDroppedCount: 0, shadowWriteFailed: false });
    const run = await q.one(`SELECT gemini_verdict FROM audit_runs WHERE id = $1`, [runId]);
    assert.equal(run.gemini_verdict, null, 'no verdict must be persisted when nothing was actually recorded');
    const rows = await rowsFor(runId, 'final-review');
    assert.deepEqual(rows, [], 'no findings rows either — both facts agree');
  });

  it('a genuinely EMPTY primary (nothing raised this round) still persists its verdict — not the same case as H16', async () => {
    const runId = await freshRun();
    const res = await mod.recordFinalReviewFindings(runId, {
      primary: [], shadow: [], shadowRan: false, verdict: 'APPROVE',
    });
    assert.deepEqual(res, { findingsRecorded: true, verdictPersisted: true, primaryDroppedCount: 0, shadowDroppedCount: 0, shadowWriteFailed: false });
    const run = await q.one(`SELECT gemini_verdict FROM audit_runs WHERE id = $1`, [runId]);
    assert.equal(run.gemini_verdict, 'APPROVE', 'an empty round is a legitimate clean result — its verdict is not an orphan');
  });
});
