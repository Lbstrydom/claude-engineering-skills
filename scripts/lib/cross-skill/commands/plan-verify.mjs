/**
 * @fileoverview Plan-verification registry commands (docs/plans/cross-skill-command-registry.md
 * — Cluster B, Phase 3). Split from `plans.mjs` per audit R1-M2: verification
 * is its own store seam, and it is the seam Cluster F's ownership join lands on.
 *
 * Behaviour-preserving moves. Persistence goes through `ctx.deps` only.
 */
import { CommandError } from '../dispatch.mjs';
import { validateCountFields } from '../../command-input.mjs';

/**
 * `record-plan-verify-run` — /ux-lock verify writes its run.
 *
 * Moved from `cmdRecordPlanVerifyRun`. Count validation runs BEFORE repo
 * resolution or any store call: `typeof n === 'number'` used to admit NaN,
 * negatives and fractions straight into the database, and a NaN peer is worse
 * than a NaN total because a satisfaction percentage derived from it renders
 * as a plausible number.
 *
 * NOTE (Cluster F): `planId` is an opaque parent id with no ownership check —
 * the deferred `parent: {table:'plans'}` declaration lands here.
 */
export async function recordPlanVerifyRunCmd(ctx) {
  const p = ctx.payload();
  if (!p.planId) throw new CommandError('BAD_INPUT', 'planId is required');
  const counts = validateCountFields(p);
  if (!counts.ok) throw new CommandError('BAD_INPUT', counts.reason);
  if (!ctx.cloud.enabled) return { ...ctx.degrade(), runId: null };
  const runId = await ctx.deps.recordPlanVerificationRun({
    planId: p.planId,
    specId: p.specId,
    commitSha: p.commitSha || ctx.git.commitSha(),
    url: p.url,
    totalCriteria: p.totalCriteria,
    passedCount: p.passedCount || 0,
    failedCount: p.failedCount || 0,
    skippedCount: p.skippedCount || 0,
    durationMs: p.durationMs,
    runContext: p.runContext || 'ux-lock-verify',
  });
  // Legacy `ok: !!runId` — the store returns null on a swallowed failure.
  // Declared softFail so the ok:true validator cannot fire on that legacy
  // shape; tightening it to a throw is Cluster F's call (it changes an
  // envelope the /ux-lock skill reads).
  return { ok: !!runId, cloud: true, runId };
}

/**
 * `record-plan-verify-items` — the per-criterion rows for a verify run.
 *
 * Moved from `cmdRecordPlanVerifyItems`. Reports what the store PERSISTED,
 * never what it was asked to persist: every failure path in
 * `recordPlanVerificationItems` logs and swallows, so `p.items.length` would
 * claim a write that may not have happened at all.
 */
export async function recordPlanVerifyItemsCmd(ctx) {
  const p = ctx.payload();
  if (!p.runId || !p.planId || !Array.isArray(p.items) || p.items.length === 0) {
    throw new CommandError('BAD_INPUT', 'runId, planId, and non-empty items array are required');
  }
  if (!ctx.cloud.enabled) return { ...ctx.degrade(), inserted: 0 };
  const res = await ctx.deps.recordPlanVerificationItems(p.runId, p.planId, p.items);
  if (!res?.ok) {
    throw new CommandError('WRITE_FAILED', `plan verification items not persisted: ${res?.reason ?? 'unknown'}`);
  }
  return { ok: true, cloud: true, inserted: res.inserted, requested: p.items.length };
}
