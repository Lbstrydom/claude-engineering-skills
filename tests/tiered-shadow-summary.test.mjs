/**
 * @fileoverview Tests for scripts/lib/audit/tiered-shadow-summary.mjs —
 * the pure aggregation lib extracted 2026-07-13 from tiered-shadow-report.mjs
 * so the dashboard collector doesn't depend on a CLI entry point. Focused
 * on windowProgress() (the H3 fix: gates on comparedRuns, not totalRuns)
 * and the shared WINDOW_MIN/MAX constants (the M2 fix).
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  windowProgress, WINDOW_MIN, WINDOW_MAX, summarize, TIERED_SHADOW_CONTRACT_EPOCH,
} from '../scripts/lib/audit/tiered-shadow-summary.mjs';

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
      contractEpoch: TIERED_SHADOW_CONTRACT_EPOCH,
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
    const complete = { contractEpoch: TIERED_SHADOW_CONTRACT_EPOCH, legacyCostUsd: 1, tieredCostUsd: 0.5, legacyLatencySec: 10, tieredLatencySec: 5, overlapCount: 1, legacyFindingCount: 1, onlyTieredCount: 0, tieredRunStatus: 'complete', legacyEligibleCount: 1, tieredEligibleCount: 1, tieredStage0Verified: 1 };
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
    // Stamped current-epoch on purpose: this block exercises the ELIGIBLE-COUNT
    // rule, so the epoch gate must not be what excludes these rows.
    contractEpoch: TIERED_SHADOW_CONTRACT_EPOCH,
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

// ── Contract-failure runs are not comparisons (evidence-anchor-path-contract §7c) ──
// THE anti-green test for this whole class. The measured reality this pins:
// stage0Verified > 0 in 1 of 62 "complete" shadow runs, because our own schema
// rejected every candidate as `fabricated`. Those runs reported as clean,
// complete, zero-finding comparisons — the FOURTH false-green this metric has
// produced. A run our contract broke is OUR bug, not a tiered-vs-legacy result.
describe('contract-failure runs (malformed anchors) are excluded and named (§7c)', () => {
  // Local fixture — the sibling block's OLD_SHAPE is scoped to its own describe.
  const BASE = {
    contractEpoch: TIERED_SHADOW_CONTRACT_EPOCH,
    legacyCostUsd: 1, tieredCostUsd: 0.5, legacyLatencySec: 10, tieredLatencySec: 5,
    overlapCount: 2, legacyFindingCount: 2, onlyTieredCount: 0, tieredRunStatus: 'complete',
  };

  test('a run whose candidates our own schema ate is NOT decision-grade, and says why', () => {
    // The exact 2026-07-17 shape: legacy found plenty, tiered verified nothing,
    // because Stage 0 rejected every candidate as malformed-by-our-schema.
    const contractFailure = {
      ...BASE,
      legacyFindingCount: 8, overlapCount: 0, onlyTieredCount: 0,
      legacyEligibleCount: 8, tieredEligibleCount: 0,
      tieredStage0Verified: 0, tieredStage0MalformedTripwire: 8,
    };
    const summary = summarize([{ legacyOk: true, shadowOk: true, comparison: contractFailure }]);
    assert.equal(summary.historicalCompleteRuns, 1, 'it IS a complete run — that is exactly the trap');
    assert.equal(summary.comparedRuns, 0, 'but it is NOT a comparison: our schema, not the model, emptied the tiered side');
    assert.equal(summary.excludedMalformedAnchors, 1, 'and it is named as OUR contract bug');
  });

  test('without the split it would have counted — the one-sided legacy population makes it look like a real recall failure', () => {
    // Same row, minus the new field (i.e. the pre-fix world). The `||`
    // population rule accepts it on legacy's 8 findings alone, so it counts as
    // a legitimate 0%-overlap comparison — attributing our bug to tiered's
    // recall. This is the regression this test exists to prevent.
    const { tieredStage0MalformedTripwire, ...preFix } = {
      ...BASE,
      legacyFindingCount: 8, overlapCount: 0, onlyTieredCount: 0,
      legacyEligibleCount: 8, tieredEligibleCount: 0,
      tieredStage0Verified: 0, tieredStage0MalformedTripwire: 8,
    };
    const summary = summarize([{ legacyOk: true, shadowOk: true, comparison: preFix }]);
    assert.equal(summary.comparedRuns, 1, 'precondition: the pre-fix shape really does count');
    assert.equal(summary.excludedMalformedAnchors, 0);
  });

  test('absent field reads as insufficient data, NEVER as zero-malformed-confirmed (historical rows)', () => {
    // The 62 pre-existing rows have no such key. `undefined > 0` is false, so
    // truthiness would silently pass them — but the assertion that matters is
    // that they are not RE-classified: they keep their existing verdict.
    const historical = { ...BASE, legacyEligibleCount: 2, tieredEligibleCount: 2, tieredStage0Verified: 2 };
    assert.equal(historical.tieredStage0MalformedTripwire, undefined, 'precondition: historical rows lack the field');
    const summary = summarize([{ legacyOk: true, shadowOk: true, comparison: historical }]);
    assert.equal(summary.comparedRuns, 1, 'a healthy historical row must still count');
    assert.equal(summary.excludedMalformedAnchors, 0, 'absent is not a contract failure — it is no signal at all');
  });

  test('malformed > 0 but Stage 0 STILL verified some candidates → a real comparison, degraded not void', () => {
    // Partial contract breakage is not a void run: the verified candidates are
    // genuine evidence. Only a total wipe (verified === 0) voids the row —
    // otherwise we would discard real signal on a partial bug.
    const partial = {
      ...BASE, legacyEligibleCount: 3, tieredEligibleCount: 2,
      tieredStage0Verified: 2, tieredStage0MalformedTripwire: 1,
    };
    const summary = summarize([{ legacyOk: true, shadowOk: true, comparison: partial }]);
    assert.equal(summary.comparedRuns, 1);
    assert.equal(summary.excludedMalformedAnchors, 0);
  });

  // ── The V3 producer-boundary path (union-gate finding, 2026-07-17) ──────────
  // Under the enum contract, an our-schema rejection lands at prepareCandidates
  // as `discoveryMalformedRaw` and NEVER reaches the Stage-0 tripwire, so
  // `tieredStage0MalformedTripwire` is 0 by construction. Keying the exclusion
  // only on the tripwire left it DEAD for exactly the run it exists to catch.
  test('V3 vacuity: our enum ate every candidate at the producer boundary → EXCLUDED, tripwire is 0', () => {
    const v3ContractFailure = {
      ...BASE,
      legacyFindingCount: 8, overlapCount: 0, onlyTieredCount: 0,
      legacyEligibleCount: 8, tieredEligibleCount: 0,
      tieredStage0Verified: 0,
      tieredStage0MalformedTripwire: 0,   // 0 by construction on the V3 path
      tieredDiscoveryMalformedRaw: 8,     // the real "our schema ate it" signal
    };
    const summary = summarize([{ legacyOk: true, shadowOk: true, comparison: v3ContractFailure }]);
    assert.equal(summary.comparedRuns, 0, 'a run our own enum voided must NOT count as a recall comparison');
    assert.equal(summary.excludedMalformedAnchors, 1, 'and it is named — via the producer-boundary counter, not just the tripwire');
  });

  test('V3 partial: producer-boundary malformed but Stage 0 still verified some → real comparison', () => {
    const partial = {
      ...BASE, legacyEligibleCount: 3, tieredEligibleCount: 2,
      tieredStage0Verified: 2, tieredStage0MalformedTripwire: 0, tieredDiscoveryMalformedRaw: 1,
    };
    const summary = summarize([{ legacyOk: true, shadowOk: true, comparison: partial }]);
    assert.equal(summary.comparedRuns, 1, 'verified candidates are genuine evidence — only a total wipe voids');
    assert.equal(summary.excludedMalformedAnchors, 0);
  });

  test('absent tieredDiscoveryMalformedRaw (historical row) is insufficient data, never a contract failure', () => {
    const historical = {
      ...BASE, legacyEligibleCount: 2, tieredEligibleCount: 2, tieredStage0Verified: 2,
    };
    assert.equal(historical.tieredDiscoveryMalformedRaw, undefined, 'precondition');
    const summary = summarize([{ legacyOk: true, shadowOk: true, comparison: historical }]);
    assert.equal(summary.comparedRuns, 1);
    assert.equal(summary.excludedMalformedAnchors, 0);
  });
});

// ── Measurement-contract epoch — the general anti-false-"met" gate ─────────
// The FIFTH false "window met" (2026-07-26) was not a new defect class: the
// report read 19 compared runs, of which 11 predated the 2026-07-22
// overlap+cost fix and carried `tieredCostUsd:0`/`legacyCostUsd:null`. Every
// prior guard was retrospective (it described the defect just found), so a row
// measured under a superseded contract was excluded only if it happened to trip
// one of them. The epoch gate is the non-retrospective one.
describe('measurement-contract epoch (the general false-"met" gate)', () => {
  const CURRENT = {
    contractEpoch: TIERED_SHADOW_CONTRACT_EPOCH,
    legacyCostUsd: 1, tieredCostUsd: 0.5, legacyLatencySec: 10, tieredLatencySec: 5,
    overlapCount: 2, legacyFindingCount: 2, onlyTieredCount: 0, tieredRunStatus: 'complete',
    legacyEligibleCount: 2, tieredEligibleCount: 2, tieredStage0Verified: 2,
  };

  test('an UNSTAMPED row is ineligible — absent is never "assume current"', () => {
    const { contractEpoch, ...unstamped } = CURRENT;
    assert.equal(unstamped.contractEpoch, undefined, 'precondition: pre-stamping row shape');
    const summary = summarize([{ legacyOk: true, shadowOk: true, comparison: unstamped }]);
    assert.equal(summary.historicalCompleteRuns, 1, 'it is still a complete run — not hidden');
    assert.equal(summary.comparedRuns, 0, 'but not decision-grade under a contract it was not measured by');
    assert.equal(summary.excludedStaleEpoch, 1);
  });

  test('a row stamped with a SUPERSEDED epoch is ineligible', () => {
    const stale = { ...CURRENT, contractEpoch: 'v3-overlap-cost-2026-07-22' };
    const summary = summarize([{ legacyOk: true, shadowOk: true, comparison: stale }]);
    assert.equal(summary.comparedRuns, 0);
    assert.equal(summary.excludedStaleEpoch, 1);
  });

  // The exact 2026-07-26 reading, reproduced: enough rows to trip the window,
  // all otherwise-healthy, none stamped. This is the regression that matters.
  test('15 healthy-but-unstamped rows do NOT satisfy the window (the 2026-07-26 false "met")', () => {
    const { contractEpoch, ...unstamped } = CURRENT;
    const records = Array.from({ length: WINDOW_MAX }, () => ({ legacyOk: true, shadowOk: true, comparison: unstamped }));
    const summary = summarize(records);
    assert.equal(summary.historicalCompleteRuns, WINDOW_MAX, 'the wider metric still shows them');
    assert.equal(summary.comparedRuns, 0);
    assert.equal(windowProgress(summary.comparedRuns).met, false, 'a sixth false "met" must be unconstructable from stale rows');
  });

  test('current-epoch rows still count normally — the gate is not a blanket zero', () => {
    const records = Array.from({ length: WINDOW_MAX }, () => ({ legacyOk: true, shadowOk: true, comparison: CURRENT }));
    const summary = summarize(records);
    assert.equal(summary.comparedRuns, WINDOW_MAX);
    assert.equal(summary.excludedStaleEpoch, 0);
    assert.equal(windowProgress(summary.comparedRuns).met, true);
  });

  test('a mixed corpus counts only the current-epoch rows', () => {
    const { contractEpoch, ...unstamped } = CURRENT;
    const summary = summarize([
      { legacyOk: true, shadowOk: true, comparison: CURRENT },
      { legacyOk: true, shadowOk: true, comparison: CURRENT },
      { legacyOk: true, shadowOk: true, comparison: unstamped },
      { legacyOk: true, shadowOk: true, comparison: { ...CURRENT, contractEpoch: 'v3-overlap-cost-2026-07-22' } },
    ]);
    assert.equal(summary.comparedRuns, 2);
    assert.equal(summary.excludedStaleEpoch, 2);
    assert.equal(summary.historicalCompleteRuns, 4, 'all four are still visible as complete runs');
  });

  // Exclusion reasons must partition, or the CLI's printed total exceeds the
  // rows that exist — and "we changed the contract" gets misdiagnosed as "the
  // pipeline degenerated", which has the opposite response.
  test('a stale row is counted ONCE, as stale — not also as degenerate', () => {
    const staleAndDegenerate = {
      ...CURRENT, contractEpoch: 'v3-overlap-cost-2026-07-22',
      legacyEligibleCount: 0, tieredEligibleCount: 0, tieredStage0Verified: 4,
    };
    const summary = summarize([{ legacyOk: true, shadowOk: true, comparison: staleAndDegenerate }]);
    assert.equal(summary.excludedStaleEpoch, 1);
    assert.equal(summary.excludedDegenerateComparison, 0, 'no double-count: epoch takes precedence');
    assert.equal(summary.excludedNoStage0Evidence, 0);
  });

  // Guards the collector→reader contract itself. If the writer ever stops
  // stamping (or stamps a value the reader does not recognise), the window
  // silently reads 0 forever — a false NEGATIVE, which is the safe direction
  // but still needs to be attributable rather than mysterious.
  test('the collector stamps the same constant the verifier checks', async () => {
    const src = await import('node:fs').then((fs) =>
      fs.readFileSync('scripts/lib/audit/tiered-shadow-compare.mjs', 'utf8'));
    assert.match(src, /contractEpoch:\s*TIERED_SHADOW_CONTRACT_EPOCH/,
      'tiered-shadow-compare.mjs must stamp the epoch at write time — a reader-side date cutoff is retroactive relabelling');
    assert.match(src, /import\s*\{\s*TIERED_SHADOW_CONTRACT_EPOCH\s*\}/,
      'and it must import the SAME constant, never a copied string literal');
  });
});

// ── shadowFailureReasons — the live cause breakdown ───────────────────────
// docs/plans/shadow-no-legacy-fallback.md decision #4. The shadow no longer
// falls back, so tieredFallbackReasons goes quiet for NEW rows; without this
// breakdown the change would trade one silent-failure mode for another.
describe('shadowFailureReasons (no-legacy-fallback plan, decision #4)', () => {
  const failed = (shadowError) => ({ legacyOk: true, shadowOk: false, shadowError, comparison: null });

  test('groups live shadow failures by their reason', () => {
    const s = summarize([
      failed('required generator failed: glm: [timeout] aborted'),
      failed('required generator failed: glm: [timeout] aborted'),
      failed('required generator failed: sonnet: 529 overloaded'),
    ]);
    assert.deepEqual(s.shadowFailureReasons, {
      'required generator failed: glm: [timeout] aborted': 2,
      'required generator failed: sonnet: 529 overloaded': 1,
    });
    assert.equal(s.shadowFailures, 3);
  });

  // The load-bearing one. 19 of the 41 live fallback rows carry TWO generator
  // causes in one string; coarse bucketing would mis-attribute the majority.
  // Grouping by the raw string cannot: a multi-cause row is its own key.
  test('a MULTI-CAUSE reason is its own key — never mis-attributed to one class', () => {
    const multi = 'required generator failed: sonnet: response did not contain a report_findings tool call; glm: [timeout] aborted';
    const s = summarize([failed(multi), failed(multi), failed('required generator failed: glm: [timeout] aborted')]);
    assert.equal(s.shadowFailureReasons[multi], 2, 'the multi-cause string is one honest key');
    assert.equal(s.shadowFailureReasons['required generator failed: glm: [timeout] aborted'], 1,
      'and it is NOT merged into the single-cause glm bucket');
    assert.equal(Object.keys(s.shadowFailureReasons).length, 2);
  });

  test('a missing shadowError keys as "unknown" — mirroring the sibling reducer, never dropped', () => {
    const s = summarize([{ legacyOk: true, shadowOk: false, shadowError: null, comparison: null }]);
    assert.deepEqual(s.shadowFailureReasons, { unknown: 1 });
  });

  test('a harness bug and a provider outage are distinguishable by reason alone (no persisted flag needed)', () => {
    const s = summarize([
      failed('required generator failed: glm: [timeout] aborted'),
      failed("Cannot read properties of undefined (reading 'x')"),
    ]);
    const keys = Object.keys(s.shadowFailureReasons);
    assert.equal(keys.filter((k) => k.startsWith('required generator failed: ')).length, 1);
    assert.equal(keys.filter((k) => !k.startsWith('required generator failed: ')).length, 1);
  });

  test('a LEGACY failure is not a shadow failure — the existing partition is unchanged', () => {
    const s = summarize([{ legacyOk: false, shadowOk: false, shadowError: 'x', comparison: null }]);
    assert.equal(s.legacyFailures, 1);
    assert.equal(s.shadowFailures, 0, 'shadowFailures only counts runs where legacy succeeded');
    assert.deepEqual(s.shadowFailureReasons, {}, 'and its reason must not pollute the live breakdown');
  });

  // Mixed-corpus guard: 41 historical fallback_legacy rows must keep reporting
  // exactly as before, alongside new-shape unavailable rows.
  test('MIXED corpus: historical fallback_legacy rows still report under tieredFallbackReasons', () => {
    const historicalFallback = {
      legacyOk: true, shadowOk: true,
      comparison: {
        tieredRunStatus: 'fallback_legacy',
        tieredFallbackReason: 'required generator failed: glm: [egress-gate] refusing to send',
        legacyFindingCount: 3, onlyTieredCount: 0, overlapCount: 0,
      },
    };
    const s = summarize([historicalFallback, failed('required generator failed: glm: [timeout] aborted')]);
    // Old rows: unchanged reporting.
    assert.equal(s.excludedFallback, 1);
    assert.deepEqual(s.tieredFallbackReasons, {
      'required generator failed: glm: [egress-gate] refusing to send': 1,
    });
    // New rows: the live breakdown.
    assert.deepEqual(s.shadowFailureReasons, { 'required generator failed: glm: [timeout] aborted': 1 });
    // Neither is decision-grade, and neither ever was.
    assert.equal(s.comparedRuns, 0);
    assert.equal(s.totalRuns, 2);
  });
});
