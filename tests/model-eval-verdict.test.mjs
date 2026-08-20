/**
 * @fileoverview `verdict.mjs` — state machine correctness, incl. a
 * boundary-consistency check against `config/schema.mjs`'s
 * `parseThresholdConfig` (the schemas must agree on what a valid threshold
 * config looks like).
 *
 * Split out of `tests/model-eval-core.test.mjs` (Phase 5, plan:
 * comparison-tooling-consolidation.md, D3) — assertions moved verbatim.
 *
 * @module tests/model-eval-verdict
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { computeVerdict, VerdictInputSchema } from '../scripts/lib/model-eval/verdict.mjs';
import { parseThresholdConfig } from '../scripts/lib/model-eval/config/schema.mjs';

const routeEvidence = { judgeTier: 'C', lineageStatus: 'known', independenceEligible: true, lineageSource: 'catalog-verified' };

describe('verdict.mjs — state machine correctness (implementation H3/H4/H14 regression guard)', () => {
  test('oracle screen: failed floors never promotes to full', () => {
    const v = computeVerdict({
      mode: 'oracle', role: 'auditor', tier: 'screen', routeEvidence,
      candidateMetrics: { recall: 0.3, falsePositiveRate: 0.5, f1: 0.2 },
      sampleSize: 4, minSampleSize: 4, corpusVersion: 'v1',
      thresholds: { oracle: { minRecall: 0.7, maxFalsePositiveRate: 0.2 } },
    });
    assert.notEqual(v.nextAction, 'promote_to_full');
  });

  test('oracle screen: met floors promotes to full', () => {
    const v = computeVerdict({
      mode: 'oracle', role: 'auditor', tier: 'screen', routeEvidence,
      candidateMetrics: { recall: 0.9, falsePositiveRate: 0.1, f1: 0.9 },
      sampleSize: 4, minSampleSize: 4, corpusVersion: 'v1',
      thresholds: { oracle: { minRecall: 0.7, maxFalsePositiveRate: 0.2 } },
    });
    assert.equal(v.verdict, 'keep');
    assert.equal(v.nextAction, 'promote_to_full');
  });

  test('sampleSize below minSampleSize forces inconclusive regardless of metrics', () => {
    const v = computeVerdict({
      mode: 'oracle', role: 'auditor', tier: 'screen', routeEvidence,
      candidateMetrics: { recall: 0.99, falsePositiveRate: 0.01, f1: 0.99 },
      sampleSize: 1, minSampleSize: 4, corpusVersion: 'v1',
      thresholds: { oracle: { minRecall: 0.7, maxFalsePositiveRate: 0.2 } },
    });
    assert.equal(v.verdict, 'inconclusive');
  });

  test('oracle mode structurally cannot reach verdict:switch', () => {
    const v = computeVerdict({
      mode: 'oracle', role: 'adjudicator', tier: 'promotion', routeEvidence,
      candidateMetrics: { recall: 0.99, falsePositiveRate: 0.01, f1: 0.99 },
      sampleSize: 30, minSampleSize: 30, corpusVersion: 'v1',
      thresholds: { oracle: { minF1: 0.9 } },
    });
    assert.notEqual(v.verdict, 'switch');
  });

  test('comparative: zero-baseline FPR regression fails, never silently passes as ratio=1', () => {
    const comparisonEvidence = {
      candidateRoute: { judgeTier: 'A', lineageStatus: 'known', independenceEligible: true, lineageSource: 'catalog-verified' },
      baselineRoute: { judgeTier: 'A', lineageStatus: 'known', independenceEligible: true, lineageSource: 'catalog-verified' },
      // No judge supplied → computedJudgeTier is naturally 'C' (matches what
      // resolveEvaluationTier would actually derive here; round-7 H4's
      // cross-validation now rejects a non-C tier claim with a null judgeRoute).
      judgeRoute: null, computedJudgeTier: 'C',
      independenceChecks: { candidateVsBaseline: true, candidateVsJudge: null, baselineVsJudge: null },
    };
    const v = computeVerdict({
      mode: 'comparative', role: 'auditor', tier: 'promotion', comparisonEvidence,
      candidateMetrics: { recall: 0.9, falsePositiveRate: 0.1, f1: 0.9 },
      baselineMetrics: { recall: 0.9, falsePositiveRate: 0, f1: 0.9 },
      sampleSize: 8, minSampleSize: 8,
      costDelta: { candidateCostUsd: 1, baselineCostUsd: 10 },
      thresholds: { comparative: { maxFalsePositiveRatioVsBaseline: 1.15, minRecallRatioVsBaseline: 1.0, switchIfCostPerKdImprovesByPct: 20 }, allowUnpricedPromotion: false },
    });
    assert.notEqual(v.verdict, 'switch');
  });

  test('threshold referencing a missing metric throws (fail-closed, never silently 0)', () => {
    assert.throws(() => computeVerdict({
      mode: 'oracle', role: 'auditor', tier: 'screen', routeEvidence,
      candidateMetrics: { recall: 0.9 }, // falsePositiveRate deliberately absent
      sampleSize: 4, minSampleSize: 4, corpusVersion: 'v1',
      thresholds: { oracle: { maxFalsePositiveRate: 0.2 } },
    }));
  });

  test('switch IS reachable through a fully-trusted (catalog-verified) independent triple — positive control for the round-11 gating fix', () => {
    const trustedRoute = { judgeTier: 'A', lineageStatus: 'known', independenceEligible: true, lineageSource: 'catalog-verified' };
    const comparisonEvidence = {
      candidateRoute: trustedRoute, baselineRoute: trustedRoute, judgeRoute: trustedRoute,
      computedJudgeTier: 'A',
      independenceChecks: { candidateVsBaseline: true, candidateVsJudge: true, baselineVsJudge: true },
    };
    const v = computeVerdict({
      mode: 'comparative', role: 'auditor', tier: 'promotion', comparisonEvidence,
      candidateMetrics: { recall: 0.95, falsePositiveRate: 0.05, f1: 0.95 },
      baselineMetrics: { recall: 0.9, falsePositiveRate: 0.1, f1: 0.9 },
      sampleSize: 8, minSampleSize: 8,
      costDelta: { candidateCostUsd: 1, baselineCostUsd: 10 },
      thresholds: { comparative: { minRecallRatioVsBaseline: 1.0, maxFalsePositiveRatioVsBaseline: 1.15, switchIfCostPerKdImprovesByPct: 20 } },
    });
    assert.equal(v.verdict, 'switch');
  });

  test('an operator-attested (or provenance-less) route caps at Tier C and blocks switch, even with met floors + cost improvement (round-11 H5/H8/M5/H9 regression guard)', () => {
    const trustedRoute = { judgeTier: 'A', lineageStatus: 'known', independenceEligible: true, lineageSource: 'catalog-verified' };
    const attestedRoute = { judgeTier: 'A', lineageStatus: 'known', independenceEligible: true, lineageSource: 'operator-attested' };
    const base = {
      mode: 'comparative', role: 'auditor', tier: 'promotion',
      candidateMetrics: { recall: 0.95, falsePositiveRate: 0.05, f1: 0.95 },
      baselineMetrics: { recall: 0.9, falsePositiveRate: 0.1, f1: 0.9 },
      sampleSize: 8, minSampleSize: 8,
      costDelta: { candidateCostUsd: 1, baselineCostUsd: 10 },
      thresholds: { comparative: { minRecallRatioVsBaseline: 1.0, maxFalsePositiveRatioVsBaseline: 1.15, switchIfCostPerKdImprovesByPct: 20 } },
    };
    const comparisonEvidence = {
      candidateRoute: attestedRoute, baselineRoute: trustedRoute, judgeRoute: trustedRoute,
      computedJudgeTier: 'A',
      independenceChecks: { candidateVsBaseline: true, candidateVsJudge: true, baselineVsJudge: true },
    };
    const v = computeVerdict({ ...base, comparisonEvidence });
    assert.equal(v.verdict, 'manual_review_required');

    // Round-13 M1/M5 fix — lineageSource is now REQUIRED at the schema
    // level (was optional + functionally fail-closed); a route with no
    // provenance at all is rejected outright, not silently downgraded.
    const noProvenanceRoute = { judgeTier: 'A', lineageStatus: 'known', independenceEligible: true };
    assert.throws(() => computeVerdict({ ...base, comparisonEvidence: { ...comparisonEvidence, candidateRoute: noProvenanceRoute } }));

    // Explicit acknowledgement overrides the cap.
    const v3 = computeVerdict({ ...base, comparisonEvidence, acknowledgeOperatorAttestedLineage: true });
    assert.equal(v3.verdict, 'switch');
  });

  test('a threshold sub-object with zero floor keys throws instead of vacuously passing (round-6 H1 regression guard)', () => {
    assert.throws(() => computeVerdict({
      mode: 'oracle', role: 'auditor', tier: 'screen', routeEvidence,
      candidateMetrics: { recall: 0.0, falsePositiveRate: 1.0, f1: 0.0 },
      sampleSize: 4, minSampleSize: 4, corpusVersion: 'v1',
      thresholds: { oracle: {} }, // no floor keys declared at all
    }), /declares no floor keys/);
  });

  test('self-contradictory route evidence is rejected at the schema boundary (round-6 H5 regression guard)', () => {
    const contradictory = { judgeTier: 'A', lineageStatus: 'unknown', independenceEligible: false, lineageSource: 'operator-attested' };
    const r = VerdictInputSchema.safeParse({
      mode: 'oracle', role: 'auditor', tier: 'screen', routeEvidence: contradictory,
      candidateMetrics: { recall: 0.9, falsePositiveRate: 0.1, f1: 0.9 },
      sampleSize: 4, minSampleSize: 4, corpusVersion: 'v1',
      thresholds: { oracle: { minRecall: 0.7 } },
    });
    assert.equal(r.success, false);
  });

  test('a negative or non-finite costDelta is rejected (round-7 H2 regression guard)', () => {
    const comparisonEvidence = {
      candidateRoute: { judgeTier: 'C', lineageStatus: 'unknown', independenceEligible: false, lineageSource: 'operator-attested' },
      baselineRoute: { judgeTier: 'C', lineageStatus: 'unknown', independenceEligible: false, lineageSource: 'operator-attested' },
      judgeRoute: null, computedJudgeTier: 'C',
      independenceChecks: { candidateVsBaseline: false, candidateVsJudge: null, baselineVsJudge: null },
    };
    const base = {
      mode: 'comparative', role: 'auditor', tier: 'promotion', comparisonEvidence,
      candidateMetrics: { recall: 0.9, falsePositiveRate: 0.1, f1: 0.9 },
      baselineMetrics: { recall: 0.9, falsePositiveRate: 0.1, f1: 0.9 },
      sampleSize: 8, minSampleSize: 8,
      thresholds: { comparative: { minRecallRatioVsBaseline: 1.0 } },
    };
    assert.equal(VerdictInputSchema.safeParse({ ...base, costDelta: { candidateCostUsd: -1, baselineCostUsd: 10 } }).success, false);
    assert.equal(VerdictInputSchema.safeParse({ ...base, costDelta: { candidateCostUsd: Infinity, baselineCostUsd: 10 } }).success, false);
  });

  test('a top-level computedJudgeTier contradicting independenceChecks/judgeRoute is rejected (round-7 H4 regression guard)', () => {
    const contradictory = {
      candidateRoute: { judgeTier: 'A', lineageStatus: 'known', independenceEligible: true, lineageSource: 'catalog-verified' },
      baselineRoute: { judgeTier: 'A', lineageStatus: 'known', independenceEligible: true, lineageSource: 'catalog-verified' },
      judgeRoute: null, computedJudgeTier: 'A', // claims Tier A with no judge at all
      independenceChecks: { candidateVsBaseline: true, candidateVsJudge: null, baselineVsJudge: null },
    };
    const r = VerdictInputSchema.safeParse({
      mode: 'comparative', role: 'auditor', tier: 'promotion', comparisonEvidence: contradictory,
      candidateMetrics: { recall: 0.9, falsePositiveRate: 0.1, f1: 0.9 },
      baselineMetrics: { recall: 0.9, falsePositiveRate: 0.1, f1: 0.9 },
      sampleSize: 8, minSampleSize: 8, costDelta: null,
      thresholds: { comparative: { minRecallRatioVsBaseline: 1.0 } },
    });
    assert.equal(r.success, false);
  });

  test('a zero-baseline higher-is-better ratio requires strict improvement, not a tie at zero (round-8 H3 regression guard)', () => {
    const comparisonEvidence = {
      candidateRoute: { judgeTier: 'C', lineageStatus: 'unknown', independenceEligible: false, lineageSource: 'operator-attested' },
      baselineRoute: { judgeTier: 'C', lineageStatus: 'unknown', independenceEligible: false, lineageSource: 'operator-attested' },
      judgeRoute: null, computedJudgeTier: 'C',
      independenceChecks: { candidateVsBaseline: false, candidateVsJudge: null, baselineVsJudge: null },
    };
    // Both candidate and baseline caught NOTHING (recall 0 vs 0) — this must
    // NOT satisfy a "recall ratio >= 1.0" floor; demonstrating zero
    // performance is not "meeting the floor."
    const v = computeVerdict({
      mode: 'comparative', role: 'auditor', tier: 'screen', comparisonEvidence,
      candidateMetrics: { recall: 0, falsePositiveRate: 0, f1: 0 },
      baselineMetrics: { recall: 0, falsePositiveRate: 0, f1: 0 },
      sampleSize: 4, minSampleSize: 4, costDelta: null,
      thresholds: { comparative: { minRecallRatioVsBaseline: 1.0 } },
    });
    assert.equal(v.nextAction, 'reject'); // screen tier: floorsMet false -> reject
  });

  test('an impossible ratio metric value (negative or >1) is rejected (round-12 H3 regression guard)', () => {
    const comparisonEvidence = {
      candidateRoute: { judgeTier: 'C', lineageStatus: 'unknown', independenceEligible: false, lineageSource: 'operator-attested' },
      baselineRoute: { judgeTier: 'C', lineageStatus: 'unknown', independenceEligible: false, lineageSource: 'operator-attested' },
      judgeRoute: null, computedJudgeTier: 'C',
      independenceChecks: { candidateVsBaseline: false, candidateVsJudge: null, baselineVsJudge: null },
    };
    const base = {
      mode: 'comparative', role: 'auditor', tier: 'promotion', comparisonEvidence,
      baselineMetrics: { recall: 0.9, falsePositiveRate: 0.1, f1: 0.9 },
      sampleSize: 8, minSampleSize: 8, costDelta: null,
      thresholds: { comparative: { minRecallRatioVsBaseline: 1.0 } },
    };
    assert.equal(VerdictInputSchema.safeParse({ ...base, candidateMetrics: { recall: -0.1, falsePositiveRate: 0.1, f1: 0.9 } }).success, false);
    assert.equal(VerdictInputSchema.safeParse({ ...base, candidateMetrics: { recall: 1.5, falsePositiveRate: 0.1, f1: 0.9 } }).success, false);
    assert.equal(VerdictInputSchema.safeParse({ ...base, candidateMetrics: { recall: 0.9, falsePositiveRate: 0.1, f1: 0.9 } }).success, true);
  });

  test('a non-finite recall-ratio threshold or metric is rejected (round-9 M1 regression guard)', () => {
    const comparisonEvidence = {
      candidateRoute: { judgeTier: 'C', lineageStatus: 'unknown', independenceEligible: false, lineageSource: 'operator-attested' },
      baselineRoute: { judgeTier: 'C', lineageStatus: 'unknown', independenceEligible: false, lineageSource: 'operator-attested' },
      judgeRoute: null, computedJudgeTier: 'C',
      independenceChecks: { candidateVsBaseline: false, candidateVsJudge: null, baselineVsJudge: null },
    };
    const base = {
      mode: 'comparative', role: 'auditor', tier: 'screen', comparisonEvidence,
      candidateMetrics: { recall: 0.9, falsePositiveRate: 0.1, f1: 0.9 },
      baselineMetrics: { recall: 0.9, falsePositiveRate: 0.1, f1: 0.9 },
      sampleSize: 4, minSampleSize: 4, costDelta: null,
    };
    // Infinity is technically ".positive()" but must still be rejected.
    assert.equal(VerdictInputSchema.safeParse({ ...base, thresholds: { comparative: { minRecallRatioVsBaseline: Infinity } } }).success, false);
    // A NaN/Infinity metric value must be rejected too.
    assert.equal(VerdictInputSchema.safeParse({
      ...base, candidateMetrics: { recall: Infinity, falsePositiveRate: 0.1, f1: 0.9 },
      thresholds: { comparative: { minRecallRatioVsBaseline: 1.0 } },
    }).success, false);
  });

  test('an unrecognized key on the top-level thresholds object is rejected (round-8b M3 regression guard)', () => {
    const r = VerdictInputSchema.safeParse({
      mode: 'oracle', role: 'auditor', tier: 'screen', routeEvidence,
      candidateMetrics: { recall: 0.9, falsePositiveRate: 0.1, f1: 0.9 },
      sampleSize: 4, minSampleSize: 4, corpusVersion: 'v1',
      thresholds: { oracle: { minRecall: 0.7 }, strayTopLevelKey: true },
    });
    assert.equal(r.success, false);
  });

  test('a forged computedJudgeTier that disagrees with candidateRoute.judgeTier is rejected, even with a fully-consistent independence triple (backlog-triage regression guard)', () => {
    // Every independenceChecks field is true and judgeRoute is non-null — the
    // pre-existing internal-consistency check (round-7 H4) has nothing to
    // object to here. The only thing wrong is that computedJudgeTier claims
    // 'A' while candidateRoute.judgeTier is 'B' — route-catalog.mjs's
    // resolveEvaluationTier can never produce that pair (it derives
    // computedJudgeTier as `candidateRoute.judgeTier === 'A' ? 'A' : 'B'`), so
    // this is a forged/stale value that must be refused at the schema
    // boundary, not silently trusted through to verdict logic.
    const forged = {
      candidateRoute: { judgeTier: 'B', lineageStatus: 'known', independenceEligible: true, lineageSource: 'catalog-verified' },
      baselineRoute: { judgeTier: 'A', lineageStatus: 'known', independenceEligible: true, lineageSource: 'catalog-verified' },
      judgeRoute: { judgeTier: 'A', lineageStatus: 'known', independenceEligible: true, lineageSource: 'catalog-verified' },
      computedJudgeTier: 'A', // forged — should have been 'B'
      independenceChecks: { candidateVsBaseline: true, candidateVsJudge: true, baselineVsJudge: true },
    };
    const r = VerdictInputSchema.safeParse({
      mode: 'comparative', role: 'auditor', tier: 'promotion', comparisonEvidence: forged,
      candidateMetrics: { recall: 0.9, falsePositiveRate: 0.1, f1: 0.9 },
      baselineMetrics: { recall: 0.9, falsePositiveRate: 0.1, f1: 0.9 },
      sampleSize: 8, minSampleSize: 8, costDelta: null,
      thresholds: { comparative: { minRecallRatioVsBaseline: 1.0 } },
    });
    assert.equal(r.success, false);

    // Positive control: the SAME triple with the correctly-derived tier ('B')
    // must still pass — proving the new check discriminates on the value,
    // not on the shape of the object.
    const honest = { ...forged, computedJudgeTier: 'B' };
    const r2 = VerdictInputSchema.safeParse({
      mode: 'comparative', role: 'auditor', tier: 'promotion', comparisonEvidence: honest,
      candidateMetrics: { recall: 0.9, falsePositiveRate: 0.1, f1: 0.9 },
      baselineMetrics: { recall: 0.9, falsePositiveRate: 0.1, f1: 0.9 },
      sampleSize: 8, minSampleSize: 8, costDelta: null,
      thresholds: { comparative: { minRecallRatioVsBaseline: 1.0 } },
    });
    assert.equal(r2.success, true);
  });

  test('a threshold sub-object with zero floor keys is rejected at CONFIG time too, not just runtime (round-7 M8 regression guard)', () => {
    const bad = {
      version: 1, role: 'auditor', calibrationNote: 'x',
      screen: { minSampleSize: 4, thresholds: { oracle: {} } },
      promotion: { minSampleSize: 8, thresholds: { oracle: { minRecall: 0.7 } } },
    };
    assert.equal(parseThresholdConfig(bad).ok, false);
  });
});
