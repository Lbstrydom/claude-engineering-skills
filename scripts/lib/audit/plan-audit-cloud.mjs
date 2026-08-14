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
import { costFromUsage } from '../model-pricing.mjs';
import { openaiConfig } from '../config.mjs';

/**
 * Price a plan-audit result from the usage it carries.
 *
 * Pure and exported so the contract is testable without a store — the defect
 * this closes was invisible precisely because nothing owned it as a unit.
 *
 * Same single-model assumption as the code path's
 * `totalUsage.costUsd = costFromUsage(totalUsage, openaiConfig.model).totalUsd`:
 * every plan pass uses the one resolved audit model, so one price over the
 * aggregate is correct. `costFromUsage` always returns an object whose
 * `totalUsd` is null for an unpriced model, so an honest unknown stays
 * distinguishable from a measured zero — never coerce this to 0.
 *
 * @param {object|null} result - plan-audit result; `_usage` carries the tokens
 * @param {string} [model] - resolved audit model (defaults to the configured one)
 * @returns {number|null} USD, or null when unpriceable/unmetered
 */
export function planRunCostUsd(result, model = openaiConfig.model, usageOverride = null) {
  // `usageOverride` first, and it is the path that actually fires in
  // production. `result._usage` is NOT set on the in-memory result object:
  // `openai-audit.mjs` spreads usage onto the OUTPUT artifact
  // (`{...result, _usage: usage}`) 45 lines AFTER it calls
  // `completePlanAuditRun`, so reading `result._usage` here always saw
  // `undefined` and priced every run as null — the very defect this function
  // was added to fix, still live, with a green unit test beside it because the
  // test handed the function a payload directly and never exercised the
  // wiring. Verified against production 2026-08-14: three plan runs recorded
  // `total_cost_estimate: null` while `planRunCostUsd(<the artifact>)`
  // returned $0.1267 for the same data.
  const usage = usageOverride ?? result?._usage;
  if (!usage || typeof usage !== 'object') return null;
  return costFromUsage(usage, model).totalUsd ?? null;
}

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
 * `planLinkLost` carries the message when the plan upsert failed against a
 * REACHABLE store (durability plan decision 6). It is deliberately distinct
 * from a null `planId`, which a plan-less or cloud-off run produces too — the
 * whole point of the change is that those stop sharing a value. Null on every
 * other path, including the early returns.
 *
 * @returns {Promise<{ cloudRunId: string|null, cloudRepoId: string|null,
 *                     planLinkLost: string|null }>}
 */
export async function registerPlanAuditRun({ repoProfile, planFile, runId = null } = {}) {
  const NONE = { cloudRunId: null, cloudRepoId: null, planLinkLost: null };
  try {
    if (!await isCloudEnabled() || !repoProfile) return NONE;
    const repoRef = await resolveRepoForStore({ profile: repoProfile }).catch(() => null);
    const cloudRepoId = repoRef?.repoRowId ?? null;
    if (!cloudRepoId) return NONE;

    const { commitSha, branch } = await gitAnchor();

    // Register the plan artifact so audit_runs.plan_id links back
    // (cross-skill data-loop joins).
    let planId = null;
    let planLinkLost = null;
    if (planFile) {
      // Discriminated result since 2026-08-12 (durability plan decision 6).
      // Same reasoning as the code-audit path: a store failure must not arrive
      // as the same null a plan-less run produces.
      const planRes = await upsertPlan(cloudRepoId, {
        path: planFile, skill: 'plan', status: 'in_progress', commitSha,
      }).catch((err) => ({ ok: false, reason: 'write-failed', message: err?.message ?? String(err) }));
      if (planRes.ok) {
        planId = planRes.planId;
      } else if (planRes.reason === 'write-failed') {
        // Degrade to a local-only run and SAY so. This path has no
        // `writeOutcomes` tally of its own, so the report is the return value:
        // swallowing it here would leave the plan-audit branch with exactly the
        // silence the code-audit branch just removed.
        planLinkLost = planRes.message;
        process.stderr.write(`  [learning] plan linkage lost: ${planRes.message}\n`);
      } else {
        process.stderr.write(`  [learning] no plan linkage (${planRes.reason}): ${planRes.message}\n`);
      }
    }

    const cloudRunId = await recordRunStart(cloudRepoId, planFile || 'ad-hoc', 'plan', {
      scopeMode: 'plan', commitSha, branch, planId, runId,
    }).catch(() => null);
    return { cloudRunId, cloudRepoId, planLinkLost };
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
 * `costEstimate` is DERIVED here from `result._usage`, not required from the
 * caller. It used to default to null and the only call site
 * (`openai-audit.mjs`) never passed it, so `audit_runs.total_cost_estimate`
 * was NULL on every plan run for the column's entire life — measured
 * 2026-08-14: 0 of 55 plan runs priced against 136 of 178 code runs, with
 * ~$8.10 of GPT spend recoverable only from `.audit/` artifacts that prune at
 * ~14 days. Identical defect to the code path's, fixed 2026-08-08 in
 * `legacy-production-audit.mjs`, in the sibling path — the "fixed in one place
 * of two" shape this repo keeps hitting. A column that is always null does not
 * read as broken; it reads as free.
 *
 * Deriving rather than guarding is the point: the omission is now
 * unrepresentable, because there is no argument for a caller to forget. An
 * explicit `costEstimate` still wins, for a caller that priced it differently.
 *
 * @param {string|null} cloudRunId
 * @param {object} result - the plan-audit result (findings already suppressed/enriched)
 * @param {{ round?: number, durationMs?: number|null, costEstimate?: number|null }} [stats]
 */
export async function completePlanAuditRun(cloudRunId, result, { round = 1, durationMs = null, costEstimate = null, usage = null } = {}) {
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
    // to the Step-7 final gate. `gemini-review.mjs --run-id` genuinely writes
    // it as of 2026-07-18 (via `recordFinalReviewFindings`); before that this
    // comment described an intended design, not a real writer, and the column
    // was NULL on every run. Note `--run-id` is what arms the write, and the
    // automated orchestrators only started threading it the same day; the
    // GPT plan verdict lives on the findings/result artifact. Undefined stats
    // fields are omitted by the db seam's undefined contract, not nulled.
    await recordRunComplete(cloudRunId, {
      rounds: round,
      totalFindings: result.findings.length,
      durationMs,
      costEstimate: costEstimate ?? planRunCostUsd(result, openaiConfig.model, usage),
    });
  } catch (err) {
    process.stderr.write(`  [learning] plan-run completion failed (non-blocking): ${err.message}\n`);
  }
}
