/**
 * @fileoverview Producer→store contract for `recordFinalReviewFindings`'s
 * `shadowRan` flag (docs/plans/final-review-credit-projection.md Seam 3 /
 * audit-plan R1 M3). The store treats an absent/false `shadowRan` as "leave
 * prior shadow rows untouched" and `true` as "this snapshot is authoritative,
 * prune what it dropped" — so the producer forwarding the WRONG value silently
 * either erases shadow history that should have survived, or fails to prune
 * rows a genuinely-empty shadow round should have cleared.
 *
 * Two layers:
 *
 *   1. `buildFinalReviewPersistPayload` — the PURE payload builder extracted
 *      out of `runShadowAndPersist` (audit-code cluster A R1 M6, replacing an
 *      earlier version of this file that pinned the "shadow ran" cases as a
 *      call-shape assertion because the network boundary made them
 *      unreachable functionally). It takes already-resolved `result._shadow`
 *      state and a `diff`, so all THREE cases — executed non-empty, executed
 *      empty, did-not-run — are driven with hand-built fixtures and NO
 *      provider call, honouring this repo's no-whole-provider-mock doctrine
 *      (AGENTS.md §Testing doctrine, Tier 2) without resorting to source
 *      assertions for behaviour that is, in fact, fully testable.
 *   2. `runShadowAndPersist` itself, exercised through its real production
 *      path via the `persistFn` test seam (mirrors the existing
 *      `modelEvalOverride` seam) for the one case reachable without a
 *      provider call — the shadow did not run at all.
 *
 * @module tests/gemini-review-shadow-persist
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { _internals } from '../scripts/gemini-review.mjs';

const { runShadowAndPersist, buildFinalReviewPersistPayload } = _internals;

// Same FORCED_SKIP fixture tests/gemini-review-shadow.test.mjs already uses to
// force a deterministic non-'ready' shadow state without touching ambient env.
const FORCED_SKIP = { repoId: null, modelEvalRunId: null, shadow: { state: 'skipped-unset', provider: null, model: null } };
const ctx = { planContent: 'plan', transcriptContent: '{}', projectContext: '', auditMode: 'code' };

function fakePersist() {
  const calls = [];
  const persistFn = async (runId, payload) => { calls.push({ runId, payload }); };
  return { persistFn, calls };
}

const finding = (over = {}) => ({
  id: 'F1', severity: 'HIGH', category: 'Test', section: 'a.mjs:1', detail: 'd',
  risk: 'r', recommendation: 'x', is_quick_fix: false, is_mechanical: false, principle: 'p',
  _hash: 'aaaa1111', ...over,
});

describe('runShadowAndPersist → recordFinalReviewFindings — the shadowRan contract (shadow did not run)', () => {
  it('a shadow that did NOT run: shadowRan:false, shadow:[], every primary _bucket null', async () => {
    const { persistFn, calls } = fakePersist();
    const result = { new_findings: [finding()], verdict: 'PASS' };
    await runShadowAndPersist(result, 'gpt-5.6', 'run-1', ctx, { modelEvalOverride: FORCED_SKIP, persistFn });

    assert.equal(calls.length, 1, 'the primary must still persist even when the shadow did not run');
    const { runId, payload } = calls[0];
    assert.equal(runId, 'run-1');
    assert.equal(payload.shadowRan, false, 'a shadow that did not run must forward shadowRan:false, never omit it as a permissive default');
    assert.deepEqual(payload.shadow, []);
    assert.ok(payload.primary.length > 0, 'the primary findings must still be persisted');
    for (const f of payload.primary) {
      assert.equal(f._bucket, null, 'bucket is only meaningful when both reviewers ran — must be null, not left unset');
    }
  });

  it('an empty new_findings result with the shadow not run still calls persistFn once (no shadow write attempted)', async () => {
    const { persistFn, calls } = fakePersist();
    const result = { new_findings: [], verdict: 'PASS' };
    await runShadowAndPersist(result, 'gpt-5.6', 'run-2', ctx, { modelEvalOverride: FORCED_SKIP, persistFn });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].payload.shadowRan, false);
    assert.deepEqual(calls[0].payload.shadow, []);
  });

  it('persistFn is NOT called when runId is absent (unchanged contract — no run to attach to)', async () => {
    const { persistFn, calls } = fakePersist();
    const result = { new_findings: [], verdict: 'PASS' };
    await runShadowAndPersist(result, 'gpt-5.6', null, ctx, { modelEvalOverride: FORCED_SKIP, persistFn });
    assert.equal(calls.length, 0);
  });
});

describe('buildFinalReviewPersistPayload — the three shadow states (real function, no network)', () => {
  it('executed, non-empty: shadowRan:true, shadow carries the diffed findings, every primary bucket stamped', () => {
    const result = {
      new_findings: [finding({ _hash: 'p1' })],
      verdict: 'PASS',
      _shadow: { state: 'ran', usage: { input_tokens: 100, output_tokens: 50, latency_ms: 900 } },
    };
    const diff = {
      primary: [finding({ _hash: 'p1', _bucket: 'both' })],
      shadow: [finding({ _hash: 's1', _bucket: 'shadow-only' })],
    };
    const payload = buildFinalReviewPersistPayload({ result, diff, primaryModel: 'gpt-5.6', shadow: { model: 'gemini-pro-latest' } });

    assert.equal(payload.shadowRan, true);
    assert.deepEqual(payload.shadow.map((f) => f._hash), ['s1']);
    assert.equal(payload.primary[0]._bucket, 'both', 'bucket must NOT be nulled when the shadow ran');
    assert.equal(payload.primary[0]._sourceModel, 'gpt-5.6');
    assert.equal(payload.models.shadowModel, 'gemini-pro-latest');
    assert.equal(payload.models.shadowInputTokens, 100);
    assert.equal(payload.verdict, 'PASS');
  });

  it('executed, EMPTY: shadowRan:true, shadow:[] — this is the "measured, found nothing" case, distinct from "did not run"', () => {
    const result = {
      new_findings: [finding({ _hash: 'p1' })],
      verdict: 'PASS',
      _shadow: { state: 'ran', usage: { input_tokens: 10, output_tokens: 5, latency_ms: 100 } },
    };
    const diff = { primary: [finding({ _hash: 'p1', _bucket: 'primary-only' })], shadow: [] };
    const payload = buildFinalReviewPersistPayload({ result, diff, primaryModel: 'gpt-5.6', shadow: { model: 'gemini-pro-latest' } });

    assert.equal(payload.shadowRan, true, 'executed-and-empty must still report shadowRan:true — the store prunes on this, unlike did-not-run');
    assert.deepEqual(payload.shadow, []);
    assert.equal(payload.primary[0]._bucket, 'primary-only');
    assert.equal(payload.models.shadowModel, 'gemini-pro-latest', 'the shadow model is still attributed even with zero findings');
  });

  it('did NOT run (skipped or failed): shadowRan:false, shadow:[], every primary bucket forced null, no shadow model attribution', () => {
    for (const shadowState of [{ state: 'skipped-unset' }, { state: 'error', error: 'boom' }]) {
      const result = { new_findings: [finding({ _hash: 'p1' })], verdict: 'PASS', _shadow: shadowState };
      const payload = buildFinalReviewPersistPayload({ result, diff: null, primaryModel: 'gpt-5.6', shadow: { model: 'gemini-pro-latest' } });

      assert.equal(payload.shadowRan, false, `state=${shadowState.state}`);
      assert.deepEqual(payload.shadow, []);
      assert.equal(payload.primary[0]._bucket, null, 'bucket must be forced null when the shadow did not run, even if diff is absent');
      assert.equal(payload.models.shadowModel, null, 'no shadow model attribution for a round that never produced an observation');
    }
  });

  it('did NOT run, but a STALE diff object is present (e.g. left over from an earlier attempt): shadow must still be [] — the gate is `ran`, not "is diff present"', () => {
    // Reproduces exactly what a negative control caught: gating shadowFindings
    // on `diff?.shadow || []` instead of `ran ? diff.shadow : []` passes every
    // OTHER test in this file (since ran=true cases always have a diff, and the
    // plain did-not-run case above passes diff:null) but silently leaks a stale
    // diff's shadow content when both are present at once.
    const result = { new_findings: [finding({ _hash: 'p1' })], verdict: 'PASS', _shadow: { state: 'skipped-unset' } };
    const staleDiff = { primary: [finding({ _hash: 'p1', _bucket: 'both' })], shadow: [finding({ _hash: 'stale-shadow' })] };
    const payload = buildFinalReviewPersistPayload({ result, diff: staleDiff, primaryModel: 'gpt-5.6', shadow: { model: 'gemini-pro-latest' } });

    assert.equal(payload.shadowRan, false);
    assert.deepEqual(payload.shadow, [], 'a stale diff must not leak shadow findings when the shadow did not run THIS round');
  });

  it('never reads result._shadow.verdict for the persisted verdict — only the PRIMARY reviewer gates', () => {
    const result = { new_findings: [], verdict: 'REJECT', _shadow: { state: 'ran', verdict: 'APPROVE', usage: {} } };
    const payload = buildFinalReviewPersistPayload({ result, diff: { primary: [], shadow: [] }, primaryModel: 'gpt-5.6', shadow: { model: 'm' } });
    assert.equal(payload.verdict, 'REJECT', 'the shadow is observation-only and must never reach the gating verdict column');
  });
});
