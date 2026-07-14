/**
 * @fileoverview Tests for scripts/lib/audit/tiered-shadow-summary.mjs —
 * the pure aggregation lib extracted 2026-07-13 from tiered-shadow-report.mjs
 * so the dashboard collector doesn't depend on a CLI entry point. Focused
 * on windowProgress() (the H3 fix: gates on comparedRuns, not totalRuns)
 * and the shared WINDOW_MIN/MAX constants (the M2 fix).
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { windowProgress, WINDOW_MIN, WINDOW_MAX, summarize } from '../scripts/lib/audit/tiered-shadow-summary.mjs';

describe('windowProgress', () => {
  test('below the minimum: neither withinWindow nor met', () => {
    const w = windowProgress(WINDOW_MIN - 1);
    assert.equal(w.withinWindow, false);
    assert.equal(w.met, false);
  });

  test('within the window but below max: withinWindow true, met false', () => {
    const w = windowProgress(WINDOW_MIN);
    assert.equal(w.withinWindow, true);
    assert.equal(w.met, false);
  });

  test('at or above the max: both true', () => {
    assert.equal(windowProgress(WINDOW_MAX).met, true);
    assert.equal(windowProgress(WINDOW_MAX + 5).met, true);
  });

  test('exposes min/max so callers never hardcode the window', () => {
    const w = windowProgress(0);
    assert.equal(w.min, WINDOW_MIN);
    assert.equal(w.max, WINDOW_MAX);
  });
});

describe('windowProgress gates on comparedRuns, not totalRuns (H3 regression)', () => {
  test('15 attempted runs, all shadow-failed → 0 comparedRuns → window NOT met', () => {
    // Every run: legacy succeeded, shadow failed outright — no comparison object.
    const records = Array.from({ length: WINDOW_MAX }, () => ({ legacyOk: true, shadowOk: false, comparison: null }));
    const summary = summarize(records);
    assert.equal(summary.totalRuns, WINDOW_MAX);
    assert.equal(summary.comparedRuns, 0);
    assert.equal(summary.shadowFailures, WINDOW_MAX);
    const w = windowProgress(summary.comparedRuns);
    assert.equal(w.met, false, 'a pipeline that only ever fails must never read as decision-ready');
  });

  test('15 real comparisons → window met, matching comparedRuns', () => {
    const comparison = {
      legacyCostUsd: 1, tieredCostUsd: 0.5, legacyLatencySec: 10, tieredLatencySec: 5,
      overlapCount: 2, legacyFindingCount: 2, onlyTieredCount: 0, tieredRunStatus: 'complete',
    };
    const records = Array.from({ length: WINDOW_MAX }, () => ({ legacyOk: true, shadowOk: true, comparison }));
    const summary = summarize(records);
    assert.equal(summary.comparedRuns, WINDOW_MAX);
    assert.equal(windowProgress(summary.comparedRuns).met, true);
  });

  // 2026-07-14 incident: 20 real shadow runs across two repos ALL fell back
  // to legacy (a required discovery generator broke under CLAUDE_BACKEND=cli),
  // yet the report read "window met" because `compared = records.filter(r =>
  // r.comparison)` counted a fallback's non-null comparison object as a real
  // comparison. `comparison` exists whenever the shadow attempt didn't crash
  // outright — it does NOT mean the tiered pipeline actually completed.
  test('20 fallback_legacy "comparisons" → comparedRuns is 0, window NOT met (the exact 2026-07-14 incident)', () => {
    const fallbackComparison = {
      legacyCostUsd: 1, tieredCostUsd: null, legacyLatencySec: 10, tieredLatencySec: 9,
      overlapCount: 0, legacyFindingCount: 3, onlyTieredCount: 0,
      tieredRunStatus: 'fallback_legacy', tieredFallbackReason: 'required generator failed: sonnet: response did not contain a report_findings tool call',
    };
    const records = Array.from({ length: 20 }, () => ({ legacyOk: true, shadowOk: true, comparison: fallbackComparison }));
    const summary = summarize(records);
    assert.equal(summary.totalRuns, 20);
    assert.equal(summary.comparedRuns, 0, 'an all-fallback window must never read as decision-grade');
    assert.equal(windowProgress(summary.comparedRuns).met, false);
    assert.deepEqual(summary.tieredRunStatusCounts, { fallback_legacy: 20 }, 'the breakdown must still be visible even though comparedRuns is 0');
    assert.deepEqual(summary.tieredFallbackReasons, {
      'required generator failed: sonnet: response did not contain a report_findings tool call': 20,
    }, 'fallback reasons must surface so the cause is diagnosable without a live repro');
  });

  test('a mix of complete and fallback_legacy counts only the complete ones toward comparedRuns', () => {
    const complete = { legacyCostUsd: 1, tieredCostUsd: 0.5, legacyLatencySec: 10, tieredLatencySec: 5, overlapCount: 1, legacyFindingCount: 1, onlyTieredCount: 0, tieredRunStatus: 'complete' };
    const fallback = { legacyCostUsd: 1, tieredCostUsd: null, legacyLatencySec: 10, tieredLatencySec: 9, overlapCount: 0, legacyFindingCount: 1, onlyTieredCount: 0, tieredRunStatus: 'fallback_legacy', tieredFallbackReason: 'oss_provider_unavailable' };
    const records = [
      { legacyOk: true, shadowOk: true, comparison: complete },
      { legacyOk: true, shadowOk: true, comparison: fallback },
      { legacyOk: true, shadowOk: true, comparison: fallback },
    ];
    const summary = summarize(records);
    assert.equal(summary.comparedRuns, 1);
    assert.deepEqual(summary.tieredRunStatusCounts, { complete: 1, fallback_legacy: 2 });
    assert.deepEqual(summary.tieredFallbackReasons, { oss_provider_unavailable: 2 });
  });
});
