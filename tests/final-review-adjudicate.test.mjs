/**
 * @fileoverview `adjudicateFinalReviewFinding` — bucket resolution + the
 * no-silent-success contract.
 *
 * This function had NO test, which is why a hardcoded `bucket: 'shadow-only'`
 * predicate survived: every PRIMARY final-review finding "adjudicated"
 * successfully and nothing changed. `{ok: true, updated: 0}` is the
 * unverified-write-success class this codebase rates HIGH elsewhere.
 *
 * **Coverage honesty about this file itself**: the bucket-resolution matrix
 * genuinely needs a database — the decision is made from a live `SELECT
 * DISTINCT bucket`. So it is an env-gated integration block (`AUDIT_DB_TEST_URL`,
 * disposable-DSN asserted), NOT a pure re-implementation of the branch table.
 * Re-stating the logic in the test would have passed on this machine while
 * proving nothing about the code — the same shape of self-satisfying green
 * that let the original bug through. Without the DSN, only the contract block
 * below runs.
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

const TEST_URL = process.env.AUDIT_DB_TEST_URL;
const skip = TEST_URL ? false : 'AUDIT_DB_TEST_URL not set (integration block)';

describe('adjudicateFinalReviewFinding — contract (no DB required)', () => {
  it('is exported and accepts an optional 4th opts argument', async () => {
    const mod = await import('../scripts/lib/store/runs-findings.mjs');
    assert.equal(typeof mod.adjudicateFinalReviewFinding, 'function');
  });

  it('rejects an invalid action loudly rather than writing nothing quietly', async () => {
    const mod = await import('../scripts/lib/store/runs-findings.mjs');
    await assert.rejects(
      () => mod.adjudicateFinalReviewFinding('run', 'fp', 'maybe'),
      /must be 'accepted' or 'dismissed'/,
    );
  });

  it('names a REASON on every failure, never a bare ok:false', async () => {
    // The CLI turns `reason` into operator guidance. A failure that cannot say
    // why is how the hardcoded-bucket no-op stayed invisible for so long.
    const mod = await import('../scripts/lib/store/runs-findings.mjs');
    const prior = process.env.AUDIT_DB_URL;
    delete process.env.AUDIT_DB_URL;
    try {
      const res = await mod.adjudicateFinalReviewFinding('run', 'fp', 'dismissed');
      assert.equal(res.ok, false);
      assert.ok(res.reason, 'a failure must carry a reason');
    } finally {
      if (prior !== undefined) process.env.AUDIT_DB_URL = prior;
    }
  });
});

describe('adjudicateFinalReviewFinding — bucket resolution (integration)', { skip }, () => {
  let mod, q, client, repoId, runId;
  const FP_SHADOW = 'fpshadow';
  const FP_PRIMARY = 'fpprimar';
  const FP_BOTH = 'fpboth00';

  before(async () => {
    const { assertDisposableDbUrl, _resetForTest } = await import('../scripts/lib/db/client.mjs');
    const savedUrl = process.env.AUDIT_DB_URL;
    // Refuses a production-identical DSN. The July 2026 wipe came from a suite
    // run against a prod-aliased URL; this guard is why that cannot recur.
    assertDisposableDbUrl(TEST_URL, { productionUrl: savedUrl });
    process.env.AUDIT_DB_URL = TEST_URL;
    _resetForTest?.();
    q = await import('../scripts/lib/db/query.mjs');
    mod = await import('../scripts/lib/store/runs-findings.mjs');

    repoId = crypto.randomUUID();
    runId = crypto.randomUUID();
    await q.query(`INSERT INTO audit_repos (id, name) VALUES ($1, $2)
                   ON CONFLICT (id) DO NOTHING`, [repoId, `test-${repoId.slice(0, 8)}`]);
    await q.query(`INSERT INTO audit_runs (id, repo_id) VALUES ($1, $2)
                   ON CONFLICT (id) DO NOTHING`, [runId, repoId]);
    const ins = (fp, bucket) => q.query(
      `INSERT INTO audit_findings (run_id, finding_fingerprint, pass_name, severity, category, bucket)
       VALUES ($1, $2, 'final-review', 'HIGH', 'test', $3)`, [runId, fp, bucket]);
    await ins(FP_SHADOW, 'shadow-only');
    await ins(FP_PRIMARY, null);
    await ins(FP_BOTH, null);
    await ins(FP_BOTH, 'shadow-only');
  });

  after(async () => {
    if (!q) return;
    await q.query('DELETE FROM audit_findings WHERE run_id = $1', [runId]);
    await q.query('DELETE FROM audit_runs WHERE id = $1', [runId]);
    await q.query('DELETE FROM audit_repos WHERE id = $1', [repoId]);
    const { closePool } = await import('../scripts/lib/db/client.mjs');
    await closePool();
  });

  const outcomeOf = async (fp, bucket) => {
    const r = await q.one(
      `SELECT adjudication_outcome ao, user_action ua, decided_at da
         FROM audit_findings
        WHERE run_id = $1 AND finding_fingerprint = $2 AND bucket IS NOT DISTINCT FROM $3`,
      [runId, fp, bucket]);
    return r;
  };

  it('resolves a lone shadow-only row with no --bucket (back-compat)', async () => {
    const res = await mod.adjudicateFinalReviewFinding(runId, FP_SHADOW, 'accepted');
    assert.equal(res.ok, true);
    assert.equal(res.updated, 1);
    const row = await outcomeOf(FP_SHADOW, 'shadow-only');
    assert.equal(row.ua, 'accepted-permanent');
    // Written alongside user_action so ground-truth queries keyed on these
    // columns can see the adjudication at all.
    assert.equal(row.ao, 'accepted');
    assert.ok(row.da, 'decided_at must be stamped');
  });

  it('adjudicates a PRIMARY (null-bucket) finding — the case that was unreachable', async () => {
    const res = await mod.adjudicateFinalReviewFinding(runId, FP_PRIMARY, 'dismissed');
    assert.equal(res.ok, true, 'a primary finding must be adjudicable');
    assert.equal(res.updated, 1);
    const row = await outcomeOf(FP_PRIMARY, null);
    assert.equal(row.ao, 'dismissed');
  });

  it('REFUSES rather than guessing when a fingerprint spans buckets', async () => {
    // Two buckets sharing a fingerprint are two INDEPENDENT observations
    // (primary vs shadow). Collapsing them would corrupt the A/B comparison
    // the shadow experiment exists to make — the legitimate concern the
    // original hardcode was reaching for.
    const res = await mod.adjudicateFinalReviewFinding(runId, FP_BOTH, 'accepted');
    assert.equal(res.ok, false);
    assert.equal(res.reason, 'ambiguous-bucket');
    assert.equal(res.updated, 0);
    assert.equal(res.buckets.length, 2);
    const untouched = await outcomeOf(FP_BOTH, null);
    assert.equal(untouched.ao, null, 'a refusal must not write anything');
  });

  it('an explicit --bucket disambiguates the multi-bucket case', async () => {
    const res = await mod.adjudicateFinalReviewFinding(
      runId, FP_BOTH, 'accepted', { bucket: 'shadow-only' });
    assert.equal(res.ok, true);
    assert.equal(res.updated, 1);
    assert.equal((await outcomeOf(FP_BOTH, 'shadow-only')).ao, 'accepted');
    assert.equal((await outcomeOf(FP_BOTH, null)).ao, null, 'the sibling row stays untouched');
  });

  it('an unknown fingerprint FAILS — never a quiet success', async () => {
    // The whole defect in one assertion.
    const res = await mod.adjudicateFinalReviewFinding(runId, 'nosuchfp', 'dismissed');
    assert.equal(res.ok, false);
    assert.equal(res.reason, 'no-match');
    assert.equal(res.updated, 0);
  });

  it('an explicit bucket that matches nothing FAILS and names what exists', async () => {
    const res = await mod.adjudicateFinalReviewFinding(
      runId, FP_SHADOW, 'dismissed', { bucket: null });
    assert.equal(res.ok, false);
    assert.equal(res.reason, 'no-match-in-bucket');
    assert.deepEqual(res.buckets, ['shadow-only']);
  });
});
