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
  // The FIELD NAMES must match the payload. `validateCountFields(p)` with its
  // defaults checks passedCriteria/failedCriteria/skippedCriteria, and this
  // command's payload carries passedCount/failedCount/skippedCount — so every
  // optional field was `undefined`, skipped, and the validator returned ok for
  // `passedCount: -5`. Accepted, validated, and inert: a guard satisfied by its
  // own presence, which is why four audit rounds reported these counts as
  // unvalidated while a validator sat right here. Confirmed by executing it.
  const counts = validateCountFields(p, {
    required: ['totalCriteria'],
    optional: ['passedCount', 'failedCount', 'skippedCount'],
  });
  if (!counts.ok) throw new CommandError('BAD_INPUT', counts.reason);
  if (!ctx.cloud.enabled) return { ...ctx.degrade(), runId: null };
  // D7 / Phase 8: thread the RESOLVED repo into the writer's parent join.
  // `null` for unresolved/none scope relaxes the TENANT predicate only — the
  // parent-existence join always applies, so a dangling id is refused either
  // way. The registry's `parent:` declaration is for conformance; the SQL is
  // the enforcement.
  const scope = await ctx.resolveScope();
  const repoId = scope.kind === 'scoped' ? scope.repoId : null;
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
  }, { repoId });
  // §2b F2: the writer reports its own outcome, so `ok: !!runId` is no longer
  // writable — there is nothing left to infer from. A failed write is a
  // CommandError (exit 1) carrying the store's reason; cloud-off never reaches
  // here (the degrade branch above returns first).
  if (!res.ok) {
    // Exit 1 for a failed write, 2 for a refused input — see the same branch in
    // ship.mjs's recordRegressionSpecCmd for why the two must not collapse.
    // An ownership refusal gets its OWN code: 'that plan does not exist' and
    // 'that plan belongs to another repository' are different things for the
    // operator to do next, and both are exit 1 (we tried; it did not work).
    const code = res.reason === 'parent-not-found' ? 'PARENT_NOT_FOUND'
      : res.reason === 'parent-not-owned' ? 'PARENT_NOT_OWNED'
        : res.reason === 'write-failed' ? 'WRITE_FAILED' : 'BAD_INPUT';
    throw new CommandError(code,
      `recordPlanVerificationRun: ${res.message}`, { reason: res.reason }, code === 'BAD_INPUT' ? 2 : 1);
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
  // D7 / Phase 8: thread the RESOLVED repo into the writer's parent join.
  // `null` for unresolved/none scope relaxes the TENANT predicate only — the
  // parent-existence join always applies, so a dangling id is refused either
  // way. The registry's `parent:` declaration is for conformance; the SQL is
  // the enforcement.
  const scope = await ctx.resolveScope();
  const repoId = scope.kind === 'scoped' ? scope.repoId : null;
  const res = await ctx.deps.recordPlanVerificationItems(p.runId, p.planId, p.items, { repoId });
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
