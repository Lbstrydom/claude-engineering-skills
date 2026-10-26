/**
 * @fileoverview Record the Stage-1 triage prediction for every envelope as a
 * `learning_decisions` row (type `stage1_prediction`) — the shadow baseline the
 * H1 distillation experiment compares a cheap model against
 * (docs/plans/own-model-telemetry-slice-1.md, gap 5).
 *
 * Reuses `learning_decisions` rather than a parallel table, and deliberately does
 * NOT write `audit_findings.stage` / `.arm`: those are the model-A/B scorer's
 * PRODUCING-stage tags (NULL = baseline provenance, plus a CHECK), so a
 * prediction there would corrupt that view.
 *
 * Identity is run-scoped and deterministic — `<auditRunId>:stage1_prediction:r<round>:s<index>`
 * where `index` is the envelope's position in the Stage-1 input order — so two
 * runs never collapse and a retry of one run is an idempotent `decision_key`
 * conflict. Every envelope is recorded, including those that never become a
 * final finding; the export join by `(audit_run_id, fingerprint)` reports those
 * as unmatched instead of dropping them.
 *
 * @module scripts/lib/audit/stage1-prediction-log
 */
import { recordDecision } from '../learning/decision-logger.mjs';

/** The most recent `stage1` decision on an envelope, or null. */
function lastStage1Decision(envelope) {
  const ds = Array.isArray(envelope?.stageDecisions) ? envelope.stageDecisions : [];
  for (let i = ds.length - 1; i >= 0; i--) if (ds[i]?.stage === 'stage1') return ds[i];
  return null;
}

/**
 * PURE. One `recordDecision` input per envelope that carries a Stage-1 decision.
 *
 * @param {object[]} envelopes - the Stage-1 INPUT list, in order (index = sequence)
 * @param {{auditRunId: string, round?: number, model?: string|null, repoId?: string|null}} opts
 * @returns {object[]}
 */
export function buildStage1PredictionEntries(envelopes, { auditRunId, round = 1, model = null, repoId = null } = {}) {
  const out = [];
  (envelopes || []).forEach((env, index) => {
    const d = lastStage1Decision(env);
    if (!d) return;
    const f = env.canonicalFinding || {};
    out.push({
      decisionType: 'stage1_prediction',
      auditRunId,
      round,
      sequence: index,
      repoId,
      context: {
        candidateId: env.candidateId ?? null,
        fingerprint: env.fingerprint ?? null,
        severity: f.severity ?? null,
        category: f.category ?? null,
        primaryFile: f._primaryFile ?? null,
      },
      choice: { outcome: d.outcome, reasonCode: d.reasonCode ?? null, model },
      outcome: null,
    });
  });
  return out;
}

/**
 * Admit the entries to the decision logger. Never throws: telemetry must not
 * fail an audit (the logger's own spill covers a store outage).
 * @returns {{recorded: number, failed: number}}
 */
export function logStage1Predictions(envelopes, opts) {
  let recorded = 0, failed = 0;
  if (!opts?.auditRunId || /:/.test(String(opts.auditRunId))) return { recorded, failed };
  for (const entry of buildStage1PredictionEntries(envelopes, opts)) {
    try { recordDecision(entry); recorded++; }
    catch (err) {
      failed++;
      process.stderr.write(`  [learning:tel:stage1_prediction] record failure: ${err.message || err}\n`);
    }
  }
  return { recorded, failed };
}
