/**
 * @fileoverview `route-catalog.mjs` — independence + fail-closed transport,
 * incl. a boundary-consistency check that its evidence output validates
 * against `verdict.mjs`'s own `VerdictInputSchema`.
 *
 * Split out of `tests/model-eval-core.test.mjs` (Phase 5, plan:
 * comparison-tooling-consolidation.md, D3) — assertions moved verbatim.
 *
 * @module tests/model-eval-route-catalog
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  resolveCandidateRoute, resolveEvaluationTier, buildComparisonEvidenceFromRoutes,
  _internals as routeCatalogInternals,
} from '../scripts/lib/model-eval/route-catalog.mjs';
import { VerdictInputSchema } from '../scripts/lib/model-eval/verdict.mjs';
import { OSS_POOL } from '../scripts/lib/model-resolver.mjs';

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
