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

/**
 * `record-regression-spec` — /ux-lock writes a new Playwright spec.
 *
 * Moved from `cmdRecordRegressionSpec`. The `!repoId` refusal is load-bearing
 * and stays a hard error: the (repo_id, spec_path) arbiter is a FULL index and
 * a NULL repo_id is distinct from every other NULL in Postgres, so an unscoped
 * row INSERTs a duplicate on every re-run instead of updating.
 */
export async function recordRegressionSpecCmd(ctx) {
  const p = ctx.payload();
  if (!p.sourceKind || !p.description) {
    throw new CommandError('BAD_INPUT', 'sourceKind and description are required');
  }
  if (!p.specPath) throw new CommandError('BAD_INPUT', 'specPath is required');
  if (!ctx.cloud.enabled) return { ...ctx.degrade(), specId: null };
  const scope = await ctx.resolveScope();
  const repoId = scope.kind === 'scoped' ? scope.repoId : null;
  if (!repoId) {
    throw new CommandError('BAD_INPUT',
      'regression specs require a resolved repoId — run resolve-repo-identity --persist first');
  }
  const specId = await ctx.deps.recordRegressionSpec(repoId, {
    specPath: p.specPath ?? null,
    description: p.description,
    commitSha: p.commitSha || ctx.git.commitSha(),
    assertionCount: p.assertionCount,
    domContractTypes: p.domContractTypes,
    sourceKind: p.sourceKind,
    sourceFindingId: p.sourceFindingId,
    sourceFindingType: p.sourceFindingType,
  });
  // Legacy `ok: !!specId` (the store returns null on a swallowed failure) —
  // declared softFail; tightening it changes an envelope /ux-lock reads.
  return { ok: !!specId, cloud: true, specId };
}

/**
 * `record-regression-spec-run` — append a pass/fail run to a spec.
 *
 * Moved from `cmdRecordRegressionSpecRun`. The store reports its own outcome
 * (fixed 2026-08-12): this emitted an unconditional `{ok:true}` while the
 * writer swallowed every error, so a run that never reached the store reported
 * as persisted.
 *
 * NOTE (Cluster F): `specId` is an opaque parent id with no ownership check —
 * the deferred `parent: {table:'regression_specs'}` declaration lands here.
 */
export async function recordRegressionSpecRunCmd(ctx) {
  const p = ctx.payload();
  if (!p.specId || typeof p.passed !== 'boolean') {
    throw new CommandError('BAD_INPUT', 'specId and passed (bool) are required');
  }
  if (!ctx.cloud.enabled) return ctx.degrade();
  const res = await ctx.deps.recordRegressionSpecRun(p.specId, {
    passed: p.passed,
    commitSha: p.commitSha || ctx.git.commitSha(),
    capturedRegression: p.capturedRegression,
    durationMs: p.durationMs,
    errorMessage: p.errorMessage,
    runContext: p.runContext,
  });
  if (!res.ok) {
    throw new CommandError('WRITE_FAILED',
      `regression spec run not persisted: ${res.reason ?? 'unknown'}${res.error ? ` (${res.error})` : ''}`,
      { reason: res.reason ?? null }, 1);
  }
  return { ok: true, cloud: true };
}
