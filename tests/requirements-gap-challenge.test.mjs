/**
 * Tests for scripts/lib/requirements/gap-challenge.mjs — the pure parts:
 * degraded-assessment detection and batching arithmetic. Per testing doctrine
 * (Tier 2 — LLM-orchestration seams): assert INVARIANTS, never mock the whole
 * provider (`classifyGaps` itself is exercised by a live run, not a fake
 * `callOpenAI`).
 *
 * **Why these two functions exist.** `classifyGaps` makes ONE unbatched LLM
 * call over every candidate handed to it, capped at 16K output tokens
 * (~50-70 tokens per assessment ⇒ realistically a few hundred candidates).
 * Measured against the 2026-08-12 whole-repo extract: 8 of 10 tranches (up to
 * 1,460 candidates each) exceeded that ceiling and silently degraded to
 * `gap:'none', rationale:'not assessed'` for every candidate in the batch —
 * 2,083 of 4,051 ledger entries (51%) carried that placeholder, and it is
 * indistinguishable from a genuine "sound invariant" verdict without reading
 * `rationale`.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  isDegradedGapAssessment, chunkForGapChallenge, GAP_BATCH_SIZE,
} from '../scripts/lib/requirements/gap-challenge.mjs';

describe('isDegradedGapAssessment', () => {
  it('no assessment at all — never ran', () => {
    assert.equal(isDegradedGapAssessment(null), true);
    assert.equal(isDegradedGapAssessment(undefined), true);
  });

  it('the exact placeholder strings classifyGaps emits are all degraded', () => {
    assert.equal(isDegradedGapAssessment({ gap: 'none', rationale: 'not assessed' }), true);
    assert.equal(isDegradedGapAssessment({ gap: 'none', rationale: 'coerced — malformed assessment' }), true);
    // The dynamic `gap-challenge LLM ${state}` family — every possible
    // callOpenAI state (`empty`, `blocked`, `truncated`, `timeout`,
    // `http_error`, `malformed`), plus the two hardcoded WARN paths.
    for (const state of ['empty', 'blocked', 'truncated', 'timeout', 'http_error', 'malformed']) {
      assert.equal(isDegradedGapAssessment({ gap: 'none', rationale: `gap-challenge LLM ${state}` }), true, state);
    }
    assert.equal(isDegradedGapAssessment({ gap: 'none', rationale: 'gap-challenge errored' }), true);
    assert.equal(isDegradedGapAssessment({ gap: 'none', rationale: "gap-challenge response missing an 'assessments' array — degraded" }), true);
  });

  it('a GENUINE gap:"none" verdict is NOT degraded — this is the whole point', () => {
    // The two readings this function exists to keep apart: 'none' meaning
    // "sound invariant" (real, must survive) vs 'none' meaning "never
    // assessed" (degraded, must be re-run). Collapsing them either drowns
    // every clean requirement in false re-review, or silently does nothing.
    assert.equal(isDegradedGapAssessment({ gap: 'none', rationale: 'A well-formed, intentional invariant with no conflicting requirement.' }), false);
  });

  it('a genuine non-"none" verdict is never degraded, whatever its rationale text', () => {
    assert.equal(isDegradedGapAssessment({ gap: 'untested', rationale: 'No linked test evidence.' }), false);
    assert.equal(isDegradedGapAssessment({ gap: 'contradictory', rationale: 'Conflicts with REQ-x.' }), false);
  });

  it('a real rationale that merely CONTAINS the word "gap-challenge" mid-sentence is not a false positive', () => {
    // The detector matches on STARTS-WITH, not "contains" — an LLM rationale
    // that happens to reference the pass by name partway through must not be
    // swept into "degraded" by accident.
    assert.equal(isDegradedGapAssessment({ gap: 'none', rationale: 'This invariant predates the gap-challenge pass and remains sound.' }), false);
  });
});

describe('chunkForGapChallenge', () => {
  it('splits into groups no larger than the batch size', () => {
    const items = Array.from({ length: 425 }, (_, i) => ({ id: i }));
    const batches = chunkForGapChallenge(items, 180);
    assert.equal(batches.length, 3);
    assert.deepEqual(batches.map((b) => b.length), [180, 180, 65]);
  });

  it('is LOSSLESS and ORDER-PRESERVING — every item appears exactly once, in order', () => {
    const items = Array.from({ length: 425 }, (_, i) => ({ id: i }));
    const flat = chunkForGapChallenge(items, 180).flat();
    assert.deepEqual(flat.map((i) => i.id), items.map((i) => i.id));
  });

  it('an empty input produces zero batches, not one empty batch', () => {
    assert.deepEqual(chunkForGapChallenge([], 180), []);
  });

  it('input smaller than the batch size is exactly one batch', () => {
    const items = Array.from({ length: 5 }, (_, i) => ({ id: i }));
    assert.deepEqual(chunkForGapChallenge(items, 180).length, 1);
  });

  it('GAP_BATCH_SIZE is comfortably under the documented ~228-320 output-token ceiling', () => {
    // 16,000 output tokens / ~70 tokens per assessment (the module's own
    // stated upper estimate) ≈ 228. The constant must sit BELOW that with
    // real margin, or a batch could reproduce the exact degradation this
    // module exists to fix.
    assert.ok(GAP_BATCH_SIZE < 228, `GAP_BATCH_SIZE (${GAP_BATCH_SIZE}) has no safety margin below the ~228-token ceiling`);
    assert.ok(GAP_BATCH_SIZE > 0);
  });
});
