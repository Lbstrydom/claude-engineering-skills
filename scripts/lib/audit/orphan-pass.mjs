/**
 * @fileoverview Orphan-Introduced audit pass (Wave 1.5b) — deterministic,
 * no LLM call.
 *
 * Extracted from `legacy-production-audit.mjs` (docs/plans/legacy-production-audit-decomposition.md
 * Phase 3) — a pure relocation, verbatim bodies, no behaviour change.
 *
 * @module scripts/lib/audit/orphan-pass
 */

import { writeLearningState } from '../robustness.mjs';
import { deriveArchState } from '../arch-intent/adapter-contract.mjs';
import { detectOrphansIntroduced } from './orphan-introduced.mjs';
import { resolveDiffScope } from './diff-scope-resolver.mjs';
import { processFindings } from './findings-pipeline.mjs';
import { emitOrphanRunMetrics } from './orphan-metrics.mjs';

/**
 * Convert a raw orphan-introduced finding to the standard FindingSchema shape
 * so it merges into the normal findings stream consumed by the ledger / Gemini /
 * cost reporting paths.
 *
 * @param {object} raw - finding from detectOrphansIntroduced (after processFindings)
 * @returns {object} FindingSchema-shaped finding
 */
function orphanToStandardFinding(raw, idx) {
  const idSuffix = raw._fingerprint ? raw._fingerprint.slice(0, 4) : String(idx).padStart(2, '0');
  return {
    id: `O${idSuffix}`,
    severity: raw.severity, // 'MEDIUM'
    category: `Orphan Introduced (${raw.subKind})`,
    section: raw.file,
    detail: raw.rationale,
    risk: 'Dead code accumulation — file is no longer reachable from any non-test caller but remains in the repo',
    recommendation: raw.subKind === 'born-orphan'
      ? `Either wire ${raw.file} into the call graph or remove it before merge`
      : `Remove ${raw.file} along with the diff that orphaned it, or accept via <!-- audit:accept-v1: ${raw.file} :: reason -->`,
    is_quick_fix: false,
    is_mechanical: true,
    is_reopened: false,   // mechanical wave — never reopens a prior ruling
    principle: 'Long-Term Sustainability (#20) — dead code is invisible debt',
    classification: {
      sonarType: 'CODE_SMELL',
      effort: 'TRIVIAL',
      sourceKind: 'LINTER',
      sourceName: 'orphan-introduced',
    },
  };
}

/**
 * Pick the git range the orphan-introduced wave (Wave 1.5b) analyses.
 *
 * **Why a named function for four lines.** The call site hard-coded
 * `{ baseRef: 'HEAD~1', headRef: 'HEAD' }` immediately beneath a comment
 * describing working-tree mode as though it were reachable. It was not, so on a
 * dirty tree — the normal `/audit-code` case — this wave analysed the previous
 * COMMIT while every other wave scoped to `auditBaseCommit..worktree`. Four
 * findings between 2026-07-22 and 2026-08-12. A literal cannot carry the
 * reasoning below, and this policy is one decision, not two constants.
 *
 * **`headRef` must stay `'HEAD'` on a clean tree — this is not symmetry.**
 * `resolveDiffScope`'s working-tree branch builds changed files from
 * `git diff --name-status HEAD` ∪ untracked, against literal `HEAD`, **ignoring
 * `baseRef`** (diff-scope-resolver.mjs). On a clean tree that set is EMPTY, so
 * "audit my last commit" (`/cycle`: base `HEAD~1`, clean tree) would analyse
 * nothing and report a healthy zero. Always-`null` is therefore a regression
 * that reads as a pass; `tests/orphan-scope-refs.test.mjs` pins that direction
 * explicitly.
 *
 * The two arms agree on the range because `auditBaseCommit` is already
 * dirty-aware upstream (openai-audit.mjs: dirty → base at `HEAD`, clean →
 * `HEAD~1`). Using it rather than a literal also stops this wave being the one
 * consumer that silently ignored `--base` — AGENTS.md, "one range, one
 * resolver": a consumer must not re-infer a base from working-tree state.
 *
 * @param {{auditBaseCommit: string|null|undefined, workingTreeDirty: boolean}} a
 * @returns {{baseRef: string, headRef: string|null}}
 */
export function resolveOrphanScopeRefs({ auditBaseCommit, workingTreeDirty }) {
  return {
    // `?? 'HEAD~1'` keeps library/test callers (ctx defaults it to null) on the
    // exact prior behaviour rather than silently re-pointing them at the tree.
    baseRef: auditBaseCommit ?? 'HEAD~1',
    headRef: workingTreeDirty ? null : 'HEAD',
  };
}

/**
 * Wave 1.5b — Orphan-Introduced check. Runs after the architecture pass; reuses
 * the HEAD import graph from `archReport._meta['js-ts']`. Pure deterministic
 * algorithm (no LLM call); emits MEDIUM findings for files orphaned by the diff.
 *
 * Plan: docs/plans/dead-code-phase-1-orphan-introduced.md
 *
 * @param {object} args
 * @param {object|null} args.archReport - from runArchitecturePass; null → SKIPPED_NO_GRAPH
 * @param {string} args.repoRoot
 * @param {string|null} args.baseRef - explicit base sha/ref (e.g. from --base flag)
 * @param {string|null} args.headRef
 * @param {string} args.runId
 * @param {string|null} args.planContent
 * @param {object|null} args.ledger - parsed adjudication ledger (R2+ only)
 * @returns {Promise<{state: string, result: object}>}
 */
export async function runOrphanIntroducedPass({ archReport, repoRoot, baseRef, headRef, runId, planContent, ledger, learningWritesAllowed = true }) {
  const emptyResult = {
    result: { pass_name: 'orphan-introduced', findings: [], summary: '' },
    usage: { input_tokens: 0, cached_tokens: 0, output_tokens: 0, reasoning_tokens: 0, latency_ms: 0 },
    latencyMs: 0,
  };

  if (!archReport) {
    // No graph available — arch pass skipped or errored before producing one.
    return { state: 'SKIPPED_NO_GRAPH', result: { ...emptyResult, result: { ...emptyResult.result, summary: 'no arch graph' } } };
  }

  // Extract HEAD graph from arch report's js-ts adapter _meta.
  const jsMeta = archReport._meta?.['js-ts'];
  if (!jsMeta || !jsMeta.allFiles || jsMeta.allFiles.length === 0) {
    return { state: 'SKIPPED_NO_GRAPH', result: { ...emptyResult, result: { ...emptyResult.result, summary: 'no js-ts graph' } } };
  }
  const head = {
    callersByTarget: jsMeta.callersByTarget || {},
    targetsByCaller: jsMeta.targetsByCaller || {},
    allFiles: jsMeta.allFiles || [],
  };

  // Resolve diff scope (orchestration owns git I/O + AST pre-edges).
  const startedAt = Date.now();
  let scope;
  try {
    scope = await resolveDiffScope({ repoPath: repoRoot, baseRef, headRef });
  } catch (err) {
    process.stderr.write(`  [orphan-introduced] resolver error: ${err.message}\n`);
    return { state: 'ERROR', result: { ...emptyResult, result: { ...emptyResult.result, summary: `resolver: ${err.message}` } } };
  }

  // Short-circuit states from the resolver.
  if (scope.state === 'SKIPPED_NO_BASELINE' || scope.state === 'SKIPPED_PATCH_ONLY_MODE') {
    // Gated (audit R1-H1): the metrics file is durable local learning
    // telemetry (.audit/orphan-metrics.jsonl) shared with the real run — an
    // observation-only shadow appending to it double-counts the same commit.
    await writeLearningState(learningWritesAllowed, () => emitOrphanRunMetrics({
      runId, passState: scope.state, rawFindings: [], survivors: [], suppressed: [], _meta: {}, repoPath: repoRoot,
    }));
    return { state: scope.state, result: emptyResult };
  }

  // Inherit ANALYZED_PARTIAL from upstream arch state (Gemini-R2/M2 fix).
  const archDerived = deriveArchState(archReport);
  if (archDerived === 'ANALYZED_PARTIAL') scope.state = 'ANALYZED_PARTIAL';

  // Run pure detector.
  const detector = detectOrphansIntroduced({ scope, head });

  // Post-processing pipeline (fingerprint + ledger-suppress + accept-v1).
  const { survivors, suppressed } = processFindings(detector.rawFindings, {
    ledger,
    planContent,
  });

  // Emit telemetry (per-pass orchestration responsibility — Gemini-R4/H1).
  // Gated on learningWritesAllowed (audit R1-H1) — see the short-circuit
  // emit above for why an observation-only run must not append here.
  await writeLearningState(learningWritesAllowed, () => emitOrphanRunMetrics({
    runId,
    passState: detector.state,
    rawFindings: detector.rawFindings,
    survivors,
    suppressed,
    _meta: detector._meta,
    repoPath: repoRoot,
  }));

  const findings = survivors.map((f, i) => orphanToStandardFinding(f, i));
  const summary = findings.length === 0
    ? `No orphans introduced. Suspects: ${detector._meta.suspectsCount}, removed-edge targets: ${detector._meta.removedEdgeTargetCount}, total removed edges: ${detector._meta.totalRemovedEdges}, entry-points: ${detector._meta.entryPointsCount}.`
    : `${findings.length} orphan-introduced finding(s) surfaced (${detector.rawFindings.length} raw, ${suppressed.length} suppressed).`;

  const latencyMs = Date.now() - startedAt;
  return {
    state: detector.state,
    result: {
      result: { pass_name: 'orphan-introduced', findings, summary },
      usage: { input_tokens: 0, cached_tokens: 0, output_tokens: 0, reasoning_tokens: 0, latency_ms: latencyMs },
      latencyMs,
    },
  };
}
