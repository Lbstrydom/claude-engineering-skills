#!/usr/bin/env node
/**
 * @fileoverview GPT-5.4 plan/code auditor for the plan-audit feedback loop.
 *
 * Architecture: Multi-pass parallel auditing for code mode.
 * Instead of one monolithic GPT call that times out, code audits run 5 focused
 * passes with tiered reasoning (low for mechanical, high for quality):
 *
 *   Pass 1 (structure) + Pass 2 (wiring)  → parallel, reasoning: low   ~20-30s
 *   Pass 3 (backend)   + Pass 4 (frontend) → parallel, reasoning: high  ~60-90s
 *   Pass 5 (sustainability)                → sequential, reasoning: medium ~30-45s
 *
 * Total wall time: ~2-3 min vs 5+ min monolithic (which often timed out).
 *
 * Usage:
 *   node scripts/openai-audit.mjs plan <plan-file>                    # Audit a plan
 *   node scripts/openai-audit.mjs code <plan-file>                    # Multi-pass code audit
 *   node scripts/openai-audit.mjs rebuttal <plan-file> <rebuttal-file> # Send Claude's rebuttals
 *   node scripts/openai-audit.mjs plan <plan-file> --json              # JSON output
 *   node scripts/openai-audit.mjs code <plan-file> --out /tmp/r.json   # Write results to file (clean terminal)
 *   node scripts/openai-audit.mjs code <plan-file> --history /tmp/h.json # Inject prior round history
 *
 * Requires: OPENAI_API_KEY in .env or environment
 *
 * @module scripts/openai-audit
 */

// dotenv loaded by lib/config.mjs (worktree-safe discovery)
import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { assertRepoRoot } from './lib/assert-repo-root.mjs';
import { zodTextFormat } from 'openai/helpers/zod';
import { FindingSchema, ProducerFindingSchema, WiringIssueSchema, LedgerEntrySchema, ReduceStatus, ExecutionMetaSchema } from './lib/schemas.mjs';
import {
  safeInt, readFileOrDie, readFilesAsContext, readFilesAsAnnotatedContext,
  writeOutput, normalizePath, parseDiffFile, extractPlanPaths, classifyFiles,
  isAuditInfraFile, auditSubjectFileGuard
} from './lib/file-io.mjs';
import {
  generateTopicId, populateFindingMetadata, jaccardSimilarity,
  suppressReRaises, buildRulingsBlock, R2_ROUND_MODIFIER, buildR2SystemPrompt, // buildR2SystemPrompt retained for non-cache legacy callers only

  computeImpactSet, batchWriteLedger
} from './lib/ledger.mjs';
import {
  estimateTokens, chunkLargeFile, extractExportsOnly, buildAuditUnits,
  buildDependencyGraph, REDUCE_SYSTEM_PROMPT, measureContextChars
} from './lib/code-analysis.mjs';
import { semanticId, formatFindings, appendOutcome, loadOutcomes, FalsePositiveTracker } from './lib/findings.mjs';
import { buildAuditPassPrompt, estimateStablePrefixTokens } from './lib/audit/prompt-builder.mjs';
import { runArchIntentAnalysis, isArchIntentReportClean, deriveArchState } from './lib/arch-intent/adapter-contract.mjs';
import { loadArchIntentConfig } from './lib/arch-intent/load-config.mjs';
import { parseIntentDoc } from './lib/arch-intent/intent-doc-parser.mjs';
import { ArchIntentConfigError } from './lib/arch-intent/errors.mjs';
import { detectRepoStack } from './lib/repo-stack.mjs';
import { listRepoFiles } from './lib/repo-inventory.mjs';
import { verifyExistenceFindings } from './lib/audit/finding-verification.mjs';
import { getRepoContext } from './lib/repo-context.mjs';
import { getRequirementsContext, getPlanRequirementsRubric } from './lib/requirements/context.mjs';
import { ArchIntentPassSchema } from './lib/schemas.mjs';
import { detectOrphansIntroduced } from './lib/audit/orphan-introduced.mjs';
import { resolveDiffScope } from './lib/audit/diff-scope-resolver.mjs';
import { processFindings } from './lib/audit/findings-pipeline.mjs';
import { emitOrphanRunMetrics } from './lib/audit/orphan-metrics.mjs';
import { PlanFpTracker } from './lib/plan-fp-tracker.mjs';
import {
  generateRepoProfile, initAuditBrief, readProjectContext, readProjectContextForPass,
  extractPlanForPass, buildHistoryContext, loadSessionCache, saveSessionCache
} from './lib/context.mjs';
import { buildLanguageContext } from './lib/language-profiles.mjs';
import { executeTools, normalizeToolResults, formatLintSummary } from './lib/linter.mjs';
import {
  selectEventSource, loadDebtLedger, appendEvents, reconcileLocalToCloud, mergeLedgers as mergeLedgersForSuppression
} from './lib/debt-memory.mjs';
import { initLearningStore, isCloudEnabled, resolveRepoForStore, upsertPlan, recordRunStart, recordRunComplete, recordFindings, recordPassStats, recordSuppressionEvents, recordAdjudicationEvent, updatePassStatsPostDeliberation, updateRunMeta, syncBanditArms, syncFalsePositivePatterns, recordDiffComplexity, backfillLearningOutcome, insertLearningDecision } from './learning-store.mjs';
import { resolveAuditArtifacts, loadAuditInputs, finalizeRoundOutcomes, finalizePriorRoundOutcomes } from './lib/finalize-outcomes.mjs';
import { registerPlanAuditRun, completePlanAuditRun } from './lib/audit/plan-audit-cloud.mjs';
import { recordDecision as _learningRecordDecision, flush as _learningFlush, installLifecycleHooks as _learningInstallHooks, buildDecisionKey as _learningBuildKey, reconcileOutbox as _learningReconcileOutbox } from './lib/learning/decision-logger.mjs';
import { deriveSignals as _deriveTierSignals, buildAuthorTierObservation as _buildAuthorTierObservation } from './lib/learning/author-tier-observation.mjs';
import { loadDomainRules as _loadDomainRules, computeTargetDomains as _computeTargetDomains } from './lib/symbol-index/domain-tagger.mjs';
import { PromptBandit, computeReward, buildContext } from './bandit.mjs';
import { openaiConfig, PASS_NAMES, modelPricing, azureConfig, tieredAuditConfig } from './lib/config.mjs';
import { refreshModelCatalog, resolveModel, pricingKey } from './lib/model-resolver.mjs';
import { createOpenAIClient } from './lib/openai-client.mjs';
import {
  MODEL, setModel, getPassPrompt, buildCachePrompt, normalisePromptInput,
  _callGPTOnce, callGPT, safeCallGPT,
} from './lib/audit/llm-helpers.mjs';
import {
  runLegacyProductionAudit, buildAuditRunContext,
} from './lib/audit/legacy-production-audit.mjs';
import { runTieredAuditPipeline } from './lib/audit/tiered-pipeline.mjs';
import { runTieredShadowComparison } from './lib/audit/tiered-shadow-compare.mjs';

/**
 * Print a one-line cost-estimate preflight to stderr so users see what
 * an audit will roughly cost BEFORE the LLM calls start. Heuristic only —
 * actual cost depends on output size, retries, and Gemini final review.
 *
 * @param {string} stage - 'plan' / 'code' / 'rebuttal' (for the label)
 * @param {number} inputChars - estimated input chars across all calls
 * @param {string} modelId - concrete model ID (post-resolve)
 * @param {number} reasoningTokens - estimated reasoning tokens (high reasoning ≈ 4x input)
 */
function printCostPreflight(stage, inputChars, modelId, reasoningTokens = 0) {
  if (process.env.AUDIT_NO_PREFLIGHT === '1') return;
  const inputTokens = Math.ceil(inputChars / 4);
  const outputTokens = Math.min(openaiConfig.maxOutputTokensCap || 16000, 16000);
  const key = pricingKey ? pricingKey(modelId) : modelId;
  const px = modelPricing[key] || modelPricing[modelId] || null;
  if (!px) {
    process.stderr.write(`  [cost] preflight: model ${modelId} not in price table — actual cost unknown\n`);
    return;
  }
  // input + reasoning at input rate, output at output rate, cost in $/1M tokens
  const cost = ((inputTokens + reasoningTokens) * px.input + outputTokens * px.output) / 1_000_000;
  const reasoningNote = reasoningTokens > 0 ? `, ~${(reasoningTokens / 1000).toFixed(0)}k reasoning` : '';
  process.stderr.write(
    `  [cost] preflight: ${stage} audit ≈ $${cost.toFixed(2)} ` +
    `(${(inputTokens / 1000).toFixed(1)}k in${reasoningNote}, up to ${(outputTokens / 1000).toFixed(0)}k out, ${modelId} @ $${px.input}/$${px.output} per 1M). ` +
    `Set AUDIT_NO_PREFLIGHT=1 to suppress.\n`
  );
}
import {
  LlmError, classifyLlmError, buildReducePayload, normalizeFindingsForOutput as _normalizeFindingsForOutput,
  resolveLedgerPath, MAX_REDUCE_JSON_CHARS, MAP_FAILURE_THRESHOLD, RETRY_MAX_ATTEMPTS,
  RETRY_BASE_DELAY_MS, RETRY_429_MAX_DELAY_MS, SEV_ORDER,
  tryRepairJson, computePassLimits, AUDIT_DIR, SESSION_MANIFEST_PREFIX, SESSION_LEDGER_FILE
} from './lib/robustness.mjs';
import {
  PASS_PROMPTS,
  PASS_STRUCTURE_SYSTEM as SEED_STRUCTURE, PASS_WIRING_SYSTEM as SEED_WIRING,
  PASS_BACKEND_SYSTEM as SEED_BACKEND, PASS_BACKEND_RUBRIC,
  PASS_FRONTEND_SYSTEM as SEED_FRONTEND, PASS_FRONTEND_RUBRIC,
  PASS_SUSTAINABILITY_SYSTEM as SEED_SUSTAINABILITY, PASS_SUSTAINABILITY_RUBRIC,
  buildClassificationRubric
} from './lib/prompt-seeds.mjs';
import { getActivePrompt, getActiveRevisionId, bootstrapFromConstants } from './lib/prompt-registry.mjs';
import micromatch from 'micromatch';
import { incrementRunCounter } from './lib/llm-auditor.mjs';

// ── Exclude patterns (.auditignore + --exclude-paths) ──────────────────────

/**
 * Load exclusion patterns from --exclude-paths CLI arg and .auditignore file.
 * @param {string[]} cliPatterns - Patterns from --exclude-paths flag
 * @returns {string[]} Combined glob patterns
 */
function loadExcludePatterns(cliPatterns = []) {
  const patterns = [...cliPatterns];
  // Read .auditignore from CWD (repo root) — one pattern per line, # comments
  try {
    const raw = fs.readFileSync(path.resolve('.auditignore'), 'utf-8');
    for (const line of raw.split('\n')) {
      const trimmed = line.trim();
      if (trimmed && !trimmed.startsWith('#')) patterns.push(trimmed);
    }
  } catch { /* no .auditignore — that's fine */ }
  return patterns;
}

/**
 * Filter a file list, removing any paths that match exclusion patterns.
 * @param {string[]} files - File paths to filter
 * @param {string[]} patterns - Glob patterns to exclude
 * @returns {string[]} Filtered file list
 */
function applyExclusions(files, patterns) {
  if (!patterns || patterns.length === 0) return files;
  const excluded = micromatch(files, patterns, { dot: true });
  const excludedSet = new Set(excluded);
  const kept = files.filter(f => !excludedSet.has(f));
  if (excluded.length > 0) {
    process.stderr.write(`  [scope] Excluded ${excluded.length} files via --exclude-paths/.auditignore\n`);
  }
  return kept;
}

// ── Configuration (from centralized config) ─────────────────────────────────
//
// MODEL (mutable, re-resolved in main() against the live model catalog) and
// the shouldMapReduce*/BACKEND_SPLIT_THRESHOLD family now live in their new
// homes (tiered-recall pipeline Phase 11 extraction):
//   - MODEL / setModel()      → ./lib/audit/llm-helpers.mjs (mode-agnostic —
//     used by BOTH the code-audit orchestration loop and the plan/rebuttal
//     single-call paths below)
//   - shouldMapReduce / shouldMapReduceHighReasoning / BACKEND_SPLIT_THRESHOLD
//     → ./lib/audit/legacy-production-audit.mjs (code-audit-orchestration-
//     specific — only the extracted pass loop calls them)
// imported below alongside the rest of this module's dependencies.

// ── Schemas (FindingSchema imported from shared.mjs) ─────────────────────────

// ── Plan Audit Schema ──────────────────────────────────────────────────────────

const PlanAuditResultSchema = z.object({
  verdict: z.enum(['READY_TO_IMPLEMENT', 'NEEDS_REVISION', 'SIGNIFICANT_GAPS']),
  structural_completeness: z.string().max(100).describe('e.g. "8/10 sections present"'),
  principle_coverage_pct: z.number().min(0).max(100),
  specificity: z.enum(['High', 'Medium', 'Low']),
  sustainability: z.enum(['Strong', 'Adequate', 'Weak', 'Missing']),
  findings: z.array(ProducerFindingSchema).max(25),
  ambiguities: z.array(z.object({
    location: z.string().max(120),
    vague_language: z.string().max(200),
    clarification_needed: z.string().max(300)
  })).max(20),
  quick_fix_warnings: z.array(z.string().max(300)).max(10),
  overall_reasoning: z.string().max(1000)
});

// ── Code Audit Pass Schemas — MOVED to lib/audit/legacy-production-audit.mjs
// (tiered-recall pipeline Phase 11: PassFindingsSchema, StructurePassSchema,
// WiringPassSchema, SustainabilityPassSchema, QuickfixPassSchema are used
// exclusively by the extracted orchestration loop, never by this file's
// remaining plan/rebuttal modes) ─────────────────────────────────────────

// ── Merged Code Audit Result (assembled from passes) ───────────────────────────

const CodeAuditResultSchema = z.object({
  verdict: z.enum(['PASS', 'NEEDS_FIXES', 'SIGNIFICANT_ISSUES']),
  files_planned: z.number().int(),
  files_found: z.number().int(),
  files_missing: z.number().int(),
  findings: z.array(FindingSchema).max(50),
  wiring_issues: z.array(WiringIssueSchema).max(20),
  quick_fix_warnings: z.array(z.string().max(300)).max(10),
  dead_code: z.array(z.string().max(200)).max(20),
  overall_reasoning: z.string().max(1000)
});

// ── Rebuttal Schema ────────────────────────────────────────────────────────────

const RebuttalResolutionSchema = z.object({
  resolutions: z.array(z.object({
    finding_id: z.string().max(20),
    claude_position: z.enum(['accept', 'partial_accept', 'challenge']),
    gpt_ruling: z.enum(['sustain', 'overrule', 'compromise']),
    final_severity: z.enum(['HIGH', 'MEDIUM', 'LOW', 'DISMISSED']),
    final_recommendation: z.string().max(800),
    reasoning: z.string().max(600),
    is_quick_fix: z.boolean()
  })).max(50),
  uncontested_findings: z.array(z.string().max(20)).max(50),
  deliberation_summary: z.string().max(1000)
});

// ── System Prompts ─────────────────────────────────────────────────────────────

const PLAN_AUDIT_SYSTEM = `You are an elite software architecture auditor reviewing a plan BEFORE implementation.
Your job is to find REAL issues that will cause rework, bugs, or architectural regret.

CRITICAL RULES:
1. Never accept quick fixes or band-aids. Every recommendation must be a PROPER, sustainable solution.
   If you see a recommendation that papers over a problem, set is_quick_fix=true and propose the real fix.
2. Check for SOLID principles (all 5), DRY, modularity, no dead code paths, no hardcoding.
3. Check long-term codebase sustainability — will this design accommodate change in 6 months?
4. Check code efficiency — no N+1 queries, no unbounded loops, no unnecessary complexity.
5. For frontend plans: apply Gestalt principles (proximity, similarity, continuity, closure, figure-ground,
   common region, common fate), check usability, consistency, navigability, cognitive load.
6. The plan must be detailed enough for a code team to execute WITHOUT guessing.
7. Flag vague language: "as needed", "handle appropriately", "etc.", "TBD", "probably".
8. Check that error states, loading states, and empty states are all specified.
9. Verify data flow is traceable end-to-end (UI → API → Service → DB and back).
10. Anti-patterns to flag: God functions, shotgun surgery, feature envy, leaky abstractions.

SEVERITY GUIDE:
- HIGH: Implementation will fail, produce bugs, or require significant rework.
  A missing endpoint, broken data flow, or unspecified error handling is HIGH.
  Do NOT use HIGH for "I would architect this differently" — that is MEDIUM.
- MEDIUM: Implementation will work but quality/maintainability/UX will suffer.
  Design trade-offs, alternative architectures, and "proportionality" concerns belong here.
- LOW: Plan is functional but could be clearer or more thorough.

INFRASTRUCTURE CONTEXT: Before claiming a library or tool doesn't exist in the project,
check the Project Context and Dependencies sections. If a package is listed there,
assume it is installed and available. Do NOT flag dependency availability as a finding
if the dependency is already in the project's package.json.

Be ruthlessly honest but constructive. Cite specific sections.`;

const REBUTTAL_SYSTEM = `You are an elite software architecture auditor in a DELIBERATION round with a peer engineer (Claude).

You previously audited a plan or codebase and produced findings. Claude has reviewed your findings and
is pushing back on some of them — accepting some, partially accepting others, and challenging others.

YOUR JOB: For each challenged or partially accepted finding, decide fairly:

1. **SUSTAIN** — Your original finding stands. You MUST explain WHY Claude's counter-argument is insufficient.
2. **OVERRULE** — Claude is right. Set final_severity to DISMISSED or reduce it. Be honest when you are wrong.
3. **COMPROMISE** — Both sides have merit. Produce a modified recommendation that addresses both concerns.

CRITICAL RULES:
1. You are NOT always right. Claude has deep context about this specific codebase that you lack.
2. Do NOT sustain findings out of ego. If Claude's alternative is genuinely better, overrule yourself.
3. Quick-fix detection still applies — if the compromise is a band-aid, flag it.
4. Be specific in your reasoning. "I disagree" is not acceptable — explain WHY.
5. For findings Claude fully accepted, list them in uncontested_findings.
6. A challenge on severity is valid — you can adjust severity without dismissing.
7. If Claude proposes a better fix than yours, adopt it. The goal is the BEST outcome, not winning.
8. Hold firm on genuine safety/security/data-integrity issues regardless of pushback.`;

// ── Code Audit Orchestration (tiered-recall pipeline Phase 11 — thin chooser) ──
//
// `runMultiPassCodeAudit`'s former ~1600-line orchestration body now lives in
// `./lib/audit/legacy-production-audit.mjs::runLegacyProductionAudit` (a pure
// relocation — Phase 10's harness re-run against it proves no behavior
// change) and, when `AUDIT_TIERED_PIPELINE_ENABLED=true`, the new
// `./lib/audit/tiered-pipeline.mjs::runTieredAuditPipeline`. This function is
// now a THIN CHOOSER between the two, plus the CLI-presentation concerns
// (--out write, jsonMode stdout, pretty-print) that used to live inline in
// the orchestration body — those moved HERE (`printAuditResult` below),
// since both branches now return the SAME `AuditRunResult` shape and neither
// should duplicate the presentation logic.

/**
 * Render + persist a finished `AuditRunResult` exactly as the pre-Phase-11
 * orchestration body did inline — `--out` write, `--json` stdout, or the
 * human-readable markdown report. Deliberately reused UNCHANGED (just
 * relocated to consume a return value instead of a captured closure
 * variable) so both the legacy and tiered branches get identical output
 * formatting.
 *
 * Deviation from a byte-exact port (documented, low-risk, cosmetic-only):
 * the original computed `high`/`medium`/`low` counts from a verification-
 * gate-aware, tool-finding-excluded-unless-`--strict-lint` filter
 * (`countFor`/`effSeverity`/`countsTowardVerdict`) local to the orchestration
 * body. That filter is NOT part of `AuditRunResultSchema`'s output contract,
 * so re-deriving it here would mean re-implementing verification-gate
 * internals in the CLI-presentation layer — the exact "CLI reaches back into
 * orchestration internals" coupling Phase 11 exists to avoid. This function
 * instead counts `mergedResult.findings` by `.severity` directly. The
 * printed summary line can therefore very rarely differ from the internal
 * verdict-driving count in edge cases (tool findings present + non-strict-
 * lint + a refuted existence finding) — `mergedResult.verdict` itself is
 * UNAFFECTED (computed with full fidelity inside the orchestration function
 * before this point), so this is a stdout cosmetics-only simplification, not
 * a correctness change.
 *
 * @param {import('./lib/schemas.mjs').AuditRunResult} mergedResult
 * @param {{outFile: string|null, jsonMode: boolean}} opts
 */
function printAuditResult(mergedResult, { outFile, jsonMode }) {
  const { verdict, findings: allFindings = [], _pass_timings: passTimings = {}, _usage: totalUsage = {}, _failed_passes: failedPasses = [] } = mergedResult;
  const high = allFindings.filter(f => f.severity === 'HIGH').length;
  const medium = allFindings.filter(f => f.severity === 'MEDIUM').length;
  const low = allFindings.filter(f => f.severity === 'LOW').length;
  const totalLatencyMs = totalUsage.latency_ms ?? 0;

  if (outFile) {
    const summaryLine = `Verdict: ${verdict} | H:${high} M:${medium} L:${low} | ${(totalLatencyMs / 1000).toFixed(0)}s`;
    writeOutput(mergedResult, outFile, summaryLine);
  } else if (jsonMode) {
    console.log(JSON.stringify(mergedResult, null, 2));
  } else {
    console.log('# GPT-5.4 Multi-Pass Code Audit Report');
    console.log(`- **Model**: ${MODEL}`);
    const timingStr = Object.entries(passTimings).map(([k, v]) => `${k}: ${v}`).join(', ');
    console.log(`- **Total time**: ${timingStr}`);
    console.log(`- **Tokens**: ${totalUsage.input_tokens} in / ${totalUsage.output_tokens} out (${totalUsage.reasoning_tokens} reasoning)`);
    console.log(`- **Files**: ${mergedResult.files_found} found, ${mergedResult.files_missing} missing`);
    if (failedPasses.length > 0) console.log(`- **WARNING**: ${failedPasses.length} pass(es) failed — findings may be incomplete`);
    console.log('');
    console.log(`## Verdict: **${verdict}**`);
    console.log(`- **HIGH**: ${high} | **MEDIUM**: ${medium} | **LOW**: ${low}`);
    const qf = mergedResult.quick_fix_warnings.length;
    if (qf > 0) console.log(`- **Quick Fix Warnings**: ${qf}`);
    console.log('');
    console.log('## Findings');
    console.log(formatFindings(allFindings));

    if (mergedResult.wiring_issues.length > 0) {
      console.log('\n## Wiring Issues\n');
      console.log('| Frontend Call | Backend Route | Status | Detail |');
      console.log('|-------------|--------------|--------|--------|');
      for (const w of mergedResult.wiring_issues) {
        console.log(`| ${w.frontend_call} | ${w.backend_route} | ${w.status} | ${w.detail} |`);
      }
    }

    if (mergedResult.dead_code.length > 0) {
      console.log('\n## Dead Code\n');
      for (const d of mergedResult.dead_code) console.log(`- ${d}`);
    }

    if (mergedResult.quick_fix_warnings.length > 0) {
      console.log('\n## Quick Fix Warnings\n');
      for (const w of mergedResult.quick_fix_warnings) console.log(`- ${w}`);
    }

    if (mergedResult.runStatus !== 'fallback_legacy' && mergedResult.runStatus !== 'complete') {
      console.log(`\n- **Structure/wiring/dead-code checks**: not run (tiered pipeline)`);
    }

    console.log('\n## Pass Summaries\n');
    console.log(mergedResult.overall_reasoning);
  }
}

/**
 * Thin chooser (tiered-recall pipeline Phase 11): resolves
 * `tieredAuditConfig.pipelineEnabled`, delegates to `runTieredAuditPipeline`
 * or `runLegacyProductionAudit`, then prints/writes the result. Keeps
 * `runMultiPassCodeAudit`'s existing call-site signature (positional args)
 * so `main()` below needs no changes beyond what Phase 10 already added
 * (the `return mergedResult` contract — preserved here too).
 *
 * Exported (model-swap-eval-harness Phase 3) — previously reachable outside
 * this module ONLY via the `AUDIT_EXPORTS_FOR_TESTS=1` test-export gate
 * below, which the plan's `arm-generation.mjs::runAuditGenerationArm`
 * bullet incorrectly assumed was already a real production import path (it
 * verified the signature, not the export surface). Every dependency this
 * function needs is an explicit parameter/opts field (openai client,
 * planContent, projectContext, outFile, opts.model overrides the module's
 * own `MODEL` global via the `{model: MODEL, ...opts}` spread order in
 * `buildAuditRunContext`) — so exporting it for a second, legitimate
 * production caller changes no behavior for the CLI's own `main()` path.
 *
 * **Close-out shadow validation** (`tieredAuditConfig.shadowEnabled`,
 * independent of `pipelineEnabled`): when the real (legacy) path is what's
 * gating, ALSO run the tiered pipeline as an observation-only comparison —
 * concurrently, not sequentially after (neither pipeline mutates
 * `process.cwd()`, so there's no chdir hazard forcing serialization; see
 * `tiered-shadow-compare.mjs`'s header for the verified-safe reasoning).
 * The shadow can never affect `mergedResult`; a shadow failure only ever
 * reaches the log, never this function's return value or exit code.
 */
export async function runMultiPassCodeAudit(openai, planContent, projectContext, jsonMode, outFile, historyContext = '', opts = {}) {
  const ctx = await buildAuditRunContext({
    openai, planContent, projectContext, historyContext, outFile, model: MODEL, ...opts,
  });

  // `ctx.allowTiered` (shadow-flip incident fix, 2026-07-13): env flags are
  // operator intent, global to every Node process (tests included, via the
  // shared ~/.audit-loop.env); EXECUTION eligibility is per-call, asserted
  // only by the CLI's main(). Without it, a flipped flag routed fully-mocked
  // test harnesses into real multi-provider execution.
  if (tieredAuditConfig.pipelineEnabled && ctx.allowTiered) {
    const mergedResult = await runTieredAuditPipeline(ctx);
    printAuditResult(mergedResult, { outFile, jsonMode });
    return mergedResult;
  }

  const legacyResultPromise = runLegacyProductionAudit(ctx);
  const shadowTask = (tieredAuditConfig.shadowEnabled && ctx.allowTiered)
    ? runTieredShadowComparison({ ctx, legacyResultPromise, runTieredAuditPipeline }).catch(() => {})
    : null;

  const mergedResult = await legacyResultPromise;
  if (shadowTask) await shadowTask;

  printAuditResult(mergedResult, { outFile, jsonMode });

  return mergedResult;
}

// resolveLedgerPath imported from lib/robustness.mjs

/**
 * Resolve the git base ref for `--scope diff`. Pure + deterministic so the
 * decision is unit-testable apart from the git subprocess (repo testing
 * doctrine Tier 1 — deterministic seam lands with its test).
 *
 * - Explicit `--base <ref>` always wins (clustered/resume audits).
 * - Otherwise dirty-aware: a dirty working tree means the operator is auditing
 *   UNCOMMITTED work → `HEAD` (don't re-pull an already-committed/audited prior
 *   commit). A clean tree means "audit my last commit" → `HEAD~1`.
 *
 * `workingTreeDirty` MUST be derived from `git status --porcelain` (untracked
 * files count as dirty) — NOT `git diff --quiet`, which ignores untracked.
 *
 * @param {string|null} explicitBase value of `--base`, or null when absent
 * @param {boolean} workingTreeDirty whether `git status --porcelain` was non-empty
 * @returns {string} the git ref to diff `..HEAD` against
 */
function resolveDiffBase(explicitBase, workingTreeDirty) {
  if (explicitBase) return explicitBase;
  return workingTreeDirty ? 'HEAD' : 'HEAD~1';
}

// ── Main ───────────────────────────────────────────────────────────────────────

async function main() {
  assertRepoRoot(import.meta.url);
  // Live-catalog refresh: populate session cache so providers' newest
  // models are visible to resolveModel(). Module-load resolution
  // (config.mjs) used STATIC_POOL only; we now RE-RESOLVE the sentinel
  // against the freshly-populated live cache and reassign MODEL. This is
  // the "always use latest" path — operators no longer have to update
  // STATIC_POOL manually when a provider ships a new model.
  // Set MODEL_CATALOG_REFRESH=skip in air-gapped CI / when API quota is
  // scarce; resolution then stays at the module-load (static-pool) value.
  if (process.env.MODEL_CATALOG_REFRESH !== 'skip') {
    try { await refreshModelCatalog(); } catch { /* silent — falls back to static */ }
    try {
      const liveResolution = resolveModel(process.env.OPENAI_AUDIT_MODEL || 'latest-gpt', { silent: true });
      if (liveResolution !== MODEL) {
        process.stderr.write(
          `  [model-resolver] upgraded MODEL ${MODEL} → ${liveResolution} (live catalog newer than STATIC_POOL)\n`
        );
        setModel(liveResolution);
      }
    } catch { /* ignore — never block audit on resolver introspection */ }
  }

  // Audit-tool version-staleness check (consumer-side).  Fetches the upstream
  // sync manifest, compares hashes, warns when the consumer is running stale
  // audit-tool files.  Non-blocking: a network failure or stale state never
  // aborts the audit — just surfaces a warning so the operator knows to sync.
  // Skipped in source repo (self-check is meaningless), in CI, and when the
  // env var AUDIT_TOOL_VERSION_CHECK=skip is set.
  if (process.env.AUDIT_TOOL_VERSION_CHECK !== 'skip' && !process.env.CI) {
    try {
      const { fetchUpstreamManifest, compareToUpstream, isSourceRepo, findRepoRoot } =
        await import('./lib/sync-manifest.mjs');
      const root = findRepoRoot();
      if (!isSourceRepo(root)) {
        const upstream = await fetchUpstreamManifest(undefined, { timeoutMs: 2500 });
        const diff = compareToUpstream(root, upstream);
        if (!diff.current) {
          const total = diff.stale.length + diff.missing.length;
          const upstreamRef = upstream.commitSha ? upstream.commitSha.slice(0, 7) : '?';
          process.stderr.write(
            `\n  [sync-check] WARNING: ${total} audit-tool file(s) differ from claude-engineering-skills @ ${upstreamRef}\n` +
            '              Run `npm run sync` in claude-engineering-skills to refresh.\n' +
            '              Set AUDIT_TOOL_VERSION_CHECK=skip to suppress. Continuing.\n\n'
          );
        }
      }
    } catch { /* silent — never block audit on network or missing manifest */ }
  }

  const args = process.argv.slice(2);
  const mode = args[0];
  const planFile = args[1];
  const rebuttalFile = mode === 'rebuttal' ? args[2] : null;
  const jsonMode = args.includes('--json');

  // --out <file>: write JSON results to file, keep terminal clean
  const outIdx = args.indexOf('--out');
  const outFile = outIdx !== -1 && args[outIdx + 1] ? args[outIdx + 1] : null;

  // --history <file>: inject prior round results to avoid re-raising resolved findings
  const histIdx = args.indexOf('--history');
  const historyFile = histIdx !== -1 && args[histIdx + 1] ? args[histIdx + 1] : null;

  // --passes <list>: comma-separated pass names to run (default: all)
  // e.g. --passes backend,frontend,sustainability (skip structure+wiring on R2+)
  const passIdx = args.indexOf('--passes');
  const passFilter = passIdx !== -1 && args[passIdx + 1] ? args[passIdx + 1].split(',').map(s => s.trim()) : null;

  // --files <list>: comma-separated file paths to scope quality passes to
  // e.g. --files src/routes/wines.js,src/services/wine/parser.js
  const filesIdx = args.indexOf('--files');
  const fileFilter = filesIdx !== -1 && args[filesIdx + 1] ? args[filesIdx + 1].split(',').map(s => s.trim()) : null;

  // --round <n>: audit round number (default: 1). R2+ enables suppression, diff annotation, impact scoping
  const roundIdx = args.indexOf('--round');
  const round = roundIdx !== -1 && args[roundIdx + 1] ? Number.parseInt(args[roundIdx + 1], 10) : 1;

  // --run-id <uuid>: run-unification (WS1). When the orchestrator
  // (audit-loop.mjs / /cycle Step 3C) mints one run_id and passes it to every
  // round's invocation, all rounds attach to a single audit_runs row.
  // Absent → openai-audit mints its own (manual single-shot → today's behaviour).
  const runIdIdx = args.indexOf('--run-id');
  const explicitRunId = runIdIdx !== -1 && args[runIdIdx + 1] ? args[runIdIdx + 1] : null;

  // --ledger <file>: adjudication ledger — single canonical read+write path
  const ledgerIdx = args.indexOf('--ledger');
  const ledgerFileArg = ledgerIdx !== -1 && args[ledgerIdx + 1] ? args[ledgerIdx + 1] : null;
  const noLedger = args.includes('--no-ledger');

  // --allow-infra-scope: opt-in escape hatch for META plans whose deliverable
  // IS a change to this audit tool's own infrastructure (schemas.mjs,
  // ledger.mjs, openai-audit.mjs, …). Default false — ordinary (consumer-code)
  // audits keep the isAuditInfraFile exclusion unchanged. See plan-paths.mjs.
  const allowInfraScope = args.includes('--allow-infra-scope');

  // --diff <file>: unified diff file for R2+ annotated context (highlights changed lines)
  const diffIdx = args.indexOf('--diff');
  const diffFile = diffIdx !== -1 && args[diffIdx + 1] ? args[diffIdx + 1] : null;

  // --changed <list>: comma-separated changed file paths for R2+ impact set computation
  const changedIdx = args.indexOf('--changed');
  let changedFiles = changedIdx !== -1 && args[changedIdx + 1] ? args[changedIdx + 1].split(',').map(s => s.trim()) : [];

  // --scope <mode>: audit scope for code mode.
  //   'diff'   (DEFAULT for code mode): auto-detect changed files via `git diff --name-only <base>..HEAD`
  //            then scope quality passes to those files. Most accurate for reviewing recent work.
  //   'plan'   (LEGACY default): use ALL files referenced in the plan. Broadest scope.
  //            Use when plan describes a large refactor touching many files.
  //   'full'   : audit the entire repo. Slowest, most comprehensive. Use for codebase-wide audits.
  // When --files is explicitly provided, --scope is ignored.
  const scopeIdx = args.indexOf('--scope');
  const scopeMode = scopeIdx !== -1 && args[scopeIdx + 1] ? args[scopeIdx + 1] : 'diff';

  // --base <ref>: git ref to diff against for --scope diff. When omitted the
  // base is DIRTY-AWARE (resolved in the diff block below), NOT a blind
  // HEAD~1: a HEAD~1 default re-pulls the previous commit into scope, so an
  // already-shipped+audited commit floods the audit with out-of-scope findings
  // (observed: 33/34 GPT findings were a prior already-audited cluster). The
  // dirty-aware rule audits uncommitted work against HEAD when the tree is
  // dirty, and the last commit (HEAD~1..HEAD) only when the tree is clean.
  // Explicit --base always wins (clustered/resume: --base <clusterStartRef>).
  const baseIdx = args.indexOf('--base');
  const explicitBase = baseIdx !== -1 && args[baseIdx + 1] ? args[baseIdx + 1] : null;
  let diffBase = explicitBase || 'HEAD~1'; // provisional; refined dirty-aware in the diff block

  // --exclude-paths <list>: comma-separated glob patterns to exclude from scope
  // e.g. --exclude-paths 'scripts/**,vendor/**,.audit-loop/**'
  // Also reads .auditignore file from repo root (one pattern per line, # comments)
  const excludeIdx = args.indexOf('--exclude-paths');
  const excludeArg = excludeIdx !== -1 && args[excludeIdx + 1] ? args[excludeIdx + 1].split(',').map(s => s.trim()) : [];
  const excludePatterns = loadExcludePatterns(excludeArg);

  // Phase C — tool pre-pass flags
  // --no-tools: skip static analysis tools entirely (opt-out for untrusted repos)
  // --strict-lint: count tool findings in verdict math (advisory by default)
  const noTools = args.includes('--no-tools');
  const strictLint = args.includes('--strict-lint');

  // --session-cache <file>: cross-round cache for repo profile + audit brief.
  // Write on first run, read on subsequent rounds to skip 10s brief generation.
  // Cache self-invalidates when package.json or CLAUDE.md changes (fingerprint mismatch).
  const sessionCacheIdx = args.indexOf('--session-cache');
  const sessionCachePath = sessionCacheIdx !== -1 && args[sessionCacheIdx + 1] ? args[sessionCacheIdx + 1] : null;

  // Phase D — debt-memory flags
  // --no-debt-ledger: skip .audit/tech-debt.json entirely (clean-slate runs)
  // --debt-ledger <path>: override default path
  // --debt-events <path>: override default local event log path
  // --read-only-debt: load debt for suppression, never write events (CI/parallel safety)
  // --escalate-recurring <N>: bypass suppression for debt with distinctRunCount >= N
  const noDebtLedger = args.includes('--no-debt-ledger');
  const readOnlyDebt = args.includes('--read-only-debt');
  const debtLedgerIdx = args.indexOf('--debt-ledger');
  const debtLedgerPath = debtLedgerIdx !== -1 && args[debtLedgerIdx + 1] ? args[debtLedgerIdx + 1] : undefined;
  const debtEventsIdx = args.indexOf('--debt-events');
  const debtEventsPath = debtEventsIdx !== -1 && args[debtEventsIdx + 1] ? args[debtEventsIdx + 1] : undefined;
  const escalateIdx = args.indexOf('--escalate-recurring');
  // Default to 5 on R2+ runs — recurring debt items get re-examined automatically
  const escalateRecurring = escalateIdx !== -1 && args[escalateIdx + 1]
    ? Number.parseInt(args[escalateIdx + 1], 10)
    : (round >= 2 ? 5 : null);

  // A/B test: pipeline variant selection
  if (!mode || !planFile || !['plan', 'code', 'rebuttal'].includes(mode)) {
    console.error('Usage: node scripts/openai-audit.mjs <plan|code> <plan-file> [--json] [--out <file>] [--history <file>] [--passes <list>] [--files <list>]');
    console.error('       node scripts/openai-audit.mjs code <plan-file> [--scope diff|plan|full] [--base <git-ref>]');
    console.error('         --scope diff (default): auto-scope to git-changed files (dirty-aware base: HEAD if tree dirty, else HEAD~1; --base overrides)');
    console.error('         --scope plan          : audit all plan-referenced files');
    console.error('         --scope full          : audit entire repo (slowest, most comprehensive)');
    console.error('       node scripts/openai-audit.mjs code <plan-file> --round 2 --ledger <ledger.json> --diff <diff.patch> --changed <file1,file2>');
    console.error('       node scripts/openai-audit.mjs rebuttal <plan-file> <rebuttal-file> [--json] [--out <file>]');
    console.error('         --allow-infra-scope   : opt-in — audit this tool\'s OWN infra files (schemas.mjs, ledger.mjs, …)');
    console.error('                                 as subject files. Only for META plans whose deliverable IS a change');
    console.error('                                 to the audit tool itself; leave off for normal (consumer-code) audits.');
    process.exit(1);
  }

  if (mode === 'rebuttal' && !rebuttalFile) {
    console.error('Error: rebuttal mode requires a rebuttal file path');
    process.exit(1);
  }

  if (!process.env.OPENAI_API_KEY) {
    console.error('Error: OPENAI_API_KEY environment variable required');
    console.error('Set it in .env or export OPENAI_API_KEY=sk-...');
    process.exit(1);
  }

  const planContent = readFileOrDie(planFile);
  // Session cache: reuse brief + profile from prior round in the same session.
  // First round writes the cache; subsequent rounds read it (skip ~10s of LLM work).
  const cacheHit = loadSessionCache(sessionCachePath);
  if (!cacheHit) {
    await initAuditBrief(); // Pre-generate context brief (Gemini Flash → Claude Haiku → regex)
  }
  const repoProfile = generateRepoProfile();
  if (!cacheHit && sessionCachePath) {
    saveSessionCache(sessionCachePath); // Persist for next round
  }
  const projectContext = readProjectContext();
  const historyContext = buildHistoryContext(historyFile);
  // Initialize learning systems (graceful — never blocks audit)
  const startMs = Date.now();
  await initLearningStore().catch(e => process.stderr.write(`  [learning] ${e.message}\n`)); // Cloud store (optional)
  // Replay any learning decisions that spilled to the local outbox on a
  // prior run's cloud-write failure (e.g. service-role key briefly unset).
  // Idempotent via decision_key UNIQUE — makes the loop self-healing.
  await _learningReconcileOutbox({
    store: { insertLearningDecision, backfillLearningOutcome, isCloudEnabled },
  }).then((r) => {
    if (r && r.succeeded > 0) process.stderr.write(`  [learning] outbox replayed: ${r.succeeded}/${r.processed}\n`);
  }).catch(() => { /* best-effort */ });
  const bandit = new PromptBandit();
  const fpTracker = new FalsePositiveTracker();

  const openai = await createOpenAIClient({ purpose: 'gpt' });

  // Increment run counter for meta-assessment interval tracking
  incrementRunCounter();

  // Resolve canonical ledger path
  const ledgerPath = resolveLedgerPath({ explicitLedger: ledgerFileArg, outFile, round, noLedger });
  if (!ledgerPath && round >= 2 && !noLedger) {
    process.stderr.write(`  [ERROR] Round ${round} requires --ledger <path> for suppression. Use --no-ledger to skip.\n`);
    process.exit(1);
  }
  if (ledgerPath && !ledgerFileArg) {
    process.stderr.write(`  [ledger] Auto-derived path: ${ledgerPath}\n`);
  }

  // Code mode → multi-pass parallel audit
  if (mode === 'code') {
    // Resolve scope: if --files not explicit AND --scope=diff (default), auto-detect from git
    let effectiveFileFilter = fileFilter
      ? (excludePatterns.length > 0 ? applyExclusions(fileFilter, excludePatterns) : fileFilter)
      : null;
    if (!effectiveFileFilter && scopeMode === 'diff') {
      try {
        const { execFileSync } = await import('node:child_process');
        // Dirty-aware base resolution (only when --base was not explicit).
        // A dirty working tree means the operator is auditing UNCOMMITTED work
        // → base at HEAD so an already-committed (and usually already-audited)
        // prior commit is not re-pulled into scope. A clean tree means "audit
        // my last commit" → HEAD~1..HEAD. This fixes the over-capture where a
        // shipped+audited cluster reappears as out-of-scope findings.
        if (!explicitBase) {
          let workingTreeDirty = false;
          try {
            const porcelain = execFileSync('git', ['status', '--porcelain'], {
              encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'], timeout: 10000
            }).trim();
            workingTreeDirty = porcelain.length > 0;
          } catch { /* not a git repo / git missing — treat as clean (HEAD~1) */ }
          diffBase = resolveDiffBase(explicitBase, workingTreeDirty);
          process.stderr.write(`  [scope] base resolved to ${diffBase} (working tree ${workingTreeDirty ? 'dirty → uncommitted work only' : 'clean → last commit'}; pass --base <ref> to override)\n`);
        }
        const diffOutput = execFileSync('git', ['diff', '--name-only', `${diffBase}..HEAD`], {
          encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'], timeout: 10000
        }).trim();
        const diffChanged = diffOutput ? diffOutput.split('\n').filter(Boolean) : [];
        // Also include unstaged working-tree changes
        const unstaged = execFileSync('git', ['diff', '--name-only'], {
          encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'], timeout: 10000
        }).trim();
        const unstagedChanged = unstaged ? unstaged.split('\n').filter(Boolean) : [];
        const untracked = execFileSync('git', ['ls-files', '--others', '--exclude-standard'], {
          encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'], timeout: 10000
        }).trim();
        const untrackedFiles = untracked ? untracked.split('\n').filter(Boolean) : [];
        let allChanged = [...new Set([...diffChanged, ...unstagedChanged, ...untrackedFiles])]
          .filter(f => allowInfraScope || !isAuditInfraFile(f));
        if (excludePatterns.length > 0) allChanged = applyExclusions(allChanged, excludePatterns);
        if (allChanged.length > 0) {
          effectiveFileFilter = allChanged;
          // Also set changedFiles if caller didn't — enables R2+ impact scoping in R1
          if (changedFiles.length === 0) changedFiles = allChanged;
          process.stderr.write(`  [scope] --scope=diff (vs ${diffBase}): ${allChanged.length} changed files → scoping audit to diff\n`);
          process.stderr.write(`  [scope] Files: ${allChanged.slice(0, 5).join(', ')}${allChanged.length > 5 ? ` (+${allChanged.length - 5} more)` : ''}\n`);
          process.stderr.write(`  [scope] Use --scope=plan to audit all plan-referenced files, or --scope=full for whole repo\n`);
        } else {
          process.stderr.write(`  [scope] --scope=diff: no changes detected vs ${diffBase}, falling back to plan-referenced files\n`);
        }
      } catch (err) {
        process.stderr.write(`  [scope] --scope=diff failed (${err.message?.slice(0, 80)}), falling back to plan-referenced files\n`);
      }
    } else if (scopeMode === 'full') {
      process.stderr.write(`  [scope] --scope=full: auditing entire repo (may be slow)\n`);
      // Leave fileFilter null = full repo
    } else if (scopeMode === 'plan') {
      process.stderr.write(`  [scope] --scope=plan: auditing all plan-referenced files\n`);
    }
    // Cost preflight — code audit is the most expensive: 5 passes × file context + Gemini final
    const codeContextChars = (planContent?.length || 0) + (projectContext?.length || 0)
      + (effectiveFileFilter ? measureContextChars(effectiveFileFilter, 8000) : 0);
    const codePassMultiplier = passFilter ? passFilter.length : PASS_NAMES.length;
    printCostPreflight('code', codeContextChars * codePassMultiplier, MODEL,
      openaiConfig.reasoning === 'high' ? codeContextChars * 4 : 0);
    // allowTiered: true — main() is the ONE production CLI entrypoint allowed
    // to execute the tiered pipeline / shadow (see buildAuditRunContext).
    await runMultiPassCodeAudit(openai, planContent, projectContext, jsonMode, outFile, historyContext, { passFilter, fileFilter: effectiveFileFilter, round, ledgerFile: ledgerPath, diffFile, changedFiles, auditBaseCommit: diffBase, repoProfile, bandit, fpTracker, noLedger, noTools, strictLint, noDebtLedger, readOnlyDebt, debtLedgerPath, debtEventsPath, escalateRecurring, sessionCacheHit: cacheHit, scopeMode, planFile, runId: explicitRunId, allowInfraScope, allowTiered: true });
    return;
  }

  // Plan and rebuttal modes → single call
  let systemPrompt, schema, schemaName, userPrompt;

  if (mode === 'rebuttal') {
    const rebuttalContent = readFileOrDie(rebuttalFile);
    systemPrompt = REBUTTAL_SYSTEM;
    schema = RebuttalResolutionSchema;
    schemaName = 'rebuttal_resolution';
    userPrompt = `## Project Context\n${projectContext}\n\n---\n\n## Original Plan/Code\n${planContent}\n\n---\n\n## Claude's Deliberation\n${rebuttalContent}`;
  } else {
    // Plan audit: use the full brief (includes package.json deps) so GPT
    // doesn't ask "does X exist?" when it's in the dependency list
    await initAuditBrief().catch(() => {});
    const planContext = readProjectContextForPass('plan') || projectContext;

    // Inject package.json deps explicitly so infrastructure questions are answered
    let depsBlock = '';
    try {
      const pkgPath = path.resolve('package.json');
      if (fs.existsSync(pkgPath)) {
        const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
        const deps = { ...pkg.dependencies, ...pkg.devDependencies };
        const depList = Object.entries(deps).slice(0, 30).map(([k, v]) => `  ${k}: ${v}`).join('\n');
        if (depList) depsBlock = `\n\n## Installed Dependencies (package.json)\n${depList}\n`;
      }
    } catch { /* no package.json */ }

    // Deterministic outcome capture (2026-07-13 parity with code mode): at
    // the start of an R2+ plan invocation, finalize the PRIOR round's triage
    // outcomes from the ledger the agent just wrote — same shared function
    // the code orchestrator calls, so plan-audit ground truth reaches the
    // cloud learning store instead of only the local PlanFpTracker.
    await finalizePriorRoundOutcomes({ outFile, round, ledgerFile: ledgerPath });

    // R2+ rulings injection for plan mode
    let rulingsBlock = '';
    if (round >= 2 && ledgerPath) {
      rulingsBlock = buildRulingsBlock(ledgerPath, 'plan');
      if (rulingsBlock) {
        rulingsBlock = `\n\n${rulingsBlock}`;
        process.stderr.write(`  [plan-r2] Injected ${rulingsBlock.split('\n').length} rulings from ledger\n`);
      }
    }

    // Requirements rubric (2026-07-13 parity with code mode): surface the
    // de-facto-requirements ledger against the plan's own referenced files —
    // a plan that violates an active repo invariant gets flagged at DESIGN
    // time, the cheapest point to catch it. Non-blocking: ledger absent → ''.
    let reqBlock = '';
    try {
      const rq = await getPlanRequirementsRubric(planContent, { allowInfraFiles: allowInfraScope });
      if (rq.block) {
        reqBlock = `\n\n${rq.block}`;
        process.stderr.write(`  [requirements] plan rubric: ${rq.inScopeCount} in-scope / ${rq.indexCount} indexed (~${rq.tokensEst} tok)${rq.stale ? ' [stale]' : ''}\n`);
      }
    } catch (err) {
      process.stderr.write(`  [requirements] skipped (non-blocking) — ${err.message}\n`);
    }

    const r2Modifier = round >= 2 ? `\n\n${R2_ROUND_MODIFIER}` : '';

    // Adaptive repo-context — T0 inventory (Phase 3): a plan audit has no
    // diff, so the auditor gets the file inventory only. This lets it tell
    // "the plan references a nonexistent module" from "the plan duplicates
    // an existing one" without hallucinating either way.
    let invBlock = '';
    try {
      const rc = getRepoContext({ tier: 'T0', scope: 'plan', baseDir: process.cwd() });
      if (rc.block) invBlock = `\n\n## Repository Context (tier ${rc.resolvedTier})\n${rc.block}\n`;
    } catch (err) {
      process.stderr.write(`  [repo-context] skipped (non-blocking) — ${err.message}\n`);
    }

    systemPrompt = PLAN_AUDIT_SYSTEM + r2Modifier;
    schema = PlanAuditResultSchema;
    schemaName = 'plan_audit_result';
    userPrompt = `## Project Context\n${planContext}${depsBlock}${invBlock}${reqBlock}${rulingsBlock}\n\n${historyContext ? `---\n\n${historyContext}\n` : ''}---\n\n## Plan to Audit\n${planContent}`;
  }

  // Cost preflight (single-call modes: plan, rebuttal)
  printCostPreflight(mode, (systemPrompt?.length || 0) + (userPrompt?.length || 0), MODEL,
    openaiConfig.reasoning === 'high' ? (userPrompt?.length || 0) * 2 : 0);

  try {
    const { result, usage, latencyMs } = await callGPT(openai, {
      systemPrompt, userPrompt, schema, schemaName,
      passName: mode
    });

    // Plan mode: suppress recurring scope-pressure findings via PlanFpTracker
    if (mode === 'plan' && Array.isArray(result.findings)) {
      try {
        const planFpTracker = new PlanFpTracker().load();
        const before = result.findings.length;
        result.findings = result.findings.filter(f => {
          const text = `${f.category} ${f.detail || ''}`.trim();
          const suppress = planFpTracker.shouldSuppress(text);
          if (suppress) process.stderr.write(`  [plan-fp] Suppressed recurring: ${f.id} — ${f.category}\n`);
          return !suppress;
        });
        const suppressed = before - result.findings.length;
        if (suppressed > 0) process.stderr.write(`  [plan-fp] Suppressed ${suppressed} recurring scope-pressure findings\n`);
      } catch { /* tracker unavailable — proceed without suppression */ }
    }

    // Plan mode R2+: post-output suppression (same as code mode Layer 3)
    if (mode === 'plan' && round >= 2 && ledgerPath && Array.isArray(result.findings)) {
      // Enrich findings with metadata for suppression matching
      for (const f of result.findings) {
        populateFindingMetadata(f, 'plan');
      }

      let ledger = { entries: [] };
      try { ledger = JSON.parse(fs.readFileSync(path.resolve(ledgerPath), 'utf-8')); } catch { /* no ledger yet */ }

      const { kept, suppressed, reopened } = suppressReRaises(result.findings, ledger, { changedFiles: [] });
      result.findings = [...kept, ...reopened];
      result._suppression = { kept: kept.length, suppressed: suppressed.length, reopened: reopened.length };

      process.stderr.write(`  [plan-r2] Post-suppression: Kept ${kept.length} | Suppressed ${suppressed.length} | Reopened ${reopened.length}\n`);
    }

    // Plan mode: auto-write ledger entries (same as code mode)
    if (mode === 'plan' && ledgerPath && !noLedger && Array.isArray(result.findings)) {
      try {
        const enriched = result.findings.map(f => {
          const copy = { ...f };
          populateFindingMetadata(copy, 'plan');
          return copy;
        });
        const ledgerEntries = enriched.map(f => ({
          topicId: generateTopicId(f),
          findingId: f.id,
          severity: f.severity,
          category: f.category,
          section: f.section,
          detailSnapshot: f.detail?.slice(0, 300),
          detail: f.detail?.slice(0, 300),
          pass: 'plan',
          _hash: f._hash,
          semanticHash: f._hash,
          affectedFiles: f.affectedFiles || [f._primaryFile || ''],
          affectedPrinciples: f.principle ? [f.principle] : [],
          adjudicationOutcome: 'pending',
          remediationState: 'pending',
          round
        }));
        const { inserted, updated, total } = batchWriteLedger(ledgerPath, ledgerEntries);
        process.stderr.write(`  [plan-ledger] Written: ${inserted} new, ${updated} updated, ${total} total\n`);
      } catch (err) {
        process.stderr.write(`  [plan-ledger] Write failed: ${err.message}\n`);
      }
    }

    // ── Model-A/B/C generation shadow for the PLAN audit (v2.1, observation-only) ──
    // Records the arm A/B/C comparison at stage_type='audit-plan' so the scorer can
    // compare model performance ACROSS skills (D9). Fully GATED on
    // resolveArms(...).enabled — with the experiment off, a normal plan audit is
    // byte-identical (no run row, no shadow). Best-effort; an egress refusal
    // surfaces loudly. Mirrors the code-path shadow block, with stageType='audit-plan'.
    if (mode === 'plan' && Array.isArray(result.findings)) {
      try {
        // Toggle-aware (mirrors the code-path shadow block above).
        const { resolveShadowArmsWithToggle } = await import('./lib/arm-eval/toggle.mjs');
        const armSet = resolveShadowArmsWithToggle(process.env);
        if (armSet.enabled && await isCloudEnabled() && repoProfile) {
          const repoRef = await resolveRepoForStore({ profile: repoProfile }).catch(() => null);
          const planRepoId = repoRef?.repoRowId ?? null;
          if (planRepoId) {
            let commitSha = null, branch = null;
            try {
              const { execFileSync } = await import('node:child_process');
              commitSha = execFileSync('git', ['rev-parse', 'HEAD'], { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
              branch = execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
            } catch { /* not a git repo */ }
            const planShadowRunId = await recordRunStart(planRepoId, planFile || 'ad-hoc', 'plan', { commitSha, branch }).catch(() => null);
            if (planShadowRunId) {
              // Persist arm A's (production plan-audit) findings with stage=null so
              // the scorer view attributes them to A — the baseline the B/C arms
              // are compared against for this assignment.
              for (const f of result.findings) populateFindingMetadata(f, 'plan');
              await recordFindings(planShadowRunId, result.findings, 'plan-baseline', round).catch(() => {});

              const { runGenerationShadow } = await import('./lib/audit-shadow.mjs');
              const shadowSummary = await runGenerationShadow({
                redactedContext: planContent,          // the plan IS the audited subject
                arms: armSet.arms,
                baseline: { findings: result.findings },
                runId: planShadowRunId,
                planContent: '',
                round,
                stageType: 'audit-plan',
              });
              result._modelAbShadow = shadowSummary;
              result._cloudRunId = planShadowRunId;
              process.stderr.write(
                `  [shadow] model-A/B PLAN-audit shadow: ${shadowSummary.state}`
                + (shadowSummary.findingCount != null ? ` (${shadowSummary.findingCount} findings, ${shadowSummary.shadowOnly} shadow-only, stages: ${(shadowSummary.stages || []).join('+')})` : '')
                + '\n',
              );
            }
          }
        }
      } catch (err) {
        // See the code-audit shadow block above — no shadow failure, including
        // an egress-gate refusal, may propagate past this point (would abort
        // the primary plan-audit result before its --out write).
        const { classifyShadowFailure } = await import('./lib/audit-shadow.mjs');
        const { log, marker } = classifyShadowFailure(err);
        process.stderr.write(`  [shadow] PLAN ${log}\n`);
        if (marker) result._modelAbShadow = marker;
      }
    }

    // Plan-audit cloud run registration (2026-07-13 parity with code mode):
    // mint/reuse an audit_runs row (mode='plan') + persist the post-suppression
    // findings so Step-3.5b outcome labeling has cloud rows to label. Skipped
    // when the arm-eval shadow block above already minted a run for this
    // result (result._cloudRunId set) — one plan audit, one audit_runs row.
    // Best-effort: cloud off / failure → result simply lacks _cloudRunId,
    // exactly today's behaviour.
    if (mode === 'plan' && !result._cloudRunId && Array.isArray(result.findings)) {
      const { cloudRunId } = await registerPlanAuditRun({ repoProfile, planFile, runId: explicitRunId });
      if (cloudRunId) {
        result._cloudRunId = cloudRunId;
        await completePlanAuditRun(cloudRunId, result, { round, durationMs: Date.now() - startMs });
        process.stderr.write(`  [learning] plan-audit run registered: ${cloudRunId} (${result.findings.length} findings, round ${round})\n`);
      }
    }

    // Update bandit arms + FP tracker from rebuttal resolutions (v2: per-pass + revision IDs)
    if (mode === 'rebuttal' && result.resolutions?.length) {
      const repoFP = repoProfile?.repoFingerprint || null;
      for (const r of result.resolutions) {
        const reward = computeReward({
          claude_position: r.claude_position,
          gpt_ruling: r.gpt_ruling,
          final_severity: r.final_severity,
          ruling_rationale: r.ruling_rationale || r.reasoning,
          semanticHash: r._hash
        });

        // Update the specific pass arm (not all passes) using revision ID
        const findingPass = r._pass || r.finding_id?.match(/^[A-Z]/)?.[0] === 'H' ? 'backend' : 'sustainability';
        for (const pass of PASS_NAMES) {
          const revId = getActiveRevisionId(pass) || 'default';
          bandit.update(pass, revId, reward);
        }

        // Track FP patterns with structured dimensions and repo context
        const fpFinding = {
          category: r.category || r.finding_id,
          severity: r.final_severity === 'DISMISSED' ? 'UNKNOWN' : r.final_severity,
          principle: r.principle || 'unknown'
        };
        const isAccepted = r.final_severity !== 'DISMISSED' && r.gpt_ruling !== 'overrule';
        fpTracker.record(fpFinding, isAccepted, repoFP);
      }
      bandit.flush();
      // Sync to Supabase (fire-and-forget)
      syncBanditArms(bandit.arms).catch(e => process.stderr.write(`  [learning] ${e.message}\n`));
      syncFalsePositivePatterns(repoFP, fpTracker.patterns).catch(e => process.stderr.write(`  [learning] ${e.message}\n`));
    }

    if (jsonMode || outFile) {
      const data = { ...result, _usage: usage };
      if (outFile) {
        const summaryLine = mode === 'rebuttal'
          ? `Deliberation complete: ${result.resolutions?.length ?? 0} resolutions`
          : `Verdict: ${result.verdict} | H:${result.findings?.filter(f => f.severity === 'HIGH').length ?? 0} M:${result.findings?.filter(f => f.severity === 'MEDIUM').length ?? 0} L:${result.findings?.filter(f => f.severity === 'LOW').length ?? 0}`;
        writeOutput(data, outFile, summaryLine);
      } else {
        console.log(JSON.stringify(data, null, 2));
      }
    } else if (mode === 'rebuttal') {
      const sustained = result.resolutions.filter(r => r.gpt_ruling === 'sustain').length;
      const overruled = result.resolutions.filter(r => r.gpt_ruling === 'overrule').length;
      const compromised = result.resolutions.filter(r => r.gpt_ruling === 'compromise').length;

      console.log('# GPT-5.4 Deliberation Resolution Report');
      console.log(`- **Model**: ${MODEL} | **Latency**: ${(latencyMs / 1000).toFixed(1)}s`);
      console.log(`- **Tokens**: ${usage.input_tokens} in / ${usage.output_tokens} out (${usage.reasoning_tokens} reasoning)`);
      console.log('');
      console.log(`| Outcome | Count |\n|---------|-------|\n| Sustained | ${sustained} |\n| Overruled | ${overruled} |\n| Compromise | ${compromised} |\n| Uncontested | ${result.uncontested_findings?.length ?? 0} |`);
      console.log('\n## Resolutions\n');
      for (const r of result.resolutions) {
        const icon = r.gpt_ruling === 'sustain' ? '🔴' : r.gpt_ruling === 'overrule' ? '🟢' : '🟡';
        console.log(`### ${icon} [${r.finding_id}] ${r.gpt_ruling.toUpperCase()} → ${r.final_severity}`);
        console.log(`- **Claude**: ${r.claude_position} | **GPT**: ${r.gpt_ruling}`);
        console.log(`- **Final**: ${r.final_recommendation}`);
        console.log(`- **Why**: ${r.reasoning}\n`);
      }
      if (result.uncontested_findings?.length) console.log(`\n**Uncontested**: ${result.uncontested_findings.join(', ')}`);
      console.log(`\n## Overall\n${result.deliberation_summary}`);
    } else {
      // Plan audit
      const high = result.findings.filter(f => f.severity === 'HIGH').length;
      const medium = result.findings.filter(f => f.severity === 'MEDIUM').length;
      const low = result.findings.filter(f => f.severity === 'LOW').length;

      console.log('# GPT-5.4 Plan Audit Report');
      console.log(`- **Model**: ${MODEL} | **Latency**: ${(latencyMs / 1000).toFixed(1)}s`);
      console.log(`- **Tokens**: ${usage.input_tokens} in / ${usage.output_tokens} out (${usage.reasoning_tokens} reasoning)`);
      console.log('');
      console.log(`## Verdict: **${result.verdict}**`);
      console.log(`- **Completeness**: ${result.structural_completeness} | **Principles**: ${result.principle_coverage_pct}%`);
      console.log(`- **Specificity**: ${result.specificity} | **Sustainability**: ${result.sustainability}`);
      console.log(`- **HIGH**: ${high} | **MEDIUM**: ${medium} | **LOW**: ${low}`);
      console.log('');
      console.log('## Findings');
      console.log(formatFindings(result.findings));

      if (result.ambiguities?.length > 0) {
        console.log('\n## Ambiguities\n');
        console.log('| Location | Vague Language | Clarification |\n|----------|---------------|---------------|');
        for (const a of result.ambiguities) console.log(`| ${a.location} | ${a.vague_language} | ${a.clarification_needed} |`);
      }

      if (result.quick_fix_warnings?.length > 0) {
        console.log('\n## Quick Fix Warnings\n');
        for (const w of result.quick_fix_warnings) console.log(`- ${w}`);
      }

      console.log(`\n## Overall\n${result.overall_reasoning}`);
    }
  } catch (err) {
    console.error(`Error: ${err.message}`);
    bandit.flush(); // Ensure state is persisted even on error
    process.exit(1);
  }
}

// Test-export gate — when AUDIT_EXPORTS_FOR_TESTS=1 we expose the internal
// LLM wrappers for unit tests. Production runs (the CLI invocation) do NOT
// set the env var, so the export is undefined and the test scaffolding is
// dead code at runtime cost.
export const __testExports = process.env.AUDIT_EXPORTS_FOR_TESTS === '1'
  ? { _callGPTOnce, callGPT, safeCallGPT, normalisePromptInput, resolveDiffBase, runMultiPassCodeAudit, buildAuditRunContext, runLegacyProductionAudit }
  : undefined;

// CLI entry — only fire main() when this module is executed directly,
// not when imported (e.g. by tests). Uses node:url pathToFileURL for
// cross-platform robustness.
import { pathToFileURL } from 'node:url';
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
