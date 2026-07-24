/**
 * @fileoverview Discovery fallback policy for the tiered pipeline: the
 * required-generator-failure semantics (§1.5) and the never-ran-a-generator
 * result shape (§7j).
 *
 * Extracted from `tiered-pipeline.mjs` (docs/plans/tiered-pipeline-refresh-god-module-decomposition.md).
 *
 * @module scripts/lib/audit/discovery-fallback
 */

import { buildUsageBlock } from './cost-budget.mjs';

/**
 * Thrown INSTEAD of falling back to a second legacy audit when a required
 * discovery generator fails on a SHADOW run (`ctx.shadowMode`).
 * Plan: docs/plans/shadow-no-legacy-fallback.md decision #3.
 *
 * Carries `.reason` ONLY — deliberately not `generatorOutcomes` (round-2
 * plan-audit M4): `discovery-portfolio.mjs` mutates `ctx.generatorOutcomes`
 * in place and `runShadowTieredPipeline` already holds the `shadowCtx`, so
 * threading them through the exception would be a second, redundant channel
 * for state the catch already has in hand.
 *
 * It exists for exactly two small, real reasons: the shadow's catch can
 * record the clean formatted `.reason` rather than a raw `err.message`, and
 * tests can assert the class instead of regexing a string.
 */
export class TieredUnavailableError extends Error {
  constructor(reason) {
    super(reason);
    this.name = 'TieredUnavailableError';
    this.reason = reason;
  }
}

/**
 * §1.5's required-generator-failure semantics, in ONE place because there are
 * now two ways to reach them: a generator that actually failed, and a
 * diff-path map that blew its budget (§8a — over-budget FAILS LOUD and falls
 * back exactly like any other required-generator failure; it is deliberately
 * NOT truncated and NOT partitioned).
 *
 * Lifted verbatim from the single call site it used to have — no new failure
 * machinery, just one caller became two.
 *
 * @param {import('../schemas.mjs').AuditRunContext} ctx
 * @param {string} reason - already prefixed `required generator failed: `
 * @param {Array<object>} discoveryGeneratorOutcomes - captured BEFORE delegating
 * @returns {Promise<import('../schemas.mjs').AuditRunResult>}
 */
export async function failRequiredGenerator(ctx, reason, discoveryGeneratorOutcomes) {
  // Falling back is a PRODUCTION obligation, not a universal one
  // (plan: docs/plans/shadow-no-legacy-fallback.md). This function has
  // exactly two callers and they have opposite contracts:
  //   - openai-audit.mjs:440 (pipelineEnabled) — GATING. Its result IS the
  //     audit, so it must return findings. Falling back is CORRECT.
  //   - tiered-shadow-compare.mjs (runShadowTieredPipeline) —
  //     observation-only. It has NO obligation to return findings, and
  //     falling back here ran a SECOND full legacy audit inside the shadow,
  //     then returned legacy's findings labelled as the tiered result — so
  //     compareAuditRunResults compared the real legacy run against a second
  //     legacy run. Measured over 57 live records: 41 of them, each paying
  //     for a whole extra 5-pass GPT audit to yield zero tiered signal.
  //     Their `overlap: 0` was never recall — it was two independent legacy
  //     runs disagreeing with each other (an accidental, unwanted
  //     measurement of GPT's own nondeterminism) polluting the very
  //     denominator the Phase-14 decision reads.
  // "The tiered pipeline could not run" is a complete, cheap, honest shadow
  // result, and `runShadowTieredPipeline`'s existing {ok:false, error} path
  // already persists it via the existing `shadow_error` column — so this
  // needs no new status, no schema change, and no migration.
  if (ctx.shadowMode) throw new TieredUnavailableError(reason);

  // Production only. The dynamic import lives INSIDE this branch so a shadow
  // run never even loads the legacy module — and so the throw above
  // structurally precludes reaching it (which is half the proof that the
  // shadow never invokes legacy; the other half is a static pin in
  // tests/tiered-pipeline-wiring.test.mjs, since an internal dynamic import
  // has no injection seam to spy on and inventing one purely for a test
  // would be the over-engineered cliff — round-1 plan-audit M2).
  const { runLegacyProductionAudit } = await import('./legacy-production-audit.mjs');
  const legacyResult = await runLegacyProductionAudit(ctx);
  return {
    ...legacyResult,
    generatorOutcomes: discoveryGeneratorOutcomes,
    runStatus: 'fallback_legacy',
    fallbackReason: reason,
  };
}

/**
 * The result of a run that never called a generator at all (plan §7j).
 *
 * THE POINT: neither an empty scope nor an invalid diff may EVER report as a
 * clean 0-finding `complete` run — that is the anti-green class this whole
 * plan exists to kill. Both get their own named `runStatus`, so
 * `summarize()`'s `historicalComplete` filter (`=== 'complete'`) excludes them
 * from `comparedRuns` and `tieredRunStatusCounts` gives each its own bucket.
 *
 * CONTRACT GAP RESOLVED (adjudicated 2026-07-17): both values are now members
 * of `AuditRunResultSchema.runStatus`. This was weighed against
 * shadow-no-legacy-fallback's "why NOT a new runStatus enum value" note and
 * found consistent with it — that note's own tests (consumer distinction
 * needed? data migration? alternative channel?) all answer differently here;
 * see the adjudication comment on the enum itself (schemas.mjs) for the full
 * reasoning. An emissions⊆enum scan in tests/tiered-pipeline-wiring.test.mjs
 * now guards the divergence class mechanically.
 *
 * @param {import('../schemas.mjs').AuditRunContext} ctx
 * @param {{kind:string, reason:string, detail?:string}} map
 * @param {number} startedAt
 * @returns {import('../schemas.mjs').AuditRunResult}
 */
export function skippedNoGeneratorResult(ctx, map, startedAt) {
  const runStatus = map.kind === 'empty' ? 'skipped_no_eligible_files' : 'failed_invalid_diff_input';
  const reason = `${runStatus}: ${map.reason}${map.detail ? ` — ${map.detail}` : ''}`;
  // `invalid` is OUR bug (a diff we produced and could not parse), so it gets
  // stage0Malformed's loud stderr treatment (§7c); `empty` is a legitimate
  // no-op and stays quiet.
  process.stderr.write(map.kind === 'invalid'
    ? `  [discovery] CONTRACT BUG — ${reason}. Both generators SKIPPED; this run verified nothing and is excluded from comparedRuns.\n`
    : `  [discovery] no eligible diff files — both generators skipped (${map.reason}). Not a clean 0-finding run.\n`);

  const elapsed = `${((Date.now() - startedAt) / 1000).toFixed(1)}s`;
  return {
    verdict: 'INCOMPLETE',
    files_planned: 0, files_found: 0, files_missing: 0,
    code_files: ctx.changedFiles || [],
    findings: [],
    wiring_issues: [], quick_fix_warnings: [], dead_code: [],
    overall_reasoning: `**Discovery**: SKIPPED — ${reason}. No generator was called, so this run is not a zero-findings result; it is a run that did not happen.`,
    _pass_timings: { discovery: '0.0s', total: elapsed },
    // No generator was called, so there is genuinely nothing to meter →
    // costUsd null (unmeasured), never a fabricated 0.
    _usage: buildUsageBlock([]),
    _cacheMetrics: { totalInputTokens: 0, totalCachedTokens: 0, hitRate: 0, estimatedSavingsPct: 0, seedUsed: false, perPass: {} },
    _toolCapability: { toolsAvailable: [], toolsFailed: [], strictLint: false, disabled: true, timestamp: Date.now() },
    _sid: ctx.runId || `tiered-${Date.now()}`,
    generatorOutcomes: ctx.generatorOutcomes || [],
    runStatus,
    fallbackReason: reason,
    _suppression: { stage1MechanicalDismissed: 0, stage2ConfirmedDismissal: 0 },
    debtRoutedFiles: [], debtRoutingIncomplete: [],
    // Every count 0 because nothing ran — NOT because everything passed. The
    // named runStatus above is what tells those two apart; a consumer must
    // never have to infer it from the zeros.
    _stageBreakdown: {
      discoveryRawFindings: 0, discoveryMalformedRaw: 0,
      stage0Verified: 0, stage0Rejected: 0, stage0MalformedTripwire: 0,
      stage0PreExistingIndependent: 0, stage0DebtRouted: 0, stage0DebtRoutingIncomplete: 0,
      stage1MechanicalDismissed: 0, stage1Escalated: 0, stage1ConfirmedSurvivor: 0, stage1BudgetExhausted: 0,
      stage2Verified: 0, stage2Reversed: 0, stage2ConfirmedDismissal: 0, stage2MissedCandidate: 0, stage2Unresolved: 0,
      diffPathMapStatus: `${map.kind}:${map.reason}`,
    },
    pendingAdjudicationItems: [],
    _stage1BudgetExhausted: { count: 0, itemIds: [] },
    _stage1FailureCategories: {},
  };
}
