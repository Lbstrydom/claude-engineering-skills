/**
 * @fileoverview Misc registry commands (docs/plans/cross-skill-command-registry.md
 * — Cluster A template trio; grows in Phases 4–5).
 *
 * Handlers here are BEHAVIOUR-PRESERVING moves of the legacy cross-skill.mjs
 * handlers: same envelope fields, same refusal codes, same ordering of
 * store-touching operations. All persistence goes through `ctx.deps` (the
 * store port) — never a direct store import; the conformance suite enforces
 * that via the import graph.
 */
import { CommandError } from '../dispatch.mjs';

/**
 * `whoami` — repo/cloud diagnostics. Moved verbatim from `cmdWhoami`.
 *
 * `cloud:'none'` in the registry: this command REPORTS cloud state as data,
 * so it owns its own `initLearningStore()` + `isCloudEnabled()` reads via
 * the port rather than being gated by the dispatcher.
 */
export async function whoamiCmd(ctx) {
  await ctx.deps.initLearningStore();
  return {
    ok: true,
    cloud: await ctx.deps.isCloudEnabled(),
    commitSha: ctx.git.commitSha(),
    branch: ctx.git.branch(),
  };
}

/**
 * The two closed scope values `record-nav-audit-run` accepts. The store's
 * UNIQUE constraint depends on this being exactly two values — an unknown
 * scope is rejected, never silently folded in.
 */
const NAV_AUDIT_RUN_SCOPES = ['full', 'diff'];

/**
 * `record-nav-audit-run` — /nav-audit run telemetry (WS2). Idempotent by
 * (repoId, headSha, scope). Moved from `cmdRecordNavAuditRun`.
 *
 * The unresolvable-repo branch reports `status:'unavailable'` rather than a
 * clean empty success — an unmeasurable condition is reported as unmeasured.
 */
export async function recordNavAuditRunCmd(ctx) {
  const p = ctx.payload();
  if (!p.headSha) throw new CommandError('BAD_INPUT', 'headSha is required');
  if (!Array.isArray(p.driftKeys)) throw new CommandError('BAD_INPUT', 'driftKeys (array) is required');
  const scope = p.scope ?? 'full';
  if (!NAV_AUDIT_RUN_SCOPES.includes(scope)) {
    throw new CommandError('BAD_INPUT', `scope must be one of ${NAV_AUDIT_RUN_SCOPES.join('|')}, got "${scope}"`);
  }
  if (!ctx.cloud.enabled) return ctx.degrade();
  const repoScope = await ctx.resolveScope();
  const repoId = repoScope.kind === 'scoped' ? repoScope.repoId : null;
  if (!repoId) return { ok: true, cloud: true, status: 'unavailable', note: 'no resolvable repo identity' };
  const result = await ctx.deps.recordNavAuditRun({
    repoId, headSha: p.headSha, scope,
    driftKeys: p.driftKeys,
    findingCounts: p.findingCounts ?? null,
    verifySummary: p.verifySummary ?? null,
    toolVersion: p.toolVersion ?? null,
  });
  // Legacy `ok: result.status !== 'failed'` — declared softFail so the
  // dispatcher's validator cannot fire on the store's own failure shape.
  return { ok: result.status !== 'failed', cloud: true, ...result };
}

/**
 * `learning-record` — generic adaptive-learning decision recorder.
 * Moved from `cmdLearningRecord`.
 *
 * `contextHash` comes from decision-logger's oracle — never re-implemented.
 * The local copy used `JSON.stringify(ctx, Object.keys(ctx).sort())`, whose
 * replacer ARRAY is a recursive property allowlist: every nested object
 * serialised EMPTY, so two contexts differing only below the top level hashed
 * identically, and one column had two writers producing different hashes.
 */
export async function learningRecordCmd(ctx) {
  const p = ctx.payload();
  if (!p.decisionType) throw new CommandError('BAD_INPUT', 'decisionType is required');
  if (!p.context || !p.choice) throw new CommandError('BAD_INPUT', 'context and choice are required');

  const auditBound = p.auditRunId && Number.isInteger(p.round) && Number.isInteger(p.sequence);
  if (!auditBound && !p.externalId) {
    throw new CommandError('BAD_INPUT', 'must provide either (auditRunId, round, sequence) OR externalId');
  }

  if (!ctx.cloud.enabled) return { ...ctx.degrade(), decisionKey: null };

  // Built the same way decision-logger builds it.
  const decisionKey = auditBound
    ? `${p.auditRunId}:${p.decisionType}:r${p.round}:s${p.sequence}`
    : `${p.decisionType}:${p.externalId}`;

  const { contextHash: computeContextHash } = await import('../../learning/decision-logger.mjs');
  const contextHash = computeContextHash(p.context);

  const result = await ctx.deps.insertLearningDecision({
    decisionKey,
    auditRunId: p.auditRunId ?? null,
    decisionType: p.decisionType,
    round: p.round ?? null,
    sequence: p.sequence ?? null,
    externalId: p.externalId ?? null,
    repoId: p.repoId ?? null,
    context: p.context,
    contextHash,
    choice: p.choice,
    outcome: p.outcome ?? null,
  });

  if (!result.ok) throw new CommandError('STORE_ERROR', result.error || 'insert failed', { decisionKey });
  return { ok: true, cloud: true, decisionKey };
}
