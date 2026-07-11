/**
 * @fileoverview Closes the adjudicator Tier A/B `pending_shadow` lifecycle.
 * Owns ALL access to `model_eval_shadow_observations` (Phase 4 migration
 * 20260713100000) — no other module queries this table directly.
 *
 * Gemini round-2 audit G1 (a correctness bug this design specifically
 * avoids): `runShadowAndPersist` (gemini-review.mjs) writes an observation
 * at the end of audit generation, BEFORE a human has reviewed the
 * underlying findings — gating purely on raw observation count would let
 * `finalizeShadowEval` compute F1 against still-`pending` findings,
 * silently treating them as false and producing a fabricated `keep`
 * verdict from garbage data. `getTerminalShadowObservations` only counts an
 * observation once EVERY finding it references has reached a terminal
 * `user_action` — an observation with any pending reference stays in the
 * table, uncounted, until a human adjudicates via the EXISTING
 * `adjudicateFinalReviewFinding` flow (runs-findings.mjs) — no new
 * polling mechanism.
 *
 * Round-6 audit H5's disambiguated join key: `finding_fingerprint` is only
 * unique WITHIN one audit run, so `findingRefs` carries `{auditRunId,
 * findingFingerprint, passName, bucket}` — the join target is
 * `(run_id = auditRunId, finding_fingerprint = findingFingerprint,
 * pass_name = passName)`, never fingerprint alone (which could silently
 * match a same-fingerprint finding from an unrelated audit run).
 *
 * `adjudicateFinalReviewFinding` (runs-findings.mjs) sets ONLY
 * `audit_findings.user_action` for these rows, never `adjudication_outcome`
 * (the general model-A/B/C queue's column) — so this module reads
 * `user_action`, not `adjudication_outcome`, matching the EXISTING
 * adjudication workflow byte-for-byte.
 *
 * Plan: docs/plans/model-swap-eval-harness.md — File-Level Plan Phase 4.
 *
 * @module scripts/lib/model-eval/finalize-shadow-eval
 */

import { one, many, insertReturning, upsert } from '../db/query.mjs';
import { isCloudEnabled } from '../store/repo.mjs';
import { scoreBinaryClassification } from './deterministic-scorer.mjs';
import { computeVerdict } from './verdict.mjs';
import { updateEvalRunTerminal } from '../store/model-eval.mjs';
import { buildComparisonEvidenceFromRoutes } from './route-catalog.mjs';

const TERMINAL_USER_ACTIONS = Object.freeze(['accepted-permanent', 'dismissed']);

export class ShadowObservationRepoMismatchError extends Error {
  constructor(runId, repoId) {
    super(`ShadowObservationRepoMismatchError: model_eval run ${runId} does not belong to repo ${repoId}`);
    this.name = 'ShadowObservationRepoMismatchError';
  }
}

/**
 * Called by gemini-review.mjs::runShadowAndPersist when a `pending_shadow`
 * evaluation is active. Repo-scoped (round-5 audit H2) — verifies `runId`
 * belongs to `repoId` before writing, rejects otherwise. Idempotent on
 * `(model_eval_run_id, idempotency_key)` — a repeated write for the same
 * underlying review event upserts, never duplicates.
 * @param {{repoId: string, runId: string, observation: object, idempotencyKey: string}} args
 */
export async function appendModelEvalShadowObservation({ repoId, runId, observation, idempotencyKey }) {
  if (!await isCloudEnabled()) return { ok: true, cloud: false, id: null };
  const owner = await one('SELECT run_id FROM model_eval_runs WHERE run_id = $1 AND repo_id = $2', [runId, repoId]);
  if (!owner) throw new ShadowObservationRepoMismatchError(runId, repoId);
  const row = await upsert(
    'model_eval_shadow_observations',
    { model_eval_run_id: runId, observation, idempotency_key: idempotencyKey },
    { onConflict: ['model_eval_run_id', 'idempotency_key'], updateColumns: ['observation'], returning: ['id'] },
  );
  return { ok: true, cloud: true, id: row.id };
}

/**
 * Raw, unfiltered observations for a run — progress reporting only, never
 * scoring (a pending-labeled observation must never silently enter a
 * verdict computation).
 * @param {{repoId: string, runId: string}} args
 */
export async function getShadowObservationsForEvalRun({ repoId, runId }) {
  if (!await isCloudEnabled()) return { ok: true, cloud: false, observations: [] };
  const rows = await many(
    `SELECT o.id, o.observation, o.idempotency_key, o.created_at
       FROM model_eval_shadow_observations o
       JOIN model_eval_runs r ON r.run_id = o.model_eval_run_id
      WHERE o.model_eval_run_id = $1 AND r.repo_id = $2
      ORDER BY o.created_at`,
    [runId, repoId],
  );
  return { ok: true, cloud: true, observations: rows };
}

/**
 * The scoring-eligible subset — every referenced finding has reached a
 * terminal `user_action`. Joins on the disambiguated key (round-6 H5):
 * `(run_id = findingRefs[].auditRunId, finding_fingerprint =
 * findingRefs[].findingFingerprint, pass_name = findingRefs[].passName)`.
 *
 * Round-1 (Cluster C) audit H2 fix — the finding lookup additionally joins
 * `audit_runs` and requires `ar.repo_id = $4`. `getShadowObservationsForEvalRun`
 * already repo-scopes the OBSERVATION row (via model_eval_runs.repo_id), but
 * `findingRefs[].auditRunId` is a value stored inside the observation's own
 * jsonb blob with no DB-level constraint tying it to the same repo — without
 * this join, a corrupted or cross-repo observation payload could read
 * `audit_findings.user_action` from a DIFFERENT repo's audit run. Defense
 * in depth, matching this repo's established repo-scoping paranoia.
 * @param {{repoId: string, runId: string}} args
 */
export async function getTerminalShadowObservations({ repoId, runId }) {
  const { observations } = await getShadowObservationsForEvalRun({ repoId, runId });
  if (observations.length === 0) return { ok: true, cloud: await isCloudEnabled(), observations: [] };

  const terminal = [];
  for (const obs of observations) {
    const refs = obs.observation?.findingRefs || [];
    if (refs.length === 0) continue;
    let allTerminal = true;
    const labeled = [];
    for (const ref of refs) {
      const finding = await one(
        `SELECT f.user_action FROM audit_findings f
          JOIN audit_runs ar ON ar.id = f.run_id
          WHERE f.run_id = $1 AND f.finding_fingerprint = $2 AND f.pass_name = $3 AND ar.repo_id = $4
          LIMIT 1`,
        [ref.auditRunId, ref.findingFingerprint, ref.passName, repoId],
      );
      const userAction = finding?.user_action ?? null;
      if (!TERMINAL_USER_ACTIONS.includes(userAction)) { allTerminal = false; break; }
      labeled.push({ ...ref, userAction });
    }
    if (allTerminal) terminal.push({ ...obs, labeledRefs: labeled });
  }
  return { ok: true, cloud: true, observations: terminal };
}

/**
 * Reduces terminal-labeled observations into a comparative pair of binary
 * rows — SHADOW's (candidate) and PRIMARY's (baseline) own raise/miss
 * decision, each scored against the SAME human ground truth. Corrected
 * design (verified directly against adjudicator-thresholds.json): the
 * promotion tier's `thresholds.promotion.thresholds` declares ONLY a
 * `comparative` sub-key (minF1VsBaseline/maxFalseAcceptDeltaAbs/
 * switchIfCostImprovesByPct) — there is no `oracle` key at promotion tier,
 * so computeVerdict's own `mode:'comparative'` is the only mode this
 * config can drive (an earlier draft of this function used oracle mode,
 * which computeRawVerdict would hard-fail on: `thresholds.comparative`
 * is missing — mode:'oracle' would read `thresholds.oracle`, undefined).
 * This is also the semantically correct question for promotion:
 * "is the candidate at least as good as what we have now," not an
 * absolute floor.
 *
 * Findings are grouped by fingerprint SCOPED TO EACH OBSERVATION
 * INDEPENDENTLY, never globally across observations. Round-1 (Cluster C)
 * audit H4 fix — this file's own header comment states "finding_fingerprint
 * is only unique WITHIN one audit run, never fingerprint alone"; an
 * earlier draft violated that exact principle here by deduping across the
 * WHOLE terminalObservations set with one global Map, which would merge
 * two genuinely DIFFERENT defects from two DIFFERENT audit runs (or,
 * separately, silently collapse a legitimately RECURRING finding pattern
 * across multiple review events into a single sample). Within one
 * observation, `auditRunId` is constant for every ref (runShadowAndPersist
 * builds findingRefs from a single `runId`), so a 'both'-bucket finding's
 * two refs (one final-review, one final-review-shadow) correctly dedup to
 * one row THERE — but each observation contributes its OWN independent set
 * of rows to the overall sample, preserving one data point per real review
 * event.
 */
function toBinaryRows(terminalObservations) {
  const candidatePredictions = [], baselinePredictions = [], groundTruthLabels = [];
  for (const obs of terminalObservations) {
    const byFingerprint = new Map(); // scoped to THIS observation only
    for (const ref of obs.labeledRefs) {
      if (!byFingerprint.has(ref.findingFingerprint)) {
        byFingerprint.set(ref.findingFingerprint, { bucket: ref.bucket, userAction: ref.userAction });
      }
    }
    for (const { bucket, userAction } of byFingerprint.values()) {
      groundTruthLabels.push(userAction === 'accepted-permanent' ? 'true_positive' : 'false_positive');
      candidatePredictions.push((bucket === 'both' || bucket === 'shadow-only') ? 'true_positive' : 'false_positive');
      baselinePredictions.push((bucket === 'both' || bucket === 'primary-only') ? 'true_positive' : 'false_positive');
    }
  }
  return { candidatePredictions, baselinePredictions, groundTruthLabels };
}

function toMetrics(scored) {
  return { recall: scored.recall, falsePositiveRate: scored.falsePositiveRate, f1: scored.f1 };
}

/**
 * Idempotent — re-invoking while still short of the threshold reports
 * current progress as a no-op; invoking once the terminal-labeled count
 * meets `minLiveShadowRuns` performs the finalize/reconcile transition
 * (pending_shadow -> completed via updateEvalRunTerminal's compare-and-set,
 * store/model-eval.mjs Phase 1).
 *
 * `baselineRoute` is the CURRENT primary reviewer's route (the caller
 * resolves it — this module has no opinion on which provider is
 * "primary," that's gemini-review.mjs's selectProvider() precedence).
 * `judgeRoute` is always null: this comparison's ground truth comes from
 * HUMAN adjudication (adjudicateFinalReviewFinding), not a cross-family
 * LLM judge — resolveEvaluationTier correctly forces Tier C for a null
 * judgeRoute, matching this framework's own vocabulary for "no automated
 * judge was involved."
 * @param {{repoId: string, runId: string, minLiveShadowRuns: number, candidateRoute: object, baselineRoute: object, thresholds: object}} args
 */
export async function finalizeShadowEval({ repoId, runId, minLiveShadowRuns, candidateRoute, baselineRoute, thresholds }) {
  const [{ observations: allObservations }, { observations: terminalObservations }] = await Promise.all([
    getShadowObservationsForEvalRun({ repoId, runId }),
    getTerminalShadowObservations({ repoId, runId }),
  ]);

  if (terminalObservations.length < minLiveShadowRuns) {
    return {
      ok: true, finalized: false,
      progress: { terminal: terminalObservations.length, total: allObservations.length, minLiveShadowRuns },
    };
  }

  const { candidatePredictions, baselinePredictions, groundTruthLabels } = toBinaryRows(terminalObservations);
  const candidateMetrics = toMetrics(scoreBinaryClassification(candidatePredictions, groundTruthLabels));
  const baselineMetrics = toMetrics(scoreBinaryClassification(baselinePredictions, groundTruthLabels));

  // costDelta: null (accepted limitation, documented not silent) — gemini-review.mjs's
  // shadow-review usage isn't yet wired into a ModelEvalUsageEvent for this
  // path. With allowUnpricedPromotion:false (the config's own value),
  // computeVerdict correctly degrades a floors-met result to 'inconclusive'
  // rather than fabricating a 'switch' verdict without real cost evidence —
  // the honest behavior this repo's own "never fabricate, mark missing"
  // doctrine requires. Wiring cost capture for this path is follow-up work.
  const comparisonEvidence = buildComparisonEvidenceFromRoutes({ candidateRoute, baselineRoute, judgeRoute: null });
  const { verdict, nextAction, reasons } = computeVerdict({
    mode: 'comparative', role: 'adjudicator', tier: 'promotion', comparisonEvidence,
    candidateMetrics, baselineMetrics, sampleSize: terminalObservations.length, minSampleSize: minLiveShadowRuns,
    costDelta: null, thresholds,
  });

  await updateEvalRunTerminal({
    repoId, runId, expectedStatus: 'pending_shadow',
    terminalBundle: {
      status: 'completed', verdict, nextAction, metrics: candidateMetrics, cost: null,
      evidence: { mode: 'live-shadow', baselineMetrics, terminalCount: terminalObservations.length, totalCount: allObservations.length, reasons },
    },
  });

  return {
    ok: true, finalized: true, verdict, nextAction, metrics: candidateMetrics,
    progress: { terminal: terminalObservations.length, total: allObservations.length, minLiveShadowRuns },
  };
}

// Exported for direct testing (mirrors the _internals pattern already used
// across scripts/lib/model-eval/*.mjs) — both are pure, no I/O.
export const _internals = { toBinaryRows, toMetrics };
