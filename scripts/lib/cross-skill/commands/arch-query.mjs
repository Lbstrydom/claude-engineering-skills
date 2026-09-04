/**
 * @fileoverview Architectural-memory READ commands (docs/plans/cross-skill-command-registry.md
 * — Cluster C, Phase 4).
 *
 * The read half of the split the audit forced (R1-M2): `arch-refresh.mjs` owns
 * the refresh lifecycle and symbol writes, this module owns identity,
 * snapshots, the neighbourhood queries and the graph reads.
 *
 * Behaviour-preserving moves. Every degrade path is byte-identical to legacy,
 * which matters more here than for writers: these commands exist to keep an
 * EMPTY result and an UNMEASURED result apart (`repoFound:false`,
 * `snapshotProvenance`, `degraded:'no-embed-provider'`), and collapsing any of
 * them would re-create the false-zero class the whole plan is about.
 */
import { CommandError } from '../dispatch.mjs';
import { resolveRepoIdentity, persistRepoIdentity } from '../../repo-identity.mjs';

/** Legacy `try { … } catch { emitError(err.code || 'EXCEPTION', …) }` shape. */
async function passthroughErrors(fn) {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof CommandError) throw err;
    throw new CommandError(err.code || 'EXCEPTION', err.message);
  }
}

/** `resolve-repo-identity` — the stable repo_uuid for this checkout. */
export async function resolveRepoIdentityCmd(ctx) {
  const cwd = ctx.flag('cwd') || process.cwd();
  const persist = ctx.hasFlag('persist');
  const id = resolveRepoIdentity(cwd);
  if (persist) persistRepoIdentity(id.repoUuid, cwd);
  return { ok: true, ...id, persisted: persist };
}

/**
 * `get-active-refresh-id` — the published snapshot pointer for a repo.
 *
 * `repoFound:false` is load-bearing and distinct from a null refreshId: an
 * unindexed repo and an indexed repo with no published snapshot are different
 * facts, and the consumer branches on them.
 */
export async function getActiveRefreshIdCmd(ctx) {
  if (!ctx.cloud.enabled) return { ...ctx.degrade(), refreshId: null };
  const repoUuid = ctx.flag('repo-uuid');
  if (!repoUuid) throw new CommandError('BAD_INPUT', '--repo-uuid required');
  const repo = await ctx.deps.getRepoIdByUuid(repoUuid);
  if (!repo) return { ok: true, cloud: true, repoFound: false, refreshId: null };
  const snap = await ctx.deps.getActiveSnapshot(repo.id);
  return {
    ok: true,
    cloud: true,
    repoFound: true,
    refreshId: snap?.refreshId || null,
    activeEmbeddingModel: snap?.activeEmbeddingModel || null,
    activeEmbeddingDim: snap?.activeEmbeddingDim || null,
  };
}

/** `compute-target-domains` — pure, local: map paths to domain tags. */
export async function computeTargetDomainsCmd(ctx) {
  const p = ctx.payload();
  if (!p.targetPaths || !Array.isArray(p.targetPaths)) {
    throw new CommandError('BAD_INPUT', 'targetPaths array required', {}, 1);
  }
  // Lazy import — keeps cold-start cheap.
  const { loadDomainRules, computeTargetDomains } = await import('../../symbol-index/domain-tagger.mjs');
  const rules = loadDomainRules(process.cwd());
  const result = computeTargetDomains(p.targetPaths, rules);
  return { ok: true, ...result, ruleCount: rules.length };
}

/**
 * Resolve the repo this invocation is running IN, for the snapshot reads whose
 * only argument is a bare refresh id.
 *
 * These two commands take a `refreshId` and no tenant key, so the store read
 * used to be scoped by `refresh_id` alone — it would happily return another
 * repo's snapshot to whoever named its id. The repo is resolved from `cwd`
 * instead of being added as a flag, the same way `getCallersForFileCmd` below
 * already does it, so no documented recipe grows a required argument:
 * `skills/audit-code/SKILL.md` Step 0.5 keeps working verbatim.
 *
 * BEHAVIOUR CHANGE, stated deliberately: running one of these from a different
 * checkout than the repo whose snapshot is named now yields
 * `repoFound:false` + `rows: []` instead of that other repo's rows. That is the
 * correct answer — the question a repo-scoped tool answers is "…in the repo I
 * am in" — but it is NOT reported silently. `repoFound:false` is the same
 * discriminator `getActiveRefreshIdCmd` already publishes, and the reason
 * string names the cwd, because an empty result that means "wrong checkout"
 * and one that means "no violations" are different facts and the caller
 * branches on them. This mirrors `getActiveSnapshot`'s corrupt-pointer
 * handling: refuse to answer, loudly, rather than answer unverified.
 *
 * Returns `{repo}` on success, or `{miss}` — a ready-to-return envelope.
 */
async function resolveOwningRepo(ctx, emptyShape) {
  const cwd = process.cwd();
  const repoUuid = resolveRepoIdentity(cwd).repoUuid;
  const repo = await ctx.deps.getRepoIdByUuid(repoUuid);
  if (!repo) {
    process.stderr.write(
      `  [arch] this checkout (${cwd}) is not indexed in the audit store, so a snapshot `
      + `read cannot be bound to it — returning no rows rather than rows belonging to `
      + `whichever repo owns that refresh id. Run \`node scripts/symbol-index/refresh.mjs\` here.\n`,
    );
    return {
      miss: {
        ok: true, cloud: true, repoFound: false,
        reason: 'repo-not-indexed', ...emptyShape,
      },
    };
  }
  return { repo };
}

/** `list-symbols-for-snapshot` — the symbol rows of one refresh, in THIS repo. */
export async function listSymbolsForSnapshotCmd(ctx) {
  const p = ctx.payload();
  if (!p.refreshId) throw new CommandError('BAD_INPUT', 'refreshId required');
  // Ordered so the two pinned envelopes are byte-identical: BAD_INPUT still
  // precedes everything, and cloud-off still degrades before any repo lookup
  // (which would need a store). See tests/fixtures/cross-skill-envelopes.json.
  if (!ctx.cloud.enabled) return { ...ctx.degrade(), rows: [] };
  const owner = await resolveOwningRepo(ctx, { rows: [], count: 0 });
  if (owner.miss) return owner.miss;
  return passthroughErrors(async () => {
    // `repoId` is set from the resolved repo, never from the payload — a
    // caller-supplied tenant key would let the very confusion this closes be
    // re-declared as an argument.
    const rows = await ctx.deps.listSymbolsForSnapshot({ ...p, repoId: owner.repo.id });
    return { ok: true, cloud: true, repoFound: true, rows, count: rows.length };
  });
}

/** `list-layering-violations-for-snapshot` — the violations of one refresh, in THIS repo. */
export async function listLayeringViolationsForSnapshotCmd(ctx) {
  const refreshId = ctx.flag('refresh-id');
  if (!refreshId) throw new CommandError('BAD_INPUT', '--refresh-id required');
  if (!ctx.cloud.enabled) return { ...ctx.degrade(), rows: [] };
  const owner = await resolveOwningRepo(ctx, { rows: [] });
  if (owner.miss) return owner.miss;
  return passthroughErrors(async () => {
    const rows = await ctx.deps.listLayeringViolationsForSnapshot(refreshId, owner.repo.id);
    return { ok: true, cloud: true, repoFound: true, rows };
  });
}

/** `compute-drift-score` — snapshot drift for a repo. */
export async function computeDriftScoreCmd(ctx) {
  const p = ctx.payload();
  if (!p.repoId || !p.refreshId) throw new CommandError('BAD_INPUT', 'repoId and refreshId required');
  if (!ctx.cloud.enabled) return { ...ctx.degrade(), drift: null };
  return passthroughErrors(async () => {
    const drift = await ctx.deps.computeDriftScore(p);
    return { ok: true, cloud: true, drift };
  });
}

/**
 * `get-callers-for-file` — importers of a file, with their domain tags.
 *
 * The `snapshotProvenance` ladder is the point of this command: zero importers
 * is AMBIGUOUS unless the snapshot's import graph is known-populated, so every
 * not-yet-answerable state names itself (`cloud-disabled`, `repo-not-indexed`,
 * `no-active-snapshot`, `pre-feature-snapshot`) instead of returning a clean
 * empty list. Collapsing any of these is the false-zero class.
 */
export async function getCallersForFileCmd(ctx) {
  const p = ctx.payload();
  if (typeof p.path !== 'string' || p.path.length === 0) {
    throw new CommandError('BAD_INPUT', 'path required', {}, 1);
  }
  if (!ctx.cloud.enabled) {
    return { ok: true, cloud: false, callers: [], callerDomains: [], snapshotProvenance: 'cloud-disabled' };
  }
  const repoUuid = resolveRepoIdentity(process.cwd()).repoUuid;
  const repo = await ctx.deps.getRepoIdByUuid(repoUuid);
  if (!repo) {
    return { ok: true, cloud: true, callers: [], callerDomains: [], snapshotProvenance: 'repo-not-indexed' };
  }
  const snap = await ctx.deps.getActiveSnapshot(repo.id);
  if (!snap?.refreshId) {
    return { ok: true, cloud: true, callers: [], callerDomains: [], snapshotProvenance: 'no-active-snapshot' };
  }
  if (snap.importGraphPopulated !== true) {
    return { ok: true, cloud: true, callers: [], callerDomains: [], snapshotProvenance: 'pre-feature-snapshot' };
  }
  const { tagDomain, loadDomainRules } = await import('../../symbol-index/domain-tagger.mjs');
  const rules = loadDomainRules(process.cwd());

  let importers;
  try {
    importers = await ctx.deps.getImportersForFiles({ refreshId: snap.refreshId, repoId: repo.id, paths: [p.path] });
  } catch (err) {
    throw new CommandError('RPC_ERROR', `getImportersForFiles failed: ${err.message}`);
  }
  const importerPaths = importers.get(p.path) || [];
  const callers = importerPaths.map((ip) => ({ importer_path: ip, domain: tagDomain(ip, rules) }));
  const callerDomains = Array.from(new Set(callers.map((c) => c.domain).filter((d) => d != null))).sort();
  return { ok: true, cloud: true, callers, callerDomains, snapshotProvenance: 'import-graph-populated' };
}

/**
 * `get-neighbourhood` — the architectural-memory consultation.
 *
 * Provider-ABSENT (a deterministic config state) degrades exactly like
 * cloud-disabled: the consultation contract is "log a hint, proceed
 * greenfield", and a fresh install with a DSN but no embedding provider must
 * not read as fatal. Provider ERRORS still surface (2026-07-14 installer audit).
 */
export async function getNeighbourhoodCmd(ctx) {
  const p = ctx.payload();
  if (!ctx.cloud.enabled) {
    return {
      ok: true, cloud: false, refreshId: null, records: [], totalCandidatesConsidered: 0,
      truncated: false, hint: 'cloud disabled — run `npm run arch:refresh` to enable',
    };
  }
  const { isEmbedProviderAvailable } = await import('../../embed-text.mjs');
  if (!await isEmbedProviderAvailable()) {
    return {
      ok: true, cloud: true, refreshId: null, records: [], totalCandidatesConsidered: 0,
      truncated: false, degraded: 'no-embed-provider',
      hint: 'no embedding provider — set GEMINI_API_KEY (or activate the Azure profile) to enable neighbourhood consultation',
    };
  }
  const repoUuid = p.repoUuid || resolveRepoIdentity(process.cwd()).repoUuid;
  const { getNeighbourhoodForIntent } = await import('../../neighbourhood-query.mjs');
  try {
    const out = await getNeighbourhoodForIntent({
      getRepoIdByUuid: ctx.deps.getRepoIdByUuid,
      getActiveSnapshot: ctx.deps.getActiveSnapshot,
      getBandCalibration: ctx.deps.getBandCalibration,
      callNeighbourhoodRpc: (args) => ctx.deps.callNeighbourhoodRpc(args),
    }, { ...p, repoUuid });
    return { ok: true, cloud: true, ...out };
  } catch (err) {
    throw new CommandError(err.code || 'EXCEPTION', err.message, {
      issues: err.issues, expected: err.expected, available: err.available,
    });
  }
}

/** `get-incident-neighbourhood` — the security-memory sibling of the above. */
export async function getIncidentNeighbourhoodCmd(ctx) {
  const p = ctx.payload();
  if (!ctx.cloud.enabled) {
    return {
      ok: true, cloud: false, records: [], totalCandidatesConsidered: 0,
      freshnessWarning: null, hint: 'cloud disabled — security memory unavailable',
    };
  }
  const { isEmbedProviderAvailable } = await import('../../embed-text.mjs');
  if (!await isEmbedProviderAvailable()) {
    return {
      ok: true, cloud: true, records: [], totalCandidatesConsidered: 0,
      freshnessWarning: null, degraded: 'no-embed-provider',
      hint: 'no embedding provider — set GEMINI_API_KEY (or activate the Azure profile) to enable incident consultation',
    };
  }
  const repoUuid = p.repoUuid || resolveRepoIdentity(process.cwd()).repoUuid;
  const { getIncidentNeighbourhoodForIntent } = await import('../../neighbourhood-query.mjs');
  try {
    const wrapped = await getIncidentNeighbourhoodForIntent({
      getRepoIdByUuid: ctx.deps.getRepoIdByUuid,
      getActiveSnapshot: ctx.deps.getActiveSnapshot,
      callIncidentNeighbourhoodRpc: (args) => ctx.deps.callIncidentNeighbourhoodRpc(args),
      getMaxIncidentRefreshAt: (repoId) => ctx.deps.getMaxIncidentRefreshAt(repoId),
    }, { ...p, repoUuid });
    // R-Gemini-G4: unwrap .result for the flat CLI JSON shape.
    return { ok: true, cloud: true, ...wrapped.result, _usage: wrapped.usage, _latencyMs: wrapped.latencyMs };
  } catch (err) {
    throw new CommandError(err.code || 'EXCEPTION', err.message, { issues: err.issues });
  }
}
