/**
 * @fileoverview Architectural-memory REFRESH-PIPELINE registry commands
 * (docs/plans/cross-skill-command-registry.md — Cluster B, Phase 3).
 *
 * Split from the first draft's single `arch-memory.mjs` per audit R1-M2: that
 * module bundled 15 commands across refresh lifecycle, symbol writes and graph
 * reads — a mini god-module inside the fix for one. Reads live in
 * `arch-query.mjs` (Cluster C).
 *
 * These are internal pipeline steps invoked by `arch:refresh`, which resolves
 * the repo id itself immediately before calling them; that is why they declare
 * `scope: 'none'` and take `repoId` from the payload. Behaviour-preserving
 * moves — every one keeps its legacy envelope, refusal codes and exit codes.
 */
import { CommandError } from '../dispatch.mjs';

/**
 * Wrap the legacy `try { … } catch (err) { emitError(err.code || 'EXCEPTION', err.message) }`
 * shape shared by every handler in this module. The store functions throw
 * typed errors; the legacy code surfaced `err.code` when present and fell back
 * to EXCEPTION, at exit 2 (emitError's default) — preserved exactly.
 */
async function passthroughErrors(fn) {
  try {
    return await fn();
  } catch (err) {
    // A CommandError raised INSIDE fn is this handler's own deliberate
    // refusal — re-throw it untouched. Re-wrapping would silently drop its
    // `extra` and `exitCode` (PUBLISH_NOT_CONFIRMED and ABORT_NOT_APPLIED are
    // exit 1 with payload; the wrapper would demote them to a bare exit 2),
    // which is a byte-compat break invisible to a reader of the catch.
    if (err instanceof CommandError) throw err;
    throw new CommandError(err.code || 'EXCEPTION', err.message);
  }
}

/**
 * Both batch writers use ON CONFLICT DO UPDATE, so a successful chunk's
 * rowCount EQUALS the rows attempted (the store warns on any mismatch). That
 * makes the honest check "wrote everything", not "wrote something":
 *
 *  - a non-integer result (undefined/NaN from a store-shape change) is not
 *    evidence of a write at all — the earlier `n === 0` test passed it
 *    straight through as success (audit CB-r1);
 *  - a PARTIAL count means rows were silently dropped, which is the
 *    unverified-write-success shape wearing a plausible number.
 *
 * An empty request stays a legitimate no-op.
 */
function assertWroteEverything(fnName, n, requested) {
  if (!Number.isInteger(n)) {
    throw new CommandError('WRITE_UNVERIFIED',
      `${fnName} returned ${JSON.stringify(n)} instead of a row count — refusing to report a write it cannot confirm`,
      { cloud: true, requested, inserted: null }, 1);
  }
  // EXACT cardinality, both directions (audit CB-r2): one row per input means
  // `n === requested`. Rejecting only short counts left an OVER-count — which
  // is equally evidence the contract does not hold — reading as success.
  if (requested > 0 && n !== requested) {
    throw new CommandError(n === 0 ? 'NO_ROWS_WRITTEN' : 'ROW_COUNT_MISMATCH',
      `${fnName} was given ${requested} row(s) and reported ${n} — these writers upsert exactly one row per `
      + 'input, so any other count means the write did not do what was asked',
      { cloud: true, requested, inserted: n }, 1);
  }
}

/** `open-refresh-run` — start a refresh, minting the repo row if needed. */
export async function openRefreshRunCmd(ctx) {
  const p = ctx.payload();
  if (!p.repoUuid || !p.mode) throw new CommandError('BAD_INPUT', 'repoUuid and mode required');
  return passthroughErrors(async () => {
    let repo = await ctx.deps.getRepoIdByUuid(p.repoUuid);
    if (!repo) {
      const newRepo = await ctx.deps.upsertRepoByUuid({ repoUuid: p.repoUuid, name: p.name || 'unknown' });
      if (!newRepo) throw new CommandError('UPSERT_FAILED', 'could not create audit_repos row');
      repo = { id: newRepo.id };
    }
    const run = await ctx.deps.openRefreshRun({
      repoId: repo.id, mode: p.mode, walkStartCommit: p.walkStartCommit,
    });
    // A refresh with no id is not an opened refresh (audit CB-r3 — the same
    // receipt discipline the batch writers got; leaving the sibling unguarded
    // is how "fixed one instance, missed the twin" keeps happening here).
    // Every downstream step keys on refreshId, so emitting ok:true without one
    // hands the pipeline an undefined key.
    if (!run?.refreshId) {
      throw new CommandError('REFRESH_NOT_OPENED',
        `openRefreshRun returned no refreshId for repo ${repo.id} — refusing to report an opened refresh that has no id`,
        { cloud: true, repoId: repo.id }, 1);
    }
    return { ok: true, cloud: true, repoId: repo.id, ...run };
  });
}

/**
 * `publish-refresh-run` — atomic promote via the publish_refresh_run RPC.
 *
 * Asserts the RPC's own `ok` rather than assuming it (2026-08-12): the live
 * SQL RAISEs on all three failure modes, so this branch genuinely means
 * "published" — but the sibling abort fails closed, and an asymmetry between
 * two lifecycle commands is how the next reader concludes the unchecked one
 * is fine.
 */
export async function publishRefreshRunCmd(ctx) {
  const p = ctx.payload();
  if (!p.repoId || !p.refreshId) throw new CommandError('BAD_INPUT', 'repoId and refreshId required');
  return passthroughErrors(async () => {
    const r = await ctx.deps.publishRefreshRun({ repoId: p.repoId, refreshId: p.refreshId });
    if (!r || r.ok !== true) {
      throw new CommandError('PUBLISH_NOT_CONFIRMED',
        `publish_refresh_run returned no confirmation for refresh ${p.refreshId} — treating an unconfirmed publish as a failure`,
        { cloud: true, result: r ?? null }, 1);
    }
    return { ok: true, cloud: true, result: r };
  });
}

/**
 * `abort-refresh-run` — terminate a running refresh.
 *
 * Fails closed when nothing was aborted (2026-08-12): the store half was fixed
 * to return `aborted:false` for a wrong-repo or already-terminal run, and the
 * CLI wrapped that honest false in `ok:true` — surfacing the real outcome only
 * as a data field a shell caller checking `.ok` never reads.
 */
export async function abortRefreshRunCmd(ctx) {
  const p = ctx.payload();
  if (!p.repoId || !p.refreshId) throw new CommandError('BAD_INPUT', 'repoId and refreshId required');
  return passthroughErrors(async () => {
    const { aborted } = await ctx.deps.abortRefreshRun({ refreshId: p.refreshId, repoId: p.repoId, reason: p.reason });
    if (!aborted) {
      throw new CommandError('ABORT_NOT_APPLIED',
        `refresh run ${p.refreshId} was not aborted — no running row for that id under repo ${p.repoId} `
        + '(wrong repo, already published, or already terminal). Nothing was changed.',
        { cloud: true, aborted: false }, 1);
    }
    return { ok: true, cloud: true, aborted };
  });
}

/** `record-symbol-definitions` — upsert definitions, return the id map. */
export async function recordSymbolDefinitionsCmd(ctx) {
  const p = ctx.payload();
  if (!p.repoId || !Array.isArray(p.definitions)) {
    throw new CommandError('BAD_INPUT', 'repoId and definitions required');
  }
  return passthroughErrors(async () => {
    const map = await ctx.deps.recordSymbolDefinitions(p.repoId, p.definitions);
    // Same receipt discipline as the batch writers (audit CB-r3): the map is
    // this command's entire product — every later pipeline step resolves
    // definition ids through it — so a non-empty request that yields no
    // mapping is a write that did not happen, not a quiet success.
    const mapped = map && typeof map === 'object' ? Object.keys(map).length : null;
    if (p.definitions.length > 0 && !mapped) {
      throw new CommandError('WRITE_UNVERIFIED',
        `recordSymbolDefinitions was given ${p.definitions.length} definition(s) and returned no id mapping — `
        + 'refusing to report a write it cannot confirm',
        { cloud: true, requested: p.definitions.length }, 1);
    }
    return { ok: true, cloud: true, definitionMap: map };
  });
}

/**
 * `record-symbol-index` — the per-snapshot symbol rows.
 *
 * The zero-against-non-empty check is load-bearing: these use ON CONFLICT DO
 * UPDATE, so a successful chunk's rowCount equals the rows attempted (the
 * store warns on any mismatch). A ZERO against a non-empty request is an
 * RLS-filtered or otherwise silently-dropped batch, and reporting it as
 * `{ok:true}` is the unverified-write-success shape.
 */
export async function recordSymbolIndexCmd(ctx) {
  const p = ctx.payload();
  if (!p.refreshId || !p.repoId || !Array.isArray(p.rows)) {
    throw new CommandError('BAD_INPUT', 'refreshId, repoId, rows required');
  }
  return passthroughErrors(async () => {
    const n = await ctx.deps.recordSymbolIndex(p.refreshId, p.repoId, p.rows);
    assertWroteEverything('recordSymbolIndex', n, p.rows.length);
    return { ok: true, cloud: true, inserted: n, requested: p.rows.length };
  });
}

/** `record-symbol-embedding` — one embedding vector for a definition. */
export async function recordSymbolEmbeddingCmd(ctx) {
  const p = ctx.payload();
  if (!p.definitionId || !p.embeddingModel || !p.dimension || !Array.isArray(p.vector)) {
    throw new CommandError('BAD_INPUT', 'definitionId, embeddingModel, dimension, vector required');
  }
  return passthroughErrors(async () => {
    await ctx.deps.recordSymbolEmbedding(p);
    return { ok: true, cloud: true };
  });
}

/** `record-layering-violations` — same zero-against-non-empty check as the index. */
export async function recordLayeringViolationsCmd(ctx) {
  const p = ctx.payload();
  if (!p.refreshId || !p.repoId || !Array.isArray(p.violations)) {
    throw new CommandError('BAD_INPUT', 'refreshId, repoId, violations required');
  }
  return passthroughErrors(async () => {
    const n = await ctx.deps.recordLayeringViolations(p.refreshId, p.repoId, p.violations);
    assertWroteEverything('recordLayeringViolations', n, p.violations.length);
    return { ok: true, cloud: true, inserted: n, requested: p.violations.length };
  });
}

/** `set-active-embedding-model` — pin the repo's active embedding space. */
export async function setActiveEmbeddingModelCmd(ctx) {
  const p = ctx.payload();
  if (!p.repoId || !p.model || !p.dim) throw new CommandError('BAD_INPUT', 'repoId, model, dim required');
  return passthroughErrors(async () => {
    await ctx.deps.setActiveEmbeddingModel({ repoId: p.repoId, model: p.model, dim: p.dim });
    return { ok: true, cloud: true };
  });
}
