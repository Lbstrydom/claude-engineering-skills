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
      // docs/plans/stage0-evidence-relevance-split.md round-3 M1: the
      // decision-grade `comparedRuns` metric now additionally requires a
      // confirmed non-empty eligible population on BOTH sides.
      legacyEligibleCount: 2, tieredEligibleCount: 2, tieredStage0Verified: 2,
    };
    const records = Array.from({ length: WINDOW_MAX }, () => ({ legacyOk: true, shadowOk: true, comparison }));
    const summary = summarize(records);
    assert.equal(summary.comparedRuns, WINDOW_MAX);
    assert.equal(summary.historicalCompleteRuns, WINDOW_MAX);
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
    const complete = { legacyCostUsd: 1, tieredCostUsd: 0.5, legacyLatencySec: 10, tieredLatencySec: 5, overlapCount: 1, legacyFindingCount: 1, onlyTieredCount: 0, tieredRunStatus: 'complete', legacyEligibleCount: 1, tieredEligibleCount: 1, tieredStage0Verified: 1 };
    const fallback = { legacyCostUsd: 1, tieredCostUsd: null, legacyLatencySec: 10, tieredLatencySec: 9, overlapCount: 0, legacyFindingCount: 1, onlyTieredCount: 0, tieredRunStatus: 'fallback_legacy', tieredFallbackReason: 'oss_provider_unavailable' };
    const records = [
      { legacyOk: true, shadowOk: true, comparison: complete },
      { legacyOk: true, shadowOk: true, comparison: fallback },
      { legacyOk: true, shadowOk: true, comparison: fallback },
    ];
    const summary = summarize(records);
    assert.equal(summary.comparedRuns, 1);
    assert.equal(summary.excludedFallback, 2);
    assert.deepEqual(summary.tieredRunStatusCounts, { complete: 1, fallback_legacy: 2 });
    assert.deepEqual(summary.tieredFallbackReasons, { oss_provider_unavailable: 2 });
  });
});

// docs/plans/stage0-evidence-relevance-split.md round-3 plan-audit M1: the
// two-metric split. `historicalCompleteRuns` preserves the PRE-EXISTING
// meaning exactly (so old rows are neither deleted nor hidden);
// `comparedRuns` is the new, stricter, Phase-14-decision-grade metric that
// old-shape rows can never satisfy. The plan explicitly requires a test
// asserting these two do NOT agree on an old-shape row.
describe('two-metric window readiness — historicalCompleteRuns vs comparedRuns', () => {
  const OLD_SHAPE = {
    legacyCostUsd: 1, tieredCostUsd: 0.5, legacyLatencySec: 10, tieredLatencySec: 5,
    overlapCount: 2, legacyFindingCount: 2, onlyTieredCount: 0, tieredRunStatus: 'complete',
    // No legacyEligibleCount / tieredEligibleCount / tieredStage0Verified —
    // exactly the pre-migration row shape.
  };

  test('an old-shape `complete` row counts toward historicalCompleteRuns but is EXCLUDED from comparedRuns', () => {
    const summary = summarize([{ legacyOk: true, shadowOk: true, comparison: OLD_SHAPE }]);
    assert.equal(summary.historicalCompleteRuns, 1, 'the pre-existing metric must be unaffected by this plan');
    assert.equal(summary.comparedRuns, 0, 'a null/absent eligible count is insufficient data, never "zero population confirmed"');
    assert.equal(summary.excludedDegenerateComparison, 1);
    assert.equal(summary.excludedNoStage0Evidence, 0, 'an old-shape row has no stage0Verified signal at all — it is degenerate, not no-evidence');
  });

  test('15 old-shape rows never satisfy the window, even though historicalCompleteRuns reads 15', () => {
    const records = Array.from({ length: WINDOW_MAX }, () => ({ legacyOk: true, shadowOk: true, comparison: OLD_SHAPE }));
    const summary = summarize(records);
    assert.equal(summary.historicalCompleteRuns, WINDOW_MAX);
    assert.equal(summary.comparedRuns, 0);
    assert.equal(windowProgress(summary.comparedRuns).met, false, 'the old 15/15 reading must not resurrect under the new metric');
  });

  // The `||` correction (2026-07-16, found via a cross-session review of the
  // in-flight `&&` guard): one-sided runs are the HIGHEST-signal comparisons
  // — legacy-found-tiered-missed is a recall failure, tiered-found-legacy-
  // missed is tiered's value-add. The original symmetric `&&` silently
  // dropped both, inflating the surviving overlap rate toward a false
  // "flip it" (a selection bias in the dangerous direction).
  test('legacy found findings, tiered verified nothing → COUNTS as a comparison (recall-failure signal, not an artifact)', () => {
    const tieredMissedAll = { ...OLD_SHAPE, legacyFindingCount: 5, overlapCount: 0, onlyTieredCount: 0, legacyEligibleCount: 5, tieredEligibleCount: 0, tieredStage0Verified: 0 };
    const summary = summarize([{ legacyOk: true, shadowOk: true, comparison: tieredMissedAll }]);
    assert.equal(summary.comparedRuns, 1, 'a one-sided zero is exactly the run the Phase-14 decision needs');
    assert.equal(summary.findingOverlapRate.mean, 0, 'and it contributes an honest 0% overlap, not an exclusion');
  });

  test('tiered found findings legacy missed → COUNTS as a comparison (tiered value-add signal)', () => {
    const tieredOnly = { ...OLD_SHAPE, legacyFindingCount: 0, overlapCount: 0, onlyTieredCount: 3, legacyEligibleCount: 0, tieredEligibleCount: 3, tieredStage0Verified: 3 };
    const summary = summarize([{ legacyOk: true, shadowOk: true, comparison: tieredOnly }]);
    assert.equal(summary.comparedRuns, 1);
  });

  test('BOTH sides empty AND stage0Verified:0 → excludedNoStage0Evidence, distinct from degenerate', () => {
    const noEvidence = { ...OLD_SHAPE, legacyFindingCount: 0, overlapCount: 0, onlyTieredCount: 0, legacyEligibleCount: 0, tieredEligibleCount: 0, tieredStage0Verified: 0 };
    const summary = summarize([{ legacyOk: true, shadowOk: true, comparison: noEvidence }]);
    assert.equal(summary.historicalCompleteRuns, 1);
    assert.equal(summary.comparedRuns, 0, 'a both-sides-empty run carries no recall information');
    assert.equal(summary.excludedNoStage0Evidence, 1);
    assert.equal(summary.excludedDegenerateComparison, 0);
  });

  test('BOTH sides empty but Stage 0 HAD verified evidence (Stage 1/2 dismissed everything) → degenerate, not no-evidence', () => {
    const degenerate = { ...OLD_SHAPE, legacyFindingCount: 0, overlapCount: 0, onlyTieredCount: 0, legacyEligibleCount: 0, tieredEligibleCount: 0, tieredStage0Verified: 4 };
    const summary = summarize([{ legacyOk: true, shadowOk: true, comparison: degenerate }]);
    assert.equal(summary.comparedRuns, 0);
    assert.equal(summary.excludedDegenerateComparison, 1);
    assert.equal(summary.excludedNoStage0Evidence, 0);
  });

  test('the three exclusion reasons are reported separately, never collapsed into one count', () => {
    const good = { ...OLD_SHAPE, legacyEligibleCount: 2, tieredEligibleCount: 2, tieredStage0Verified: 2 };
    const noEvidence = { ...OLD_SHAPE, legacyFindingCount: 0, overlapCount: 0, onlyTieredCount: 0, legacyEligibleCount: 0, tieredEligibleCount: 0, tieredStage0Verified: 0 };
    const fallback = { ...OLD_SHAPE, tieredRunStatus: 'fallback_legacy', tieredFallbackReason: 'oss_provider_unavailable' };
    const summary = summarize([
      { legacyOk: true, shadowOk: true, comparison: good },
      { legacyOk: true, shadowOk: true, comparison: noEvidence },
      { legacyOk: true, shadowOk: true, comparison: OLD_SHAPE },
      { legacyOk: true, shadowOk: true, comparison: fallback },
    ]);
    assert.equal(summary.totalRuns, 4);
    assert.equal(summary.historicalCompleteRuns, 3, 'the 3 `complete` rows — the fallback is not complete');
    assert.equal(summary.comparedRuns, 1, 'only the fully-populated row is decision-grade');
    assert.equal(summary.excludedNoStage0Evidence, 1);
    assert.equal(summary.excludedDegenerateComparison, 1, 'the old-shape row');
    assert.equal(summary.excludedFallback, 1);
  });
});
