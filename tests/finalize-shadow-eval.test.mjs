import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  finalizeShadowEval, getShadowObservationsForEvalRun, getTerminalShadowObservations,
  appendModelEvalShadowObservation, ShadowObservationRepoMismatchError, _internals,
} from '../scripts/lib/model-eval/finalize-shadow-eval.mjs';

const { toBinaryRows, toMetrics } = _internals;

describe('finalize-shadow-eval.mjs — toBinaryRows (pure)', () => {
  test('a "both"-bucket finding counts as caught by BOTH sides', () => {
    const observations = [{ labeledRefs: [{ findingFingerprint: 'f1', bucket: 'both', userAction: 'accepted-permanent' }] }];
    const { candidatePredictions, baselinePredictions, groundTruthLabels } = toBinaryRows(observations);
    assert.deepEqual(candidatePredictions, ['true_positive']);
    assert.deepEqual(baselinePredictions, ['true_positive']);
    assert.deepEqual(groundTruthLabels, ['true_positive']);
  });

  test('a "shadow-only" real finding is a baseline MISS (false_positive prediction) — primary\'s own blind spot is visible', () => {
    const observations = [{ labeledRefs: [{ findingFingerprint: 'f1', bucket: 'shadow-only', userAction: 'accepted-permanent' }] }];
    const { candidatePredictions, baselinePredictions, groundTruthLabels } = toBinaryRows(observations);
    assert.deepEqual(candidatePredictions, ['true_positive']);
    assert.deepEqual(baselinePredictions, ['false_positive']);
    assert.deepEqual(groundTruthLabels, ['true_positive']);
  });

  test('a "primary-only" finding dismissed by a human is a correct call for BOTH sides (neither raised a false one)', () => {
    const observations = [{ labeledRefs: [{ findingFingerprint: 'f1', bucket: 'primary-only', userAction: 'dismissed' }] }];
    const { candidatePredictions, baselinePredictions, groundTruthLabels } = toBinaryRows(observations);
    assert.deepEqual(candidatePredictions, ['false_positive']);
    assert.deepEqual(baselinePredictions, ['true_positive']); // primary DID raise it — a false positive raise
    assert.deepEqual(groundTruthLabels, ['false_positive']);
  });

  test('a fingerprint appearing twice (both a final-review and final-review-shadow ref) is deduped to one row', () => {
    const observations = [{
      labeledRefs: [
        { findingFingerprint: 'f1', bucket: 'both', userAction: 'accepted-permanent' },
        { findingFingerprint: 'f1', bucket: 'both', userAction: 'accepted-permanent' },
      ],
    }];
    const { candidatePredictions } = toBinaryRows(observations);
    assert.equal(candidatePredictions.length, 1);
  });

  test('rows from multiple observations are all included', () => {
    const observations = [
      { labeledRefs: [{ findingFingerprint: 'f1', bucket: 'both', userAction: 'accepted-permanent' }] },
      { labeledRefs: [{ findingFingerprint: 'f2', bucket: 'shadow-only', userAction: 'dismissed' }] },
    ];
    const { candidatePredictions, groundTruthLabels } = toBinaryRows(observations);
    assert.equal(candidatePredictions.length, 2);
    assert.equal(groundTruthLabels.length, 2);
  });

  test('round-1 (Cluster C) audit H4 regression guard: the SAME fingerprint recurring across TWO DIFFERENT observations is NOT merged — each review event contributes its own row', () => {
    const observations = [
      { labeledRefs: [{ findingFingerprint: 'f1', bucket: 'both', userAction: 'accepted-permanent' }] },
      { labeledRefs: [{ findingFingerprint: 'f1', bucket: 'primary-only', userAction: 'dismissed' }] },
    ];
    const { candidatePredictions, baselinePredictions, groundTruthLabels } = toBinaryRows(observations);
    // Two independent review events, both referencing fingerprint 'f1' — a
    // pre-fix global-dedup would have collapsed this to ONE row (silently
    // dropping the second observation's evidence). Must be two rows.
    assert.equal(candidatePredictions.length, 2);
    assert.equal(baselinePredictions.length, 2);
    assert.equal(groundTruthLabels.length, 2);
    assert.deepEqual(groundTruthLabels, ['true_positive', 'false_positive']);
  });
});

describe('finalize-shadow-eval.mjs — toMetrics (pure)', () => {
  test('extracts exactly recall/falsePositiveRate/f1 from a scoreBinaryClassification-shaped object', () => {
    const scored = { truePositives: 1, falsePositives: 0, trueNegatives: 0, falseNegatives: 0, precision: 1, recall: 1, f1: 1, accuracy: 1, falsePositiveRate: 0 };
    assert.deepEqual(toMetrics(scored), { recall: 1, falsePositiveRate: 0, f1: 1 });
  });
});

describe('finalize-shadow-eval.mjs — store functions (real DB, no writes into shared tables)', () => {
  const FAKE_REPO = '00000000-0000-0000-0000-000000000000';
  const FAKE_RUN = '00000000-0000-0000-0000-000000000001';

  test('getShadowObservationsForEvalRun returns empty for a nonexistent run (no SQL error)', async () => {
    const result = await getShadowObservationsForEvalRun({ repoId: FAKE_REPO, runId: FAKE_RUN });
    assert.ok(Array.isArray(result.observations));
    assert.equal(result.observations.length, 0);
  });

  test('getTerminalShadowObservations returns empty for a nonexistent run (no SQL error)', async () => {
    const result = await getTerminalShadowObservations({ repoId: FAKE_REPO, runId: FAKE_RUN });
    assert.ok(Array.isArray(result.observations));
    assert.equal(result.observations.length, 0);
  });

  test('appendModelEvalShadowObservation refuses (repo-scoping) when the run does not belong to the repo', async () => {
    await assert.rejects(
      () => appendModelEvalShadowObservation({ repoId: FAKE_REPO, runId: FAKE_RUN, observation: { findingRefs: [] }, idempotencyKey: 'k1' }),
      ShadowObservationRepoMismatchError,
    );
  });

  test('finalizeShadowEval reports not-finalized progress when there are zero observations', async () => {
    const result = await finalizeShadowEval({
      repoId: FAKE_REPO, runId: FAKE_RUN, minLiveShadowRuns: 20,
      candidateRoute: { judgeTier: 'C', lineageStatus: 'known', independenceEligible: true, lineageSource: 'catalog-verified' },
      baselineRoute: { judgeTier: 'C', lineageStatus: 'known', independenceEligible: true, lineageSource: 'catalog-verified' },
      thresholds: { comparative: { minF1VsBaseline: 0.98 } },
    });
    assert.equal(result.finalized, false);
    assert.equal(result.progress.terminal, 0);
  });
});
