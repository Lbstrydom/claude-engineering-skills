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
  const res = await ctx.deps.recordPlanVerificationRun({
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
  // §2b F2: the writer reports its own outcome, so `ok: !!runId` is no longer
  // writable — there is nothing left to infer from. A failed write is a
  // CommandError (exit 1) carrying the store's reason; cloud-off never reaches
  // here (the degrade branch above returns first).
  if (!res.ok) {
    // Exit 1 for a failed write, 2 for a refused input — see the same branch in
    // ship.mjs's recordRegressionSpecCmd for why the two must not collapse.
    const failed = res.reason === 'write-failed';
    throw new CommandError(failed ? 'WRITE_FAILED' : 'BAD_INPUT',
      `recordPlanVerificationRun: ${res.message}`, { reason: res.reason }, failed ? 1 : 2);
  }
  return { ok: true, cloud: true, runId: res.runId };
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
    // Exit 1 — a write that did not verify is an operational failure, not an
    // argv error. This reached here as the default 2, which put a short or
    // failed INSERT in the same bucket as a malformed payload.
    throw new CommandError('WRITE_FAILED',
      `plan verification items not persisted: ${res?.message ?? res?.reason ?? 'unknown'}`,
      { reason: res?.reason, inserted: res?.inserted ?? 0, requested: p.items.length }, 1);
  }
  return { ok: true, cloud: true, inserted: res.inserted, requested: p.items.length };
}
