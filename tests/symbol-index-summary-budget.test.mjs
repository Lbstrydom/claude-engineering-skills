/**
 * `summaryMaxTokens` — the summariser's output ceiling as a function of the
 * request, replacing a flat `max_tokens: 4096` on a one-line-per-symbol call.
 *
 * Measured 2026-11-14 (docs/plans/anthropic-cli-faithfulness-routing.md §6.A):
 * 5 runs of a 10-symbol batch on `claude-haiku-5-5` — 916 / 943 / 991 / 1146 /
 * 1308 output tokens, ~92-131 per symbol. The ceiling never bound.
 *
 * The 5th sample arrived after the first four and moved the maximum by 14%,
 * which is why the budget is 256/symbol rather than the 192 first shipped: a
 * handful of samples bounds what was SEEN, not what fits.
 *
 * @module tests/symbol-index-summary-budget
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { summaryMaxTokens, assessBatchCompleteness } from '../scripts/symbol-index/summarise.mjs';

describe('summaryMaxTokens', () => {
  // PRODUCTION PIN. `ARCH_INDEX_BATCH_SIZE` defaults to 50
  // (scripts/lib/config.mjs), so the normal arch-index run must send exactly
  // the ceiling it sent before this change. Without this, "only bites on small
  // batches" is a claim rather than a fact.
  it('is byte-identical to the old constant at the configured default batch of 50', () => {
    assert.equal(summaryMaxTokens(50), 4096);
  });

  it('never exceeds the old constant, at any batch size', () => {
    for (const n of [50, 51, 64, 100, 1000, 100000]) {
      assert.ok(summaryMaxTokens(n) <= 4096, `batch ${n} must stay within 4096`);
    }
  });

  it('scales with the batch below the cap', () => {
    assert.equal(summaryMaxTokens(1), 256);
    assert.equal(summaryMaxTokens(10), 2560);
    assert.equal(summaryMaxTokens(15), 3840);
  });

  // The headroom is the point: truncation yields `null` summaries for the tail
  // symbols, which `summariseBatch` folds into its `summarised=X/Y` log without
  // failing the run — silent data loss in the arch-memory index. 1146 is the
  // HIGHEST of the four measured 10-symbol runs.
  // 1308 is the highest of FIVE measured 10-symbol runs. The 5th run exceeded
  // the previous maximum of 1146 by 14%, so this pins the budget against the
  // worst OBSERVED value with deliberate slack — not against an average, and
  // not against a figure a further sample would plausibly beat.
  it('leaves real headroom over the measured worst case', () => {
    const measuredWorstCaseFor10 = 1308;
    assert.ok(
      summaryMaxTokens(10) > measuredWorstCaseFor10 * 1.5,
      `want >50% headroom over the measured ${measuredWorstCaseFor10}, got ${summaryMaxTokens(10)}`,
    );
  });

  // Degenerate inputs must fail OPEN to the old constant, never to a tiny
  // ceiling that would truncate every answer.
  it('falls back to the full ceiling on a nonsensical batch length', () => {
    for (const bad of [0, -1, NaN, Infinity, undefined, null, 'ten']) {
      assert.equal(summaryMaxTokens(bad), 4096, `${String(bad)} must fail open`);
    }
  });

  it('rounds a fractional length up rather than truncating the budget', () => {
    assert.equal(summaryMaxTokens(2.5), 768);
  });
});

// ── truncation detection ────────────────────────────────────────────────────
//
// Raised by the round-1 audit (H1/H3/H5, all sustained) and correct: this
// change LOWERED the ceiling for small batches — at batch 10, 4096 -> 2560 —
// which makes truncation MORE likely than before, while `summariseBatch` read neither
// `stop_reason` nor the per-symbol count. Four samples do not establish that
// every batch fits.
//
// The defect being closed: a short list and a complete one left the parse as
// the same value, so a response the provider cut off produced `null` summaries
// indistinguishable from symbols the model declined to describe, and
// `summarised=X/Y` reported it without failing.
describe('assessBatchCompleteness', () => {
  it('a full list is complete', () => {
    const v = assessBatchCompleteness(['a', 'b', 'c'], 'end_turn');
    assert.deepEqual(v, { complete: true, missing: [], truncated: false });
  });

  it('names the MISSING 1-based indices, so the log can point at them', () => {
    const v = assessBatchCompleteness(['a', null, 'c', null], 'end_turn');
    assert.equal(v.complete, false);
    assert.deepEqual(v.missing, [2, 4]);
  });

  it('a truncated tail — the max_tokens case — is incomplete AND flagged truncated', () => {
    const v = assessBatchCompleteness(['a', 'b', null, null, null], 'max_tokens');
    assert.equal(v.complete, false);
    assert.equal(v.truncated, true);
    assert.deepEqual(v.missing, [3, 4, 5]);
  });

  // The two signals must be INDEPENDENT, and EITHER alone is disqualifying.
  it('a short list with stop_reason end_turn is STILL incomplete', () => {
    const v = assessBatchCompleteness(['a', null], 'end_turn');
    assert.equal(v.complete, false, 'a missing entry counts even when the provider claims it finished');
    assert.equal(v.truncated, false, 'and it is correctly NOT attributed to the ceiling');
  });

  // REVERSED after the round-2 audit (H1/H2, the same Silent-Data-Loss concern
  // raised a second time — correctly). The first version of this test asserted
  // that a full slate of entries CLEARED a `max_tokens` stop, which locked the
  // defect into the test as well as the implementation: a summary can be cut
  // mid-sentence and still be a non-empty string, so "every slot filled" is not
  // evidence that every slot is FINISHED.
  it('stop_reason max_tokens is incomplete EVEN with every entry present', () => {
    const v = assessBatchCompleteness(['a', 'b'], 'max_tokens');
    assert.equal(v.complete, false,
      'the last entry may be cut mid-sentence — a filled slot is not a finished one');
    assert.deepEqual(v.missing, [], 'and nothing is mis-reported as missing: the slots ARE all present');
    assert.equal(v.truncated, true);
  });

  it('whitespace-only and empty summaries count as missing, not as answers', () => {
    const v = assessBatchCompleteness(['a', '', '   ', '\t'], 'end_turn');
    assert.deepEqual(v.missing, [2, 3, 4]);
  });

  it('a non-string entry counts as missing', () => {
    const v = assessBatchCompleteness(['a', undefined, 42, {}], 'end_turn');
    assert.deepEqual(v.missing, [2, 3, 4]);
  });

  // VACUOUS-PASS GUARD. An "expect complete" assertion is worthless if the
  // function cannot report incompleteness at all; these two prove the probe
  // can find what it must find, in both directions.
  it('a degenerate input is complete rather than throwing', () => {
    assert.deepEqual(assessBatchCompleteness([], 'end_turn'), { complete: true, missing: [], truncated: false });
    assert.equal(assessBatchCompleteness(null, undefined).complete, true);
  });

  it('every entry missing is reported as every index, not as an empty result', () => {
    const v = assessBatchCompleteness([null, null, null], 'max_tokens');
    assert.deepEqual(v.missing, [1, 2, 3]);
    assert.equal(v.complete, false);
  });

  // The two signals are reported SEPARATELY as well as folded into `complete`,
  // so a caller can tell "the model skipped entries" from "the provider cut us
  // off" — they have different remedies (reword the prompt vs raise the budget).
  it('distinguishes a skipped entry from a provider cut', () => {
    const skipped = assessBatchCompleteness(['a', null, 'c'], 'end_turn');
    const cut = assessBatchCompleteness(['a', 'b', 'c'], 'max_tokens');
    assert.equal(skipped.complete, false);
    assert.equal(cut.complete, false);
    assert.ok(skipped.missing.length > 0 && !skipped.truncated, 'skipped: named indices, not attributed to the ceiling');
    assert.ok(cut.missing.length === 0 && cut.truncated, 'cut: no missing indices, attributed to the ceiling');
  });
});

// ── the verdict must PROPAGATE, not be recomputed ───────────────────────────
//
// This concern was raised in three consecutive audit rounds, each time against
// the previous round's fix, because each fix patched one layer and left another
// computing its own answer:
//
//   R1: `summariseBatch` neither read `stop_reason` nor counted entries.
//   R2: `assessBatchCompleteness` judged it — but treated a full slate of
//       non-empty entries as clearing a `max_tokens` stop. A populated slot is
//       not a finished one.
//   R3: the verdict was correct and then DISCARDED — `summariseBatch` logged it
//       and returned only the strings, so `main()` re-derived `complete` from a
//       null count and emitted `complete: true` for exactly the case the
//       verdict existed to catch.
//
// The structural fix is the single-oracle rule: one producer, every consumer
// reads it.
//
// SCOPE, stated honestly after the round-4 audit corrected an overclaim here.
// These are UNIT tests of the oracle: they pin that a null-count cannot answer
// the completeness question, so any `complete` derived from one is wrong by
// construction. They do NOT exercise `summariseBatch` or `main()`, and
// therefore do NOT detect a caller that recomputes `complete` — reverting
// `main()` to the null count leaves every test in this file green, measured.
// The earlier version of this comment claimed otherwise, which made it a
// guard-shaped assertion about a layer it never touched.
//
// That layer is covered by `tests/symbol-index-summarise-propagation.test.mjs`,
// which drives the real CLI end to end; under the same revert it fails.
describe('completeness verdict propagation', () => {
  // The defining case, and the one all three rounds missed in turn: every slot
  // populated, so every null-count is zero, yet the batch is NOT complete.
  it('a full slate + max_tokens is incomplete while its missing-count is zero', () => {
    const v = assessBatchCompleteness(['a', 'b', 'c'], 'max_tokens');
    assert.equal(v.missing.length, 0, 'a null-count sees nothing wrong here');
    assert.equal(v.complete, false, 'and that is exactly why `complete` must not be derived from it');
  });

  // The generalisable guard: for every input, `missing.length === 0` must NOT
  // be a sound substitute for `complete`. If it ever becomes one, the
  // recomputation main() used to do would be correct again and the drift could
  // return unnoticed.
  it('`missing.length === 0` is NOT equivalent to `complete` — the two disagree', () => {
    const cases = [
      [['a', 'b'], 'max_tokens'],
      [['a', 'b'], 'end_turn'],
      [['a', null], 'end_turn'],
      [[null], 'max_tokens'],
      [[], 'end_turn'],
    ];
    const disagreements = cases.filter(([list, stop]) => {
      const v = assessBatchCompleteness(list, stop);
      return (v.missing.length === 0) !== v.complete;
    });
    assert.ok(
      disagreements.length > 0,
      'if a null-count ever agreed with the verdict on every input, nothing would stop a caller recomputing it',
    );
  });

  it('truncation is reported even when it costs no entries, so a caller can act on it', () => {
    const v = assessBatchCompleteness(['a', 'b'], 'max_tokens');
    assert.equal(v.truncated, true);
    assert.equal(v.complete, false);
    // Both facts are needed: `truncated` names the CAUSE (raise the budget),
    // `missing` names the SYMPTOM (which symbols to re-ask about). Collapsing
    // them into one boolean is what made the earlier logs misleading.
    assert.deepEqual(v.missing, []);
  });
});
