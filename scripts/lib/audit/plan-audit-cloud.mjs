/**
 * @fileoverview Cloud run registration for PLAN-mode audits — closes the
 * plan-audit half of the outcome-capture asymmetry (2026-07-13): code audits
 * have created `audit_runs` rows + labeled findings since the learning-store
 * shipped, but plan audits only ever fed the LOCAL PlanFpTracker, so the
 * learning loop (FP patterns, prompt evolution, effectiveness views) had no
 * plan-audit ground truth at all — despite `audit_runs.mode` having a
 * `CHECK (mode IN ('plan','code'))` from the original migration (the schema
 * anticipated plan runs from day one; the code path never wired it).
 *
 * Mirrors the minimal correct subset of the code path's registration block
 * (legacy-production-audit.mjs runMultiPassCodeAudit): stable repo identity
 * via resolveRepoForStore, commit/branch anchoring, plans-table linkage,
 * recordRunStart(mode='plan'). Everything is best-effort and cloud-optional —
 * a cloud failure NEVER affects the plan-audit result (graceful degradation
 * invariant #16).
 *
 * NOT used by the arm-eval plan shadow (openai-audit.mjs's `_modelAbShadow`
 * block) — that concluded experiment mints its own run when its toggle is on;
 * the caller skips this registration when a shadow run id already exists so
 * one plan audit never produces two audit_runs rows.
 *
 * @module scripts/lib/audit/plan-audit-cloud
 */

import {
  isCloudEnabled, resolveRepoForStore, upsertPlan,
  recordRunStart, recordRunComplete, recordFindings,
} from '../../learning-store.mjs';
import { populateFindingMetadata } from '../ledger.mjs';

/** Best-effort git anchor — {commitSha, branch}, nulls outside a repo. */
async function gitAnchor() {
  let commitSha = null, branch = null;
  try {
    const { execFileSync } = await import('node:child_process');
    commitSha = execFileSync('git', ['rev-parse', 'HEAD'], { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
    branch = execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
  } catch { /* not a git repo, or git not on PATH */ }
  return { commitSha, branch };
}

/**
 * Register a cloud `audit_runs` row (mode='plan') for this plan-audit
 * invocation. Never throws; cloud off / no repo profile → nulls.
 *
 * @param {{ repoProfile: object|null, planFile: string|null, runId?: string|null }} args
 *   `runId` threads an orchestrator-minted id (--run-id) so all rounds of one
 *   plan audit share a single row — same run-unification contract as code mode.
 * @returns {Promise<{ cloudRunId: string|null, cloudRepoId: string|null }>}
 */
export async function registerPlanAuditRun({ repoProfile, planFile, runId = null } = {}) {
  const NONE = { cloudRunId: null, cloudRepoId: null };
  try {
    if (!await isCloudEnabled() || !repoProfile) return NONE;
    const repoRef = await resolveRepoForStore({ profile: repoProfile }).catch(() => null);
    const cloudRepoId = repoRef?.repoRowId ?? null;
    if (!cloudRepoId) return NONE;

    const { commitSha, branch } = await gitAnchor();

    // Register the plan artifact so audit_runs.plan_id links back — same
    // skill inference as the code path (cross-skill data-loop joins).
    let planId = null;
    if (planFile) {
      const inferredSkill = /plan[-_]?frontend|\bfrontend\b|\bui\b/i.test(planFile)
        ? 'plan-frontend'
        : /plan[-_]?backend|\bbackend\b|\bapi\b/i.test(planFile)
          ? 'plan-backend'
          : 'manual';
      planId = await upsertPlan(cloudRepoId, {
        path: planFile, skill: inferredSkill, status: 'in_progress', commitSha,
      }).catch(() => null);
    }

    const cloudRunId = await recordRunStart(cloudRepoId, planFile || 'ad-hoc', 'plan', {
      scopeMode: 'plan', commitSha, branch, planId, runId,
    }).catch(() => null);
    return { cloudRunId, cloudRepoId };
  } catch (err) {
    process.stderr.write(`  [learning] plan-run registration failed (non-blocking): ${err.message}\n`);
    return NONE;
  }
}

/**
 * Persist the plan audit's findings + completion stats onto the registered
 * run. Records the POST-suppression findings (what the operator actually
 * triages) so cloud labels line up 1:1 with the ledger the agent writes.
 * Never throws.
 *
 * @param {string|null} cloudRunId
 * @param {object} result - the plan-audit result (findings already suppressed/enriched)
 * @param {{ round?: number, durationMs?: number|null, costEstimate?: number|null }} [stats]
 */
export async function completePlanAuditRun(cloudRunId, result, { round = 1, durationMs = null, costEstimate = null } = {}) {
  if (!cloudRunId || !result || !Array.isArray(result.findings)) return;
  try {
    // Defensive: recordFindings keys on _hash/_primaryFile metadata — the
    // suppression/ledger blocks usually populated these already; idempotent.
    for (const f of result.findings) populateFindingMetadata(f, 'plan');
    // Best-effort but never SILENT: a failed findings insert must be visible
    // (the run row would otherwise read complete-with-zero-findings and the
    // operator would have no clue the labels are missing).
    await recordFindings(cloudRunId, result.findings, 'plan', round).catch((err) => {
      process.stderr.write(`  [learning] plan-run findings persist failed (non-blocking): ${err.message}\n`);
    });
    // NOTE: gemini_verdict is deliberately NOT set here — that column belongs
    // to the Step-7 final gate (gemini-review.mjs --run-id writes it); the
    // GPT plan verdict lives on the findings/result artifact. Undefined stats
    // fields are omitted by the db seam's undefined contract, not nulled.
    await recordRunComplete(cloudRunId, {
      rounds: round,
      totalFindings: result.findings.length,
      durationMs,
      costEstimate,
    });
  } catch (err) {
    process.stderr.write(`  [learning] plan-run completion failed (non-blocking): ${err.message}\n`);
  }
}
