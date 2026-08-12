/**
 * @fileoverview Plans-domain registry commands (docs/plans/cross-skill-command-registry.md
 * — Cluster B, Phase 3; `plan-satisfaction` joins in Phase 4).
 *
 * Behaviour-preserving moves of the legacy handlers: same envelope fields,
 * same refusal codes and exit codes, same ordering of store-touching
 * operations. Persistence goes through `ctx.deps` only.
 */
import { CommandError } from '../dispatch.mjs';

/**
 * `upsert-plan` — register a plan artefact, return its UUID.
 *
 * Moved from `cmdUpsertPlan`. The store's discriminated reasons keep their
 * legacy mapping: `write-failed` → PLAN_WRITE_FAILED, `invalid-input` →
 * BAD_INPUT (a caller bug on a command line someone typed). A skill that saw
 * `{ok:true, planId:null}` proceeded as though the plan simply was not
 * registered — the reading that made an outage invisible.
 */
export async function upsertPlanCmd(ctx) {
  const p = ctx.payload();
  if (!p.path || !p.skill) throw new CommandError('BAD_INPUT', 'path and skill are required');
  if (!ctx.cloud.enabled) return { ...ctx.degrade(), planId: null };
  const scope = await ctx.resolveScope();
  const repoId = scope.kind === 'scoped' ? scope.repoId : null;
  const res = await ctx.deps.upsertPlan(repoId, {
    path: p.path,
    skill: p.skill,
    status: p.status,
    principlesCited: p.principlesCited,
    focusAreas: p.focusAreas,
    commitSha: p.commitSha || ctx.git.commitSha(),
    checksum: p.checksum,
  });
  if (!res.ok && res.reason === 'write-failed') {
    throw new CommandError('PLAN_WRITE_FAILED', res.message, { cloud: true });
  }
  if (!res.ok && res.reason === 'invalid-input') {
    throw new CommandError('BAD_INPUT', res.message, { cloud: true });
  }
  // Any OTHER `!res.ok` is still a failure (audit CB-r4). Mapping only the two
  // reasons known TODAY meant a reason added later fell through to
  // `{ok:false, planId:null}` at exit 0 — the store would grow a new failure
  // mode and this command would silently start reporting it as a non-event.
  // Closed-set handling, so the fall-through cannot exist.
  if (!res.ok) {
    throw new CommandError('PLAN_WRITE_FAILED',
      `upsertPlan failed with an unhandled reason "${res.reason ?? 'unknown'}"${res.message ? `: ${res.message}` : ''}`,
      { cloud: true, reason: res.reason ?? null });
  }
  const planId = res.planId;
  // Deterministic arm-eval capture (toggle-gated; detached) — fires when the
  // plan skill includes the original task text in this upsert payload, so
  // capture is part of PERSISTING the plan rather than a skippable trailing
  // step. No-op when the per-repo toggle is off.
  if (p.taskText && String(p.taskText).trim()) {
    try {
      const { maybeFireArmEvalCaptureDetached } = await import('../../arm-eval/capture-trigger.mjs');
      maybeFireArmEvalCaptureDetached({ experimentType: 'plan-authoring', task: p.taskText });
    } catch { /* never block plan persistence on capture */ }
  }
  // Every `!res.ok` now throws, so this is unconditionally a success — the
  // softFail exemption this entry used to need is GONE (audit CB-r4). Kept as
  // `ok: !!planId` only to preserve the field shape a skill reads.
  return { ok: !!planId, cloud: true, planId };
}

/**
 * `update-plan-status` — set a plan's lifecycle status.
 *
 * Moved from `cmdUpdatePlanStatus`. `path` is the ergonomic entry point (a
 * human deciding a plan is done knows the path, not the UUID). Scope resolves
 * on BOTH entry paths — supplying an explicit `planId` used to skip scoping
 * entirely, so the UPDATE could land on another repo's plan row.
 */
export async function updatePlanStatusCmd(ctx) {
  const p = ctx.payload();
  if (!p.planId && !p.path) {
    throw new CommandError('BAD_INPUT', 'one of planId or path is required (path is usually what you know)');
  }
  if (!p.status) throw new CommandError('BAD_INPUT', 'status is required');
  if (!ctx.cloud.enabled) return ctx.degrade();

  let planId = p.planId;
  let resolvedPath = null;
  const scope = await ctx.resolveScope();
  const repoId = scope.kind === 'scoped' ? scope.repoId : null;
  if (!planId) {
    const found = await ctx.deps.getPlanIdByPath(repoId, p.path);
    if (!found.ok) {
      // `not-found` (the plan really is not registered) and `lookup-failed`
      // (the store could not be queried) are different facts that used to
      // arrive under one label — a store outage read as "run the /plan flow
      // first" and invited a duplicate registration.
      const code = found.reason === 'lookup-failed' ? 'PLAN_LOOKUP_FAILED' : 'PLAN_NOT_RESOLVED';
      throw new CommandError(code, found.message, { reason: found.reason ?? null }, 1);
    }
    planId = found.planId;
    resolvedPath = found.path;
  }

  // Report the STORE's answer, not a blanket ok: rowCount 0 means a stale id,
  // an invalid status, or a plan owned by a different repo.
  const res = await ctx.deps.updatePlanStatus({ repoId, planId, status: p.status });
  if (!res.ok) {
    throw new CommandError('STATUS_NOT_UPDATED',
      `no row updated for planId=${planId} — stale id, invalid status, or the plan belongs to another repo`,
      { reason: res.reason ?? null }, 1);
  }
  return { ok: true, cloud: true, planId, path: resolvedPath, status: p.status };
}
