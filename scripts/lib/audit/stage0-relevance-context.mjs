/**
 * @fileoverview Evidence/file-read caching for Stage 0 (docs/plans/stage0-evidence-relevance-split.md)
 * — the per-run relevance context and the blame/impact/head-content adapters
 * built from it.
 *
 * Extracted from `tiered-pipeline.mjs` (docs/plans/tiered-pipeline-refresh-god-module-decomposition.md).
 *
 * @module scripts/lib/audit/stage0-relevance-context
 */

import path from 'node:path';
import { safeReadFile } from '../file-io.mjs';
import { contentExistsAtMappedRange, gitShowFileAtRevision } from '../vcs.mjs';
import { getFreshImportersOrNull } from '../store/arch/imports.mjs';
import { resolveRepoIdentity } from '../repo-identity.mjs';

/**
 * Distinct file paths any envelope's evidence anchors (canonical OR
 * alternative) could resolve to — a superset, since Gate A's fallback may
 * promote an alternative whose anchor points at a different file than the
 * canonical claim.
 */
export function collectCandidateAnchorFiles(envelopes) {
  const files = new Set();
  const addAnchor = (anchor) => {
    if (!anchor) return;
    const fp = anchor.side === 'base' ? anchor.oldFile : anchor.newFile;
    if (fp) files.add(fp);
  };
  for (const env of envelopes) {
    addAnchor(env.canonicalFinding?.anchor);
    addAnchor(env.canonicalFinding?.triggerAnchor);
    for (const alt of env.evidenceAlternatives || []) {
      addAnchor(alt?.anchor);
      addAnchor(alt?.triggerAnchor);
    }
  }
  return [...files];
}

/**
 * Build the run-scoped caching layer the real `blameAdapter`/`impactAdapter`/
 * `headContentAdapter` closures need (decision #5, round-3 H3's deferred
 * caching-structure spec). Constructed ONCE per pipeline run, BEFORE
 * `runStage0EvidenceTriage` — `impactAdapter` must be fully SYNCHRONOUS
 * (evidence-triage.mjs's `tagPreExisting` calls it with no `await`, an
 * already-tested Cluster A contract this phase does not reopen), but
 * `getFreshImportersOrNull` is an async DB query — so the import-graph
 * independence check for every distinct candidate file is resolved HERE, up
 * front, into a plain sync-lookup Map; the adapter itself never touches the
 * network. `headContentCache`/`baseContentCache` are likewise precomputed
 * per DISTINCT candidate file (never per Gate-B call) — each file's content
 * is read/fetched at most once per run, regardless of how many candidates
 * cite it (tests/tiered-pipeline-wiring.test.mjs asserts the per-run call
 * count directly).
 *
 * @param {import('../schemas.mjs').AuditRunContext} ctx
 * @param {Array<import('./candidate-envelope.mjs').AuditCandidateEnvelope>} envelopes
 * @returns {Promise<{headContentCache: Map<string,string|null>, baseContentCache: Map<string,string|null>, impactCache: Map<string,boolean|null>}>}
 */
export async function buildStage0RelevanceContext(ctx, envelopes) {
  const candidateFiles = collectCandidateAnchorFiles(envelopes);
  const cwdBoundary = path.resolve('.');

  const headContentCache = new Map();
  for (const filePath of candidateFiles) {
    const result = safeReadFile(filePath, cwdBoundary);
    headContentCache.set(filePath, result ? result.content : null);
  }

  const baseContentCache = new Map();
  if (ctx.auditBaseCommit) {
    for (const filePath of candidateFiles) {
      const result = gitShowFileAtRevision(process.cwd(), ctx.auditBaseCommit, filePath);
      baseContentCache.set(filePath, result.ok ? result.content : null);
    }
  }

  const impactCache = new Map();
  let repoUuid = null;
  try {
    repoUuid = resolveRepoIdentity(process.cwd())?.repoUuid ?? null;
  } catch { /* no resolvable repo identity — every impact lookup degrades to null (unknown) */ }
  // 5308a5d6: bounded-concurrency worker pool over the local Postgres RPC
  // (getFreshImportersOrNull), replacing a fully sequential for...of loop.
  // Not a semaphore around the same sequential loop — that shape provides
  // no concurrency at all (audit-plan round-3 M1 caught exactly this
  // mistake in an earlier draft of this fix). candidateFiles is a bounded,
  // known-size array (this run's own diff scope), so no cancellation/
  // backpressure protocol is needed beyond each worker's own loop ending.
  const STAGE0_IMPACT_CONCURRENCY = 8;
  let nextIndex = 0;
  const worker = async () => {
    let i;
    while ((i = nextIndex++) < candidateFiles.length) {
      const filePath = candidateFiles[i];
      let result = null;
      try {
        result = await getFreshImportersOrNull({
          repoUuid,
          headSha: ctx.commitSha,
          workingTreeDirty: !!ctx.workingTreeDirty,
          filePath,
          changedFiles: ctx.changedFiles || [],
        });
      } catch { result = null; }
      impactCache.set(filePath, result);
    }
  };
  const workerCount = Math.min(STAGE0_IMPACT_CONCURRENCY, candidateFiles.length);
  await Promise.all(Array.from({ length: workerCount }, () => worker()));

  return { headContentCache, baseContentCache, impactCache };
}

export function makeHeadContentAdapter(stage0Ctx) {
  return (filePath) => (stage0Ctx.headContentCache.has(filePath) ? stage0Ctx.headContentCache.get(filePath) : null);
}

export function makeImpactAdapter(stage0Ctx) {
  return (filePath) => (stage0Ctx.impactCache.has(filePath) ? stage0Ctx.impactCache.get(filePath) : null);
}

export function makeBlameAdapter(stage0Ctx, baseRef) {
  return (filePath, startLine, endLine, quote) => {
    if (!baseRef) return null;
    const baseContent = stage0Ctx.baseContentCache.has(filePath) ? stage0Ctx.baseContentCache.get(filePath) : null;
    if (baseContent === null) return null;
    return contentExistsAtMappedRange(
      process.cwd(), filePath, { startLine, endLine }, quote, baseRef,
      { preloadedContent: baseContent },
    );
  };
}
