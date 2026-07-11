import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { computeVerdict, VerdictInputSchema } from '../scripts/lib/model-eval/verdict.mjs';
import { resolveCandidateRoute, resolveEvaluationTier, buildComparisonEvidenceFromRoutes, _internals as routeCatalogInternals } from '../scripts/lib/model-eval/route-catalog.mjs';
import { scoreBinaryClassification, scoreDefectLocalization } from '../scripts/lib/model-eval/deterministic-scorer.mjs';
import { assembleCostRows, buildUsageEvent, ModelEvalUsageEventSchema, CostRowSchema } from '../scripts/lib/model-eval/cost.mjs';
import { parseThresholdConfig } from '../scripts/lib/model-eval/config/schema.mjs';
import { OSS_POOL } from '../scripts/lib/model-resolver.mjs';
import { extractStructured, InvalidEvaluationInputError, AuditorExtractionSchema, AdjudicatorExtractionSchema, prepareModelEvalPayloadForEgress } from '../scripts/lib/model-eval/structured-extractor.mjs';
import { _internals as storeModelEvalInternals } from '../scripts/lib/store/model-eval.mjs';

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

  test('a threshold sub-object with zero floor keys is rejected at CONFIG time too, not just runtime (round-7 M8 regression guard)', () => {
    const bad = {
      version: 1, role: 'auditor', calibrationNote: 'x',
      screen: { minSampleSize: 4, thresholds: { oracle: {} } },
      promotion: { minSampleSize: 8, thresholds: { oracle: { minRecall: 0.7 } } },
    };
    assert.equal(parseThresholdConfig(bad).ok, false);
  });
});

describe('route-catalog.mjs — independence + fail-closed transport', () => {
  test('resolveEvaluationTier forces Tier C when judgeRoute is omitted, even with independent candidate/baseline (H4 regression guard)', () => {
    const candidate = resolveCandidateRoute({ role: 'auditor', candidateSpec: { kind: 'oss-role', role: 'reasoner' } });
    const baseline = resolveCandidateRoute({ role: 'auditor', candidateSpec: { kind: 'sentinel', value: 'latest-gpt' } });
    const tier = resolveEvaluationTier({ mode: 'comparative', candidateRoute: candidate, baselineRoute: baseline });
    assert.equal(tier.computedJudgeTier, 'C');
  });

  test('oss-role lineage is keyed on the resolved model, not the abstract role name (H5 regression guard)', () => {
    const coder = resolveCandidateRoute({ role: 'auditor', candidateSpec: { kind: 'oss-role', role: 'coder' } });
    const reasoner = resolveCandidateRoute({ role: 'auditor', candidateSpec: { kind: 'oss-role', role: 'reasoner' } });
    // Lineage must be derived from resolvedModel, so identical resolved
    // models would produce identical lineage regardless of role label.
    if (coder.resolvedModel === reasoner.resolvedModel) {
      assert.equal(coder.modelLineage, reasoner.modelLineage);
    } else {
      assert.notEqual(coder.modelLineage, reasoner.modelLineage);
    }
  });

  test('unknown lineage is not independence-eligible and does not get its own group', () => {
    const route = resolveCandidateRoute({ role: 'auditor', candidateSpec: { kind: 'oss-role', role: 'coder' } });
    assert.equal(route.lineageStatus === 'unknown' ? route.independenceEligible : true, route.lineageStatus === 'unknown' ? false : route.independenceEligible);
  });

  test('resolveEvaluationTier caps at C for same-lineage candidate/baseline', () => {
    const route = resolveCandidateRoute({ role: 'auditor', candidateSpec: { kind: 'sentinel', value: 'latest-gpt' } });
    const tier = resolveEvaluationTier({ mode: 'comparative', candidateRoute: route, baselineRoute: route });
    assert.equal(tier.computedJudgeTier, 'C');
  });

  test('unrecognized provider fails closed (never silently defaults transport)', async () => {
    const rc = await import('../scripts/lib/model-eval/route-catalog.mjs');
    assert.throws(() => rc._internals.transportForProvider('mystery-provider'));
  });

  test('invalid role is rejected', () => {
    assert.throws(() => resolveCandidateRoute({ role: 'not-a-role', candidateSpec: { kind: 'sentinel', value: 'latest-gpt' } }));
  });

  test('CandidateSpecSchema rejects a stale/misspelled key instead of silently stripping it (round-12 L1 regression guard)', () => {
    assert.throws(() => resolveCandidateRoute({ role: 'auditor', candidateSpec: { kind: 'sentinel', value: 'latest-gpt', extraStrayKey: true } }));
  });

  test('an OSS model on the reviewed OSS_POOL allowlist earns known/independence-eligible lineage (round-6 H2 regression guard)', () => {
    const route = resolveCandidateRoute({ role: 'auditor', candidateSpec: { kind: 'oss-role', role: 'coder' } });
    assert.equal(route.resolvedModel, OSS_POOL.coder[0]);
    assert.equal(route.lineageStatus, 'known');
    assert.equal(route.independenceEligible, true);
  });

  test('an env-overridden OSS model NOT on the reviewed allowlist fails closed to unknown lineage (round-6 H2 regression guard)', () => {
    const prior = process.env.OSS_CODER_MODEL;
    process.env.OSS_CODER_MODEL = 'some-vendor/mystery-proxy-model';
    try {
      const route = resolveCandidateRoute({ role: 'auditor', candidateSpec: { kind: 'oss-role', role: 'coder' } });
      assert.equal(route.resolvedModel, 'some-vendor/mystery-proxy-model');
      assert.equal(route.lineageStatus, 'unknown');
      assert.equal(route.independenceEligible, false);
      // Round-12 M2 fix — lineageSource must reflect the ACTUAL method (env
      // override outside the pool), not be hardcoded 'reviewed-pool'
      // regardless of whether the model is really in the pool.
      assert.notEqual(route.lineageSource, 'reviewed-pool');
    } finally {
      if (prior === undefined) delete process.env.OSS_CODER_MODEL; else process.env.OSS_CODER_MODEL = prior;
    }
  });

  test('an azure route resolving to google lineage fails closed at resolve time, not just at invocation (round-6 H3 regression guard)', () => {
    assert.throws(
      () => routeCatalogInternals.assertAzureTransportSupported('azure', 'google'),
      /no Azure-hosted Gemini transport exists/,
    );
    // Sibling azure lineages the harness DOES support must not be affected.
    assert.doesNotThrow(() => routeCatalogInternals.assertAzureTransportSupported('azure', 'openai'));
    assert.doesNotThrow(() => routeCatalogInternals.assertAzureTransportSupported('azure', 'anthropic'));
  });

  test('resolveCandidateRoute reports lineageSource distinctly per resolution method (round-8b H7 regression guard)', () => {
    const sentinelRoute = resolveCandidateRoute({ role: 'auditor', candidateSpec: { kind: 'sentinel', value: 'latest-gpt' } });
    assert.equal(sentinelRoute.lineageSource, 'catalog-verified');
    const ossRoute = resolveCandidateRoute({ role: 'auditor', candidateSpec: { kind: 'oss-role', role: 'coder' } });
    assert.equal(ossRoute.lineageSource, 'reviewed-pool');
  });

  test('lineageSource survives into the actual RouteEvidence used for verdict computation, not just the resolved route (round-10 M7 regression guard)', () => {
    const route = resolveCandidateRoute({ role: 'auditor', candidateSpec: { kind: 'oss-role', role: 'coder' } });
    const baseline = resolveCandidateRoute({ role: 'auditor', candidateSpec: { kind: 'sentinel', value: 'latest-gpt' } });
    const evidence = buildComparisonEvidenceFromRoutes({ candidateRoute: route, baselineRoute: baseline });
    assert.equal(evidence.candidateRoute.lineageSource, 'reviewed-pool');
    assert.equal(evidence.baselineRoute.lineageSource, 'catalog-verified');
  });

  test('buildComparisonEvidenceFromRoutes derives comparisonEvidence from real routes, never a hand-assembled independence claim (round-8b H4 regression guard)', () => {
    const candidate = resolveCandidateRoute({ role: 'auditor', candidateSpec: { kind: 'oss-role', role: 'reasoner' } });
    const baseline = resolveCandidateRoute({ role: 'auditor', candidateSpec: { kind: 'sentinel', value: 'latest-gpt' } });
    // No judge supplied -> must derive Tier C, matching resolveEvaluationTier's
    // own rule, not whatever a caller might have wished to assert.
    const evidence = buildComparisonEvidenceFromRoutes({ candidateRoute: candidate, baselineRoute: baseline });
    assert.equal(evidence.computedJudgeTier, 'C');
    assert.equal(evidence.judgeRoute, null);
    // The resulting object must itself pass verdict.mjs's own schema.
    const parsed = VerdictInputSchema.safeParse({
      mode: 'comparative', role: 'auditor', tier: 'screen', comparisonEvidence: evidence,
      candidateMetrics: { recall: 0.9, falsePositiveRate: 0.1, f1: 0.9 },
      baselineMetrics: { recall: 0.9, falsePositiveRate: 0.1, f1: 0.9 },
      sampleSize: 4, minSampleSize: 4, costDelta: null,
      thresholds: { comparative: { minRecallRatioVsBaseline: 1.0 } },
    });
    assert.equal(parsed.success, true);
  });

  test('MODEL_EVAL_ALLOWED_PROVIDERS restricts candidate resolution centrally, unset means unrestricted (round-9 H1/H8 regression guard)', () => {
    assert.throws(
      () => resolveCandidateRoute({ role: 'auditor', candidateSpec: { kind: 'sentinel', value: 'latest-gpt' }, env: { MODEL_EVAL_ALLOWED_PROVIDERS: 'anthropic' } }),
      /not in the approved candidate-provider catalog/,
    );
    const allowed = resolveCandidateRoute({ role: 'auditor', candidateSpec: { kind: 'sentinel', value: 'latest-gpt' }, env: { MODEL_EVAL_ALLOWED_PROVIDERS: 'openai,anthropic' } });
    assert.deepEqual(allowed.catalogPolicy, ['openai', 'anthropic']);
    const unrestricted = resolveCandidateRoute({ role: 'auditor', candidateSpec: { kind: 'sentinel', value: 'latest-gpt' } });
    assert.equal(unrestricted.catalogPolicy, null);
  });

  test('AzureRouteEntrySchema rejects a stale/misspelled route key instead of silently stripping it (round-7 M7 regression guard)', () => {
    const bad = {
      profile: 'foundry-gpt-audit-candidate', role: 'auditor',
      deploymentEnvVar: 'AZURE_MODEL_EVAL_AUDITOR_DEPLOYMENT',
      modelLineage: 'openai:gpt', lineageStatus: 'known',
      pricingModelSentinel: 'latest-gpt',
      extraStrayKey: true,
    };
    assert.equal(routeCatalogInternals.AzureRouteEntrySchema.safeParse(bad).success, false);
  });
});

describe('deterministic-scorer.mjs', () => {
  test('scoreBinaryClassification returns a numeric falsePositiveRate when false positives exist', () => {
    const r = scoreBinaryClassification(['true_positive', 'true_positive'], ['true_positive', 'false_positive']);
    assert.equal(typeof r.falsePositiveRate, 'number');
    assert.equal(r.falsePositiveRate, 1);
  });

  test('scoreDefectLocalization matching is order-independent', () => {
    const expected = [
      { files: ['src/a.js'], expectedFindingRubric: 'off by one in loop' },
      { files: ['src/b.js'], expectedFindingRubric: 'null pointer on empty array' },
    ];
    const forward = [
      { file: 'src/a.js', description: 'off by one in loop' },
      { file: 'src/b.js', description: 'null pointer on empty array' },
    ];
    const reversed = [...forward].reverse();
    const rf = scoreDefectLocalization(forward, expected);
    const rr = scoreDefectLocalization(reversed, expected);
    assert.equal(rf.correct, rr.correct);
    assert.equal(rf.correct, 2);
  });

  test('extra/hallucinated candidate outputs are counted, not free', () => {
    const expected = [{ files: ['src/a.js'], expectedFindingRubric: 'off by one in loop' }];
    const candidates = [
      { file: 'src/a.js', description: 'off by one in loop' },
      { file: 'src/z.js', description: 'totally made up defect' },
      { file: 'src/y.js', description: 'another made up defect' },
    ];
    const r = scoreDefectLocalization(candidates, expected);
    assert.equal(r.extraCount, 2);
    assert.ok(r.precision < 1);
  });

  test('an empty candidate/expected description does not score a "perfect" match (round-9 H6 regression guard)', () => {
    const expected = [{ files: ['src/a.js'], expectedFindingRubric: '' }];
    const candidates = [{ file: 'src/a.js', description: '' }];
    const r = scoreDefectLocalization(candidates, expected);
    assert.equal(r.correct, 0);
    // Same for whitespace-only, which normalize() also reduces to ''.
    const r2 = scoreDefectLocalization([{ file: 'src/a.js', description: '   ' }], [{ files: ['src/a.js'], expectedFindingRubric: '   ' }]);
    assert.equal(r2.correct, 0);
  });

  test('an unrecognized matchMode or out-of-bounds fuzzyConfig threshold throws instead of silently weakening the gate (round-9 M2 regression guard)', () => {
    const expected = [{ files: ['src/a.js'], expectedFindingRubric: 'x' }];
    const candidates = [{ file: 'src/a.js', description: 'x' }];
    assert.throws(() => scoreDefectLocalization(candidates, expected, { matchMode: 'eaxct' }), /matchMode must be/);
    assert.throws(() => scoreDefectLocalization(candidates, expected, { fuzzyConfig: { levenshteinRatioThreshold: 1.5 } }), /levenshteinRatioThreshold/);
  });

  test('an oversized candidateOutputs/expectedRubrics array is rejected at the algorithm boundary, not just the extraction-schema string length (round-12 M8 regression guard)', () => {
    const tooMany = Array.from({ length: 501 }, (_, i) => ({ file: `src/f${i}.js`, description: 'x' }));
    const expected = [{ files: ['src/a.js'], expectedFindingRubric: 'x' }];
    assert.throws(() => scoreDefectLocalization(tooMany, expected), /must each be <= 500/);
  });

  test('a malformed expectedRubrics.files (non-array) throws a clean validation error, not a raw TypeError from deep in the matching loop (round-14 M9 regression guard)', () => {
    const candidates = [{ file: 'src/a.js', description: 'x' }];
    const expected = [{ files: 'not-an-array', expectedFindingRubric: 'x' }];
    assert.throws(() => scoreDefectLocalization(candidates, expected), /expectedRubrics\[0\]\.files must be an array/);
  });

  test('an oversized expectedFindingRubric or candidate description (corpus side, not just extraction-schema-bounded output) is a NON-match, never silently truncated-and-compared (round-13 M2/M7, round-14 H4 regression guard)', () => {
    // Must not hang/crash on an oversized string, AND must not corrupt the
    // comparison by truncating-then-comparing (round-14 H4: two DIFFERENT
    // findings sharing a long identical prefix must not score as equal).
    const candidates = [{ file: 'src/a.js', description: 'x'.repeat(3000) }];
    const expectedSamePrefix = [{ files: ['src/a.js'], expectedFindingRubric: 'x'.repeat(2500) + 'DIFFERENT_SUFFIX' }];
    const r = scoreDefectLocalization(candidates, expectedSamePrefix, { matchMode: 'exact' });
    assert.equal(r.correct, 0); // oversized -> non-match, not a truncated false-positive equal
  });

  test('exact mode does not require a valid fuzzyConfig (which it never reads) (round-13 L1 regression guard)', () => {
    const expected = [{ files: ['src/a.js'], expectedFindingRubric: 'x' }];
    const candidates = [{ file: 'src/a.js', description: 'x' }];
    assert.doesNotThrow(() => scoreDefectLocalization(candidates, expected, { matchMode: 'exact', fuzzyConfig: {} }));
    assert.doesNotThrow(() => scoreDefectLocalization(candidates, expected, { matchMode: 'exact' }));
  });

  test('an unrecognized label throws instead of being silently coerced to a negative (round-6 M1 regression guard)', () => {
    assert.throws(
      () => scoreBinaryClassification(['true_positive', 'not_a_real_label'], ['true_positive', 'false_positive']),
      /not a recognized label/,
    );
    assert.throws(
      () => scoreBinaryClassification(['true_positive', 'false_positive'], ['true_positive', null]),
      /not a recognized label/,
    );
  });
});

describe('structured-extractor.mjs', () => {
  test('an unrecognized role is rejected instead of silently falling into the adjudicator branch (round-7 M5 regression guard)', async () => {
    await assert.rejects(
      () => extractStructured({ role: 'not-a-role', route: {}, rawContext: {} }),
      InvalidEvaluationInputError,
    );
  });

  test('a null/undefined rawContext raises a structured error, not a raw TypeError (round-8 M2/L1 regression guard)', async () => {
    await assert.rejects(() => extractStructured({ role: 'auditor', route: {}, rawContext: null }), InvalidEvaluationInputError);
    await assert.rejects(() => extractStructured({ role: 'auditor', route: {}, rawContext: undefined }), InvalidEvaluationInputError);
  });

  test('a sensitive file PATH (not just secret-shaped content) blocks egress (round-8b H2 regression guard)', () => {
    const sensitive = prepareModelEvalPayloadForEgress({
      route: { role: 'auditor' },
      visibleInput: { evidenceHunk: 'diff --git a/.env b/.env\n+FOO=bar', filePaths: ['.env'] },
    });
    assert.equal(sensitive.egressDecision, 'blocked');

    const clean = prepareModelEvalPayloadForEgress({
      route: { role: 'auditor' },
      visibleInput: { evidenceHunk: 'diff --git a/src/foo.js b/src/foo.js\n+const x = 1;', filePaths: ['src/foo.js'] },
    });
    assert.notEqual(clean.egressDecision, 'blocked');
  });

  test('a sensitive path mentioned only in the diff HEADERS (not the declared filePaths array) also blocks egress (round-9 H2/H9 regression guard)', () => {
    const r = prepareModelEvalPayloadForEgress({
      route: { role: 'auditor' },
      visibleInput: {
        evidenceHunk: 'diff --git a/.env b/.env\n--- a/.env\n+++ b/.env\n+SECRET=x',
        filePaths: ['src/unrelated.js'], // caller's declared list omits the sensitive path
      },
    });
    assert.equal(r.egressDecision, 'blocked');
  });

  test('a sensitive path in a quoted (C-style) diff header also blocks egress (round-11 H3/H6 regression guard)', () => {
    const r = prepareModelEvalPayloadForEgress({
      route: { role: 'auditor' },
      visibleInput: {
        evidenceHunk: 'diff --git "a/secrets/api keys.json" "b/secrets/api keys.json"\n--- "a/secrets/api keys.json"\n+++ "b/secrets/api keys.json"\n+{"key":"x"}',
        filePaths: ['src/unrelated.js'],
      },
    });
    assert.equal(r.egressDecision, 'blocked');
    const clean = prepareModelEvalPayloadForEgress({
      route: { role: 'auditor' },
      visibleInput: { evidenceHunk: 'diff --git "a/normal file.js" "b/normal file.js"\n+const x=1;', filePaths: ['src/unrelated.js'] },
    });
    assert.notEqual(clean.egressDecision, 'blocked');
  });

  test('a sensitive path mentioned only in adjudicator findingText prose also blocks egress (round-11 H7 regression guard)', () => {
    const r = prepareModelEvalPayloadForEgress({
      route: { role: 'adjudicator' },
      visibleInput: { findingText: 'the file .env has a hardcoded credential on line 3', severity: 'HIGH' },
    });
    assert.equal(r.egressDecision, 'blocked');
    const clean = prepareModelEvalPayloadForEgress({
      route: { role: 'adjudicator' },
      visibleInput: { findingText: 'the function foo() in src/utils.js has a null check bug', severity: 'MEDIUM' },
    });
    assert.notEqual(clean.egressDecision, 'blocked');
  });

  test('a sensitive path introduced only via a diff rename/copy header also blocks egress (round-10 M10 regression guard)', () => {
    const r = prepareModelEvalPayloadForEgress({
      route: { role: 'auditor' },
      visibleInput: {
        evidenceHunk: 'diff --git a/config.js b/.env\nsimilarity index 100%\nrename from config.js\nrename to .env',
        filePaths: ['config.js'],
      },
    });
    assert.equal(r.egressDecision, 'blocked');
  });

  test('prepareModelEvalPayloadForEgress rejects malformed input shapes at its own boundary instead of throwing a raw TypeError (round-10 M9 regression guard)', () => {
    assert.equal(prepareModelEvalPayloadForEgress({ route: { role: 'auditor' }, visibleInput: null }).egressDecision, 'blocked');
    assert.equal(prepareModelEvalPayloadForEgress({ route: { role: 'auditor' }, visibleInput: { evidenceHunk: 'x', filePaths: 'not-an-array' } }).egressDecision, 'blocked');
  });

  test('extraction schemas cap description/rationale length, bounding Levenshtein\'s worst-case cost (round-11 M3 regression guard)', () => {
    const tooLong = 'x'.repeat(2001);
    assert.equal(AuditorExtractionSchema.safeParse({ defectLocation: { file: 'a.js', description: tooLong } }).success, false);
    assert.equal(AdjudicatorExtractionSchema.safeParse({ verdict: 'true_positive', rationale: tooLong }).success, false);
    assert.equal(AuditorExtractionSchema.safeParse({ defectLocation: { file: 'a.js', description: 'x'.repeat(2000) } }).success, true);
  });

  test('extraction schemas reject empty-string fields as a vacuous-but-success-shaped response (round-8 H2 regression guard)', () => {
    assert.equal(AuditorExtractionSchema.safeParse({ defectLocation: { file: '', description: 'x' } }).success, false);
    assert.equal(AuditorExtractionSchema.safeParse({ defectLocation: { file: 'a.js', description: '' } }).success, false);
    assert.equal(AdjudicatorExtractionSchema.safeParse({ verdict: 'true_positive', rationale: '' }).success, false);
    assert.equal(AuditorExtractionSchema.safeParse({ defectLocation: { file: 'a.js', description: 'x' } }).success, true);
  });
});

describe('cost.mjs', () => {
  test('assembleCostRows never collapses events across different runs', () => {
    const eventA = buildUsageEvent({ runId: 'run-1', role: 'auditor', phase: 'generation', armId: null, candidateRef: 'cand-1', resolvedModel: 'gpt-5.5', pricingModel: 'gpt-5.5', deploymentId: null, provider: 'openai', usage: { input_tokens: 100, output_tokens: 50 } });
    const eventB = buildUsageEvent({ runId: 'run-2', role: 'auditor', phase: 'generation', armId: null, candidateRef: 'cand-1', resolvedModel: 'gpt-5.5', pricingModel: 'gpt-5.5', deploymentId: null, provider: 'openai', usage: { input_tokens: 100, output_tokens: 50 } });
    const rows = assembleCostRows([eventA, eventB]);
    assert.equal(rows.length, 2);
  });

  test('buildUsageEvent persists pricingModel on the returned event, not just resolvedModel (round-6 M2 regression guard)', () => {
    const event = buildUsageEvent({ runId: 'run-3', role: 'auditor', phase: 'generation', armId: null, candidateRef: 'cand-1', resolvedModel: 'azure-deployment-xyz', pricingModel: 'gpt-5.5', deploymentId: 'azure-deployment-xyz', provider: 'azure', usage: { input_tokens: 100, output_tokens: 50 } });
    assert.equal(event.pricingModel, 'gpt-5.5');
    assert.notEqual(event.pricingModel, event.resolvedModel);
  });

  test('a null/missing provider usage is tagged usageStatus:"missing" and never priced, not silently treated as zero cost (round-9 H11 regression guard)', () => {
    const event = buildUsageEvent({ runId: 'run-7', role: 'auditor', phase: 'generation', armId: null, candidateRef: 'cand-1', resolvedModel: 'gpt-5.5', pricingModel: 'gpt-5.5', deploymentId: null, provider: 'openai', usage: null });
    assert.equal(event.usageStatus, 'missing');
    assert.equal(event.costUsd, null);
    // A real, captured usage response still prices normally.
    const captured = buildUsageEvent({ runId: 'run-8', role: 'auditor', phase: 'generation', armId: null, candidateRef: 'cand-1', resolvedModel: 'gpt-5.5', pricingModel: 'gpt-5.5', deploymentId: null, provider: 'openai', usage: { input_tokens: 100, output_tokens: 50 } });
    assert.equal(captured.usageStatus, 'captured');
  });

  test('usageStatus:"missing" paired with a non-null costUsd is rejected at the schema boundary (round-9 H11 regression guard)', () => {
    const base = { runId: 'run-9', role: 'auditor', phase: 'generation', armId: null, candidateRef: 'cand-1', provider: 'openai', resolvedModel: 'gpt-5.5', pricingModel: 'gpt-5.5', deploymentId: null, inputTokens: 0, outputTokens: 0, priceTableVersion: 'v1', capturedAt: null };
    assert.throws(() => ModelEvalUsageEventSchema.parse({ ...base, usageStatus: 'missing', costUsd: 1.5 }));
    assert.doesNotThrow(() => ModelEvalUsageEventSchema.parse({ ...base, usageStatus: 'missing', costUsd: null }));
  });

  test('a non-numeric token field value is tagged "missing", not silently coerced (round-13 H4 regression guard)', () => {
    const badType = buildUsageEvent({ runId: 'run-16', role: 'auditor', phase: 'generation', armId: null, candidateRef: 'cand-1', resolvedModel: 'gpt-5.5', pricingModel: 'gpt-5.5', deploymentId: null, provider: 'openai', usage: { input_tokens: 'not-a-number', output_tokens: 50 } });
    assert.equal(badType.usageStatus, 'missing');
    assert.equal(badType.costUsd, null);
  });

  test('a negative token count is also tagged "missing", not clamped-then-treated-as-captured (round-14 M3/M4 regression guard)', () => {
    const negative = buildUsageEvent({ runId: 'run-17', role: 'auditor', phase: 'generation', armId: null, candidateRef: 'cand-1', resolvedModel: 'gpt-5.5', pricingModel: 'gpt-5.5', deploymentId: null, provider: 'openai', usage: { input_tokens: -5, output_tokens: 50 } });
    assert.equal(negative.usageStatus, 'missing');
    assert.equal(negative.costUsd, null);
  });

  test('a non-null but unrecognized/empty usage object is also tagged usageStatus:"missing" (round-10 H2/H4 regression guard)', () => {
    const emptyObj = buildUsageEvent({ runId: 'run-11', role: 'auditor', phase: 'generation', armId: null, candidateRef: 'cand-1', resolvedModel: 'gpt-5.5', pricingModel: 'gpt-5.5', deploymentId: null, provider: 'openai', usage: {} });
    assert.equal(emptyObj.usageStatus, 'missing');
    assert.equal(emptyObj.costUsd, null);
    const unrecognizedShape = buildUsageEvent({ runId: 'run-12', role: 'auditor', phase: 'generation', armId: null, candidateRef: 'cand-1', resolvedModel: 'gpt-5.5', pricingModel: 'gpt-5.5', deploymentId: null, provider: 'openai', usage: { totally_unrecognized_field: 5 } });
    assert.equal(unrecognizedShape.usageStatus, 'missing');
  });

  test('a one-sided usage object (only input OR only output tokens) is also tagged "missing" (round-11 H4 regression guard)', () => {
    const inputOnly = buildUsageEvent({ runId: 'run-13', role: 'auditor', phase: 'generation', armId: null, candidateRef: 'cand-1', resolvedModel: 'gpt-5.5', pricingModel: 'gpt-5.5', deploymentId: null, provider: 'openai', usage: { input_tokens: 100 } });
    assert.equal(inputOnly.usageStatus, 'missing');
    const outputOnly = buildUsageEvent({ runId: 'run-14', role: 'auditor', phase: 'generation', armId: null, candidateRef: 'cand-1', resolvedModel: 'gpt-5.5', pricingModel: 'gpt-5.5', deploymentId: null, provider: 'openai', usage: { output_tokens: 50 } });
    assert.equal(outputOnly.usageStatus, 'missing');
    const both = buildUsageEvent({ runId: 'run-15', role: 'auditor', phase: 'generation', armId: null, candidateRef: 'cand-1', resolvedModel: 'gpt-5.5', pricingModel: 'gpt-5.5', deploymentId: null, provider: 'openai', usage: { input_tokens: 100, output_tokens: 50 } });
    assert.equal(both.usageStatus, 'captured');
  });

  test('a negative or non-finite costUsd is rejected (round-6 M1 regression guard)', () => {
    const base = { runId: 'run-4', role: 'auditor', phase: 'generation', armId: null, candidateRef: 'cand-1', provider: 'openai', resolvedModel: 'gpt-5.5', pricingModel: 'gpt-5.5', deploymentId: null, usageStatus: 'captured', inputTokens: 1, outputTokens: 1, priceTableVersion: 'v1', capturedAt: null };
    assert.throws(() => ModelEvalUsageEventSchema.parse({ ...base, costUsd: -1 }));
    assert.throws(() => ModelEvalUsageEventSchema.parse({ ...base, costUsd: Infinity }));
  });

  test('a malformed (non-ISO) capturedAt string is rejected (round-7 L1 regression guard)', () => {
    const base = { runId: 'run-5', role: 'auditor', phase: 'generation', armId: null, candidateRef: 'cand-1', provider: 'openai', resolvedModel: 'gpt-5.5', pricingModel: 'gpt-5.5', deploymentId: null, usageStatus: 'captured', inputTokens: 1, outputTokens: 1, priceTableVersion: 'v1', costUsd: null };
    assert.throws(() => ModelEvalUsageEventSchema.parse({ ...base, capturedAt: 'not-a-timestamp' }));
    assert.doesNotThrow(() => ModelEvalUsageEventSchema.parse({ ...base, capturedAt: new Date(0).toISOString() }));
    assert.doesNotThrow(() => ModelEvalUsageEventSchema.parse({ ...base, capturedAt: null }));
  });

  test('a cost row with contradictory costStatus/totalUsd is rejected (round-7 M2 regression guard)', () => {
    const base = { runId: 'run-6', role: 'auditor', armId: null, candidateRef: 'cand-1', byPhase: { generation: { usd: 5, status: 'available' } } };
    assert.throws(() => CostRowSchema.parse({ ...base, costStatus: 'available', totalUsd: null }));
    assert.throws(() => CostRowSchema.parse({ ...base, costStatus: 'unavailable', totalUsd: 5 }));
    assert.doesNotThrow(() => CostRowSchema.parse({ ...base, costStatus: 'available', totalUsd: 5 }));
  });

  test('a cost row whose totalUsd does not match the sum of its byPhase entries is rejected (round-10 M2 regression guard)', () => {
    const base = { runId: 'run-10', role: 'auditor', armId: null, candidateRef: 'cand-1', costStatus: 'available' };
    assert.throws(() => CostRowSchema.parse({ ...base, totalUsd: 5, byPhase: { generation: { usd: 3, status: 'available' } } }));
    assert.doesNotThrow(() => CostRowSchema.parse({ ...base, totalUsd: 5, byPhase: { generation: { usd: 3, status: 'available' }, extraction: { usd: 2, status: 'available' } } }));
  });
});

describe('config/schema.mjs — .strict() catches typos', () => {
  test('a typo\'d field name is rejected, not silently accepted', () => {
    const bad = {
      version: 1, role: 'auditor', calibrationNote: 'x',
      screen: { minSampleSize: 4, thresholds: { oracle: { minRecalll: 0.7 } } },
      promotion: { minSampleSize: 8, thresholds: { oracle: { minRecall: 0.7 } } },
    };
    const r = parseThresholdConfig(bad);
    assert.equal(r.ok, false);
  });

  test('an unrecognized key at the OUTER tier/role level is rejected, not silently stripped (round-6 M4 regression guard)', () => {
    const badTierLevel = {
      version: 1, role: 'auditor', calibrationNote: 'x',
      screen: { minSampleSize: 4, extraStrayKey: true, thresholds: { oracle: { minRecall: 0.7 } } },
      promotion: { minSampleSize: 8, thresholds: { oracle: { minRecall: 0.7 } } },
    };
    assert.equal(parseThresholdConfig(badTierLevel).ok, false);

    const badRoleLevel = {
      version: 1, role: 'auditor', calibrationNote: 'x', extraStrayTopLevelKey: true,
      screen: { minSampleSize: 4, thresholds: { oracle: { minRecall: 0.7 } } },
      promotion: { minSampleSize: 8, thresholds: { oracle: { minRecall: 0.7 } } },
    };
    assert.equal(parseThresholdConfig(badRoleLevel).ok, false);
  });
});

describe('store/model-eval.mjs — persisted verdict/nextAction bounded to the reachable vocabulary (round-7 M3 regression guard)', () => {
  test('an arbitrary string verdict/nextAction is rejected at the persistence boundary', () => {
    // Round-12 audit M9 fix — createEvalRun only ever starts a NON-terminal
    // run now (updateEvalRunTerminal is the sole path to 'completed'), so a
    // verdict/nextAction pair can only legitimately appear in a
    // terminalBundle; test through that surface.
    const base = { repoId: 'r1', runId: 'run-x', expectedStatus: 'running', terminalBundle: { status: 'completed' } };
    assert.equal(storeModelEvalInternals.UpdateEvalRunTerminalArgsSchema.safeParse({ ...base, terminalBundle: { ...base.terminalBundle, verdict: 'not-a-real-verdict', nextAction: 'none' } }).success, false);
    assert.equal(storeModelEvalInternals.UpdateEvalRunTerminalArgsSchema.safeParse({ ...base, terminalBundle: { ...base.terminalBundle, verdict: 'keep', nextAction: 'not-a-real-action' } }).success, false);
    assert.equal(storeModelEvalInternals.UpdateEvalRunTerminalArgsSchema.safeParse({ ...base, terminalBundle: { ...base.terminalBundle, verdict: 'keep', nextAction: 'none' } }).success, true);
  });

  test('createEvalRun only accepts a NON-terminal status — completed/failed_* must go through updateEvalRunTerminal (round-12 M9 regression guard)', () => {
    const base = { repoId: 'r1', role: 'auditor', tier: 'screen', candidateRef: { spec: 'x' } };
    assert.equal(storeModelEvalInternals.CreateEvalRunBundleSchema.safeParse({ ...base, status: 'completed' }).success, false);
    assert.equal(storeModelEvalInternals.CreateEvalRunBundleSchema.safeParse({ ...base, status: 'failed_provider' }).success, false);
    assert.equal(storeModelEvalInternals.CreateEvalRunBundleSchema.safeParse({ ...base, status: 'running' }).success, true);
  });

  test('status:"pending_shadow" is rejected for a non-adjudicator role (round-14 M1 regression guard)', () => {
    const base = { repoId: 'r1', tier: 'screen', candidateRef: { spec: 'x' }, status: 'pending_shadow' };
    assert.equal(storeModelEvalInternals.CreateEvalRunBundleSchema.safeParse({ ...base, role: 'auditor' }).success, false);
    assert.equal(storeModelEvalInternals.CreateEvalRunBundleSchema.safeParse({ ...base, role: 'adjudicator' }).success, true);
  });

  test('a non-JSON-serializable candidateRef/metrics/cost/evidence value is rejected — jsonb columns can\'t safely hold it (round-14 H1/M10 regression guard)', () => {
    const base = { repoId: 'r1', role: 'auditor', tier: 'screen', status: 'running' };
    const circular = {}; circular.self = circular;
    assert.equal(storeModelEvalInternals.CreateEvalRunBundleSchema.safeParse({ ...base, candidateRef: circular }).success, false);
    assert.equal(storeModelEvalInternals.CreateEvalRunBundleSchema.safeParse({ ...base, candidateRef: { fn: () => {} } }).success, false);
    assert.equal(storeModelEvalInternals.CreateEvalRunBundleSchema.safeParse({ ...base, candidateRef: { spec: 'x', nested: { a: 1 } } }).success, true);
  });

  test('updateEvalRunTerminal args reject the same out-of-vocabulary verdict/nextAction', () => {
    const args = {
      repoId: 'r1', runId: 'run-1', expectedStatus: 'running',
      terminalBundle: { status: 'completed', verdict: 'bogus', nextAction: 'none' },
    };
    assert.equal(storeModelEvalInternals.UpdateEvalRunTerminalArgsSchema.safeParse(args).success, false);
  });

  test('a syntactically-valid but never-produced (verdict, nextAction) pair is rejected (round-8 M5 regression guard)', () => {
    const base = { repoId: 'r1', runId: 'run-x', expectedStatus: 'running', terminalBundle: { status: 'completed' } };
    // "switch" only ever pairs with "promote_to_full" in DECISION_TABLE.
    assert.equal(storeModelEvalInternals.UpdateEvalRunTerminalArgsSchema.safeParse({ ...base, terminalBundle: { ...base.terminalBundle, verdict: 'switch', nextAction: 'reject' } }).success, false);
    assert.equal(storeModelEvalInternals.UpdateEvalRunTerminalArgsSchema.safeParse({ ...base, terminalBundle: { ...base.terminalBundle, verdict: 'switch', nextAction: 'promote_to_full' } }).success, true);
  });

  test('a half-populated verdict/nextAction (one set, one null) is rejected (round-9 H7 regression guard)', () => {
    const base = { repoId: 'r1', runId: 'run-x', expectedStatus: 'running', terminalBundle: { status: 'completed' } };
    assert.equal(storeModelEvalInternals.UpdateEvalRunTerminalArgsSchema.safeParse({ ...base, terminalBundle: { ...base.terminalBundle, verdict: 'keep', nextAction: null } }).success, false);
    assert.equal(storeModelEvalInternals.UpdateEvalRunTerminalArgsSchema.safeParse({ ...base, terminalBundle: { ...base.terminalBundle, verdict: null, nextAction: 'none' } }).success, false);
  });

  test('a non-completed status must not carry a verdict/nextAction, and completed must (round-9 H10 regression guard)', () => {
    const base = { repoId: 'r1', role: 'auditor', tier: 'screen', candidateRef: { spec: 'x' } };
    // Non-terminal, in-flight run with a decision already attached — invalid.
    assert.equal(storeModelEvalInternals.CreateEvalRunBundleSchema.safeParse({ ...base, status: 'running', verdict: 'keep', nextAction: 'none' }).success, false);
    // A failed terminal status persisting a success-shaped decision — invalid.
    assert.equal(storeModelEvalInternals.UpdateEvalRunTerminalArgsSchema.safeParse({
      repoId: 'r1', runId: 'run-1', expectedStatus: 'running',
      terminalBundle: { status: 'failed_provider', verdict: 'keep', nextAction: 'none' },
    }).success, false);
    // completed with no decision at all — invalid.
    assert.equal(storeModelEvalInternals.UpdateEvalRunTerminalArgsSchema.safeParse({
      repoId: 'r1', runId: 'run-1', expectedStatus: 'running',
      terminalBundle: { status: 'completed' },
    }).success, false);
    // The legitimate shapes both pass.
    assert.equal(storeModelEvalInternals.CreateEvalRunBundleSchema.safeParse({ ...base, status: 'running' }).success, true);
    assert.equal(storeModelEvalInternals.UpdateEvalRunTerminalArgsSchema.safeParse({
      repoId: 'r1', runId: 'run-1', expectedStatus: 'running',
      terminalBundle: { status: 'failed_provider' },
    }).success, true);
  });
});
