/**
 * @fileoverview Ship-domain registry commands (docs/plans/cross-skill-command-registry.md
 * — Cluster A template trio; grows in Phases 3–4).
 *
 * Behaviour-preserving moves of the legacy handlers: same envelope fields,
 * same refusal codes and exit codes, same ordering of store-touching
 * operations. Persistence goes through `ctx.deps` only.
 */
import { CommandError } from '../dispatch.mjs';

/**
 * `record-ship-event` — /ship writes its outcome. Moved from
 * `cmdRecordShipEvent`; the write template for every Cluster B migration:
 * validate → cloud degrade → lazy scope → port write → map the store's
 * discriminated result (`{ok:false}` becomes a thrown CommandError, never a
 * returned envelope — the unverified-write-success class F2 stays dead).
 */
export async function recordShipEventCmd(ctx) {
  const p = ctx.payload();
  if (!p.outcome) throw new CommandError('BAD_INPUT', 'outcome is required');
  if (!ctx.cloud.enabled) return ctx.degrade();
  const scope = await ctx.resolveScope();
  const repoId = scope.kind === 'scoped' ? scope.repoId : null;
  const res = await ctx.deps.recordShipEvent(repoId, {
    commitSha: p.commitSha || ctx.git.commitSha(),
    branch: p.branch || ctx.git.branch(),
    outcome: p.outcome,
    blockReasons: p.blockReasons,
    openP0Count: p.openP0Count,
    openP1Count: p.openP1Count,
    missingSpecCount: p.missingSpecCount,
    overriddenByUser: p.overriddenByUser,
    overrideFlag: p.overrideFlag,
    stackDetected: p.stackDetected,
    framework: p.framework,
    durationMs: p.durationMs,
  });
  if (!res.ok) {
    throw new CommandError('WRITE_FAILED',
      `ship event not persisted: ${res.reason ?? 'unknown'}${res.error ? ` (${res.error})` : ''}`,
      { reason: res.reason ?? null }, 1);
  }
  return { ok: true, cloud: true };
}
