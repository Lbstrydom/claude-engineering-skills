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

// ── Cluster C (Phase 4) readers ───────────────────────────────────────────

/** `audit-effectiveness` — the dashboard precision/recall rollup. */
export async function auditEffectivenessCmd(ctx) {
  if (!ctx.cloud.enabled) return { ...ctx.degrade(), row: null };
  const repoId = ctx.flag('repo-id');
  if (!repoId) throw new CommandError('BAD_INPUT', '--repo-id is required');
  const row = await ctx.deps.readAuditEffectiveness(repoId);
  return { ok: true, cloud: true, row };
}

/** `detect-stack` — local repo-stack detection, schema-validated before emit. */
export async function detectStackCmd(ctx) {
  const { detectRepoStack, detectPythonEnvironmentManager } = await import('../../repo-stack.mjs');
  const { StackProfileSchema } = await import('../../schemas.mjs');
  const cwd = ctx.flag('cwd') || process.cwd();
  const includeEnvManager = ctx.hasFlag('include-env-manager');
  const { stack, pythonFramework, detectedFrom, stackKinds } = detectRepoStack(cwd);
  const profile = {
    ok: true,
    stack,
    pythonFramework,
    environmentManager: includeEnvManager ? detectPythonEnvironmentManager(cwd) : null,
    detectedFrom,
    stackKinds: stackKinds ?? [],
  };
  const parsed = StackProfileSchema.safeParse(profile);
  if (!parsed.success) {
    throw new CommandError('SCHEMA_VIOLATION', 'detect-stack produced invalid profile', { issues: parsed.error.issues });
  }
  return parsed.data;
}

/**
 * `get-nav-first-seen` — when each drift key was first observed.
 *
 * `truncated` rides the envelope so a caller can tell a complete history from
 * a capped one; the empty-history degrade keeps `firstSeen: {}` rather than
 * omitting the field.
 */
export async function getNavFirstSeenCmd(ctx) {
  const p = ctx.payload();
  if (!Array.isArray(p.driftKeys) || p.driftKeys.length === 0) {
    throw new CommandError('BAD_INPUT', 'driftKeys (non-empty array) is required');
  }
  if (!ctx.cloud.enabled) return { ...ctx.degrade(), firstSeen: {} };
  const scope = await ctx.resolveScope();
  const repoId = scope.kind === 'scoped' ? scope.repoId : null;
  if (!repoId) return { ok: true, cloud: true, firstSeen: {} };
  const history = await ctx.deps.listNavAuditRunHistory({ repoId, sinceDays: p.sinceDays ?? undefined });
  if (!history.ok) return { ok: false, cloud: true, firstSeen: {}, error: history.error };
  const { firstSeenFromHistory } = await import('../../nav/drift.mjs');
  const lookup = firstSeenFromHistory(history.rows);
  const firstSeen = {};
  for (const key of p.driftKeys) { const v = lookup(key); if (v) firstSeen[key] = v; }
  return { ok: true, cloud: true, firstSeen, truncated: history.truncated };
}

// ── Cluster D (Phase 5) — durability + friction surfaces ──────────────────

/**
 * `write-spill <status|drain>` — the durable-write spill queue.
 *
 * `audit-store-writers.mjs` is the registry's ONLY bootstrap, so it must be
 * imported before `registeredWriters()` can answer — both this command and the
 * orchestrator import it for that reason.
 */
export async function writeSpillCmd(ctx) {
  const sub = ctx.verb;
  const VERBS = ['status', 'drain'];
  if (!sub || !VERBS.includes(sub)) {
    throw new CommandError('BAD_INPUT', `usage: write-spill <${VERBS.join('|')}> [--cap N]`);
  }
  await import('../../audit-store-writers.mjs');
  const { drainSpill, spillSummary, registeredWriters, DRAIN_CAP } = await import('../../durable-write.mjs');
  const cloud = ctx.cloud.enabled;

  if (sub === 'status') {
    const summary = spillSummary();
    if (summary.state === 'unavailable') {
      throw new CommandError('SPILL_UNREADABLE', summary.reason, { cloud });
    }
    return {
      ok: true,
      cloud,
      spilled: summary.spilled,
      lost: summary.lost,
      oldestAgeMs: summary.oldestAgeMs,
      writers: registeredWriters(),
      drainCap: DRAIN_CAP,
      // `lost/` is an evidence drawer the drain never replays — a writer with
      // no idempotency key cannot be safely retried, so saying so beats a
      // number the operator would read as a replay backlog.
      note: summary.lost > 0
        ? `${summary.lost} artifact(s) in lost/ are evidence only — no writer declared an idempotency key, so they are never replayed`
        : undefined,
    };
  }

  const capRaw = ctx.flag('cap');
  const cap = capRaw ? Number.parseInt(capRaw, 10) : undefined;
  if (capRaw && !(/^\d+$/.test(String(capRaw).trim()) && Number.isInteger(cap) && cap > 0)) {
    throw new CommandError('BAD_INPUT', `--cap must be a positive integer; got ${JSON.stringify(capRaw)}`);
  }
  const res = await drainSpill({ cap, isCloudEnabled: () => ctx.deps.isCloudEnabled() });
  if (res.state === 'unavailable') {
    throw new CommandError('DRAIN_UNAVAILABLE', res.reason, { cloud, ...res });
  }
  return { ok: true, cloud, ...res };
}

/** `friction-log` — `audit:wtf <message>`; forwards argv to friction-log.mjs. */
export async function frictionLogCmd(ctx) {
  const { runFrictionLog } = await import('../../../friction-log.mjs');
  // The sub-CLI's result IS the envelope (a flat `{ok, errors:[…]}` on
  // failure, not this CLI's {code,message} shape) and its `ok` drives the exit
  // code — both preserved by the forwarder contract in dispatch.mjs.
  return runFrictionLog(ctx.forwardArgs);
}

/** `get-friction-neighbourhood` — similar past friction for an intent. */
export async function getFrictionNeighbourhoodCmd(ctx) {
  const p = ctx.payload();
  const { frictionNeighbourhood } = await import('../../friction/commands.mjs');
  return frictionNeighbourhood({
    prompt: p.prompt ?? p.intentDescription ?? ctx.flag('prompt') ?? '',
    k: p.k ?? (ctx.flag('k') ? Number(ctx.flag('k')) : undefined),
  });
}
