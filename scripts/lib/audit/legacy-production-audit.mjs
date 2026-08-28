/**
 * @fileoverview `runLegacyProductionAudit` — the extracted, unchanged current
 * production code-audit path (GPT 5-pass orchestration + R2+ suppression +
 * ledger write + verdict computation), plus `buildAuditRunContext`, the
 * builder that maps `openai-audit.mjs`'s `main()` parsed CLI args into an
 * `AuditRunContext`.
 *
 * Tiered-recall audit pipeline Phase 11 — a PURE RELOCATION of
 * `runMultiPassCodeAudit`'s original ~1600-line body out of
 * `scripts/openai-audit.mjs` (no behavior change beyond taking one `ctx`
 * param instead of ~19 loose params, and setting `generatorOutcomes`/
 * `runStatus` on the return — see the docblock on `runLegacyProductionAudit`
 * below). This file is also where the plan's other code-audit-orchestration-
 * specific helpers physically relocate to (confirmed single-mode via a
 * direct symbol-use inventory before this phase started, not assumed from
 * plan prose — audit-plan fix H3, round 4): `printCostPreflight` was
 * EXCLUDED from that inventory result (deviation from the plan's literal
 * text — see the comment at its former call site in `openai-audit.mjs`) —
 * direct-code inspection showed it is called from `main()` itself for ALL
 * THREE modes (code/plan/rebuttal), never from inside the orchestration
 * loop, so it stays in `openai-audit.mjs` rather than being relocated here.
 *
 * The five mode-agnostic GPT-calling primitives (`_callGPTOnce`, `callGPT`,
 * `safeCallGPT`, `getPassPrompt`, `buildCachePrompt`) are NOT here — they
 * live in the neutral `./llm-helpers.mjs` (Gemini gate fix G2, round 3):
 * this file imports `runLegacyProductionAudit`'s entry point FROM
 * `openai-audit.mjs`'s perspective, so if those primitives lived here
 * instead, `openai-audit.mjs`'s multi-mode `main()` (plan/rebuttal calls
 * them directly, confirmed via `grep` — audit-plan fix H3) would need to
 * import them back FROM this file, a genuine two-file A-imports-B/B-imports-A
 * cycle. `llm-helpers.mjs` is the third, neutral module both files import
 * FROM, eliminating the cycle structurally.
 *
 * Plan: docs/plans/tiered-recall-audit-pipeline.md Phase 11.
 *
 * @module scripts/lib/audit/legacy-production-audit
 */

// dotenv loaded by lib/config.mjs (worktree-safe discovery)
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { z } from 'zod';
import { ProducerFindingSchema, WiringIssueSchema, LedgerEntrySchema, BatchLedgerEntrySchema, buildExecutionMeta } from '../schemas.mjs';
import { classifyProviderReadiness } from './provider-readiness.mjs';
import {
  safeInt, readFileOrDie, readFilesAsContext, readFilesAsAnnotatedContext,
  writeOutput, normalizePath, parseDiffFile, extractPlanPaths, mergeScopeFiles, classifyFiles,
  isAuditInfraFile, auditSubjectFileGuard, atomicWriteFileSync
} from '../file-io.mjs';
import {
  generateTopicId, populateFindingMetadata, jaccardSimilarity,
  suppressReRaises, buildRulingsBlock, R2_ROUND_MODIFIER, buildR2SystemPrompt,
  computeImpactSet, batchWriteLedger, classifyLedgerEntry,
  computeFixLifecycleUpdates, applyLifecycleUpdates
} from '../ledger.mjs';
import {
  estimateTokens, chunkLargeFile, extractExportsOnly,
  buildDependencyGraph, measureContextChars
} from '../code-analysis.mjs';
import { semanticId, formatFindings, appendOutcome, loadOutcomes, FalsePositiveTracker } from '../findings.mjs';
import { estimateStablePrefixTokens } from './prompt-builder.mjs';
import { listRepoFiles } from '../repo-inventory.mjs';
import { verifyExistenceFindings, effectiveSeverity, countsTowardVerdict, isRefuted } from './finding-verification.mjs';
import { getRepoContext } from '../repo-context.mjs';
import { evaluateConvergence, evaluateConvergenceWithDetectors, resolveDetectorResultForRound } from './convergence.mjs';
import { checkDetectors } from './detector.mjs';
import { getRequirementsContext } from '../requirements/context.mjs';
import { computeAuditVerdict, normalizeArchCategory } from './findings-pipeline.mjs';
import { PlanFpTracker } from '../plan-fp-tracker.mjs';
import {
  generateRepoProfile, initAuditBrief, readProjectContext, readProjectContextForPass,
  extractPlanForPass, buildHistoryContext, loadSessionCache, saveSessionCache
} from '../context.mjs';
import { buildLanguageContext } from '../language-profiles.mjs';
import { executeTools, normalizeToolResults, formatLintSummary } from '../linter.mjs';
import {
  selectEventSource, loadDebtLedger, appendEvents, reconcileLocalToCloud, mergeLedgers as mergeLedgersForSuppression
} from '../debt-memory.mjs';
import { initLearningStore, isCloudEnabled, resolveRepoForStore, upsertPlan, recordRunStart, recordRunComplete, recordFindings, recordPassStats, recordSuppressionEvents, syncBanditArms, syncFalsePositivePatterns, loadFalsePositivePatterns, backfillLearningOutcome, insertLearningDecision, markFindingsRemediation, reconcileRemediationProjection } from '../../learning-store.mjs';
// Durable audit-store writes (docs/plans/audit-store-write-durability.md).
// `audit-store-writers.mjs` is imported for its REGISTRATIONS — importing it is
// the registry's bootstrap, and `durableWrite` throws for an unregistered id, so
// dropping this import would fail loudly rather than silently.
import { durableWrite, drainSpill, spillSummary } from '../durable-write.mjs';
import '../audit-store-writers.mjs';
import { buildCloudFpPolicy, runSuppressionPasses } from '../suppression-policy.mjs';
import { finalizePriorRoundOutcomes } from '../finalize-outcomes.mjs';
import { recordDecision as _learningRecordDecision, flush as _learningFlush, installLifecycleHooks as _learningInstallHooks, buildDecisionKey as _learningBuildKey, reconcileOutbox as _learningReconcileOutbox } from '../learning/decision-logger.mjs';
import { deriveSignals as _deriveTierSignals, buildAuthorTierObservation as _buildAuthorTierObservation } from '../learning/author-tier-observation.mjs';
import { loadDomainRules as _loadDomainRules, computeTargetDomains as _computeTargetDomains } from '../symbol-index/domain-tagger.mjs';
import { PromptBandit, computeReward, buildContext } from '../../bandit.mjs';
import { openaiConfig, PASS_NAMES, modelPricing, azureConfig, tieredAuditConfig, auditRuntimeConfig } from '../config.mjs';
import { supportsReasoningEffort, refreshModelCatalog, resolveModel, pricingKey } from '../model-resolver.mjs';
import { costFromUsage } from '../model-pricing.mjs';
import { createOpenRouterClient } from '../openai-client.mjs';
import { createAnthropicClient } from '../anthropic-client.mjs';
import { ossStructuredCall } from '../oss-structured-output.mjs';
import { createGeminiReviewSubprocessAdapters } from './final-adjudication.mjs';
import { MODEL, getPassPrompt, buildCachePrompt, callGPT, safeCallGPT, wireModel } from './llm-helpers.mjs';
import {
  classifyLlmError, writeLearningState, tallyWriteOutcomes,
  resolveLedgerPath, RETRY_MAX_ATTEMPTS,
  RETRY_BASE_DELAY_MS, RETRY_429_MAX_DELAY_MS, SEV_ORDER,
  tryRepairJson, computePassLimits,
} from '../robustness.mjs';
import {
  initResultCache, cachePassResult, cacheWaveResults, cleanupCache, collectReducePassStatuses,
} from './pass-result-cache.mjs';
import {
  shouldMapReduce, shouldMapReduceHighReasoning, decideSeed, throwIfConfigError, runOneMapUnit,
  runMapReducePass, resetSeedTelemetry, getSeedTelemetry, PassFindingsSchema,
} from './map-reduce-scheduler.mjs';
import { runArchitecturePass } from './architecture-pass.mjs';
import { runOrphanIntroducedPass, resolveOrphanScopeRefs } from './orphan-pass.mjs';
import { runEventWiringSymmetryPass } from './event-wiring-pass.mjs';
import { runDuplicationPass } from './duplication-pass.mjs';
import { runAdjacencyPass } from './adjacency-pass.mjs';
import { validateLedgerForR2 } from './run-persistence.mjs';
import { finalizeRun } from './run-finalization.mjs';
// `buildSuppressionStats`'s backwards-compat re-export (plan: legacy-
// production-audit-decomposition, Phase 4c line-ownership table) was REMOVED
// at Phase 5 close-out: a grep on the final tree confirmed zero external
// consumers importing it from this module (only run-persistence.mjs, its
// real owner, and this decomposition's own tests reference it now).
import {
  PASS_BACKEND_RUBRIC, PASS_FRONTEND_RUBRIC, PASS_SUSTAINABILITY_RUBRIC, buildClassificationRubric,
} from '../prompt-seeds.mjs';
import { getActiveRevisionId } from '../prompt-registry.mjs';
import { incrementRunCounter } from '../llm-auditor.mjs';

// ── Code Audit Pass Schemas (moved from openai-audit.mjs — tiered-recall
// pipeline Phase 11: used exclusively by this file's orchestration loop) ──

// PassFindingsSchema moved to map-reduce-scheduler.mjs (imported above) —
// legacy-production-audit-decomposition Phase 2.

const StructurePassSchema = z.object({
  pass_name: z.literal('structure'),
  files_planned: z.number().int(),
  files_found: z.number().int(),
  files_missing: z.number().int(),
  missing_files: z.array(z.string().max(120)).max(30),
  export_mismatches: z.array(z.object({
    file: z.string().max(120),
    expected: z.string().max(200),
    actual: z.string().max(200)
  })).max(20),
  findings: z.array(ProducerFindingSchema).max(15),
  summary: z.string().max(500)
});

const WiringPassSchema = z.object({
  pass_name: z.literal('wiring'),
  wiring_issues: z.array(WiringIssueSchema).max(20),
  findings: z.array(ProducerFindingSchema).max(10),
  summary: z.string().max(500)
});

const SustainabilityPassSchema = z.object({
  pass_name: z.literal('sustainability'),
  findings: z.array(ProducerFindingSchema).max(15),
  dead_code: z.array(z.string().max(200)).max(20),
  quick_fix_warnings: z.array(z.string().max(300)).max(10),
  summary: z.string().max(500)
});

const QuickfixPassSchema = z.object({
  pass_name: z.literal('quickfix'),
  findings: z.array(ProducerFindingSchema).max(15),
  summary: z.string().max(500)
});

// ── Code-audit-orchestration-specific thresholds (moved from openai-audit.mjs
// — only this file's orchestration loop reads this one) ─────────────────────
const BACKEND_SPLIT_THRESHOLD = openaiConfig.backendSplitThreshold;

// shouldMapReduce/shouldMapReduceHighReasoning moved to map-reduce-scheduler.mjs
// (imported above) — legacy-production-audit-decomposition Phase 2.

// Resolve prompts at module load (uses registry if available, seeds otherwise)
const PASS_STRUCTURE_SYSTEM = getPassPrompt('structure');
const PASS_WIRING_SYSTEM = getPassPrompt('wiring');
const PASS_BACKEND_SYSTEM = getPassPrompt('backend');
const PASS_FRONTEND_SYSTEM = getPassPrompt('frontend');
const PASS_SUSTAINABILITY_SYSTEM = getPassPrompt('sustainability');
// runArchitecturePass (+ PASS_ARCH_INTENT_SYSTEM, groundArchFindingsToReport, formatViolationsForPrompt, deriveFindingsFromReport) moved to architecture-pass.mjs — legacy-production-audit-decomposition Phase 3.
// initResultCache/cachePassResult/cacheWaveResults/cleanupCache/
// normalizeFindingsForOutput moved to pass-result-cache.mjs (imported above) —
// legacy-production-audit-decomposition Phase 1.

/**
 * The one definition of "is this file inside `--files` scope".
 *
 * The bidirectional-substring predicate was written out at SIX call sites
 * (backend, frontend, routes, services, sustainability, quickfix). Six copies
 * of a scope rule are six things to keep in step, and a scope predicate that
 * disagrees with itself across passes silently audits different file sets per
 * pass — which no test would catch, because each pass looks locally correct.
 *
 * Semantics are preserved EXACTLY, deliberately: matching is bidirectional
 * (`f.includes(ff) || ff.includes(f)`) so a caller may pass either a full path
 * or a fragment. Tightening it to equality or a suffix match here would silently
 * narrow every pass's scope, which is a behaviour change wearing a refactor's
 * clothes.
 *
 * Stays here (not extracted to pass-result-cache.mjs, despite sitting in its
 * source line range): this is a spine/multi-pass-shared utility, not
 * cache-lifecycle logic, and its only caller is this file's own orchestration
 * body (legacy-production-audit-decomposition Pre-Phase-1 gate finding).
 *
 * @param {string[]|null} fileFilter
 * @returns {(files: string[]) => string[]} identity when no filter is set
 */
function scopeToFileFilter(fileFilter) {
  if (!fileFilter) return (files) => files;
  return (files) => files.filter((f) => fileFilter.some((ff) => f.includes(ff) || ff.includes(f)));
}

// ── Ledger preflight, suppression stats, dedup-id, shadow-failure and
// write-outcome-tally helpers moved out (legacy-production-audit-
// decomposition Phase 4): validateLedgerForR2/buildSuppressionStats now live
// in run-persistence.mjs (validateLedgerForR2 imported above for the
// pre-wave R2+ preflight; buildSuppressionStats has no call site left in
// this file — its backwards-compat re-export was removed at Phase 5
// close-out), classifyShadowFailureSafe in run-telemetry.mjs,
// dedupReplacementId in finding-assembly.mjs, tallyWriteOutcomes in
// robustness.mjs (imported above — this file still calls it directly for the
// pre-wave writes at :688/:727).
/**
 * The extracted production pass-orchestration loop (Waves 1-4, merge/dedup,
 * R2+ suppression, ledger write, verdict computation) — a pure relocation of
 * `runMultiPassCodeAudit`'s original body (tiered-recall pipeline Phase 11),
 * with no behavior change beyond: (a) taking one `ctx: AuditRunContext` param
 * instead of ~19 loose params (destructured back into the SAME local names
 * below, so the rest of this function's ~1600 lines are untouched), (b) the
 * Phase 10 `return mergedResult` (already present pre-extraction), and
 * (c) setting `generatorOutcomes: []` / `runStatus: 'complete'` on the return
 * (this branch has no discovery-portfolio generators to report).
 *
 * CLI-presentation concerns (`jsonMode`, the final `--out` write / pretty
 * print) are NOT part of `ctx` — they stay in `openai-audit.mjs`'s `main()`,
 * operating on this function's return value. `outFile` IS part of `ctx`
 * (deviation from the plan's literal field list — see the module docblock
 * in `../schemas.mjs` `AuditRunContextSchema` for why): it is genuinely used
 * internally for artifact-path resolution (the pass-result recovery cache's
 * directory, and R2+'s prior-round-outcome finalisation via the
 * `<sid>-r<N>-result.json` naming convention) — a location HINT for
 * orchestration bookkeeping, distinct from "write the final result to disk",
 * which is the wrapper's job.
 *
 * @param {import('../schemas.mjs').AuditRunContext} ctx
 * @returns {Promise<import('../schemas.mjs').AuditRunResult>}
 */
export async function runLegacyProductionAudit(ctx) {
  // Top-level cache-lifecycle guarantee (Gemini gate G1, round 1 correction):
  // cleanupCache() must run on EVERY exit path — success, a thrown error from
  // any wave, or a thrown error from the finalization coordinator — not just
  // the success path. A narrower try/finally scoped to the coordinator alone
  // (the round-4 draft) is unreachable when an earlier wave throws before the
  // coordinator is ever invoked, which is exactly the leak Gemini caught.
  // This wrapper is the ENTIRE reason runLegacyProductionAuditImpl exists as a
  // separate function: wrapping ~1200 lines of an already-huge body in an
  // inline try/finally would mean re-indenting the whole function for a
  // one-line guarantee at both ends.
  try {
    return await runLegacyProductionAuditImpl(ctx);
  } finally {
    cleanupCache();
  }
}

async function runLegacyProductionAuditImpl(ctx) {
  // `let`, not `const` (plan deviation, noted): the observation-mode view swap
  // below reassigns `bandit`, and a const destructure would throw. The local
  // binding is the function's complete use surface for it (verified: addArm,
  // flush, syncBanditArms — no helper receives `bandit`, no ctx.bandit re-read).
  let {
    planContent, projectContext, historyContext = '',
    passFilter = null, fileFilter = null, round = 1, ledgerFile = null, diffFile = null,
    changedFiles = [], auditBaseCommit = null, repoProfile = null, bandit = null, fpTracker = null, noLedger = false,
    noTools = false, strictLint = false, noDebtLedger = false, readOnlyDebt = false,
    debtLedgerPath = undefined, debtEventsPath = undefined, escalateRecurring = null,
    sessionCacheHit = null, scopeMode = null, planFile = null, runId = null, allowInfraScope = false,
    outFile = null, providers = {}, noCloudRecording = false,
    // Present in ctx since buildAuditRunContext, but never destructured until
    // 2026-08-13 — which is why the orphan wave could not tell a dirty tree
    // from a clean one and hard-coded its range. See resolveOrphanScopeRefs.
    workingTreeDirty = false,
  } = ctx;
  const { openai } = providers;

  // May THIS run write learning state (cloud or local)? One policy, one place.
  // noCloudRecording marks an observation-only run (tiered shadow /
  // verify-anchor-contract): it must be able to READ bandit/fpTracker so its
  // suppression behaviour stays faithful to the real audit, but must never
  // persist — the real, concurrent gating audit is the only writer. This
  // boolean closes the CLOUD channel at the tail's sync sites; the view swap
  // below closes the LOCAL channel (addArm._save / flush on a shared
  // instance). Both are needed: the tail's arms sync reads the map directly,
  // regardless of which store the bandit carries.
  const learningWritesAllowed = !noCloudRecording;
  // Swap BEFORE any use — the local's complete in-function use surface is
  // the arm registration, the tail flush, and the tail arms sync.
  if (!learningWritesAllowed && bandit) bandit = bandit.nonPersistingView();
  const totalStart = Date.now();
  resetSeedTelemetry(); // reset run-scoped cache-seed flags (CLI = one run/process)

  // Initialize pass result cache — survives merge crashes
  initResultCache(outFile);

  // Deterministic outcome capture: finalize the prior round's outcomes before
  // running round N's audit (best-effort, never blocks). See the helper above.
  // 062e1be1: gated on learningWritesAllowed — this call previously ran
  // unconditionally, writing learning-outcome state even during a shadow/
  // observation-only (noCloudRecording) run. finalizePriorRoundOutcomes
  // already catches and logs its own internal failures (never throws), so
  // no result-checking is needed here beyond the policy gate.
  await writeLearningState(learningWritesAllowed, () => finalizePriorRoundOutcomes({ outFile, round, ledgerFile }));

  // Count diff lines for metadata (lines starting with + or - but not +++ / ---)
  let diffLinesChanged = null;
  let diffFilesChanged = null;
  if (diffFile) {
    try {
      const diffContent = fs.readFileSync(diffFile, 'utf-8');
      const lines = diffContent.split('\n');
      diffLinesChanged = lines.filter(l => (l.startsWith('+') || l.startsWith('-')) && !l.startsWith('+++') && !l.startsWith('---')).length;
      diffFilesChanged = (diffContent.match(/^diff --git/mg) || []).length || changedFiles.length;
    } catch (err) {
      // --diff was EXPLICITLY passed but is unreadable. Don't warn-and-proceed (Gemini
      // gate): silently degrading a targeted R2+ audit to no-annotation — or, for the
      // `base..HEAD` range-misuse, auditing the wrong scope — is the quasi-silent
      // failure A1 exists to kill. The user signalled intent by passing --diff; fail
      // fast so they fix the invocation (a unified-diff FILE, not a git range).
      const looksLikeRange = /\.\.|^[0-9a-f]{7,40}$/i.test(String(diffFile));
      throw new Error(
        `--diff "${diffFile}" is not a readable file (${err.code || err.message}). ` +
        (looksLikeRange
          ? `It looks like a git RANGE — --diff expects a unified-diff FILE: \`git diff base..HEAD > d.patch\` then \`--diff d.patch --changed <files>\`.`
          : `Pass a readable unified-diff file, or omit --diff.`)
      );
    }
  }
  if (diffFilesChanged == null && changedFiles.length > 0) diffFilesChanged = changedFiles.length;

  // Track which passes trigger map-reduce
  const mapReducePasses = [];
  const EMPTY_FINDINGS = { pass_name: 'empty', findings: [], quick_fix_warnings: [], summary: 'Pass skipped or failed.' };
  const EMPTY_STRUCTURE = { pass_name: 'structure', files_planned: 0, files_found: 0, files_missing: 0, missing_files: [], export_mismatches: [], findings: [], summary: 'Pass skipped.' };
  const EMPTY_WIRING = { pass_name: 'wiring', wiring_issues: [], findings: [], summary: 'Pass skipped.' };
  const EMPTY_SUSTAIN = { pass_name: 'sustainability', findings: [], dead_code: [], quick_fix_warnings: [], summary: 'Pass skipped.' };

  // 1. Gather and classify files
  // `planFound` is what the PLAN references (and is what `missing`/`allPaths`
  // continue to describe — plan-accounting must keep meaning the plan).
  // `found` is what this audit will actually READ: the plan's files UNION any
  // scope-supplied file the plan never mentioned. Before this union, `--files`
  // and `--scope diff` were filters only, so a changed file absent from the
  // plan was intersected away and read by no pass — see mergeScopeFiles.
  const { found: planFound, missing, allPaths } = extractPlanPaths(planContent, { allowInfraFiles: allowInfraScope });
  const { files: found, addedFromScope, rejected: scopeRejected } = mergeScopeFiles(
    planFound, fileFilter, { allowInfraFiles: allowInfraScope },
  );
  if (addedFromScope.length > 0) {
    process.stderr.write(
      `  [scope] +${addedFromScope.length} changed file(s) not referenced by the plan, now in scope: `
      + `${addedFromScope.slice(0, 5).join(', ')}${addedFromScope.length > 5 ? ` (+${addedFromScope.length - 5} more)` : ''}\n`,
    );
  }
  if (scopeRejected.length > 0) {
    // Never silent: a scope file dropped by the admission guards (infra,
    // non-source extension, absent on disk) is information, not noise.
    process.stderr.write(
      `  [scope] ${scopeRejected.length} scope file(s) not admitted (infra/extension/not-on-disk): `
      + `${scopeRejected.slice(0, 5).join(', ')}${scopeRejected.length > 5 ? ` (+${scopeRejected.length - 5} more)` : ''}\n`,
    );
  }
  // Build LanguageContext from RAW found files BEFORE category-based classification.
  // classifyFiles() has JS-centric patterns (lacks Python test/frontend detection),
  // so Python files may end up in "backend" bucket silently — but langContext
  // must see them all for dependency resolution + package-root detection.
  const langContext = buildLanguageContext(found);
  if (langContext.pythonPackageRoots.length > 1) {
    process.stderr.write(`  [lang] Python package roots: ${langContext.pythonPackageRoots.join(', ')}\n`);
  }
  const { backend, frontend, shared } = classifyFiles(found);

  // Record audit start in cloud store (fire-and-forget). noCloudRecording
  // (set by the tiered-shadow-compare harness when this function runs as
  // the tiered pipeline's internal required-generator-failure fallback,
  // concurrently with the REAL, gating legacy audit for the same commit) —
  // this branch is invisible/observation-only by design and must never
  // write audit_runs/audit_findings/etc.; it previously tried to avoid
  // colliding with the real run's row via a `<runId>-shadow` id, which
  // isn't a valid uuid and just failed loudly on every reuse-probe/insert.
  let cloudRunId = null;
  let cloudRepoId = null;
  // Durable-write tally for this run (plan decision 3). Declared here so it
  // exists on EVERY exit path, including the ones that never reach the cloud
  // block — an absent tally and an all-zero tally must not be the same thing.
  const writeOutcomes = { written: 0, spilled: 0, lost: 0, skipped: 0, byWriter: {} };
  if (!noCloudRecording && (await isCloudEnabled()) && repoProfile) {
    // Cluster A (§2.1): resolve the STABLE audit_repos.id via repo_uuid identity
    // (not the volatile content fingerprint that fragmented B1). The returned
    // repoRowId is what every child table's repo_id FK stores.
    const repoRef = await resolveRepoForStore({ profile: repoProfile }).catch(() => null);
    cloudRepoId = repoRef?.repoRowId ?? null;
    if (cloudRepoId) {
      // Best-effort commit + branch capture — anchors the audit run to a code state.
      let commitSha = null;
      let branch = null;
      try {
        const { execFileSync } = await import('node:child_process');
        commitSha = execFileSync('git', ['rev-parse', 'HEAD'], { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
        branch = execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
      } catch { /* not a git repo, or git not on PATH */ }

      // If we have a plan file path, register it so audit_runs.plan_id links back.
      let planId = null;
      if (planFile) {
        // Discriminated result since 2026-08-12 (durability plan decision 6).
        // The `.catch(() => null)` this replaces collapsed a store failure into
        // the same null a plan-less run produces, so the audit recorded
        // `plan_id: null` — indistinguishable from a deliberate ad-hoc audit.
        const planRes = await upsertPlan(cloudRepoId, {
          path: planFile,
          skill: 'plan',
          status: 'in_progress',
          commitSha,
        }).catch((err) => ({ ok: false, reason: 'write-failed', message: err?.message ?? String(err) }));
        if (planRes.ok) {
          planId = planRes.planId;
        } else if (planRes.reason === 'write-failed') {
          // Degrade to a local-only run AND count it, so the audit reports the
          // lost linkage instead of proceeding as if no plan existed. Not a
          // registered durable writer — there is no envelope and nothing to
          // replay — so it is tallied under its own id, which is why `byWriter`
          // exists rather than a bare total.
          process.stderr.write(`  [learning] plan linkage lost: ${planRes.message}\n`);
          tallyWriteOutcomes(writeOutcomes, [{ outcome: 'lost', writerId: 'audit.planLink', error: planRes.message }]);
        } else {
          // cloud-off / invalid-input: today's silence, one line of why.
          process.stderr.write(`  [learning] no plan linkage (${planRes.reason}): ${planRes.message}\n`);
        }
      }

      // R2-H2: no `.catch(() => null)`. `recordRunStart` never throws — every
      // failure path logs `[learning] recordRunStart failed: …` and returns
      // null itself — so the catch was DEAD CODE that advertised a swallow
      // which was not happening, and would have masked a genuine future throw.
      // Same removal, same reasoning, as the `recordDiffComplexity` call below.
      cloudRunId = await recordRunStart(cloudRepoId, planFile || 'ad-hoc', 'code', {
        scopeMode, commitSha, branch, planId, runId,
      });

      // Phase 1 — adaptive-learning-v1 telemetry.  Compute diff_complexity
      // (file count, LOC, scope mode) and record pass_selection decision
      // pre-wave with outcome=null; the outcome is backfilled at audit-end.
      // Plan: docs/plans/adaptive-learning-phase-1-foundation.md §2 data flow
      if (cloudRunId) {
        const diffComplexity = {
          fileCount: Array.isArray(changedFiles) ? changedFiles.length : null,
          diffLines: diffLinesChanged,
          diffFiles: diffFilesChanged,
          scopeMode: scopeMode || null,
        };
        // 656f6586: gated on learningWritesAllowed (previously unconditional
        // — a shadow/observation-only run would still record diff-complexity
        // telemetry). The function returns { ok, error? } — never throws —
        // so `.catch()` was dead code masking nothing; check the result and
        // log a failure instead of silently discarding it.
        // Permission WRAPS durability — the composition already used at the
        // bandit/fp-pattern sites. `writeLearningState` answers "may this run
        // persist?" and reports nothing; `durableWrite` answers "did it land?".
        // Logging the failure (what this did before) is not the same as
        // REPRESENTING it: a logged failure leaves `writeOutcomes` untouched and
        // the run still reports complete.
        await writeLearningState(learningWritesAllowed, async () => {
          tallyWriteOutcomes(writeOutcomes, [await durableWrite('audit.diffComplexity', {
            runId: cloudRunId, complexity: diffComplexity, run_id: cloudRunId,
          })]);
        });

        // Record pass_selection decision (telemetry-only in v1; choice always
        // 'all' until Phase 3 promotes pass-selector to live).
        try {
          _learningRecordDecision({
            decisionType: 'pass_selection',
            repoId: cloudRepoId,
            auditRunId: cloudRunId,
            round: round || 1,
            sequence: 0,
            context: {
              scopeMode: scopeMode || null,
              fileCount: diffComplexity.fileCount,
              diffLines: diffComplexity.diffLines,
            },
            choice: { chose: 'all' },
            outcome: null,
          });
          _learningInstallHooks({ insertLearningDecision, backfillLearningOutcome, isCloudEnabled });
        } catch { /* validation failure — best-effort telemetry */ }
      }
    }
  }

  // ── Drain the write-spill queue (plan Phase 3) ────────────────────────────
  // At run START, not at the end: the store has just been shown to be reachable
  // (the run row above was written through it), and anything spilled by a
  // previous run should land before this run starts adding to the queue.
  //
  // Gated on `cloudRunId` because a drain replays into the store — with cloud
  // off `drainSpill` refuses anyway (`state: 'unavailable'`), and this avoids
  // taking the lock to be told so. Never fails the audit: a drain is
  // housekeeping, and the artifacts stay on disk for the next attempt.
  //
  // `unavailable` is REPORTED, not swallowed. It is not `drained: 0` — that is
  // the vacuous-pass distinction the shared core exists to preserve, and a
  // silent one here would hide exactly the backlog this feature accumulates.
  if (cloudRunId && !noCloudRecording) {
    try {
      // No `repoRoot`: it defaults to `process.cwd()`, which is what every other
      // root-taking call in this orchestrator passes explicitly (`runArchitecturePass`,
      // the duplication and adjacency analyses). Passing the default back in would
      // just be a second spelling of the same resolution.
      const drained = await drainSpill({ isCloudEnabled });
      if (drained.state === 'drained') {
        process.stderr.write(`  [durable-write] drained ${drained.drained} spilled write(s) (${drained.rejected} quarantined, ${drained.failed} retained)\n`);
      } else if (drained.state === 'unavailable') {
        process.stderr.write(`  [durable-write] spill drain unavailable: ${drained.reason}\n`);
      }
    } catch (err) {
      process.stderr.write(`  [durable-write] spill drain error: ${err?.message || err}\n`);
    }
  }

  // ── Cloud FP-pattern policy (Layer 3 input) ──────────────────────────────
  // Read the cross-repo/cross-machine FP patterns once per run and resolve them
  // into a cloud-only policy. cloudRepoId == null (cloud off, or the repo never
  // resolved) → policy stays null → the Layer-3 pass below is a no-op and the
  // run is byte-identical to a pre-cloud-FP audit.
  //
  // The lifecycle state is logged explicitly because "no patterns yet" and "the
  // read blew up" must be distinguishable: with rows only accumulating from
  // 2026-07-17 this layer is legitimately inert for a while, and a silent inert
  // layer is indistinguishable from a broken one.
  let cloudFpPolicy = null;
  if (!cloudRepoId) {
    // cloudRepoId is null for TWO different reasons and they must not read the
    // same: cloud genuinely off (expected, silent) vs cloud on but the repo
    // never resolved (a real failure that would otherwise make this layer
    // silently absent — the exact inert-vs-broken conflation this feature's
    // lifecycle logging exists to prevent).
    if (!noCloudRecording && repoProfile && await isCloudEnabled()) {
      process.stderr.write(`  [cloud-fp] repo unresolved — falling back to local-only\n`);
    }
  } else {
    try {
      const envelope = await loadFalsePositivePatterns(cloudRepoId);
      const built = buildCloudFpPolicy(envelope);
      cloudFpPolicy = built.policy;
      if (built.lifecycleState === 'loaded-active') {
        process.stderr.write(
          `  [cloud-fp] policy active: ${built.counts.repo} repo + ${built.counts.global} global patterns\n`
        );
      } else if (built.lifecycleState === 'loaded-zero') {
        process.stderr.write(`  [cloud-fp] no patterns yet (repo=0 global=0) — layer inert\n`);
      } else if (built.lifecycleState === 'degraded-global-dropped') {
        process.stderr.write(`  [cloud-fp] global scope unusable (${built.reason}) — repo patterns only\n`);
      } else {
        process.stderr.write(`  [cloud-fp] load failed (${built.reason}) — falling back to local-only\n`);
      }
    } catch (err) {
      // The loader is internally fail-open; this catches a synchronous throw and
      // gives it its OWN named state rather than laundering it into "no data".
      // err.name only — err.message can carry a DSN fragment.
      process.stderr.write(`  [cloud-fp] load failed (${err.name}) — falling back to local-only\n`);
      cloudFpPolicy = null;
    }
  }

  // ── Phase D: Debt Memory ─────────────────────────────────────────────────
  // Load persistent debt ledger so normal audits don't resurface known debt.
  // Runs every round (not just R2+) — debt is persistent across audit runs.
  const debtContext = selectEventSource({
    noDebtLedger,
    // R2-H3: `readOnly` now carries the observation-only capability too, not
    // just the `--read-only-debt` flag. `cloudEnabled` below already blocked
    // the CLOUD debt writes for such a run, but `selectEventSource` degrades to
    // a LOCAL source with `canWrite: !readOnly` — so a shadow run still wrote
    // local debt events and escalations, against a mode documented as "the
    // concurrent real audit is the only writer".
    //
    // Production behaviour is UNCHANGED: both callers that set
    // `noCloudRecording` (tiered-shadow-compare, verify-anchor-contract) also
    // set `noDebtLedger` + `readOnlyDebt` already, and a test pins that the
    // five flags travel together. That is exactly why this is worth closing —
    // the guarantee rested on callers remembering, which is the "convention,
    // not a capability boundary" shape `writeLearningState` exists to replace.
    readOnly: readOnlyDebt || !learningWritesAllowed,
    repoId: cloudRepoId,
    // cloudRepoId is only set inside the `await isCloudEnabled()` block above,
    // so a non-null value proves cloud is on and the repo resolved.
    // 9d9d478a: also require learningWritesAllowed — previously a shadow/
    // observation-only run still wrote debt events to the SHARED cloud
    // store; selectEventSource degrades gracefully to the local event log
    // when cloudEnabled is false (matching the pattern the other 5 already-
    // migrated write sites use — a downgrade, not a hard block), so this is
    // additive, not a new failure mode.
    cloudEnabled: cloudRepoId != null && learningWritesAllowed,
  });
  // Opportunistic local→cloud reconciliation when we're online (fix R3-H3)
  if (debtContext.source === 'cloud') {
    await reconcileLocalToCloud(debtContext, { eventsPath: debtEventsPath }).catch(e => {
      process.stderr.write(`  [debt] reconcile skipped: ${e.message}\n`);
    });
  }
  const debtLedger = await loadDebtLedger(debtContext, {
    ledgerPath: debtLedgerPath,
    eventsPath: debtEventsPath,
  });
  if (debtLedger.entries.length > 0) {
    const alreadyEscalated = debtLedger.entries.filter(e => e.escalated).length;
    process.stderr.write(`  [debt] ${debtLedger.entries.length} debt entries loaded (${alreadyEscalated} escalated)\n`);
  }
  // Audit session ID for event-log attribution. `Date.now()` alone is not
  // collision-safe (0342d9cc): two audits started in the same process, or on
  // the same machine in the same millisecond, would share one debt-event
  // session id and one round-1 manifest filename. `process.pid` distinguishes
  // concurrent processes; the random suffix distinguishes concurrent calls
  // within one process (this session id is a log-attribution key, not a
  // security token, so Math.random() is sufficient entropy here).
  const debtRunId = `audit-${Date.now()}-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;

  // Phase D.3 escalation gate: flip escalated=true on entries with
  // distinctRunCount >= threshold so they bypass suppression this round.
  // Emits one 'escalated' event per entry newly escalated.
  const newlyEscalated = [];
  if (escalateRecurring && Number.isFinite(escalateRecurring) && escalateRecurring > 0 && debtContext.canWrite) {
    const nowIso = new Date().toISOString();
    for (const entry of debtLedger.entries) {
      const runs = entry.distinctRunCount ?? entry.occurrences ?? 0;
      if (runs >= escalateRecurring && !entry.escalated) {
        entry.escalated = true;           // in-memory flag bypasses suppression
        entry.escalatedAt = nowIso;
        newlyEscalated.push({
          ts: nowIso,
          runId: debtRunId,
          topicId: entry.topicId,
          event: 'escalated',
        });
      }
    }
    if (newlyEscalated.length > 0) {
      const r = await appendEvents(debtContext, newlyEscalated, { eventsPath: debtEventsPath });
      if (r.written === newlyEscalated.length) {
        process.stderr.write(`  [debt] escalated ${r.written} recurring entries (distinctRunCount >= ${escalateRecurring}) to ${r.source}\n`);
      } else {
        process.stderr.write(`  [debt] escalation write incomplete: ${r.written}/${newlyEscalated.length} event(s) written to ${r.source} (distinctRunCount >= ${escalateRecurring})\n`);
      }
    }
  }

  // Split backend into routes vs services for manageable chunk sizes
  const backendRoutes = backend.filter(f => f.includes('/routes/'));
  const backendServices = backend.filter(f => !f.includes('/routes/'));
  const splitBackend = backend.length > BACKEND_SPLIT_THRESHOLD;

  // ── R2+ initialization ──────────────────────────────────────────────────────
  const isR2Plus = round >= 2;
  let ledger = null, diffMap = null, impactSet = [];
  let suppressionUnavailable = false;
  // Entries validateLedgerForR2 drops as malformed. Travels into _executionMeta
  // alongside suppressionUnavailable (see the merged-result assembly below):
  // the stderr line it used to be reported on exclusively is not a channel the
  // convergence verdict, the result JSON, or an operator reading either can see.
  let ledgerInvalidEntryCount = 0;
  // Ruling-set provenance for `audit_runs.suppression_stats` — see
  // `buildSuppressionStats`. Stays null on R1, where suppression never runs.
  let ledgerStats = null;

  if (isR2Plus) {
    process.stderr.write(`\n═══ R${round} MODE ═══\n`);

    // Preflight: validate ledger before relying on it for suppression.
    // Phase 2 (audit-orchestrator-hardening): validateLedgerForR2 now also
    // per-entry schema-validates the ledger and returns `validEntries` —
    // the ONLY consumer of the ledger file's contents from here on. We no
    // longer separately re-read + re-parse the file (the pre-Phase-2
    // behavior called validateLedgerForR2 for its boolean/logging side
    // effect only, then re-read the SAME file independently for actual use
    // — silently accepting a structurally-present-but-per-entry-malformed
    // `entries` array as "valid," never a suppression-logic merge).
    const ledgerValidation = validateLedgerForR2(ledgerFile, round);
    if (!ledgerValidation.valid) suppressionUnavailable = true;
    ledgerInvalidEntryCount = ledgerValidation.invalidEntryCount ?? 0;
    ledgerStats = ledgerValidation.valid
      ? {
        entryCount: ledgerValidation.entryCount ?? 0,
        // The denominator: how many RULINGS suppression had to match against.
        adjudicated: ledgerValidation.validEntries?.length ?? 0,
        pending: ledgerValidation.pendingEntryCount ?? 0,
        invalid: ledgerInvalidEntryCount,
      }
      : { unavailable: true };

    if (ledgerValidation.valid && ledgerFile) {
      // Re-wrap as {version:1, entries: validEntries} (Gemini gate fix G2,
      // round 2 of that gate) — applyLedgerSuppression/suppressReRaises's
      // existing contract is `if (!ledger || !Array.isArray(ledger.entries))
      // return {kept: findings, dropped: []}`; it expects an OBJECT with an
      // `.entries` array property, not a bare array. Passing `validEntries`
      // directly would make `ledger.entries` `undefined` on every call,
      // silently disabling suppression entirely — the exact opposite of
      // this phase's purpose.
      ledger = { version: 1, entries: ledgerValidation.validEntries };
    } else if (ledgerFile) {
      // Ledger file present but validation failed (missing/corrupt/malformed
      // top-level shape) — validateLedgerForR2 already logged the specific
      // reason; degrade to no suppression.
      ledger = { version: 1, entries: [] };
    } else {
      process.stderr.write(`  [ledger] No --ledger provided; R2+ suppression disabled\n`);
      ledger = { version: 1, entries: [] };
    }

    // Parse diff
    if (diffFile) {
      diffMap = parseDiffFile(diffFile);
    }

    // Compute impact set
    impactSet = computeImpactSet(changedFiles, found);
    process.stderr.write(`  [R2+] Impact: ${impactSet.length} files (${changedFiles.length} changed + ${impactSet.length - changedFiles.length} dependents)\n`);
  }

  // Phase 6: Register prompt variants as bandit arms using revision IDs
  // Build context for contextual bandit selection
  const banditContext = repoProfile ? buildContext(repoProfile) : null;
  if (bandit) {
    for (const pass of PASS_NAMES) {
      const revId = getActiveRevisionId(pass) || 'default';
      bandit.addArm(pass, revId, null, { promptRevisionId: revId });
    }
  }

  process.stderr.write(`\nMulti-pass code audit: ${found.length} files in scope (${planFound.length} from the plan + ${addedFromScope.length} changed-not-planned), ${missing.length} missing, ${allPaths.size} referenced\n`);
  process.stderr.write(`  Backend: ${backend.length} files (${backendRoutes.length} routes, ${backendServices.length} services) + ${shared.length} shared\n`);
  process.stderr.write(`  Frontend: ${frontend.length} files + ${shared.length} shared\n`);
  if (splitBackend) process.stderr.write(`  Backend split: YES (>${BACKEND_SPLIT_THRESHOLD} files → separate route + service passes)\n`);

  // History context for round 2+ (prevents re-raising resolved findings)
  const historyBlock = historyContext ? `\n${historyContext}\n` : '';

  // Heading names both sources: conflating "the plan referenced this" with
  // "this changed and is in scope" is what let a changed file look reviewed.
  let fileListContext = `## Files In Scope (${planFound.length} referenced by the plan, ${missing.length} missing`
    + (addedFromScope.length ? `, ${addedFromScope.length} changed but not plan-referenced` : '') + `)\n\n`
    + (missing.length ? `**Missing:** ${missing.join(', ')}\n\n` : '')
    + `**Found:** ${found.join(', ')}\n`
    + (addedFromScope.length
      ? `\n**Changed but NOT referenced by the plan** (in scope because they changed; the plan may need updating): ${addedFromScope.join(', ')}\n`
      : '');

  // Adaptive repo-context block (Phase 3 — adaptive-context-blast-radius):
  // give the auditor the file inventory + import adjacency so it cannot
  // hallucinate "missing module" for unchanged-but-imported files. Lives
  // in the cacheable stable prefix. T1 for diff scope, T3 for full.
  try {
    const tier = scopeMode === 'full' ? 'T3' : 'T1';
    const rc = getRepoContext({
      tier, scope: scopeMode || 'diff',
      targetPaths: changedFiles || [], baseDir: process.cwd(),
    });
    if (rc.block) {
      fileListContext += `\n\n## Repository Context (tier ${rc.resolvedTier})\n${rc.block}\n`;
      process.stderr.write(`  [repo-context] tier ${rc.requestedTier}→${rc.resolvedTier} (~${rc.tokensEst} tok)${rc.degraded ? ` [degraded: ${rc.fallbackReason}]` : ''}\n`);
      // Without this line the operator has no signal that the model is being
      // handed a partial file list — which is precisely how the silent
      // truncation went unnoticed for 1214 commits.
      if (rc.truncated) {
        const dropped = (rc.coverage?.sections || [])
          .filter((x) => x.state !== 'full')
          .map((x) => `${x.id}=${x.state}(${x.shown}/${x.total})`).join(' ');
        process.stderr.write(`  [repo-context] TRUNCATED ${dropped || '(unitemised)'}\n`);
      }
    }
  } catch (err) {
    process.stderr.write(`  [repo-context] skipped (non-blocking) — ${err.message}\n`);
  }

  // Requirements rubric (Plan-Phase B — requirements-layer): surface the
  // de-facto-requirements ledger as an audit rubric so a pass can flag a
  // diff that violates a repo invariant. Static across rounds → lives in
  // the cacheable msg #1. Non-blocking: ledger absent / unreadable → ''.
  let requirementsRubric = '';
  try {
    const reqTargets = (changedFiles && changedFiles.length) ? changedFiles : found;
    const rq = getRequirementsContext({ targetPaths: reqTargets, baseDir: process.cwd() });
    if (rq.block) {
      requirementsRubric = rq.block;
      process.stderr.write(`  [requirements] rubric: ${rq.inScopeCount} in-scope / ${rq.indexCount} indexed (~${rq.tokensEst} tok)${rq.stale ? ' [stale]' : ''}${rq.uncoveredTargets.length ? ` [${rq.uncoveredTargets.length} uncovered]` : ''}\n`);
    }
  } catch (err) {
    process.stderr.write(`  [requirements] skipped (non-blocking) — ${err.message}\n`);
  }
  // Wrapper: thread the run-static requirements rubric into every pass
  // prompt without repeating it at each call site.
  const passPrompt = (opts) => buildCachePrompt({ ...opts, requirementsRubric });

  // When --files is specified, scope quality passes to those files + their shared deps
  // This enables delta-only auditing on Round 2+
  const inScope = scopeToFileFilter(fileFilter);
  const scopedBackend = inScope(backend);
  const scopedFrontend = inScope(frontend);
  const scopedBackendRoutes = inScope(backendRoutes);
  const scopedBackendServices = inScope(backendServices);

  if (fileFilter) {
    process.stderr.write(`  File scope: ${fileFilter.length} files → ${scopedBackend.length} BE + ${scopedFrontend.length} FE in scope\n`);
  }

  // Helper: should a pass run? Checks --passes filter + repo profile relevance
  const shouldRunPass = (name) => {
    if (passFilter && !passFilter.includes(name)) return false;
    if (repoProfile?.passRelevance && repoProfile.passRelevance[name] === false) {
      process.stderr.write(`  ${name} SKIPPED (repo profile: not relevant)\n`);
      return false;
    }
    return true;
  };

  // Inject priority focus areas from repo profile into system prompts
  const priorityBlock = repoProfile?.focusAreas?.length > 0
    ? `\n\nPRIORITY CHECKS for this codebase:\n${repoProfile.focusAreas.map(f => `- ${f}`).join('\n')}\n`
    : '';

  // Phase B: classification rubric appended to every pass prompt.
  // sourceName pulled from config so model changes don't require prompt edits.
  const classificationBlock = buildClassificationRubric({ sourceKind: 'MODEL', sourceName: MODEL });

  // ── Phase 0 (Phase C): Tool Pre-Pass ────────────────────────────────────────
  // Runs language-appropriate linters/type-checkers. Advisory-by-default:
  // tool findings are included in output but don't affect verdict math unless --strict-lint.
  // Opt-out via --no-tools for untrusted repos.
  let toolFindings = [];
  let lintContext = '';
  const toolCapability = {
    toolsAvailable: [],
    toolsFailed: [],
    strictLint,
    disabled: noTools,
    timestamp: Date.now(),
  };
  if (!noTools) {
    process.stderr.write('\n── Phase 0: Tool Pre-Pass ──\n');
    const toolStart = Date.now();
    const toolResults = executeTools(found);
    toolFindings = normalizeToolResults(toolResults);
    toolCapability.toolsAvailable = toolResults.filter(r => r.status === 'ok').map(r => r.toolId);
    toolCapability.toolsFailed = toolResults.filter(r => r.status !== 'ok').map(r => ({ id: r.toolId, status: r.status }));
    lintContext = formatLintSummary(toolFindings);
    const t = ((Date.now() - toolStart) / 1000).toFixed(1);
    process.stderr.write(`  [phase0] ${toolFindings.length} tool findings across ${toolCapability.toolsAvailable.length} tool(s) in ${t}s (strict-lint=${strictLint})\n`);
  } else {
    process.stderr.write('\n── Phase 0: Tool Pre-Pass SKIPPED (--no-tools) ──\n');
  }

  const focusBlock = priorityBlock + classificationBlock + (lintContext ? '\n\n' + lintContext : '');

  // Read shared files ONCE — reuse across passes that need them
  const sharedContext = shared.length > 0 ? readFilesAsContext(shared, { maxPerFile: 6000, maxTotal: 20000 }) : '';

  // Estimate base context size (targeted context per pass, not full CLAUDE.md)
  const baseContextChars = 2000 + fileListContext.length + historyBlock.length; // ~2000 for targeted CLAUDE.md

  // 2. Wave 1: Structure + Wiring (mechanical, reasoning: low)
  // Skippable on Round 2+ via --passes (structure rarely changes after R1)
  const wave1Promises = [];

  // Captured once (Phase 3, audit-orchestrator-hardening) so the pass-result
  // registry can derive status:'skipped' without re-invoking shouldRunPass
  // (which has a stderr side effect on the repo-profile-skip branch).
  const runStructure = shouldRunPass('structure');
  if (runStructure) {
    const structureContextChars = baseContextChars + measureContextChars(found, 2000);
    const structureLimits = computePassLimits(structureContextChars, 'low');
    process.stderr.write(`\n── Wave 1: Structure + Wiring (parallel, reasoning: low) ──\n`);
    const structureFiles = readFilesAsContext(found, { maxPerFile: 2000, maxTotal: 30000 });
    wave1Promises.push(
      safeCallGPT(openai, {
        ...passPrompt({
          rubric: PASS_STRUCTURE_SYSTEM,
          focusBlock,
          passName: 'structure',
          planContent,
          ledgerFile: isR2Plus ? ledgerFile : null,
          impactSet,
          isR2Plus,
          historyBlock,
          fileListContext,
          codeHeader: '## File Signatures',
          code: structureFiles,
        }),
        schema: StructurePassSchema,
        schemaName: 'structure_pass',
        reasoning: 'low',
        ...structureLimits,
        passName: 'structure'
      }, EMPTY_STRUCTURE)
    );
  } else {
    process.stderr.write(`\n── Wave 1: Structure SKIPPED (--passes) ──\n`);
    wave1Promises.push(Promise.resolve({ result: EMPTY_STRUCTURE, usage: { input_tokens: 0, output_tokens: 0, reasoning_tokens: 0, latency_ms: 0 }, latencyMs: 0 }));
  }

  const runWiring = shouldRunPass('wiring');
  if (runWiring) {
    const wiringFiles = found.filter(f => f.includes('/api/') || f.includes('/routes/'));
    const wiringContextChars = baseContextChars + measureContextChars(wiringFiles, 8000) + sharedContext.length;
    const wiringLimits = computePassLimits(wiringContextChars, 'low');
    const wiringCode = `${readFilesAsContext(wiringFiles, { maxPerFile: 8000, maxTotal: 60000 })}\n\n## Shared Files\n${sharedContext}`;
    wave1Promises.push(
      safeCallGPT(openai, {
        ...passPrompt({
          rubric: PASS_WIRING_SYSTEM,
          focusBlock,
          passName: 'wiring',
          planContent,
          ledgerFile: isR2Plus ? ledgerFile : null,
          impactSet,
          isR2Plus,
          historyBlock,
          fileListContext,
          codeHeader: '## API & Route Files',
          code: wiringCode,
        }),
        schema: WiringPassSchema,
        schemaName: 'wiring_pass',
        reasoning: 'low',
        ...wiringLimits,
        passName: 'wiring'
      }, EMPTY_WIRING)
    );
  } else {
    process.stderr.write(`  Wiring SKIPPED (--passes)\n`);
    wave1Promises.push(Promise.resolve({ result: EMPTY_WIRING, usage: { input_tokens: 0, output_tokens: 0, reasoning_tokens: 0, latency_ms: 0 }, latencyMs: 0 }));
  }

  const [structureResult, wiringResult] = await Promise.all(wave1Promises);
  cacheWaveResults(['structure', 'wiring'], [structureResult, wiringResult]);

  // ── Wave 1.5: Architecture Intent (NEW, PR-A 2026-05-11) ─────────────────
  // Opt-in: only runs when docs/architecture-intent.md AND
  // .audit-loop/domain-map.json both exist.
  let archResult = {
    result: { pass_name: 'architecture', findings: [], summary: 'pass not run' },
    usage: { input_tokens: 0, cached_tokens: 0, output_tokens: 0, reasoning_tokens: 0, latency_ms: 0 },
    latencyMs: 0,
  };
  let archState = 'SKIPPED_NO_INTENT';
  let archReportForOrphan = null;
  if (shouldRunPass('architecture')) {
    const archOut = await runArchitecturePass({
      openai, repoRoot: process.cwd(), focusBlock, planContent, historyBlock,
      ledgerFile, impactSet, isR2Plus,
    });
    archState = archOut.state;
    archResult = archOut.result;
    archReportForOrphan = archOut.archReport;
  } else {
    archState = 'SKIPPED_PASS_FILTER';
  }
  process.stderr.write(`  [architecture] ${archState}\n`);
  archResult._state = archState;
  cachePassResult('architecture', archResult);

  // ── Wave 1.5b: Orphan-Introduced check (dead-code phase 1, 2026-05-12) ────
  // Deterministic mechanical pass — no LLM cost. Reuses the HEAD import graph
  // from the architecture pass (shared dep-cruiser invocation).
  // Plan: docs/plans/dead-code-phase-1-orphan-introduced.md
  let orphanResult = {
    result: { pass_name: 'orphan-introduced', findings: [], summary: 'pass not run' },
    usage: { input_tokens: 0, cached_tokens: 0, output_tokens: 0, reasoning_tokens: 0, latency_ms: 0 },
    latencyMs: 0,
  };
  let orphanState = 'SKIPPED_NO_GRAPH';
  if (shouldRunPass('orphan-introduced')) {
    // audit-orchestrator-hardening H1 (hardening-implementation audit round
    // 2): this used to do its OWN independent raw JSON.parse of ledgerFile,
    // completely bypassing Phase 2's `validateLedgerForR2` schema
    // validation — a malformed entry that Phase 2 would reject/skip could
    // still reach orphan analysis through this parallel path. Reuse the
    // SAME validated `ledger` (declared above, reassigned to
    // `{version:1, entries: validEntries}` in R2+ mode) rather than
    // re-reading the file — one validated ledger object, one consumer path.
    const ledgerForOrphan = isR2Plus ? ledger : null;
    // Scope this wave to the SAME range the rest of the audit uses: a clean tree
    // means "audit my last commit" (base..HEAD); a dirty tree means "audit my
    // uncommitted work", which routes through the resolver's working-tree mode
    // (Gemini-R3/H3 — tracked diff vs HEAD + untracked files). This used to be
    // two hard-coded literals below a comment describing the mode it never
    // selected. resolveOrphanScopeRefs owns the decision and says why the clean
    // arm must NOT be `null`.
    const orphanScope = resolveOrphanScopeRefs({ auditBaseCommit, workingTreeDirty });
    const orphanOut = await runOrphanIntroducedPass({
      archReport: archReportForOrphan,
      repoRoot: process.cwd(),
      baseRef: orphanScope.baseRef,
      headRef: orphanScope.headRef,
      runId: debtRunId,
      planContent,
      ledger: ledgerForOrphan,
      learningWritesAllowed,
    });
    orphanState = orphanOut.state;
    orphanResult = orphanOut.result;
  } else {
    orphanState = 'SKIPPED_PASS_FILTER';
  }
  process.stderr.write(`  [orphan-introduced] ${orphanState} — ${orphanResult.result.findings.length} findings\n`);
  orphanResult._state = orphanState;
  cachePassResult('orphan-introduced', orphanResult);

  // ── Wave 1.5c: event-wiring-symmetry check (docs/plans/event-wiring-symmetry.md) ──
  // Deterministic mechanical pass — no LLM cost. Committed-range-only (see
  // runEventWiringSymmetryPass's docstring for why it does not follow
  // orphan's dirty-tree branch).
  let eventWiringResult = {
    result: { pass_name: 'event-wiring-symmetry', findings: [], summary: 'pass not run' },
    usage: { input_tokens: 0, cached_tokens: 0, output_tokens: 0, reasoning_tokens: 0, latency_ms: 0 },
    latencyMs: 0,
  };
  let eventWiringState = 'SKIPPED_PASS_FILTER';
  if (shouldRunPass('event-wiring-symmetry')) {
    const ledgerForEventWiring = isR2Plus ? ledger : null;
    const eventWiringOut = await runEventWiringSymmetryPass({
      repoRoot: process.cwd(),
      auditBaseCommit,
      runId: debtRunId,
      ledger: ledgerForEventWiring,
      planContent,
      learningWritesAllowed,
    });
    eventWiringState = eventWiringOut.state;
    eventWiringResult = eventWiringOut.result;
  }
  process.stderr.write(`  [event-wiring-symmetry] ${eventWiringState} — ${eventWiringResult.result.findings.length} findings\n`);
  eventWiringResult._state = eventWiringState;
  cachePassResult('event-wiring-symmetry', eventWiringResult);

  // 3. Wave 2: Backend + Frontend quality (deep, reasoning: high)
  process.stderr.write('\n── Wave 2: Quality passes (parallel, reasoning: high) ──\n');

  const wave2Promises = [];
  const backendPassNames = [];

  // Use scoped file lists when --files is specified (delta-only auditing)
  const beCtx = readProjectContextForPass('backend');
  const bePlan = extractPlanForPass(planContent, 'backend');
  const effectiveRoutes = fileFilter ? scopedBackendRoutes : backendRoutes;
  const effectiveServices = fileFilter ? scopedBackendServices : backendServices;
  const effectiveBackend = fileFilter ? scopedBackend : backend;
  const effectiveFrontend = fileFilter ? scopedFrontend : frontend;

  // The audited subject-file set — hoisted to function scope so BOTH the A1
  // guard below AND the model-A/B generation shadow (far below) can read it. It
  // was previously block-scoped inside the guard, so the shadow's
  // `buildRedactedAuditContext([...subjectFiles])` referenced an undefined
  // binding (a ReferenceError that only surfaced once the shadow was enabled —
  // caught by the first live calibration run, model-ab-harness-v2).
  const subjectFiles = new Set([
    ...effectiveBackend, ...effectiveFrontend,
    ...(splitBackend ? [...effectiveRoutes, ...effectiveServices] : []),
  ]);

  // ── A1 guard: "audit your success paths" applied to the auditor ITSELF ──
  // Refuse to emit a verdict when 0 implementation files would reach the prompt
  // (hollow-but-confident result). Pure predicate lives in audit-scope.mjs.
  {
    // (1) File-set check — scope resolved to no subject files.
    const guardMsg = auditSubjectFileGuard({
      scopeMode, subjectFileCount: subjectFiles.size, hasFileFilter: Boolean(fileFilter),
      foundCount: found.length, referencedCount: allPaths.size,
    });
    if (guardMsg) throw new Error(guardMsg);
    // (2) Content check (audit R1 HIGH) — files can RESOLVE yet assemble to EMPTY
    // context (all unreadable / sensitive-filtered / oversized), which the count
    // check can't see. Probe the actual assembled code block (cheap head-only read);
    // an empty block = the same hollow-verdict hazard, so refuse it too.
    if (scopeMode !== 'full' && subjectFiles.size > 0) {
      const probe = readFilesAsContext([...subjectFiles], { maxPerFile: 200, maxTotal: 4000 });
      if (!probe || !probe.trim()) {
        throw new Error(`audit aborted — ${subjectFiles.size} file(s) resolved but assembled to EMPTY implementation context (unreadable / sensitive-filtered / oversized); refusing to emit a verdict over an empty prompt.`);
      }
    }
  }

  if (shouldRunPass('backend')) {
    if (splitBackend) {
      if (effectiveRoutes.length > 0) {
        backendPassNames.push('be-routes');
        if (shouldMapReduceHighReasoning(effectiveRoutes)) {
          mapReducePasses.push('be-routes');
          process.stderr.write(`  [be-routes] ${effectiveRoutes.length} files — using map-reduce\n`);
          wave2Promises.push(
            runMapReducePass(openai, effectiveRoutes, 'be-routes', (unit, i, total, unitLabel) => passPrompt({
              rubric: isR2Plus ? PASS_BACKEND_RUBRIC : PASS_BACKEND_SYSTEM,
              focusBlock,
              passName: 'be-routes',
              planContent,
              ledgerFile: isR2Plus ? ledgerFile : null,
              impactSet,
              isR2Plus,
              historyBlock,
              codeHeader: '## Code',
              code: unit._context,
              unitLabel,
            }), openaiConfig.backendMaxFilesPerUnit)
          );
        } else {
          const limits = computePassLimits(baseContextChars + measureContextChars(effectiveRoutes, 8000) + sharedContext.length, 'high');
          process.stderr.write(`  be-routes: ${effectiveRoutes.length} files → ${limits.maxTokens} tok / ${(limits.timeoutMs/1000).toFixed(0)}s\n`);
          const beRoutesCode = `${isR2Plus && diffMap ? readFilesAsAnnotatedContext(effectiveRoutes, diffMap, { maxPerFile: 8000, maxTotal: 60000 }) : readFilesAsContext(effectiveRoutes, { maxPerFile: 8000, maxTotal: 60000 })}\n\n## Shared Files\n${sharedContext}`;
          wave2Promises.push(
            safeCallGPT(openai, {
              ...passPrompt({
                rubric: isR2Plus ? PASS_BACKEND_RUBRIC : PASS_BACKEND_SYSTEM,
                focusBlock,
                passName: 'be-routes',
                planContent,
                ledgerFile: isR2Plus ? ledgerFile : null,
                impactSet,
                isR2Plus,
                historyBlock,
                codeHeader: '## Backend ROUTES',
                code: beRoutesCode,
              }),
              schema: PassFindingsSchema,
              schemaName: 'backend_routes_pass',
              reasoning: 'high',
              ...limits,
              passName: 'be-routes'
            }, EMPTY_FINDINGS)
          );
        }
      }
      if (effectiveServices.length > 0) {
        backendPassNames.push('be-services');
        if (shouldMapReduceHighReasoning(effectiveServices)) {
          mapReducePasses.push('be-services');
          process.stderr.write(`  [be-services] ${effectiveServices.length} files — using map-reduce\n`);
          wave2Promises.push(
            runMapReducePass(openai, effectiveServices, 'be-services', (unit, i, total, unitLabel) => passPrompt({
              rubric: isR2Plus ? PASS_BACKEND_RUBRIC : PASS_BACKEND_SYSTEM,
              focusBlock,
              passName: 'be-services',
              planContent,
              ledgerFile: isR2Plus ? ledgerFile : null,
              impactSet,
              isR2Plus,
              historyBlock,
              codeHeader: '## Code',
              code: unit._context,
              unitLabel,
            }), openaiConfig.backendMaxFilesPerUnit)
          );
        } else {
          const limits = computePassLimits(baseContextChars + measureContextChars(effectiveServices, 8000), 'high');
          process.stderr.write(`  be-services: ${effectiveServices.length} files → ${limits.maxTokens} tok / ${(limits.timeoutMs/1000).toFixed(0)}s\n`);
          const beServicesCode = isR2Plus && diffMap ? readFilesAsAnnotatedContext(effectiveServices, diffMap, { maxPerFile: 8000, maxTotal: 80000 }) : readFilesAsContext(effectiveServices, { maxPerFile: 8000, maxTotal: 80000 });
          wave2Promises.push(
            safeCallGPT(openai, {
              ...passPrompt({
                rubric: isR2Plus ? PASS_BACKEND_RUBRIC : PASS_BACKEND_SYSTEM,
                focusBlock,
                passName: 'be-services',
                planContent,
                ledgerFile: isR2Plus ? ledgerFile : null,
                impactSet,
                isR2Plus,
                historyBlock,
                codeHeader: '## Backend SERVICES',
                code: beServicesCode,
              }),
              schema: PassFindingsSchema,
              schemaName: 'backend_services_pass',
              reasoning: 'high',
              ...limits,
              passName: 'be-services'
            }, EMPTY_FINDINGS)
          );
        }
      }
    } else if (effectiveBackend.length > 0) {
      backendPassNames.push('backend');
      if (shouldMapReduceHighReasoning(effectiveBackend)) {
        mapReducePasses.push('backend');
        process.stderr.write(`  [backend] ${effectiveBackend.length} files — using map-reduce\n`);
        wave2Promises.push(
          runMapReducePass(openai, effectiveBackend, 'backend', (unit, i, total, unitLabel) => passPrompt({
            rubric: isR2Plus ? PASS_BACKEND_RUBRIC : PASS_BACKEND_SYSTEM,
            focusBlock,
            passName: 'backend',
            planContent,
            ledgerFile: isR2Plus ? ledgerFile : null,
            impactSet,
            isR2Plus,
            historyBlock,
            codeHeader: '## Code',
            code: unit._context,
            unitLabel,
          }), openaiConfig.backendMaxFilesPerUnit)
        );
      } else {
        const limits = computePassLimits(baseContextChars + measureContextChars(effectiveBackend, 8000) + sharedContext.length, 'high');
        process.stderr.write(`  backend: ${effectiveBackend.length} files → ${limits.maxTokens} tok / ${(limits.timeoutMs/1000).toFixed(0)}s\n`);
        const backendCode = `${isR2Plus && diffMap ? readFilesAsAnnotatedContext(effectiveBackend, diffMap, { maxPerFile: 8000, maxTotal: 80000 }) : readFilesAsContext(effectiveBackend, { maxPerFile: 8000, maxTotal: 80000 })}\n\n## Shared Files\n${sharedContext}`;
        wave2Promises.push(
          safeCallGPT(openai, {
            ...passPrompt({
              rubric: isR2Plus ? PASS_BACKEND_RUBRIC : PASS_BACKEND_SYSTEM,
              focusBlock,
              passName: 'backend',
              planContent,
              ledgerFile: isR2Plus ? ledgerFile : null,
              impactSet,
              isR2Plus,
              historyBlock,
              codeHeader: '## Backend Implementation Files',
              code: backendCode,
            }),
            schema: PassFindingsSchema,
            schemaName: 'backend_pass',
            reasoning: 'high',
            ...limits,
            passName: 'backend'
          }, EMPTY_FINDINGS)
        );
      }
    }
  } else {
    process.stderr.write(`  backend SKIPPED (--passes)\n`);
  }

  const runFrontend = shouldRunPass('frontend');
  // M6 (code-audit r1): dispatch and passRegistry used to check different
  // predicates (this flag vs bare runFrontend) — a pass can be "on" via
  // --passes but have zero frontend files, in which case no model call
  // happens and the registry must not report it as having ran.
  const frontendWillRun = runFrontend && effectiveFrontend.length > 0;
  if (frontendWillRun) {
    if (shouldMapReduceHighReasoning(effectiveFrontend)) {
      mapReducePasses.push('frontend');
      process.stderr.write(`  [frontend] ${effectiveFrontend.length} files — using map-reduce\n`);
      wave2Promises.push(
        runMapReducePass(openai, effectiveFrontend, 'frontend', (unit, i, total, unitLabel) => passPrompt({
          rubric: isR2Plus ? PASS_FRONTEND_RUBRIC : PASS_FRONTEND_SYSTEM,
          focusBlock,
          passName: 'frontend',
          planContent,
          ledgerFile: isR2Plus ? ledgerFile : null,
          impactSet,
          isR2Plus,
          historyBlock,
          codeHeader: '## Code',
          code: unit._context,
          unitLabel,
        }), openaiConfig.frontendMaxFilesPerUnit)
      );
    } else {
      const limits = computePassLimits(baseContextChars + measureContextChars(effectiveFrontend, 10000) + sharedContext.length, 'high');
      process.stderr.write(`  frontend: ${effectiveFrontend.length} files → ${limits.maxTokens} tok / ${(limits.timeoutMs/1000).toFixed(0)}s\n`);
      const frontendCode = `${isR2Plus && diffMap ? readFilesAsAnnotatedContext(effectiveFrontend, diffMap, { maxPerFile: 10000, maxTotal: 80000 }) : readFilesAsContext(effectiveFrontend, { maxPerFile: 10000, maxTotal: 80000 })}\n\n## Shared Files\n${sharedContext}`;
      wave2Promises.push(
        safeCallGPT(openai, {
          ...passPrompt({
            rubric: isR2Plus ? PASS_FRONTEND_RUBRIC : PASS_FRONTEND_SYSTEM,
            focusBlock,
            passName: 'frontend',
            planContent,
            ledgerFile: isR2Plus ? ledgerFile : null,
            impactSet,
            isR2Plus,
            historyBlock,
            codeHeader: '## Frontend Implementation Files',
            code: frontendCode,
          }),
          schema: PassFindingsSchema,
          schemaName: 'frontend_pass',
          reasoning: 'high',
          ...limits,
          passName: 'frontend'
        }, EMPTY_FINDINGS)
      );
    }
  } else if (!runFrontend) {
    process.stderr.write(`  frontend SKIPPED (--passes)\n`);
  }

  if (wave2Promises.length === 0) {
    wave2Promises.push(Promise.resolve({ result: EMPTY_FINDINGS, usage: { input_tokens: 0, output_tokens: 0, reasoning_tokens: 0, latency_ms: 0 }, latencyMs: 0 }));
  }

  const wave2Results = await Promise.all(wave2Promises);
  const backendResults = wave2Results.slice(0, backendPassNames.length);
  const frontendResult = wave2Results[backendPassNames.length] ?? { result: EMPTY_FINDINGS, usage: { input_tokens: 0, output_tokens: 0, reasoning_tokens: 0, latency_ms: 0 }, latencyMs: 0 };
  cacheWaveResults([...backendPassNames, 'frontend'], wave2Results);

  // 4. Wave 3: Sustainability (reasoning: medium)
  let sustainResult;
  const runSustainability = shouldRunPass('sustainability');
  if (runSustainability) {
    const sustainFiles = inScope(found);

    process.stderr.write(`\n── Wave 3: Sustainability (reasoning: medium) ──\n`);

    if (shouldMapReduce(sustainFiles)) {
      mapReducePasses.push('sustainability');
      process.stderr.write(`  [sustainability] ${sustainFiles.length} files — using map-reduce\n`);
      // Fix #3: Pass changedFileSet so unchanged map units skip retries
      const changedFileSet = changedFiles.length > 0 ? new Set(changedFiles.map(normalizePath)) : null;
      sustainResult = await runMapReducePass(openai, sustainFiles, 'sustainability', (unit, i, total, unitLabel) => passPrompt({
        rubric: isR2Plus ? PASS_SUSTAINABILITY_RUBRIC : PASS_SUSTAINABILITY_SYSTEM,
        focusBlock,
        passName: 'sustainability',
        planContent,
        ledgerFile: isR2Plus ? ledgerFile : null,
        impactSet,
        isR2Plus,
        historyBlock,
        codeHeader: '## Code',
        code: unit._context,
        unitLabel,
      }), Infinity, { changedFileSet });
    } else {
      const sustainContextChars = baseContextChars + measureContextChars(sustainFiles, 4000);
      const sustainLimits = computePassLimits(sustainContextChars, 'medium');
      process.stderr.write(`  ${sustainFiles.length} files → ${sustainLimits.maxTokens} tok / ${(sustainLimits.timeoutMs/1000).toFixed(0)}s\n`);

      const sustainCode = isR2Plus && diffMap ? readFilesAsAnnotatedContext(sustainFiles, diffMap, { maxPerFile: 4000, maxTotal: 60000 }) : readFilesAsContext(sustainFiles, { maxPerFile: 4000, maxTotal: 60000 });
      sustainResult = await safeCallGPT(openai, {
        ...passPrompt({
          rubric: isR2Plus ? PASS_SUSTAINABILITY_RUBRIC : PASS_SUSTAINABILITY_SYSTEM,
          focusBlock,
          passName: 'sustainability',
          planContent,
          ledgerFile: isR2Plus ? ledgerFile : null,
          impactSet,
          isR2Plus,
          historyBlock,
          codeHeader: '## All Implementation Files',
          code: sustainCode,
        }),
        schema: SustainabilityPassSchema,
        schemaName: 'sustainability_pass',
        reasoning: 'medium',
        ...sustainLimits,
        passName: 'sustainability'
      }, EMPTY_SUSTAIN);
    }
  } else {
    process.stderr.write(`\n── Sustainability SKIPPED (--passes) ──\n`);
    sustainResult = { result: EMPTY_SUSTAIN, usage: { input_tokens: 0, output_tokens: 0, reasoning_tokens: 0, latency_ms: 0 }, latencyMs: 0 };
  }

  cachePassResult('sustainability', sustainResult);

  // 4.5 Wave 4: Quickfix design-shortcut detector (reasoning: low — pattern match, not deep semantic)
  // Plan: docs/plans/brainstorm-quickfix-v1.md §B2.
  let quickfixResult;
  const EMPTY_QUICKFIX = { pass_name: 'quickfix', findings: [], summary: 'Pass skipped.' };
  const runQuickfix = shouldRunPass('quickfix');
  if (runQuickfix) {
    const qfFiles = inScope(found);
    process.stderr.write(`\n── Wave 4: Quickfix design-shortcuts (reasoning: low) ──\n`);
    const PASS_QUICKFIX_SYSTEM_LOCAL = getPassPrompt('quickfix');
    const qfRubric = PASS_QUICKFIX_SYSTEM_LOCAL;  // pass full prompt for low-reasoning consistency
    const qfContextChars = baseContextChars + measureContextChars(qfFiles, 4000);
    const qfLimits = computePassLimits(qfContextChars, 'low');
    process.stderr.write(`  ${qfFiles.length} files → ${qfLimits.maxTokens} tok / ${(qfLimits.timeoutMs/1000).toFixed(0)}s\n`);
    const qfCode = isR2Plus && diffMap ? readFilesAsAnnotatedContext(qfFiles, diffMap, { maxPerFile: 4000, maxTotal: 60000 }) : readFilesAsContext(qfFiles, { maxPerFile: 4000, maxTotal: 60000 });
    quickfixResult = await safeCallGPT(openai, {
      ...passPrompt({
        rubric: qfRubric,
        focusBlock,
        passName: 'quickfix',
        planContent,
        ledgerFile: isR2Plus ? ledgerFile : null,
        impactSet,
        isR2Plus,
        historyBlock,
        codeHeader: '## All Implementation Files',
        code: qfCode,
      }),
      schema: QuickfixPassSchema,
      schemaName: 'quickfix_pass',
      reasoning: 'low',
      ...qfLimits,
      passName: 'quickfix'
    }, EMPTY_QUICKFIX);
    // Force is_quick_fix:true on every finding from this pass (defence — prompt asks but model may forget)
    if (quickfixResult?.result?.findings) {
      quickfixResult.result.findings = quickfixResult.result.findings.map(f => ({ ...f, is_quick_fix: true }));
    }
  } else {
    process.stderr.write(`\n── Quickfix SKIPPED (--passes) ──\n`);
    quickfixResult = { result: EMPTY_QUICKFIX, usage: { input_tokens: 0, output_tokens: 0, reasoning_tokens: 0, latency_ms: 0 }, latencyMs: 0 };
  }
  cachePassResult('quickfix', quickfixResult);

  // 4.6 Wave 5: Duplication detector (mechanical detection + low-reasoning LLM bouncer)
  // Plan: docs/plans/audit-code-duplication-wave.md. Extracted to runDuplicationPass
  // (2026-08-13) so the pass carries the {result, usage, latencyMs} contract its
  // bouncer call was silently dropping — see that function's docblock.
  const EMPTY_DUPLICATION = { pass_name: 'duplication', findings: [], summary: 'Pass skipped.' };
  let duplicationResult;
  // Bound once, not re-derived at the registry below: `ran` there reads this
  // exact decision, and a second `shouldRunPass` call is a second source of
  // truth for it.
  const runDuplication = shouldRunPass('duplication');
  if (runDuplication) {
    process.stderr.write(`\n── Wave 5: Duplication detector ──\n`);
    duplicationResult = await runDuplicationPass({
      openai, ctx, passPrompt, changedFiles, auditBaseCommit,
      focusBlock, planContent, historyBlock, ledgerFile, impactSet, isR2Plus,
    });
  } else {
    process.stderr.write(`\n── Duplication SKIPPED (--passes) ──\n`);
    duplicationResult = { result: EMPTY_DUPLICATION, usage: { input_tokens: 0, output_tokens: 0, reasoning_tokens: 0, latency_ms: 0 }, latencyMs: 0 };
  }
  cachePassResult('duplication', duplicationResult);

  // ── Wave 6: Containment adjacency ──────────────────────────────────────
  // Plan: docs/plans/adjacency-check-containment.md. Mechanical (no LLM in the
  // enumeration), mirroring Wave 5's two-stage shape: a deterministic detector
  // finds what exists, an LLM bouncer only judges what it is handed.
  //
  // Trigger is the FIX DIFF, not a finding — `section` is free prose (measured:
  // a line number in 6 of 1764 stored findings) and the enrichment regex
  // discards line numbers even when present, so a finding cannot carry an
  // anchor. A diff hunk always can, and a diff-driven trigger additionally
  // cannot self-trigger, so this wave can never churn on its own output.
  //
  // Extracted to runAdjacencyPass (2026-08-13) for the usage-contract reason
  // recorded on runDuplicationPass.
  const EMPTY_ADJACENCY = { pass_name: 'adjacency', findings: [], summary: 'Pass skipped.' };
  let adjacencyResult;
  const runAdjacency = shouldRunPass('adjacency');
  if (runAdjacency) {
    adjacencyResult = await runAdjacencyPass({
      openai, ctx, passPrompt, auditBaseCommit,
      focusBlock, planContent, historyBlock, ledgerFile, impactSet, isR2Plus,
    });
  } else {
    process.stderr.write(`\n── Adjacency SKIPPED (--passes) ──\n`);
    adjacencyResult = { result: EMPTY_ADJACENCY, usage: { input_tokens: 0, output_tokens: 0, reasoning_tokens: 0, latency_ms: 0 }, latencyMs: 0 };
  }
  cachePassResult('adjacency', adjacencyResult);

  // 5. Merge all pass results with semantic dedup
  const totalLatency = Date.now() - totalStart;

  // ── Phase 4 finalization (legacy-production-audit-decomposition) ────────
  // Delegates to finding-assembly.mjs (4b) -> run-telemetry.mjs (4d) ->
  // run-persistence.mjs (4c) via the thin run-finalization.mjs coordinator.
  // `writeOutcomes` is the SAME tally object declared at the top of this
  // function (:402) — pre-wave writes (audit.planLink, audit.diffComplexity)
  // already accumulated into it before this point, and it must keep
  // accumulating through 4d/4c, not be replaced by a fresh object.
  const finalizationData = {
    ctx, round, planFile, planContent, strictLint, changedFiles, impactSet,
    totalLatency, diffLinesChanged, diffFilesChanged, sessionCacheHit, mapReducePasses,
    ledgerFile, noLedger, ledger, ledgerStats, ledgerInvalidEntryCount, suppressionUnavailable,
    fpTracker, cloudFpPolicy, cloudRunId, cloudRepoId, noCloudRecording, learningWritesAllowed,
    bandit, debtLedger, debtContext, debtEventsPath, newlyEscalated, debtRunId,
    toolFindings, toolCapability, allPaths, found, missing, subjectFiles,
    runStructure, structureResult, runWiring, wiringResult, backendPassNames, backendResults,
    frontendWillRun, frontendResult, runSustainability, sustainResult, runQuickfix, quickfixResult,
    runDuplication, duplicationResult, runAdjacency, adjacencyResult,
    archState, archResult, orphanState, orphanResult, eventWiringState, eventWiringResult,
    isR2Plus,
  };
  const { mergedResult } = await finalizeRun(finalizationData, writeOutcomes);
  return mergedResult;
}

// ── Context builder (tiered-recall pipeline Phase 11, audit-plan fix M1) ──

/**
 * Maps `openai-audit.mjs`'s `main()` already-parsed CLI args into an
 * `AuditRunContext` — the orchestration-relevant subset of
 * `runMultiPassCodeAudit`'s former ~19 loose params (excludes CLI-
 * presentation-only concerns: `jsonMode` stays in the wrapper; the final
 * `--out` write happens in the wrapper too, though `outFile` itself IS
 * carried on `ctx` — see `AuditRunContextSchema`'s docblock for why).
 *
 * Constructs the four `providers` handles ONCE via the existing guarded
 * factories, per the plan's explicit instruction — so no stage module
 * constructs a provider SDK client itself:
 *   - `openai`          — passed through (already constructed by `main()`)
 *   - `anthropicClient`  — `createAnthropicClient()` (used by
 *     `discovery-portfolio.mjs`'s Sonnet cold-pass generator)
 *   - `ossCall`          — a bound `(opts) => ossStructuredCall(client, opts)`
 *     over a `createOpenAIClient({oss:{...}})` client pointed at OpenRouter
 *     (mirrors the existing `audit-shadow.mjs::callModelDefault` pattern)
 *   - `geminiReviewCall` + `geminiCleanRegionCall` — Phase 12's REAL
 *     subprocess adapters (`createGeminiReviewSubprocessAdapters`), wired
 *     2026-07-13 as part of the Close-out shadow-validation flip. TWO
 *     handles, not one: `runFinalAdjudication`'s adapters have different
 *     signatures (`reviewCall(envelope)` vs `cleanRegionCall(file)`), so
 *     the earlier single-handle design could never have served both.
 *     Construction is cheap and spawn-lazy (no subprocess until Stage 2
 *     actually calls one); the adapters resolve `gemini-review.mjs` as a
 *     module-relative sibling, correct in both the source and consumer
 *     (`scripts/.claude-skills/`) layouts.
 *
 * @param {object} cliArgs - the same options object `main()` already builds
 *   for its (pre-Phase-11) `runMultiPassCodeAudit(...)` call.
 * @returns {Promise<import('../schemas.mjs').AuditRunContext>}
 */
export async function buildAuditRunContext(cliArgs) {
  const {
    openai, planContent, projectContext = '', historyContext = '',
    passFilter = null, fileFilter = null, round = 1, ledgerFile = null, diffFile = null,
    changedFiles = [], auditBaseCommit = null, repoProfile = null, bandit = null, fpTracker = null, noLedger = false,
    noTools = false, strictLint = false, noDebtLedger = false, readOnlyDebt = false,
    debtLedgerPath = undefined, debtEventsPath = undefined, escalateRecurring = null,
    sessionCacheHit = null, scopeMode = null, planFile = null, runId = null, allowInfraScope = false,
    outFile = null, model = null, allowTiered = false, __runDuplicationAnalysis = null, __runAdjacencyAnalysis = null,
    // docs/plans/stage0-evidence-relevance-split.md decision #5: the tiered
    // pipeline's Stage 0 blame/impact adapters need the current HEAD sha
    // (import-graph freshness validation) and dirty-tree status (both
    // adapters degrade to their safe 'unknown' default on a dirty tree —
    // a graph/blame check built against a committed HEAD can't see
    // uncommitted changes). Resolved once by openai-audit.mjs's `main()`
    // (the one CLI entrypoint) using the SAME git primitives its own
    // --scope=diff dirty-check already uses, and threaded through
    // unchanged — no new resolution logic here. `runLegacyProductionAudit`
    // never reads either field, so this is purely additive.
    commitSha = null, workingTreeDirty = false,
  } = cliArgs;

  // Only construct the tiered-pipeline-only provider handles when the
  // tiered pipeline can actually RUN — as the gating path (`pipelineEnabled`)
  // OR as the Close-out shadow (`shadowEnabled`, 2026-07-13: the original
  // `pipelineEnabled`-only gate meant a shadow-validation run got
  // `anthropicClient: null, ossCall: null` and failed its discovery portfolio
  // on the first call, deterministically — the entire shadow window would
  // have produced zero comparison data). `runLegacyProductionAudit` never
  // reads these handles, so the default (both flags off) run still pays no
  // construction cost — "every phase remains additive/env-var-gated" holds.
  //
  // AND the call site must assert `allowTiered` (same day, the shadow-flip
  // incident fix): the env flags alone are NOT sufficient — they load from
  // the shared ~/.audit-loop.env in every Node process in every repo,
  // INCLUDING test runs whose harnesses stub only the `openai` argument and
  // cannot stub these independently-constructed handles. With the shadow
  // flag flipped on, fully-mocked unit tests started executing the real
  // tiered pipeline (real GLM/Sonnet calls, real gemini-review subprocess
  // spawns) — the full suite went 54s → 6.5min, observed live. Execution
  // eligibility is a per-CALL property that only the production CLI
  // entrypoint asserts (`main()` passes `allowTiered: true`); programmatic
  // callers (tests, model-eval generation arms) default false and stay
  // hermetic regardless of env.
  let anthropicClient = null;
  // Why the client was (or wasn't) constructed — see the catch below. Absent
  // construction attempt (tiered off) stays `not-attempted`, distinct from a
  // failure: "we never tried" must never render as "it broke".
  let anthropicReadiness = { state: 'not-attempted', message: 'tiered pipeline/shadow disabled' };
  let ossCall = null;
  let geminiReviewCall = null;
  let geminiCleanRegionCall = null;
  if ((tieredAuditConfig.pipelineEnabled || tieredAuditConfig.shadowEnabled) && allowTiered) {
    try {
      // Forced `backend: 'sdk'` — NOT the ambient CLAUDE_BACKEND-resolved
      // default. This handle is used SOLELY for discovery-portfolio.mjs's
      // Sonnet generator, which requires `tool_choice:{type:'tool',…}` to
      // get structured findings back. The `cli` backend's messages.create()
      // silently drops `tools`/`tool_choice` (by design, for its original
      // single-shot-text callers — see anthropic-client.mjs) and returns
      // plain text instead, which the generator's `tool_use` check then
      // fails — a REQUIRED generator failure, so every round fell back to
      // legacy. Root-caused 2026-07-14: with CLAUDE_BACKEND=cli active
      // locally since 2026-06-29, 20/20 Close-out shadow observations across
      // two repos were silent no-op fallbacks, not real comparisons. This
      // handle needs the real Messages API tool-calling surface regardless
      // of what the rest of the process is configured to use.
      anthropicClient = await createAnthropicClient({ backend: 'sdk' });
      anthropicReadiness = { state: 'available' };
    } catch (err) {
      // Construction stays NON-BLOCKING — the legacy audit does not need this
      // client, and hard-failing here would break every keyless legacy run.
      // But `null` alone conflates four different causes: credentials missing,
      // malformed configuration, transport/SDK init failure, and a future
      // regression in construction. The tiered shadow then reported all of
      // them as one generic "providers.anthropicClient unavailable", which is
      // how 51 records from a single keyless session read as intermittent
      // flakiness for two days. Classify instead — a diagnostic that lies is
      // worse than none (see tiered-shadow-summary.mjs's own note).
      anthropicReadiness = classifyProviderReadiness(err);
      process.stderr.write(
        `  [ctx] anthropicClient unavailable [${anthropicReadiness.state}] ` +
        `(non-blocking — only the tiered pipeline's Sonnet generator needs it): ${anthropicReadiness.message}\n`
      );
    }
    try {
      const ossClient = await createOpenRouterClient();
      ossCall = (opts) => ossStructuredCall(ossClient, opts);
    } catch (err) {
      process.stderr.write(`  [ctx] ossCall unavailable (non-blocking — only the tiered pipeline's discovery portfolio needs it): ${err.message}\n`);
    }
    try {
      // Spawn-lazy: construction writes/spawns nothing — the subprocess only
      // runs when Stage 2 actually invokes an adapter.
      const adapters = createGeminiReviewSubprocessAdapters({ repoRoot: process.cwd() });
      geminiReviewCall = adapters.reviewCall;
      geminiCleanRegionCall = adapters.cleanRegionCall;
    } catch (err) {
      process.stderr.write(`  [ctx] gemini adjudication adapters unavailable (non-blocking — the tiered pipeline fails fast with a clear cause if Stage 2 is reached): ${err.message}\n`);
    }
  }

  // Load-bearing for the tiered pipeline's Stage 0 evidence-triage
  // (evidence-triage.mjs `verifyAnchor`: `if (!diffText) return
  // 'unverifiable'`) — found 2026-07-15 after the first real shadow
  // observations landed: `diffText` was read in 3 places across
  // discovery-portfolio.mjs/tiered-pipeline.mjs/evidence-triage.mjs but
  // never ASSIGNED anywhere in the whole codebase, so every single
  // commission-type finding's anchor was unconditionally unverifiable —
  // Stage 0 rejected 100% of candidates on every one of the first 4 real
  // `complete` shadow runs (10-18 raw candidates, 0 verified, every time;
  // not model-recall noise — deterministic). `runLegacyProductionAudit`
  // never needed this (it re-reads `diffFile` itself, independently, for
  // its own line/file-count metadata just above) — this is purely
  // additive for tiered/shadow consumers, changes nothing for the legacy
  // path. Best-effort, NEVER throws: a genuinely broken `--diff` is
  // already validated loudly, with a detailed error, by the legacy path's
  // own read a few hundred lines above — duplicating that failure mode
  // here (which runs for EVERY audit, tiered or not, before either path
  // has started) would turn a currently-recoverable-by-legacy state into
  // a hard crash for runs that never even reach the tiered pipeline.
  let diffText = null;
  if (diffFile) {
    try {
      diffText = fs.readFileSync(diffFile, 'utf-8');
    } catch (err) {
      // Still fail-open — the comment above says why throwing HERE would crash
      // runs that never reach the tiered pipeline — but no longer silent. The
      // "legacy path surfaces it loudly" claim is true TODAY only because the
      // legacy read runs for every audit; when the tiered pipeline runs instead
      // (`AUDIT_TIERED_PIPELINE_ENABLED`), nothing else reads this file and
      // `diffText: null` reaches adjacency-detector / evidence-triage as an
      // ABSENT diff rather than an unreadable one. One line makes those two
      // states distinguishable in the log without changing control flow.
      process.stderr.write(`  [ctx] --diff "${diffFile}" unreadable (${err.code || err.message}) — diffText degraded to null\n`);
    }
  }

  return {
    planContent, projectContext, historyContext,
    passFilter, fileFilter, round, ledgerFile, diffFile, diffText, changedFiles, auditBaseCommit, __runDuplicationAnalysis, __runAdjacencyAnalysis, repoProfile, bandit, fpTracker,
    noLedger, noTools, strictLint, noDebtLedger, readOnlyDebt, debtLedgerPath, debtEventsPath,
    escalateRecurring, scopeMode, planFile, runId, allowInfraScope,
    outFile, model, sessionCacheHit, allowTiered, commitSha, workingTreeDirty,
    generatorOutcomes: [],
    // `anthropicReadiness` travels WITH the client so a downstream consumer can
    // tell a routine keyless skip from a real construction defect, instead of
    // inferring one meaning from `anthropicClient === null` (WS-B2).
    providers: { openai, anthropicClient, anthropicReadiness, ossCall, geminiReviewCall, geminiCleanRegionCall },
  };
}

// Test-export gate — mirrors openai-audit.mjs's `__testExports` /
// `AUDIT_EXPORTS_FOR_TESTS` pattern (audit-orchestrator-hardening plan).
// Exposes internals this file doesn't otherwise export, for Tier-1
// deterministic unit tests. Production runs never set the env var, so this
// export is `undefined` and the test scaffolding is dead code at runtime.
// initResultCache/cachePassResult/cleanupCache/collectReducePassStatuses
// (pass-result-cache.mjs) and runMapReducePass/decideSeed
// (map-reduce-scheduler.mjs) are gone from this object — their test
// consumers now import them directly from their new modules
// (legacy-production-audit-decomposition Phases 1-2). The remaining fields
// stay here until their own phase extracts them.
// resolveOrphanScopeRefs/runOrphanIntroducedPass (orphan-pass.mjs) and
// writeLearningState (robustness.mjs) are gone from this object — their test
// consumers now import them directly from their new modules
// (legacy-production-audit-decomposition Phase 3). validateLedgerForR2/
// buildSuppressionStats (run-persistence.mjs), classifyShadowFailureSafe
// (run-telemetry.mjs) and dedupReplacementId (finding-assembly.mjs) are gone
// too, same reason (Phase 4) — their test consumers now import them directly.
// The remaining fields stay here until their own phase extracts them.
export const __testExports = process.env.AUDIT_EXPORTS_FOR_TESTS === '1'
  ? {
      // Now the single definition of --files scope for all six quality passes,
      // so its semantics are worth pinning directly rather than inferring from
      // six call sites.
      scopeToFileFilter,
    }
  : undefined;
