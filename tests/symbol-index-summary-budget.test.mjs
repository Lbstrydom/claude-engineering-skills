/**
 * `summaryMaxTokens` — the summariser's output ceiling as a function of the
 * request, replacing a flat `max_tokens: 4096` on a one-line-per-symbol call.
 *
 * Measured 2026-11-14 (docs/plans/anthropic-cli-faithfulness-routing.md §6.A):
 * ~102 output tokens/symbol, 4 runs of a 10-symbol batch on
 * `claude-haiku-5-5` (916 / 943 / 991 / 1146 tokens). The ceiling never bound.
 *
 * @module tests/symbol-index-summary-budget
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { summaryMaxTokens } from '../scripts/symbol-index/summarise.mjs';

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
    assert.equal(summaryMaxTokens(1), 192);
    assert.equal(summaryMaxTokens(10), 1920);
    assert.equal(summaryMaxTokens(21), 4032);
  });

  // The headroom is the point: truncation yields `null` summaries for the tail
  // symbols, which `summariseBatch` folds into its `summarised=X/Y` log without
  // failing the run — silent data loss in the arch-memory index. 1146 is the
  // HIGHEST of the four measured 10-symbol runs.
  it('leaves real headroom over the measured worst case', () => {
    const measuredWorstCaseFor10 = 1146;
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
    assert.equal(summaryMaxTokens(2.5), 576);
  });
});
