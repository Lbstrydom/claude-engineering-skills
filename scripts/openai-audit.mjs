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
import OpenAI from 'openai';
import { z } from 'zod';
import { zodTextFormat } from 'openai/helpers/zod';
import { FindingSchema, ProducerFindingSchema, WiringIssueSchema, LedgerEntrySchema, ReduceStatus, ExecutionMetaSchema } from './lib/schemas.mjs';
import {
  safeInt, readFileOrDie, readFilesAsContext, readFilesAsAnnotatedContext,
  writeOutput, normalizePath, parseDiffFile, extractPlanPaths, classifyFiles,
  isAuditInfraFile
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
import { initLearningStore, isCloudEnabled, upsertRepo, upsertPlan, recordRunStart, recordRunComplete, recordFindings, recordPassStats, recordSuppressionEvents, recordAdjudicationEvent, syncBanditArms, syncFalsePositivePatterns, recordDiffComplexity, backfillLearningOutcome, insertLearningDecision } from './learning-store.mjs';
import { recordDecision as _learningRecordDecision, flush as _learningFlush, installLifecycleHooks as _learningInstallHooks, buildDecisionKey as _learningBuildKey } from './lib/learning/decision-logger.mjs';
import { PromptBandit, computeReward, buildContext } from './bandit.mjs';
import { openaiConfig, PASS_NAMES, modelPricing } from './lib/config.mjs';
import { supportsReasoningEffort, refreshModelCatalog, resolveModel, pricingKey } from './lib/model-resolver.mjs';

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

const MODEL = openaiConfig.model;
const REASONING_EFFORT = openaiConfig.reasoning;
const MAX_OUTPUT_TOKENS_CAP = openaiConfig.maxOutputTokensCap;
const TIMEOUT_MS_CAP = openaiConfig.timeoutMsCap;
const BACKEND_SPLIT_THRESHOLD = openaiConfig.backendSplitThreshold;
const MAP_REDUCE_THRESHOLD = openaiConfig.mapReduceThreshold;
const MAP_REDUCE_TOKEN_THRESHOLD = openaiConfig.mapReduceTokenThreshold;
const HIGH_REASONING_MAP_REDUCE_THRESHOLD = openaiConfig.highReasoningMapReduceThreshold;
const HIGH_REASONING_MAP_REDUCE_TOKEN_THRESHOLD = openaiConfig.highReasoningMapReduceTokenThreshold;

// Robustness constants imported from lib/robustness.mjs

/** Check if a file set should use map-reduce (by count OR total size). */
function shouldMapReduce(files) {
  if (files.length > MAP_REDUCE_THRESHOLD) return true;
  const totalChars = measureContextChars(files, 10000);
  return totalChars > MAP_REDUCE_TOKEN_THRESHOLD;
}

/**
 * Like shouldMapReduce() but uses lower thresholds for reasoning:high passes
 * (backend, frontend). These time out as single calls at ~36% on Windows —
 * splitting into smaller map-reduce units keeps each unit under 140s.
 */
function shouldMapReduceHighReasoning(files) {
  if (files.length > HIGH_REASONING_MAP_REDUCE_THRESHOLD) return true;
  const totalChars = measureContextChars(files, 10000);
  return totalChars > HIGH_REASONING_MAP_REDUCE_TOKEN_THRESHOLD;
}

// computePassLimits imported from lib/robustness.mjs (canonical owner)

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

// ── Code Audit Pass Schemas (one per pass, smaller = faster) ───────────────────

const PassFindingsSchema = z.object({
  pass_name: z.string().max(30),
  findings: z.array(ProducerFindingSchema).max(15).describe('Top 15 findings, sorted by severity (HIGH first). Prefer fewer deep findings over many shallow ones.'),
  quick_fix_warnings: z.array(z.string().max(300)).max(5),
  summary: z.string().max(500).describe('Brief summary of this pass')
});

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

// ── Code Audit Pass Prompts (from prompt-registry or seed fallback) ──────────

// Bootstrap prompt registry on first run (idempotent — same content = no-op)
bootstrapFromConstants(PASS_PROMPTS);

/**
 * Get the active prompt for a pass. Falls back to seed if registry not bootstrapped.
 * @param {string} passName
 * @returns {string}
 */
function getPassPrompt(passName) {
  const registered = getActivePrompt(passName);
  if (registered) return registered;
  return PASS_PROMPTS[passName] || '';
}

// Resolve prompts at module load (uses registry if available, seeds otherwise)
const PASS_STRUCTURE_SYSTEM = getPassPrompt('structure');
const PASS_WIRING_SYSTEM = getPassPrompt('wiring');
const PASS_BACKEND_SYSTEM = getPassPrompt('backend');
const PASS_FRONTEND_SYSTEM = getPassPrompt('frontend');
const PASS_SUSTAINABILITY_SYSTEM = getPassPrompt('sustainability');

// Architecture-intent system prompt — the LLM-bouncer rubric.  See
// docs/completed/architecture-intent-framework.md §9.  Static (never
// varies across rounds) so safe to be in `system` prompt for cache-stability.
const PASS_ARCH_INTENT_SYSTEM = `You are auditing PR diffs against the repo's declared architectural intent. The mechanical analyser has already flagged candidate violations — your job is to classify SEVERITY and filter false positives.

You receive:
1. The repo's architecture-intent.md (the hand-curated C4 + rationale).
2. A list of mechanical violations: { fromFile, toFile, fromDomain, toDomain, ruleViolated }.
3. Unmapped files (in repo, not in any domain rule).
4. Dead intent (domains declared but with no files).

Output: findings list. Use:
- HIGH: cross-cutting violation, breaks a critical invariant (e.g., audit-orchestration → learning-store when not allowed creates a circular dep between core subsystems).
- MEDIUM: boundary erosion in a non-critical edge, OR a recurring pattern that suggests the boundary is wrong (consider proposing an allowedDeps update INSTEAD of a fix).
- LOW: isolated, easily-fixed cases (one file in the wrong domain; one stray import).

When recommending a fix, prefer "move the file to the right domain" or "extract the cross-cutting concern into a shared module" over "add the dep to allowedDeps". Adding to allowedDeps is admitting the intent doc was wrong — sometimes that's right, but say so explicitly.

DO NOT raise findings for:
- Same-domain edges (always allowed by definition).
- Edges to \`vendor\` (external deps — different policy layer).
- Unmapped files in test/ or docs/ (heuristic — only flag src/ + scripts/).

DO raise findings for:
- deadIntent (domain declared but no files) — possible stale intent.
- unmappedFiles in src/ or scripts/ — gap in domain-map.

Severity floor: any mechanical violation defaults to MEDIUM unless you can justify HIGH or LOW with concrete reasoning.`;

// LlmError and classifyLlmError imported from lib/robustness.mjs

// ── GPT API Call Helper ────────────────────────────────────────────────────────

/**
 * Make a single GPT-5.4 call with structured output.
 * Detects incomplete/truncated responses and throws LlmError with usage attached.
 */
/**
 * Build an audit-pass prompt opts object ready to pass to safeCallGPT in
 * structured mode. Bundles the typical per-pass setup (brief lookup, plan
 * slicing, optional rulings, R2_ROUND_MODIFIER) so call sites stay terse.
 *
 * Returns { system, messages } — pass directly to `safeCallGPT`/`callGPT`
 * via spread: `safeCallGPT(openai, { ...buildCachePrompt({...}), schema, ... })`.
 *
 * @param {object} args
 * @param {string} args.rubric            - pass-specific static system rubric (e.g. PASS_STRUCTURE_SYSTEM)
 * @param {string} args.focusBlock        - repo-focus addition (appended to rubric)
 * @param {string} args.passName          - pass identifier (used for brief/plan slicing)
 * @param {string} args.planContent       - full plan markdown
 * @param {string|null} args.ledgerFile   - ledger path (null on R1)
 * @param {Set<string>|null} args.impactSet - impacted-file set for rulings filter
 * @param {boolean} args.isR2Plus         - R2+ flag (controls rulings + roundModifier)
 * @param {string} args.code              - file contents to audit
 * @param {string} [args.fileListContext] - optional file-list summary block
 * @returns {{ system: string, messages: Array<{role:'user',content:string}> }}
 */
function buildCachePrompt({ rubric, focusBlock, passName, planContent, ledgerFile, impactSet, isR2Plus, code, codeHeader = '## Code', fileListContext = '', historyBlock = '', unitLabel = '' }) {
  // Combine pre-existing CLI --history block (rare) with R2+ ledger rulings.
  // Both are round-varying; both belong in msg #2 for cache stability.
  const rulings = (isR2Plus && ledgerFile) ? buildRulingsBlock(ledgerFile, passName, impactSet) : null;
  const history = [historyBlock, rulings].filter(Boolean).join('\n\n') || null;
  return buildAuditPassPrompt({
    systemRubric: rubric + (focusBlock || ''),
    brief: readProjectContextForPass(passName),
    planSlice: extractPlanForPass(planContent, passName),
    fileListContext,
    code,
    codeHeader,
    history,
    roundModifier: isR2Plus ? R2_ROUND_MODIFIER : null,
    unitLabel,
  });
}

/**
 * Normalise prompt opts into a Responses-API `input` array.
 * Accepts EITHER legacy `{ systemPrompt, userPrompt }` (strings) OR
 * structured `{ system, messages }` (string + user-message array).
 * Rejects hybrid combinations with LlmError({category:'config'}) — those
 * are programmer bugs and must fail-fast per repo policy.
 *
 * SUNSET PLAN (legacy `systemPrompt`/`userPrompt` mode):
 * The legacy mode is kept for non-audit callers (currently none in this
 * repo's audit pipeline — all 14 audit call sites migrated to structured
 * mode as of `feat(audit): prompt prefix-cache restructure`). It will be
 * removed once we've gone 30 days without any internal caller using it.
 * The wrapper-contract test asserts both modes work; remove the legacy
 * branch + its test when the sunset fires.
 *
 * @returns {Array<{role:'system'|'user',content:string}>} input array
 */
function normalisePromptInput(opts) {
  const hasLegacy = opts.systemPrompt !== undefined || opts.userPrompt !== undefined;
  const hasStructured = opts.system !== undefined || opts.messages !== undefined;
  if (hasLegacy && hasStructured) {
    throw new LlmError(
      'Hybrid prompt input: cannot pass both {systemPrompt|userPrompt} and {system|messages}. Pick one mode.',
      { category: 'config', retryable: false }
    );
  }
  if (hasStructured) {
    if (typeof opts.system !== 'string') {
      throw new LlmError('Structured mode requires opts.system: string', { category: 'config', retryable: false });
    }
    if (!Array.isArray(opts.messages) || opts.messages.length === 0) {
      throw new LlmError('Structured mode requires opts.messages: non-empty array', { category: 'config', retryable: false });
    }
    for (const m of opts.messages) {
      if (!m || m.role !== 'user' || typeof m.content !== 'string') {
        throw new LlmError('Structured mode: each message must be { role: "user", content: string }', { category: 'config', retryable: false });
      }
    }
    return [{ role: 'system', content: opts.system }, ...opts.messages];
  }
  // Legacy mode
  if (typeof opts.systemPrompt !== 'string' || typeof opts.userPrompt !== 'string') {
    throw new LlmError('Legacy mode requires systemPrompt + userPrompt as strings', { category: 'config', retryable: false });
  }
  return [
    { role: 'system', content: opts.systemPrompt },
    { role: 'user', content: opts.userPrompt }
  ];
}

async function _callGPTOnce(openai, opts) {
  const { schema, schemaName, reasoning, maxTokens, timeoutMs, passName } = opts;
  const effort = reasoning ?? REASONING_EFFORT;
  const tokens = maxTokens ?? MAX_OUTPUT_TOKENS_CAP;
  const timeout = timeoutMs ?? TIMEOUT_MS_CAP;

  // Normalise prompt input ONCE — throws config-category LlmError on hybrid.
  // This deliberately happens OUTSIDE the try/catch below so it propagates
  // unwrapped (the try block re-throws structured LlmErrors anyway, but the
  // config check here makes the failure unmissable for callers).
  const input = normalisePromptInput(opts);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  const startMs = Date.now();

  if (passName) {
    process.stderr.write(`  [${passName}] Starting (reasoning: ${effort}, timeout: ${(timeout / 1000).toFixed(0)}s)...\n`);
  }

  try {
    const requestParams = {
      model: MODEL,
      input,
      text: { format: zodTextFormat(schema, schemaName) },
      max_output_tokens: tokens
    };

    if (supportsReasoningEffort(MODEL)) {
      requestParams.reasoning = { effort };
    }

    const response = await openai.responses.parse(requestParams, { signal: controller.signal });
    clearTimeout(timer);
    const latencyMs = Date.now() - startMs;

    // Extract usage regardless of success/failure (includes cached_tokens).
    // NOTE: Responses API returns cached_tokens under `input_tokens_details`
    // (NOT `prompt_tokens_details` which is the Chat Completions API shape).
    // The fallback to prompt_tokens_details is kept defensively for any
    // future SDK shape changes — it costs nothing when not present.
    const usage = {
      input_tokens: response.usage?.input_tokens ?? 0,
      cached_tokens: response.usage?.input_tokens_details?.cached_tokens
        ?? response.usage?.prompt_tokens_details?.cached_tokens
        ?? 0,
      output_tokens: response.usage?.output_tokens ?? 0,
      reasoning_tokens: response.usage?.output_tokens_details?.reasoning_tokens ?? 0,
      latency_ms: latencyMs
    };

    // Detect incomplete response
    if (response.status === 'incomplete') {
      const reason = response.incomplete_details?.reason ?? 'unknown';
      throw new LlmError(`Response incomplete: ${reason}`, { category: 'incomplete', usage, retryable: true });
    }

    // Check ALL output items for truncation
    for (const item of (response.output ?? [])) {
      if (item?.status === 'incomplete') {
        throw new LlmError(`Output truncated: ${item.incomplete_details?.reason ?? 'max_tokens'}`,
          { category: 'truncated', usage, retryable: true });
      }
    }

    let result = response.output_parsed;
    if (!result) {
      // Attempt bracket-balance repair on raw text before giving up
      const rawText = response.output?.find(o => o.type === 'output_text')?.text ?? '';
      if (rawText) {
        const repairAttempt = tryRepairJson(rawText);
        if (repairAttempt.ok) {
          process.stderr.write(`  [${passName ?? 'call'}] output_parsed null — repaired truncated JSON\n`);
          result = repairAttempt.result;
        }
      }
      if (!result) throw new LlmError('No parsed output from model', { category: 'empty', usage });
    }

    // Validate expected shape
    if (result.findings !== undefined && !Array.isArray(result.findings)) {
      throw new LlmError(`Schema violation: findings is ${typeof result.findings}, expected array`,
        { category: 'schema', usage });
    }

    if (passName) {
      process.stderr.write(`  [${passName}] Done in ${(latencyMs / 1000).toFixed(1)}s (${usage.input_tokens} in / ${usage.output_tokens} out)\n`);
    }

    return { result, usage, latencyMs };

  } catch (err) {
    clearTimeout(timer);
    if (err instanceof LlmError) throw err; // Already structured
    const latencyMs = Date.now() - startMs;
    const isAbort = err.name === 'AbortError' || err.message?.toLowerCase().includes('abort');
    const msg = isAbort
      ? `[${passName ?? 'call'}] Timeout after ${(timeout / 1000).toFixed(0)}s`
      : `[${passName ?? 'call'}] ${err.message} (${(latencyMs / 1000).toFixed(1)}s)`;
    process.stderr.write(`  [${passName ?? 'call'}] FAILED: ${msg}\n`);
    throw new Error(msg);
  }
}

/**
 * Call GPT with single retry on transient failures.
 * Accumulates usage across attempts for truthful accounting.
 */
async function callGPT(openai, opts) {
  let lastErr;
  const startMs = Date.now();
  const accumulatedUsage = { input_tokens: 0, cached_tokens: 0, output_tokens: 0, reasoning_tokens: 0 };
  const maxRetries = opts.maxRetries ?? RETRY_MAX_ATTEMPTS;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const result = await _callGPTOnce(openai, opts);
      if (attempt > 0) {
        result.usage.input_tokens += accumulatedUsage.input_tokens;
        result.usage.cached_tokens += accumulatedUsage.cached_tokens;
        result.usage.output_tokens += accumulatedUsage.output_tokens;
        result.usage.reasoning_tokens += accumulatedUsage.reasoning_tokens;
        result.latencyMs = Date.now() - startMs;
        result._retried = true;
        result._attempts = attempt + 1;
      }
      return result;
    } catch (err) {
      lastErr = err;
      if (err.llmUsage) {
        accumulatedUsage.input_tokens += err.llmUsage.input_tokens ?? 0;
        accumulatedUsage.cached_tokens += err.llmUsage.cached_tokens ?? 0;
        accumulatedUsage.output_tokens += err.llmUsage.output_tokens ?? 0;
        accumulatedUsage.reasoning_tokens += err.llmUsage.reasoning_tokens ?? 0;
      }
      const { retryable, category } = classifyLlmError(err);
      if (attempt < maxRetries && retryable) {
        const delayMs = category === 'http-429'
          ? Math.min(RETRY_429_MAX_DELAY_MS, RETRY_BASE_DELAY_MS * (attempt + 1) + Math.random() * 1000)
          : RETRY_BASE_DELAY_MS * (attempt + 1);
        process.stderr.write(`  [${opts.passName ?? 'call'}] Retry ${attempt + 1}/${RETRY_MAX_ATTEMPTS} in ${(delayMs / 1000).toFixed(1)}s [${category}]\n`);
        await new Promise(r => setTimeout(r, delayMs));
        continue;
      }
      err._accumulatedUsage = accumulatedUsage;
      throw err;
    }
  }
  throw lastErr;
}

/**
 * Wrapper that catches LLM/runtime pass failures and returns empty results
 * instead of crashing. Allows the audit to continue even if one pass fails.
 *
 * Fail-fast for config errors (programmer bugs): if the underlying call throws
 * LlmError({category:'config'}), it is RE-THROWN — those represent hybrid
 * prompt inputs or schema mismatches that must surface immediately in tests
 * rather than silently degrade in production audits.
 */
async function safeCallGPT(openai, opts, emptyResult) {
  try {
    return await callGPT(openai, opts);
  } catch (err) {
    // Fail-fast on programmer bugs (hybrid input, schema misconfig)
    if (err instanceof LlmError && err.llmCategory === 'config') {
      throw err;
    }
    process.stderr.write(`  [${opts.passName}] Graceful degradation — using empty result\n`);
    return {
      result: emptyResult,
      usage: { input_tokens: 0, cached_tokens: 0, output_tokens: 0, reasoning_tokens: 0, latency_ms: 0 },
      latencyMs: 0,
      failed: true,
      error: err.message
    };
  }
}

// ── Intermediate Result Cache ────────────────────────────────────────────────
// Write each wave's results to disk as they complete. If the merge step crashes
// (TDZ, disk error, OOM), findings survive on disk and can be recovered.
// The cache dir is derived from the --out path or uses os.tmpdir().

import os from 'node:os';

let _cacheDir = null;

function initResultCache(outFile) {
  const base = outFile
    ? path.dirname(path.resolve(outFile))
    : os.tmpdir();
  _cacheDir = path.join(base, `.audit-cache-${process.pid}`);
  try {
    fs.mkdirSync(_cacheDir, { recursive: true });
  } catch { _cacheDir = null; }
}

function cachePassResult(passName, result) {
  if (!_cacheDir) return;
  try {
    const filePath = path.join(_cacheDir, `${passName}.json`);
    fs.writeFileSync(filePath, JSON.stringify(result), 'utf-8');
  } catch (err) {
    process.stderr.write(`  [cache] Failed to cache ${passName}: ${err.message}\n`);
  }
}

function cacheWaveResults(passNames, results) {
  for (let i = 0; i < passNames.length; i++) {
    if (results[i]) cachePassResult(passNames[i], results[i]);
  }
  process.stderr.write(`  [cache] ${passNames.length} pass results cached to ${_cacheDir}\n`);
}

function cleanupCache() {
  if (!_cacheDir) return;
  try { fs.rmSync(_cacheDir, { recursive: true, force: true }); } catch { /* ignore */ }
}

// buildReducePayload and normalizeFindingsForOutput imported from lib/robustness.mjs
// Wrap normalizeFindingsForOutput to inject semanticId
function normalizeFindingsForOutput(findings) {
  return _normalizeFindingsForOutput(findings, semanticId);
}

// ── Ledger Preflight ─────────────────────────────────────────────────────────

/**
 * Validate the R2+ ledger before running suppression.
 * Returns { valid, suppressionUnavailable?, entryCount? }.
 * A missing or corrupt ledger sets suppressionUnavailable=true so the caller
 * can propagate the flag into _executionMeta without crashing.
 */
function validateLedgerForR2(ledgerPath, round) {
  if (round < 2) return { valid: true };
  if (!ledgerPath) {
    process.stderr.write('  [ledger] WARNING: R2 started with no ledger — running without suppression\n');
    return { valid: false, suppressionUnavailable: true };
  }
  if (!fs.existsSync(ledgerPath)) {
    process.stderr.write(`  [ledger] WARNING: Ledger not found at ${ledgerPath} — running without suppression\n`);
    return { valid: false, suppressionUnavailable: true };
  }
  try {
    const raw = JSON.parse(fs.readFileSync(ledgerPath, 'utf-8'));
    if (!raw.entries || !Array.isArray(raw.entries)) throw new Error('missing entries array');
    process.stderr.write(`  [ledger] R2 ledger valid — ${raw.entries.length} prior entries\n`);
    return { valid: true, entryCount: raw.entries.length };
  } catch (err) {
    process.stderr.write(`  [ledger] WARNING: Ledger corrupted (${err.message}) — running without suppression\n`);
    return { valid: false, suppressionUnavailable: true };
  }
}

// ── Map-Reduce Pass ──────────────────────────────────────────────────────────

/**
 * Run a single pass using map-reduce when file count exceeds MAP_REDUCE_THRESHOLD.
 * MAP: parallel GPT calls per audit unit (chunked file groups).
 * REDUCE: single synthesis call to deduplicate, elevate patterns, rank findings.
 *
 * The prompt for each unit is built by the caller-provided `buildPromptForUnit`
 * callback — this keeps the prompt-shape logic colocated with the per-pass
 * config in the call sites, while runMapReducePass owns the parallelism /
 * retry / aggregation logic.
 *
 * @param {OpenAI} openai - OpenAI client
 * @param {string[]} files - Files to audit in this pass
 * @param {string} passName - Name of the pass (for logging)
 * @param {(unit, i, total) => { system, messages }} buildPromptForUnit -
 *   Callback that returns structured prompt opts for a given unit.
 *   Typically uses `buildCachePrompt({ ..., unitLabel: ..., code: ... })`.
 * @param {number} [maxFilesPerUnit=Infinity]
 * @param {object} [opts]
 * @param {Set<string>|null} [opts.changedFileSet] - per-file changed set for retry-skip
 * @returns {Promise<{result: object, usage: object, latencyMs: number}>}
 */
// Re-throw config-category LlmErrors from a Promise.allSettled rejection
// so programmer wiring bugs surface immediately rather than being swallowed
// (Gemini-R1/MED fix to plan §6).
function throwIfConfigError(settled) {
  if (settled && settled.status === 'rejected'
      && settled.reason instanceof LlmError
      && settled.reason.llmCategory === 'config') {
    throw settled.reason;
  }
}

// Cache-seed eligibility policy (plan §7c). Returns the seed decision
// envelope { seedEligible, seedUsed, seedSkipReason, seedUnitIdx, seedUnitTokens }
// so the audit-pass telemetry can record which mode ran.
function decideSeed(units, passName, buildPromptForUnit) {
  const envFlag = process.env.AUDIT_CACHE_SEED === '1';
  const minPrefix = safeInt(process.env.AUDIT_CACHE_STABLE_PREFIX_MIN, 1024);
  const decision = { seedEligible: false, seedUsed: false, seedSkipReason: null, seedUnitIdx: null, seedUnitTokens: null };
  if (!envFlag) {
    decision.seedSkipReason = 'env-disabled';
    return decision;
  }
  if (units.length <= 1) {
    decision.seedSkipReason = 'units.length<=1';
    return decision;
  }
  // Pick the smallest unit by code length (proxy for tokens) — its only job
  // is to warm the cache; smaller seed = lower latency cost.
  let seedIdx = 0;
  let seedLen = Infinity;
  for (let i = 0; i < units.length; i++) {
    const u = units[i];
    const len = u.chunk
      ? (u.chunk.imports?.length ?? 0) + u.chunk.items.reduce((s, it) => s + (it.source?.length ?? 0), 0)
      : u.files.reduce((s, f) => { try { return s + fs.statSync(f).size; } catch { return s; } }, 0);
    if (len < seedLen) { seedLen = len; seedIdx = i; }
  }
  // Sanity-estimate the stable prefix by building one unit's prompt with the
  // smallest payload — if msg #1 is below threshold, seeding is pointless.
  try {
    const probe = buildPromptForUnit({ ...units[seedIdx], _context: '' }, seedIdx, units.length, 'probe');
    const prefixChars = (probe.system?.length ?? 0) + (probe.messages?.[0]?.content?.length ?? 0);
    const prefixTokens = Math.ceil(prefixChars / 4);
    if (prefixTokens < minPrefix) {
      decision.seedSkipReason = 'prefix-too-small';
      decision.seedEligible = false;
      decision.seedUnitIdx = seedIdx;
      decision.seedUnitTokens = prefixTokens;
      return decision;
    }
    decision.seedEligible = true;
    decision.seedUsed = true;
    decision.seedUnitIdx = seedIdx;
    decision.seedUnitTokens = prefixTokens;
    return decision;
  } catch (err) {
    decision.seedSkipReason = `probe-failed:${err.message?.slice(0, 60)}`;
    return decision;
  }
}

// Run one map-reduce unit. Extracted from runMapReducePass body so the
// cache-seed path (sequential seed → parallel fanout) can re-use the same
// per-unit logic without duplicating retry/context wiring.
async function runOneMapUnit(openai, unit, i, totalUnits, passName, buildPromptForUnit, changedFileSet, acquireSlot, releaseSlot) {
  if (acquireSlot) await acquireSlot();
  try {
    const context = unit.chunk
      ? `// ${unit.files[0]} (chunk)\n${unit.chunk.imports}\n\n${unit.chunk.items.map(it => it.source).join('\n\n')}`
      : readFilesAsContext(unit.files, { maxPerFile: 10000, maxTotal: 80000 });

    const limits = computePassLimits(context.length, 'high');
    const unitHasChangedFiles = !changedFileSet || unit.files.some(f => changedFileSet.has(normalizePath(f)));
    const maxRetries = unitHasChangedFiles ? undefined : 0;

    const unitLabel = `Audit Unit ${i + 1}/${totalUnits} (${unit.files.length} files)`;
    const { system, messages } = buildPromptForUnit({ ...unit, _context: context }, i, totalUnits, unitLabel);

    return await callGPT(openai, {
      system,
      messages,
      schema: PassFindingsSchema,
      schemaName: `map_${passName}_${i}`,
      reasoning: 'high',
      ...limits,
      passName: `map-${passName}-${i}`,
      maxRetries,
    });
  } finally {
    if (releaseSlot) releaseSlot();
  }
}

async function runMapReducePass(openai, files, passName, buildPromptForUnit, maxFilesPerUnit = Infinity, { changedFileSet = null } = {}) {
  const units = buildAuditUnits(files, 30000, maxFilesPerUnit);

  // MAP phase: parallel calls with concurrency limit
  const CONCURRENCY_LIMIT = safeInt(process.env.MAP_REDUCE_CONCURRENCY, 5);
  let active = 0;
  const queue = [];
  const acquireSlot = () => active < CONCURRENCY_LIMIT ? (active++, Promise.resolve()) : new Promise(r => queue.push(r));
  const releaseSlot = () => queue.length > 0 ? queue.shift()() : active--;

  process.stderr.write(`  [${passName}] MAP: ${units.length} units, concurrency=${CONCURRENCY_LIMIT}\n`);
  const mapStart = Date.now();

  // Cache-seed (PR-5): opt-in via AUDIT_CACHE_SEED=1. When enabled AND
  // units.length > 1 AND stable-prefix is large enough, run the smallest
  // unit sequentially FIRST to warm OpenAI's prefix cache, then fan out
  // the rest in parallel. Result ordering is reconstructed by original
  // unit index — seed selection is purely a warm-up optimisation.
  // Per Gemini-R1/MED: re-throw config errors from any settled result
  // so programmer bugs surface immediately instead of being swallowed by
  // Promise.allSettled.
  const seedDecision = decideSeed(units, passName, buildPromptForUnit);
  let results;
  if (seedDecision.seedUsed) {
    const seedIdx = seedDecision.seedUnitIdx;
    process.stderr.write(`  [${passName}] cache-seed: warming with unit ${seedIdx} (~${seedDecision.seedUnitTokens} tok), then fanning out\n`);
    const runOneAtIdx = (i) => runOneMapUnit(openai, units[i], i, units.length, passName, buildPromptForUnit, changedFileSet, acquireSlot, releaseSlot);
    const [seedSettled] = await Promise.allSettled([runOneAtIdx(seedIdx)]);
    throwIfConfigError(seedSettled);
    const fanoutIdxs = units.map((_, i) => i).filter(i => i !== seedIdx);
    const fanoutSettled = await Promise.allSettled(fanoutIdxs.map(runOneAtIdx));
    for (const s of fanoutSettled) throwIfConfigError(s);
    results = new Array(units.length);
    results[seedIdx] = seedSettled;
    fanoutIdxs.forEach((origIdx, j) => { results[origIdx] = fanoutSettled[j]; });
  } else {
    results = await Promise.allSettled(
      units.map((unit, i) => runOneMapUnit(openai, unit, i, units.length, passName, buildPromptForUnit, changedFileSet, acquireSlot, releaseSlot))
    );
    // Fail-fast on config errors (Gemini-R1/MED)
    for (const s of results) throwIfConfigError(s);
  }

  // Collect findings + aggregate usage (including failed units)
  const allFindings = [];
  const mapUsage = { input_tokens: 0, output_tokens: 0, reasoning_tokens: 0 };
  let effectiveFailures = 0;
  for (let i = 0; i < results.length; i++) {
    if (results[i].status === 'fulfilled') {
      const val = results[i].value;
      if (val?.usage) {
        mapUsage.input_tokens += val.usage.input_tokens ?? 0;
        mapUsage.output_tokens += val.usage.output_tokens ?? 0;
        mapUsage.reasoning_tokens += val.usage.reasoning_tokens ?? 0;
      }
      if (!val?.result || !Array.isArray(val.result.findings)) {
        effectiveFailures++;
      } else {
        for (const f of val.result.findings) {
          f._mapUnit = i;
          allFindings.push(f);
        }
      }
    } else {
      effectiveFailures++;
      if (results[i].reason?._accumulatedUsage) {
        mapUsage.input_tokens += results[i].reason._accumulatedUsage.input_tokens ?? 0;
        mapUsage.output_tokens += results[i].reason._accumulatedUsage.output_tokens ?? 0;
        mapUsage.reasoning_tokens += results[i].reason._accumulatedUsage.reasoning_tokens ?? 0;
      }
      process.stderr.write(`  [map-${passName}-${i}] FAILED: ${results[i].reason?.message || 'unknown'}\n`);
    }
  }

  const mapCompletionRate = units.length > 0 ? (units.length - effectiveFailures) / units.length : 1;
  process.stderr.write(`  [${passName}] MAP done: ${allFindings.length} findings from ${units.length - effectiveFailures}/${units.length} units (${((Date.now() - mapStart) / 1000).toFixed(1)}s, completion: ${(mapCompletionRate * 100).toFixed(0)}%)\n`);

  if (allFindings.length === 0) {
    return {
      result: { pass_name: passName, findings: [], quick_fix_warnings: [], summary: `Map-reduce: ${units.length} units, 0 findings. ${effectiveFailures} units failed.` },
      usage: mapUsage,
      latencyMs: Date.now() - mapStart
    };
  }

  // MAP failure threshold — skip REDUCE when majority failed
  const failureRate = effectiveFailures / units.length;
  if (failureRate > MAP_FAILURE_THRESHOLD && allFindings.length > 0) {
    process.stderr.write(`  [${passName}] ${effectiveFailures}/${units.length} MAP units failed (${(failureRate * 100).toFixed(0)}%) — skipping REDUCE, returning normalized raw findings\n`);
    const normalized = normalizeFindingsForOutput(allFindings);
    return {
      result: { pass_name: passName, findings: normalized, quick_fix_warnings: [],
        summary: `Map-reduce: ${effectiveFailures}/${units.length} units failed. Returning ${normalized.length} raw findings (REDUCE skipped).` },
      usage: mapUsage,
      latencyMs: Date.now() - mapStart,
      _mapFailureRate: failureRate,
      _reduceSkipped: true
    };
  }

  // REDUCE phase: single synthesis call
  process.stderr.write(`  [${passName}] REDUCE: synthesizing ${allFindings.length} findings\n`);

  // Safe JSON truncation — always produces valid JSON
  const payload = buildReducePayload(allFindings);
  if (payload.degraded) {
    process.stderr.write(`  [${passName}] REDUCE payload could not fit budget — skipping REDUCE\n`);
    return {
      result: { pass_name: passName, findings: normalizeFindingsForOutput(allFindings), quick_fix_warnings: [],
        summary: `REDUCE skipped: findings exceeded budget after normalization.` },
      usage: mapUsage, latencyMs: Date.now() - mapStart, _reduceSkipped: true
    };
  }
  const { json: findingsJson, includedCount, totalCount } = payload;
  if (includedCount < totalCount) {
    process.stderr.write(`  [${passName}] REDUCE input truncated: ${includedCount}/${totalCount} findings (budget: ${MAX_REDUCE_JSON_CHARS} chars)\n`);
  }

  // Reduce uses low reasoning — it's dedup/ranking, not deep analysis. Higher timeout for large finding sets.
  const reduceLimits = computePassLimits(findingsJson.length + 2000, 'low', openaiConfig.reduceMinTokens);
  reduceLimits.timeoutMs = Math.max(reduceLimits.timeoutMs, 240000); // Min 4 min for reduce (frontend/backend sets can be large)
  const reduceResult = await safeCallGPT(openai, {
    systemPrompt: REDUCE_SYSTEM_PROMPT,
    userPrompt: `## Findings from ${units.length} audit units (${effectiveFailures} failed):\n\n${findingsJson}\n\n## Tasks:\n1. Deduplicate\n2. Elevate systemic patterns (3+ occurrences)\n3. Flag cross-file issues\n4. Rank by severity`,
    schema: PassFindingsSchema,
    schemaName: `reduce_${passName}`,
    reasoning: 'low',
    ...reduceLimits,
    passName: `reduce-${passName}`
  }, { pass_name: passName, findings: allFindings, quick_fix_warnings: [], summary: 'Reduce phase failed — returning raw map findings' });

  // Status-gated fallback: if safeCallGPT returned the empty-result sentinel (failed=true),
  // classify the failure and preserve raw MAP findings rather than silently discarding them.
  const reduceStatus = reduceResult._reduceStatus ?? (reduceResult.failed ? ReduceStatus.MODEL_ERROR : ReduceStatus.OK);
  if (reduceStatus !== ReduceStatus.OK && allFindings.length > 0) {
    process.stderr.write(`  [${passName}] REDUCE failed (${reduceStatus}) — preserving ${allFindings.length} raw MAP findings\n`);
    const totalLatency = Date.now() - mapStart;
    return {
      result: {
        pass_name: passName,
        findings: normalizeFindingsForOutput(allFindings),
        quick_fix_warnings: [],
        summary: `REDUCE failed (${reduceStatus}) — ${allFindings.length} raw findings preserved`,
        _executionMeta: { reduceStatus, reduceSkipped: true },
      },
      usage: { ...mapUsage, latency_ms: totalLatency },
      latencyMs: totalLatency,
    };
  }

  const totalLatency = Date.now() - mapStart;
  return {
    result: reduceResult.result,
    usage: { input_tokens: 0, output_tokens: 0, reasoning_tokens: 0, latency_ms: totalLatency },
    latencyMs: totalLatency,
    _mapCompletionRate: mapCompletionRate,
  };
}

// ── Multi-Pass Code Audit ──────────────────────────────────────────────────────

/**
 * Run multi-pass parallel code audit.
 * Large backend file sets are split into route+service sub-passes.
 * Each pass uses safeCallGPT for graceful degradation on timeout/error.
 */
/**
 * Architecture-intent audit pass (Wave 1.5).
 *
 * Runs the two-phase analysis (inventory + per-stack edge analysis), then
 * either short-circuits on clean OR sends violations to the LLM bouncer.
 * Falls back to deterministic severity rubric if the LLM call fails.
 *
 * @returns {Promise<{ state: string, result: object }>}
 */
async function runArchitecturePass({ openai, repoRoot, focusBlock, planContent, historyBlock, ledgerFile, impactSet, isR2Plus }) {
  const emptyResult = {
    result: { pass_name: 'architecture', findings: [], summary: 'pass not run' },
    usage: { input_tokens: 0, cached_tokens: 0, output_tokens: 0, reasoning_tokens: 0, latency_ms: 0 },
    latencyMs: 0,
  };

  const intentPath = path.join(repoRoot, 'docs/architecture-intent.md');
  const domainMapPath = path.join(repoRoot, '.audit-loop/domain-map.json');

  if (!fs.existsSync(intentPath)) {
    return { state: 'SKIPPED_NO_INTENT', result: emptyResult, archReport: null };
  }
  if (!fs.existsSync(domainMapPath)) {
    return { state: 'SKIPPED_MISSING_DOMAIN_MAP', result: emptyResult, archReport: null };
  }

  let domainMap;
  try {
    domainMap = loadArchIntentConfig(repoRoot);
  } catch (err) {
    if (err instanceof ArchIntentConfigError) {
      return {
        state: 'ERROR_INVALID_CONFIG',
        result: {
          result: {
            pass_name: 'architecture',
            findings: [{
              severity: 'HIGH',
              category: '[Architecture] Invalid domain-map.json',
              detail: err.message,
              recommendation: 'Fix the config file at .audit-loop/domain-map.json. See docs/completed/architecture-intent-framework.md §2 decision 5.',
              section: '.audit-loop/domain-map.json',
              affectedFiles: ['.audit-loop/domain-map.json'],
              affectedPrinciples: ['#5 SSoT'],
              is_quick_fix: false,
              is_mechanical: false,
              principle: '#5 SSoT',
            }],
            summary: 'Architecture pass aborted — config invalid',
          },
          usage: emptyResult.usage,
          latencyMs: 0,
        },
        archReport: null,
      };
    }
    throw err;
  }

  if (domainMap.allowedDeps === null) {
    return { state: 'SKIPPED_NO_BASELINE', result: emptyResult, archReport: null };
  }

  const intent = parseIntentDoc(intentPath);
  const { stackKinds } = detectRepoStack(repoRoot);

  if (stackKinds.length === 0) {
    return { state: 'SKIPPED_UNSUPPORTED_STACK', result: emptyResult, archReport: null };
  }

  const report = await runArchIntentAnalysis({ repoPath: repoRoot, stackKinds, domainMap });
  const derivedState = deriveArchState(report);

  // Stderr summary so operators see the mechanical findings even when LLM
  // doesn't fire (clean) or fails (fallback).
  process.stderr.write(`  [architecture] mechanical: ${report.violations.length} violations, ${report.unmappedFiles.length} unmapped, ${report.deadIntent.length} dead, ${report.perStackResults.length} stacks\n`);

  if (isArchIntentReportClean(report)) {
    return {
      state: 'ANALYZED_CLEAN',
      archReport: report,
      result: {
        result: { pass_name: 'architecture', findings: [], summary: 'Architecture intent clean' },
        usage: emptyResult.usage,
        latencyMs: 0,
      },
    };
  }

  // Build prompt + call LLM bouncer for severity classification
  const violationsForPrompt = formatViolationsForPrompt(report, intent);
  const archLimits = computePassLimits(violationsForPrompt.length + 4000, 'medium');
  const llmCall = await safeCallGPT(openai, {
    ...buildCachePrompt({
      rubric: PASS_ARCH_INTENT_SYSTEM,
      focusBlock,
      passName: 'architecture',
      planContent,
      ledgerFile: isR2Plus ? ledgerFile : null,
      impactSet,
      isR2Plus,
      historyBlock,
      codeHeader: '## Intent + Mechanical Violations',
      code: violationsForPrompt,
    }),
    schema: ArchIntentPassSchema,
    schemaName: 'architecture_pass',
    reasoning: 'medium',
    ...archLimits,
    passName: 'architecture',
  }, { pass_name: 'architecture', findings: [], summary: 'LLM call failed; falling back to deterministic rubric' });

  if (llmCall.failed) {
    // Deterministic fallback (decision 11): emit findings from mechanical
    // report using simplified rubric (no HIGH in fallback mode).
    return {
      state: derivedState === 'ANALYZED_PARTIAL' ? 'ANALYZED_PARTIAL' : 'ANALYZED_FALLBACK_DETERMINISTIC',
      archReport: report,
      result: {
        ...llmCall,
        result: {
          pass_name: 'architecture',
          findings: deriveFindingsFromReport(report),
          summary: `LLM bouncer failed (${llmCall.error}); ${report.violations.length} mechanical findings emitted with simplified rubric`,
        },
      },
    };
  }

  return {
    state: derivedState,
    archReport: report,
    result: llmCall,
  };
}

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
async function runOrphanIntroducedPass({ archReport, repoRoot, baseRef, headRef, runId, planContent, ledger }) {
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
    await emitOrphanRunMetrics({
      runId, passState: scope.state, rawFindings: [], survivors: [], suppressed: [], _meta: {}, repoPath: repoRoot,
    });
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
  await emitOrphanRunMetrics({
    runId,
    passState: detector.state,
    rawFindings: detector.rawFindings,
    survivors,
    suppressed,
    _meta: detector._meta,
    repoPath: repoRoot,
  });

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

/**
 * Format a mechanical report into the prompt body for the LLM bouncer.
 * Aggregates by (fromDomain, toDomain, ruleViolated) when >20 violations
 * to stay within token budget (decision 16).
 */
function formatViolationsForPrompt(report, intent) {
  const lines = [];
  if (intent.mermaid) {
    lines.push('## Intended boundaries (from architecture-intent.md)');
    lines.push('```mermaid');
    lines.push(intent.mermaid);
    lines.push('```');
    lines.push('');
  }
  lines.push(`## Mechanical Violations (${report.violations.length} total)`);
  if (report.violations.length > 20) {
    // Aggregate by (fromDomain, toDomain, ruleViolated)
    const clusters = new Map();
    for (const v of report.violations) {
      const key = `${v.fromDomain} → ${v.toDomain} (${v.ruleViolated})`;
      if (!clusters.has(key)) clusters.set(key, []);
      clusters.get(key).push(v);
    }
    for (const [key, vs] of clusters) {
      lines.push(`- **${key}**: ${vs.length} edges`);
      for (const v of vs.slice(0, 3)) {
        lines.push(`  - ${v.fromFile} → ${v.toFile}`);
      }
      if (vs.length > 3) lines.push(`  - ... and ${vs.length - 3} more`);
    }
  } else {
    for (const v of report.violations) {
      lines.push(`- ${v.fromDomain} → ${v.toDomain}: ${v.fromFile} → ${v.toFile}`);
    }
  }
  if (report.unmappedFiles.length > 0) {
    lines.push('');
    lines.push(`## Unmapped Files (${report.unmappedFiles.length})`);
    for (const f of report.unmappedFiles.slice(0, 30)) lines.push(`- ${f}`);
    if (report.unmappedFiles.length > 30) lines.push(`- ... and ${report.unmappedFiles.length - 30} more`);
  }
  if (report.deadIntent.length > 0) {
    lines.push('');
    lines.push(`## Dead Intent (${report.deadIntent.length})`);
    for (const d of report.deadIntent) lines.push(`- ${d}`);
  }
  if (report.perStackResults.some(r => r.status === 'error')) {
    lines.push('');
    lines.push('## Per-stack Analyzer Failures');
    for (const r of report.perStackResults.filter(r => r.status === 'error')) {
      lines.push(`- ${r.stackKind}: ${r.error?.message}`);
    }
  }
  return lines.join('\n');
}

/**
 * Deterministic fallback rubric (decision 11). Used when the LLM bouncer
 * fails — emits findings from the mechanical report alone. No HIGH severity
 * (cross-cutting detection requires LLM judgement).
 */
function deriveFindingsFromReport(report) {
  const findings = [];
  for (const v of report.violations) {
    findings.push({
      severity: 'MEDIUM',
      category: '[Architecture] Forbidden cross-domain edge',
      detail: `${v.fromFile} (${v.fromDomain}) imports ${v.toFile} (${v.toDomain}); not in allowedDeps[${v.fromDomain}].`,
      recommendation: `Either move one of the files to align with allowed deps OR explicitly update allowedDeps in .audit-loop/domain-map.json with rationale in architecture-intent.md.`,
      section: v.fromFile,
      affectedFiles: [v.fromFile, v.toFile],
      affectedPrinciples: ['#5 SSoT'],
      is_quick_fix: false,
      is_mechanical: true,
      principle: '#5 SSoT',
    });
  }
  for (const f of report.unmappedFiles) {
    if (!f.startsWith('src/') && !f.startsWith('scripts/')) continue; // heuristic
    findings.push({
      severity: 'LOW',
      category: '[Architecture] File missing domain rule',
      detail: `${f} is not matched by any rule in .audit-loop/domain-map.json.`,
      recommendation: 'Add a rule for this path so its dependencies can be evaluated.',
      section: f,
      affectedFiles: [f],
      affectedPrinciples: ['#5 SSoT'],
      is_quick_fix: true,
      is_mechanical: true,
      principle: '#5 SSoT',
    });
  }
  for (const d of report.deadIntent) {
    findings.push({
      severity: 'LOW',
      category: '[Architecture] Dead declared domain',
      detail: `Domain "${d}" is declared in domain-map.json but no files match.`,
      recommendation: 'Either remove the unused domain from the spec, or add files that will live in it.',
      section: '.audit-loop/domain-map.json',
      affectedFiles: ['.audit-loop/domain-map.json'],
      affectedPrinciples: ['#5 SSoT'],
      is_quick_fix: true,
      is_mechanical: true,
      principle: '#5 SSoT',
    });
  }
  for (const r of report.perStackResults.filter(r => r.status === 'error')) {
    findings.push({
      severity: 'MEDIUM',
      category: `[Architecture] Stack analyzer failure (${r.stackKind})`,
      detail: r.error?.message ?? 'unknown error',
      recommendation: `Check that the ${r.stackKind} adapter dependencies are installed and the repo is in a parsable state.`,
      section: r.stackKind,
      affectedFiles: [],
      affectedPrinciples: ['#15 Error Handling'],
      is_quick_fix: false,
      is_mechanical: true,
      principle: '#15 Error Handling',
    });
  }
  return findings;
}

async function runMultiPassCodeAudit(openai, planContent, projectContext, jsonMode, outFile, historyContext = '', { passFilter = null, fileFilter = null, round = 1, ledgerFile = null, diffFile = null, changedFiles = [], repoProfile = null, bandit = null, fpTracker = null, noLedger = false, noTools = false, strictLint = false, noDebtLedger = false, readOnlyDebt = false, debtLedgerPath = undefined, debtEventsPath = undefined, escalateRecurring = null, sessionCacheHit = null, scopeMode = null, planFile = null } = {}) {
  const totalStart = Date.now();

  // Initialize pass result cache — survives merge crashes
  initResultCache(outFile);

  // Count diff lines for metadata (lines starting with + or - but not +++ / ---)
  let diffLinesChanged = null;
  let diffFilesChanged = null;
  if (diffFile) {
    try {
      const diffContent = fs.readFileSync(diffFile, 'utf-8');
      const lines = diffContent.split('\n');
      diffLinesChanged = lines.filter(l => (l.startsWith('+') || l.startsWith('-')) && !l.startsWith('+++') && !l.startsWith('---')).length;
      diffFilesChanged = (diffContent.match(/^diff --git/mg) || []).length || changedFiles.length;
    } catch { /* diff file unreadable — skip */ }
  }
  if (diffFilesChanged == null && changedFiles.length > 0) diffFilesChanged = changedFiles.length;

  // Track which passes trigger map-reduce
  const mapReducePasses = [];
  const EMPTY_FINDINGS = { pass_name: 'empty', findings: [], quick_fix_warnings: [], summary: 'Pass skipped or failed.' };
  const EMPTY_STRUCTURE = { pass_name: 'structure', files_planned: 0, files_found: 0, files_missing: 0, missing_files: [], export_mismatches: [], findings: [], summary: 'Pass skipped.' };
  const EMPTY_WIRING = { pass_name: 'wiring', wiring_issues: [], findings: [], summary: 'Pass skipped.' };
  const EMPTY_SUSTAIN = { pass_name: 'sustainability', findings: [], dead_code: [], quick_fix_warnings: [], summary: 'Pass skipped.' };

  // 1. Gather and classify files
  const { found, missing, allPaths } = extractPlanPaths(planContent);
  // Build LanguageContext from RAW found files BEFORE category-based classification.
  // classifyFiles() has JS-centric patterns (lacks Python test/frontend detection),
  // so Python files may end up in "backend" bucket silently — but langContext
  // must see them all for dependency resolution + package-root detection.
  const langContext = buildLanguageContext(found);
  if (langContext.pythonPackageRoots.length > 1) {
    process.stderr.write(`  [lang] Python package roots: ${langContext.pythonPackageRoots.join(', ')}\n`);
  }
  const { backend, frontend, shared } = classifyFiles(found);

  // Record audit start in cloud store (fire-and-forget)
  let cloudRunId = null;
  let cloudRepoId = null;
  if (isCloudEnabled() && repoProfile) {
    cloudRepoId = await upsertRepo(repoProfile, path.basename(path.resolve('.'))).catch(() => null);
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
        const inferredSkill = /plan[-_]?frontend|\bfrontend\b|\bui\b/i.test(planFile)
          ? 'plan-frontend'
          : /plan[-_]?backend|\bbackend\b|\bapi\b/i.test(planFile)
            ? 'plan-backend'
            : 'manual';
        planId = await upsertPlan(cloudRepoId, {
          path: planFile,
          skill: inferredSkill,
          status: 'in_progress',
          commitSha,
        }).catch(() => null);
      }

      cloudRunId = await recordRunStart(cloudRepoId, planFile || 'ad-hoc', 'code', {
        scopeMode, commitSha, branch, planId,
      }).catch(() => null);

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
        // Best-effort.  These calls return { ok, error? } — never throw.
        recordDiffComplexity(cloudRunId, diffComplexity).catch(() => {});

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

  // ── Phase D: Debt Memory ─────────────────────────────────────────────────
  // Load persistent debt ledger so normal audits don't resurface known debt.
  // Runs every round (not just R2+) — debt is persistent across audit runs.
  const debtContext = selectEventSource({
    noDebtLedger,
    readOnly: readOnlyDebt,
    repoId: cloudRepoId,
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
  // Audit session ID for event-log attribution
  const debtRunId = `audit-${Date.now()}`;

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
      await appendEvents(debtContext, newlyEscalated, { eventsPath: debtEventsPath });
      process.stderr.write(`  [debt] escalated ${newlyEscalated.length} recurring entries (distinctRunCount >= ${escalateRecurring})\n`);
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

  if (isR2Plus) {
    process.stderr.write(`\n═══ R${round} MODE ═══\n`);

    // Preflight: validate ledger before relying on it for suppression
    const ledgerValidation = validateLedgerForR2(ledgerFile, round);
    if (!ledgerValidation.valid) suppressionUnavailable = true;

    // Load ledger
    if (ledgerFile) {
      try {
        ledger = JSON.parse(fs.readFileSync(path.resolve(ledgerFile), 'utf-8'));
        process.stderr.write(`  [ledger] Loaded ${ledger.entries?.length ?? 0} entries\n`);
      } catch (err) {
        process.stderr.write(`  [ledger] Failed: ${err.message} — proceeding without suppression\n`);
        ledger = { version: 1, entries: [] };
        suppressionUnavailable = true;
      }
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

  process.stderr.write(`\nMulti-pass code audit: ${found.length} files found, ${missing.length} missing, ${allPaths.size} referenced\n`);
  process.stderr.write(`  Backend: ${backend.length} files (${backendRoutes.length} routes, ${backendServices.length} services) + ${shared.length} shared\n`);
  process.stderr.write(`  Frontend: ${frontend.length} files + ${shared.length} shared\n`);
  if (splitBackend) process.stderr.write(`  Backend split: YES (>${BACKEND_SPLIT_THRESHOLD} files → separate route + service passes)\n`);

  // History context for round 2+ (prevents re-raising resolved findings)
  const historyBlock = historyContext ? `\n${historyContext}\n` : '';

  const fileListContext = `## Files Referenced in Plan (${found.length} found, ${missing.length} missing)\n\n`
    + (missing.length ? `**Missing:** ${missing.join(', ')}\n\n` : '')
    + `**Found:** ${found.join(', ')}\n`;

  // When --files is specified, scope quality passes to those files + their shared deps
  // This enables delta-only auditing on Round 2+
  const scopedBackend = fileFilter ? backend.filter(f => fileFilter.some(ff => f.includes(ff) || ff.includes(f))) : backend;
  const scopedFrontend = fileFilter ? frontend.filter(f => fileFilter.some(ff => f.includes(ff) || ff.includes(f))) : frontend;
  const scopedBackendRoutes = fileFilter ? backendRoutes.filter(f => fileFilter.some(ff => f.includes(ff) || ff.includes(f))) : backendRoutes;
  const scopedBackendServices = fileFilter ? backendServices.filter(f => fileFilter.some(ff => f.includes(ff) || ff.includes(f))) : backendServices;

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

  if (shouldRunPass('structure')) {
    const structureContextChars = baseContextChars + measureContextChars(found, 2000);
    const structureLimits = computePassLimits(structureContextChars, 'low');
    process.stderr.write(`\n── Wave 1: Structure + Wiring (parallel, reasoning: low) ──\n`);
    const structureFiles = readFilesAsContext(found, { maxPerFile: 2000, maxTotal: 30000 });
    wave1Promises.push(
      safeCallGPT(openai, {
        ...buildCachePrompt({
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

  if (shouldRunPass('wiring')) {
    const wiringFiles = found.filter(f => f.includes('/api/') || f.includes('/routes/'));
    const wiringContextChars = baseContextChars + measureContextChars(wiringFiles, 8000) + sharedContext.length;
    const wiringLimits = computePassLimits(wiringContextChars, 'low');
    const wiringCode = `${readFilesAsContext(wiringFiles, { maxPerFile: 8000, maxTotal: 60000 })}\n\n## Shared Files\n${sharedContext}`;
    wave1Promises.push(
      safeCallGPT(openai, {
        ...buildCachePrompt({
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
    const ledgerForOrphan = isR2Plus && ledgerFile && fs.existsSync(ledgerFile)
      ? (() => { try { return JSON.parse(fs.readFileSync(ledgerFile, 'utf-8')); } catch { return null; } })()
      : null;
    // Default: post-commit diff (HEAD~1 vs HEAD). This is the /cycle code workflow.
    // For working-tree audits, headRef=null routes through the resolver's working-tree
    // mode (Gemini-R3/H3 — tracked diff vs HEAD + untracked files).
    const orphanOut = await runOrphanIntroducedPass({
      archReport: archReportForOrphan,
      repoRoot: process.cwd(),
      baseRef: 'HEAD~1',
      headRef: 'HEAD',
      runId: debtRunId,
      planContent,
      ledger: ledgerForOrphan,
    });
    orphanState = orphanOut.state;
    orphanResult = orphanOut.result;
  } else {
    orphanState = 'SKIPPED_PASS_FILTER';
  }
  process.stderr.write(`  [orphan-introduced] ${orphanState} — ${orphanResult.result.findings.length} findings\n`);
  orphanResult._state = orphanState;
  cachePassResult('orphan-introduced', orphanResult);

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

  if (shouldRunPass('backend')) {
    if (splitBackend) {
      if (effectiveRoutes.length > 0) {
        backendPassNames.push('be-routes');
        if (shouldMapReduceHighReasoning(effectiveRoutes)) {
          mapReducePasses.push('be-routes');
          process.stderr.write(`  [be-routes] ${effectiveRoutes.length} files — using map-reduce\n`);
          wave2Promises.push(
            runMapReducePass(openai, effectiveRoutes, 'be-routes', (unit, i, total, unitLabel) => buildCachePrompt({
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
              ...buildCachePrompt({
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
            runMapReducePass(openai, effectiveServices, 'be-services', (unit, i, total, unitLabel) => buildCachePrompt({
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
              ...buildCachePrompt({
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
          runMapReducePass(openai, effectiveBackend, 'backend', (unit, i, total, unitLabel) => buildCachePrompt({
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
            ...buildCachePrompt({
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

  if (shouldRunPass('frontend') && effectiveFrontend.length > 0) {
    if (shouldMapReduceHighReasoning(effectiveFrontend)) {
      mapReducePasses.push('frontend');
      process.stderr.write(`  [frontend] ${effectiveFrontend.length} files — using map-reduce\n`);
      wave2Promises.push(
        runMapReducePass(openai, effectiveFrontend, 'frontend', (unit, i, total, unitLabel) => buildCachePrompt({
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
          ...buildCachePrompt({
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
  } else if (!shouldRunPass('frontend')) {
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
  if (shouldRunPass('sustainability')) {
    const sustainFiles = fileFilter ? found.filter(f => fileFilter.some(ff => f.includes(ff) || ff.includes(f))) : found;

    process.stderr.write(`\n── Wave 3: Sustainability (reasoning: medium) ──\n`);

    if (shouldMapReduce(sustainFiles)) {
      mapReducePasses.push('sustainability');
      process.stderr.write(`  [sustainability] ${sustainFiles.length} files — using map-reduce\n`);
      // Fix #3: Pass changedFileSet so unchanged map units skip retries
      const changedFileSet = changedFiles.length > 0 ? new Set(changedFiles.map(normalizePath)) : null;
      sustainResult = await runMapReducePass(openai, sustainFiles, 'sustainability', (unit, i, total, unitLabel) => buildCachePrompt({
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
        ...buildCachePrompt({
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
  if (shouldRunPass('quickfix')) {
    const qfFiles = fileFilter ? found.filter(f => fileFilter.some(ff => f.includes(ff) || ff.includes(f))) : found;
    process.stderr.write(`\n── Wave 4: Quickfix design-shortcuts (reasoning: low) ──\n`);
    const PASS_QUICKFIX_SYSTEM_LOCAL = getPassPrompt('quickfix');
    const qfRubric = PASS_QUICKFIX_SYSTEM_LOCAL;  // pass full prompt for low-reasoning consistency
    const qfContextChars = baseContextChars + measureContextChars(qfFiles, 4000);
    const qfLimits = computePassLimits(qfContextChars, 'low');
    process.stderr.write(`  ${qfFiles.length} files → ${qfLimits.maxTokens} tok / ${(qfLimits.timeoutMs/1000).toFixed(0)}s\n`);
    const qfCode = isR2Plus && diffMap ? readFilesAsAnnotatedContext(qfFiles, diffMap, { maxPerFile: 4000, maxTotal: 60000 }) : readFilesAsContext(qfFiles, { maxPerFile: 4000, maxTotal: 60000 });
    quickfixResult = await safeCallGPT(openai, {
      ...buildCachePrompt({
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

  // 5. Merge all pass results with semantic dedup
  const totalLatency = Date.now() - totalStart;
  const allResults = [structureResult, wiringResult, ...backendResults, frontendResult, sustainResult, quickfixResult, orphanResult];
  const failedPasses = allResults.filter(r => r.failed).map(r => r.error);

  process.stderr.write(`\n── Merge (${allResults.length} passes, ${failedPasses.length} failed) ──\n`);
  if (failedPasses.length > 0) {
    process.stderr.write(`  Failed passes: ${failedPasses.join('; ')}\n`);
  }

  // Cross-pass dedup: if two passes flag the same issue (>80% word overlap on
  // section+detail), keep the higher-severity one
  function tokenize(s) {
    return (s ?? '').toLowerCase().replaceAll(/[^a-z0-9\s]/g, '').split(/\s+/).filter(Boolean);
  }
  function wordOverlap(a, b) {
    const ta = new Set(tokenize(a));
    const tb = new Set(tokenize(b));
    const intersection = [...ta].filter(t => tb.has(t)).length;
    const union = new Set([...ta, ...tb]).size;
    return union === 0 ? 0 : intersection / union;
  }

  const allFindings = [];
  const seenHashes = new Set();
  const findingCounter = { HIGH: 0, MEDIUM: 0, LOW: 0 };
  let dedupCount = 0;
  const sevOrder = { HIGH: 0, MEDIUM: 1, LOW: 2 };

  function addFindings(findings, prefix) {
    // Sort by severity (HIGH first) before adding
    const sorted = [...(findings ?? [])].sort((a, b) => (sevOrder[a.severity] ?? 2) - (sevOrder[b.severity] ?? 2));
    for (const f of sorted) {
      const hash = semanticId(f);

      // Exact dedup by content hash
      if (seenHashes.has(hash)) { dedupCount++; continue; }

      // Fuzzy dedup: check if a substantially similar finding already exists
      const sig = `${f.section} ${f.detail}`;
      const isDupe = allFindings.some(existing => {
        const existSig = `${existing.section} ${existing.detail}`;
        return wordOverlap(sig, existSig) > 0.8;
      });
      if (isDupe) { dedupCount++; continue; }

      seenHashes.add(hash);
      findingCounter[f.severity]++;
      const num = findingCounter[f.severity];
      const letter = f.severity === 'HIGH' ? 'H' : f.severity === 'MEDIUM' ? 'M' : 'L';
      allFindings.push({
        ...f,
        id: `${letter}${num}`,
        _hash: hash,
        _pass: prefix,
        category: `[${prefix}] ${f.category}`
      });
    }
  }

  addFindings(structureResult?.result?.findings, 'Structure');
  addFindings(wiringResult?.result?.findings, 'Wiring');
  for (let i = 0; i < backendResults.length; i++) {
    addFindings(backendResults[i]?.result?.findings, backendPassNames[i] ?? 'Backend');
  }
  addFindings(frontendResult?.result?.findings, 'Frontend');
  addFindings(sustainResult?.result?.findings, 'Sustainability');
  // Orphan-introduced findings (dead-code phase 1) flow through the standard
  // dedup + suppression path. Mechanical pass — no LLM cost.
  addFindings(orphanResult?.result?.findings, 'Orphan');

  if (dedupCount > 0) {
    process.stderr.write(`  Deduped ${dedupCount} cross-pass duplicate(s)\n`);
  }

  // Phase C: append tool findings (already carry classification from linter.mjs).
  // Tool findings use file:rule:message identity via semanticId() dispatch, so they
  // coexist with model findings without content-hash collisions.
  if (toolFindings.length > 0) {
    let toolHigh = 0, toolMed = 0, toolLow = 0;
    for (const tf of toolFindings) {
      const hash = semanticId(tf);
      if (seenHashes.has(hash)) { dedupCount++; continue; }
      seenHashes.add(hash);
      findingCounter[tf.severity]++;
      if (tf.severity === 'HIGH') toolHigh++;
      else if (tf.severity === 'MEDIUM') toolMed++;
      else toolLow++;
      allFindings.push({
        ...tf,
        id: `T${findingCounter[tf.severity]}`, // T prefix = tool
        _hash: hash,
        _pass: 'tool',
      });
    }
    process.stderr.write(`  Added ${toolFindings.length} tool findings (H:${toolHigh} M:${toolMed} L:${toolLow})\n`);
  }

  // 5.4b Linter overlap tracking (Phase 0G) — compares tool vs GPT findings
  // Match by file + line proximity (G3 fix: both must have line numbers).
  const toolFindingsInResult = allFindings.filter(f => f._pass === 'tool');
  const gptFindingsInResult = allFindings.filter(f => f._pass !== 'tool');
  let linterOverlapCount = 0, linterOnlyCount = 0, gptOnlyCount = 0;

  if (toolFindingsInResult.length > 0) {
    const matchedGpt = new Set();
    for (const tf of toolFindingsInResult) {
      const [tFile, tLineStr] = (tf.section || '').split(':');
      const tLine = Number.parseInt(tLineStr, 10);
      let matched = false;
      for (const gf of gptFindingsInResult) {
        const gFile = gf._primaryFile || (gf.section || '').split(':')[0];
        if (normalizePath(tFile || '') !== normalizePath(gFile || '')) continue;
        const gLine = Number.parseInt((gf.section || '').split(':')[1], 10);
        if (isNaN(gLine) || isNaN(tLine)) continue; // G3 fix: both need line numbers
        if (Math.abs(gLine - tLine) <= 5) {
          matched = true;
          matchedGpt.add(gf._hash);
          break;
        }
      }
      if (matched) linterOverlapCount++;
      else linterOnlyCount++;
    }
    gptOnlyCount = gptFindingsInResult.filter(f => !matchedGpt.has(f._hash)).length;
    process.stderr.write(`  [linter-overlap] Tool: ${toolFindingsInResult.length} | GPT: ${gptFindingsInResult.length} | Overlap: ${linterOverlapCount} | Linter-only: ${linterOnlyCount} | GPT-only: ${gptOnlyCount}\n`);
  }

  // Stored in temp var because mergedResult is defined later (TDZ).
  var _linterOverlapData = { linterOverlapCount, linterOnlyCount, gptOnlyCount };

  // 5.5 Post-output suppression
  // Phase D: merge session ledger (R2+) with persistent debt ledger so debt
  // gets suppressed in every round, not just R2+. Suppression runs when
  // either ledger has entries.
  const sessionLedgerForSuppression = ledger || { version: 1, entries: [] };
  const debtLedgerForSuppression = debtLedger && debtLedger.entries.length > 0
    ? { version: 1, entries: debtLedger.entries }
    : { version: 1, entries: [] };
  const mergedLedger = mergeLedgersForSuppression(sessionLedgerForSuppression, debtLedgerForSuppression);

  if (mergedLedger.entries.length > 0) {
    // Enrich findings with structured metadata
    for (const f of allFindings) {
      populateFindingMetadata(f, f._pass);
    }

    let { kept, suppressed, reopened } = suppressReRaises(allFindings, mergedLedger, { changedFiles, impactSet });

    process.stderr.write(`\n═══════════════════════════════════════\n`);
    process.stderr.write(`  R${round} POST-PROCESSING\n`);
    process.stderr.write(`  Kept: ${kept.length} | Suppressed: ${suppressed.length} | Reopened: ${reopened.length}\n`);
    if (suppressed.length > 0) {
      for (const s of suppressed.slice(0, 5)) {
        process.stderr.write(`    [suppressed] ${s.matchedTopic.slice(0,8)} score=${s.matchScore.toFixed(2)}\n`);
      }
    }
    process.stderr.write(`═══════════════════════════════════════\n\n`);

    // Phase 4: FP tracker — suppress patterns with historically high dismiss rates
    let fpSuppressed = [];
    if (fpTracker) {
      const finalKept = [];
      for (const f of kept) {
        if (fpTracker.shouldSuppress(f)) {
          fpSuppressed.push(f);
          process.stderr.write(`    [fp-tracker] Auto-suppressed: ${f.category?.slice(0, 60)} (EMA < 0.15)\n`);
        } else {
          finalKept.push(f);
        }
      }
      if (fpSuppressed.length > 0) {
        process.stderr.write(`  [fp-tracker] Suppressed ${fpSuppressed.length} historically noisy findings\n`);
        kept = finalKept;
      }
    }

    // Replace findings with kept + reopened only
    allFindings.length = 0;
    allFindings.push(...kept, ...reopened);

    // Populate _suppression — full arrays for recordSuppressionEvents() + summary counts
    // Stored in temp var because mergedResult is defined later (TDZ)
    var _suppressionData = {
      suppressed,   // Array of { finding, matchedTopic, matchScore, reason } objects
      reopened,     // Array of finding objects with _matchedTopic, _matchScore
      keptCount: kept.length,
      suppressedCount: suppressed.length,
      reopenedCount: reopened.length,
      fpSuppressedCount: fpSuppressed.length
    };

    // Phase D: emit debt events for matches against debt-ledger entries.
    // One 'surfaced' event per topicId per run (fix M1) — dedup via Set.
    const debtEvents = [];
    const surfacedTopics = new Map();  // topicId → matchCount
    for (const s of suppressed) {
      if (s.matchedSource !== 'debt') continue;
      surfacedTopics.set(s.matchedTopic, (surfacedTopics.get(s.matchedTopic) || 0) + 1);
    }
    const nowIso = new Date().toISOString();
    for (const [topicId, matchCount] of surfacedTopics) {
      debtEvents.push({ ts: nowIso, runId: debtRunId, topicId, event: 'surfaced', matchCount });
    }
    // Reopens: one 'reopened' event per topicId (not counted toward occurrences)
    const reopenedDebtTopics = new Set();
    for (const r of reopened) {
      const match = mergedLedger.entries.find(e => e.topicId === r._matchedTopic);
      if (match?.source === 'debt') reopenedDebtTopics.add(r._matchedTopic);
    }
    for (const topicId of reopenedDebtTopics) {
      debtEvents.push({ ts: nowIso, runId: debtRunId, topicId, event: 'reopened' });
    }
    if (debtEvents.length > 0 && debtContext.canWrite) {
      const r = await appendEvents(debtContext, debtEvents, { eventsPath: debtEventsPath });
      process.stderr.write(`  [debt] emitted ${r.written} event(s) to ${r.source} (${surfacedTopics.size} surfaced, ${reopenedDebtTopics.size} reopened)\n`);
    } else if (debtEvents.length > 0) {
      process.stderr.write(`  [debt] ${debtEvents.length} event(s) suppressed (read-only mode)\n`);
    }
    // Phase D.3 debt status card
    if (debtLedger.entries.length > 0) {
      const escalatedCount = debtLedger.entries.filter(e => e.escalated).length;
      const recurring3 = debtLedger.entries.filter(e => (e.distinctRunCount ?? 0) >= 3).length;
      // oldestEntryDays inline
      const now = Date.now();
      let oldestMs = now;
      for (const e of debtLedger.entries) {
        const t = Date.parse(e.deferredAt);
        if (Number.isFinite(t) && t < oldestMs) oldestMs = t;
      }
      const oldestDays = Math.floor(Math.max(0, now - oldestMs) / (24 * 60 * 60 * 1000));
      process.stderr.write(`\n═══════════════════════════════════════\n`);
      process.stderr.write(`  DEBT LEDGER: ${debtLedger.entries.length} entries | Suppressed this run: ${surfacedTopics.size}\n`);
      process.stderr.write(`  Recurring (≥3 runs): ${recurring3} | Escalated: ${escalatedCount}${newlyEscalated.length > 0 ? ` (+${newlyEscalated.length} this run)` : ''}\n`);
      if (debtLedger.entries.length >= 10) {
        // Top file only surfaces for larger ledgers (noise suppression per fix L3)
        const byFile = new Map();
        for (const e of debtLedger.entries) {
          const f = (e.affectedFiles || [])[0];
          if (f) byFile.set(f, (byFile.get(f) || 0) + 1);
        }
        const topFile = [...byFile.entries()].sort((a, b) => b[1] - a[1])[0];
        if (topFile) {
          process.stderr.write(`  Oldest: ${oldestDays}d | Top file: ${topFile[0]} (${topFile[1]} entries)\n`);
        } else {
          process.stderr.write(`  Oldest: ${oldestDays}d\n`);
        }
      } else {
        process.stderr.write(`  Oldest: ${oldestDays}d\n`);
      }
      process.stderr.write(`═══════════════════════════════════════\n\n`);
    }

    // Build suppression context envelope for downstream Gemini review (Phase D.4)
    // so the final-gate doesn't resurface what we already filtered.
    const debtSuppressionContext = [];
    for (const [topicId] of surfacedTopics) {
      const entry = debtLedger.entries.find(e => e.topicId === topicId);
      if (entry) {
        debtSuppressionContext.push({
          topicId,
          category: entry.category,
          section: entry.section,
          affectedFiles: entry.affectedFiles,
          deferredReason: entry.deferredReason,
        });
      }
    }

    // Stored in temp var because mergedResult is defined later (TDZ)
    var _debtMemoryData = {
      eventSource: debtContext.source,
      debtSuppressed: surfacedTopics.size,
      debtReopened: reopenedDebtTopics.size,
      debtEntriesLoaded: debtLedger.entries.length,
      newlyEscalated: newlyEscalated.length,
      // Phase D.4: transcript envelope for Gemini (capped to 50 topics to bound context)
      suppressionContext: debtSuppressionContext.slice(0, 50),
    };
  }

  // Auto-write ledger (default-on when ledgerFile resolved)
  if (ledgerFile && !noLedger) {
    try {
      const enriched = allFindings.map(f => {
        const copy = { ...f };
        populateFindingMetadata(copy, copy._pass);
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
        pass: f._pass,
        _hash: f._hash,
        semanticHash: f._hash,
        affectedFiles: f.affectedFiles || [f._primaryFile || ''],
        affectedPrinciples: f.principle ? [f.principle] : [],
        adjudicationOutcome: 'pending',
        remediationState: 'pending',
        round
      }));

      const { inserted, updated, total, rejected } = batchWriteLedger(ledgerFile, ledgerEntries);
      process.stderr.write(`  [ledger] Written to ${ledgerFile}: ${inserted} new, ${updated} updated, ${total} total\n`);
      if (rejected?.length > 0) {
        process.stderr.write(`  [ledger] ${rejected.length} entries REJECTED:\n`);
        for (const { entry, reason } of rejected.slice(0, 5)) {
          process.stderr.write(`    - ${entry.topicId || '(no topicId)'}: ${reason}\n`);
        }
        var _ledgerRejectedCount = rejected.length;
      }
    } catch (err) {
      process.stderr.write(`  [ledger] WRITE FAILED: ${err.message}\n`);
      var _ledgerWriteError = err.message;
    }
  }

  // Phase C: verdict counts exclude tool findings by default (advisory mode).
  // With --strict-lint, tool findings count in the verdict.
  const isToolFinding = (f) => {
    const k = f.classification?.sourceKind;
    return k === 'LINTER' || k === 'TYPE_CHECKER';
  };
  const countFor = strictLint ? allFindings : allFindings.filter(f => !isToolFinding(f));
  const high = countFor.filter(f => f.severity === 'HIGH').length;
  const medium = countFor.filter(f => f.severity === 'MEDIUM').length;
  const low = countFor.filter(f => f.severity === 'LOW').length;

  let verdict = 'PASS';
  if (high > 0) verdict = 'SIGNIFICANT_ISSUES';
  else if (medium > 2) verdict = 'NEEDS_FIXES';
  // Failed passes mean incomplete audit — don't report PASS with 0 findings if passes failed
  if (verdict === 'PASS' && failedPasses.length > 0) verdict = 'INCOMPLETE';

  // Fix #2: Partial MAP verdict downgrade. When any pass completed <66% of MAP
  // units, the verdict is unreliable — downgrade to INCOMPLETE regardless of findings.
  const minMapCompletion = Math.min(...allResults.map(r => r._mapCompletionRate ?? 1));
  if (minMapCompletion < 0.66 && verdict !== 'INCOMPLETE') {
    process.stderr.write(`  [verdict] Downgrading to INCOMPLETE — MAP completion ${(minMapCompletion * 100).toFixed(0)}% (need ≥66%)\n`);
    verdict = 'INCOMPLETE';
  }

  const totalUsage = {
    input_tokens: allResults.reduce((s, r) => s + (r.usage?.input_tokens ?? 0), 0),
    cached_tokens: allResults.reduce((s, r) => s + (r.usage?.cached_tokens ?? 0), 0),
    output_tokens: allResults.reduce((s, r) => s + (r.usage?.output_tokens ?? 0), 0),
    reasoning_tokens: allResults.reduce((s, r) => s + (r.usage?.reasoning_tokens ?? 0), 0),
    latency_ms: totalLatency
  };

  // ── Cache telemetry (PR-4) ───────────────────────────────────────────
  // Aggregate prompt-prefix-cache hit metrics across all audit-pass calls.
  // hitRate guard: 0/0 → 0 (per Gemini R2 review of plan).
  // Per-pass entries keyed by passName; map-reduce sub-units use their
  // map-<passName>-<i> keys (kept distinct for diagnostic per-unit visibility,
  // per plan §2 telemetry contract).
  const cacheMetrics = {
    totalInputTokens: totalUsage.input_tokens,
    totalCachedTokens: totalUsage.cached_tokens,
    hitRate: totalUsage.input_tokens > 0
      ? totalUsage.cached_tokens / totalUsage.input_tokens : 0,
    estimatedSavingsPct: 0,
    perPass: {},
  };
  cacheMetrics.estimatedSavingsPct = cacheMetrics.hitRate * 0.5; // OpenAI ~50% discount
  // Build perPass entries via parallel arrays — passName isn't carried on the
  // result objects, but the order in `allResults` matches a known sequence.
  const passNameOrder = ['structure', 'wiring', ...backendPassNames, 'frontend', 'sustainability', 'quickfix'];
  for (let i = 0; i < allResults.length && i < passNameOrder.length; i++) {
    const pass = passNameOrder[i];
    const r = allResults[i];
    const entry = { totalInputTokens: 0, totalCachedTokens: 0, hitRate: 0, callCount: 0, retryCount: 0 };
    entry.totalInputTokens = r.usage?.input_tokens ?? 0;
    entry.totalCachedTokens = r.usage?.cached_tokens ?? 0;
    entry.callCount = 1;
    entry.retryCount = r._retried ? (r._attempts ?? 2) - 1 : 0;
    entry.hitRate = entry.totalInputTokens > 0
      ? entry.totalCachedTokens / entry.totalInputTokens : 0;
    cacheMetrics.perPass[pass] = entry;
  }
  process.stderr.write(`  [cache] input=${cacheMetrics.totalInputTokens} cached=${cacheMetrics.totalCachedTokens} hitRate=${(cacheMetrics.hitRate * 100).toFixed(1)}% (~${(cacheMetrics.estimatedSavingsPct * 100).toFixed(1)}% savings)\n`);

  // Build per-pass timing map
  const passTimings = {};
  passTimings.structure = `${(structureResult.latencyMs / 1000).toFixed(1)}s`;
  passTimings.wiring = `${(wiringResult.latencyMs / 1000).toFixed(1)}s`;
  for (let i = 0; i < backendResults.length; i++) {
    passTimings[backendPassNames[i] ?? `backend_${i}`] = `${(backendResults[i].latencyMs / 1000).toFixed(1)}s`;
  }
  passTimings.frontend = `${(frontendResult.latencyMs / 1000).toFixed(1)}s`;
  passTimings.sustainability = `${(sustainResult.latencyMs / 1000).toFixed(1)}s`;
  passTimings.quickfix = `${(quickfixResult.latencyMs / 1000).toFixed(1)}s`;
  passTimings.total = `${(totalLatency / 1000).toFixed(1)}s`;

  // Build overall reasoning from pass summaries
  const summaryLines = [
    `**Structure**: ${structureResult.result.summary ?? 'N/A'}`,
    `**Wiring**: ${wiringResult.result.summary ?? 'N/A'}`
  ];
  for (let i = 0; i < backendResults.length; i++) {
    summaryLines.push(`**${backendPassNames[i] ?? 'Backend'}**: ${backendResults[i].result.summary ?? 'N/A'}`);
  }
  summaryLines.push(`**Frontend**: ${frontendResult.result.summary ?? 'N/A'}`);
  summaryLines.push(`**Sustainability**: ${sustainResult.result.summary ?? 'N/A'}`);
  if (failedPasses.length > 0) {
    summaryLines.push(`\n**WARNING**: ${failedPasses.length} pass(es) failed — findings may be incomplete.`);
  }

  const mergedResult = {
    verdict,
    files_planned: structureResult.result.files_planned ?? allPaths.size,
    files_found: structureResult.result.files_found ?? found.length,
    files_missing: structureResult.result.files_missing ?? missing.length,
    code_files: found,
    findings: allFindings,
    wiring_issues: wiringResult.result.wiring_issues ?? [],
    quick_fix_warnings: [
      ...backendResults.flatMap(r => r.result.quick_fix_warnings ?? []),
      ...(frontendResult.result.quick_fix_warnings ?? []),
      ...(sustainResult.result.quick_fix_warnings ?? [])
    ],
    dead_code: sustainResult.result.dead_code ?? [],
    overall_reasoning: summaryLines.join('\n'),
    _pass_timings: passTimings,
    _failed_passes: failedPasses.length > 0 ? failedPasses : undefined,
    _usage: totalUsage,
    _cacheMetrics: cacheMetrics,
    _executionMeta: suppressionUnavailable ? { suppressionUnavailable: true } : undefined,
  };

  // Attach data accumulated before mergedResult was defined (var hoisting avoids TDZ)
  if (typeof _suppressionData !== 'undefined') {
    mergedResult._suppression = _suppressionData;
  }
  if (typeof _debtMemoryData !== 'undefined') {
    mergedResult._debtMemory = _debtMemoryData;
  }
  if (typeof _ledgerRejectedCount !== 'undefined') {
    mergedResult._ledgerRejectedCount = _ledgerRejectedCount;
  }
  if (typeof _ledgerWriteError !== 'undefined') {
    mergedResult._ledgerWriteError = _ledgerWriteError;
  }
  if (typeof _linterOverlapData !== 'undefined') {
    mergedResult._linterOverlap = _linterOverlapData;
  }

  // Phase 3-4: Record initial findings for learning (pre-triage — accepted is null).
  // Actual triage outcomes are written by outcome-sync.mjs AFTER deliberation.
  for (const f of allFindings) {
    const revId = getActiveRevisionId(f._pass) || 'default';
    appendOutcome('.audit/outcomes.jsonl', {
      findingId: f.id,
      severity: f.severity,
      category: f.category,
      section: f.section,
      primaryFile: f._primaryFile || f.section,
      affectedFiles: f.affectedFiles || [],
      pass: f._pass,
      accepted: null, // Pre-triage: outcome-sync writes actual result after deliberation
      round,
      promptVariant: revId,
      promptRevisionId: revId,
      semanticHash: f._hash,
    });
  }

  // Phase 3: Cloud store — record findings + pass stats (fire-and-forget)
  if (cloudRunId) {
    recordFindings(cloudRunId, allFindings, 'merged', round).catch(e => process.stderr.write(`  [learning] ${e.message}\n`));

    // Record per-pass stats
    const passResults = [
      { name: 'structure', result: structureResult },
      { name: 'wiring', result: wiringResult },
      ...backendResults.map((r, i) => ({ name: backendPassNames[i] ?? 'backend', result: r })),
      { name: 'frontend', result: frontendResult },
      { name: 'sustainability', result: sustainResult },
      { name: 'quickfix', result: quickfixResult }
    ];
    for (const pr of passResults) {
      const findings = pr.result?.result?.findings ?? [];
      recordPassStats(cloudRunId, pr.name, {
        raised: findings.length,
        accepted: 0, // Updated after deliberation
        dismissed: 0,
        compromised: 0,
        inputTokens: pr.result?.usage?.input_tokens,
        outputTokens: pr.result?.usage?.output_tokens,
        latencyMs: pr.result?.latencyMs,
        reasoning: pr.name === 'sustainability' ? 'medium' : pr.name === 'quickfix' ? 'low' : 'high'
      }).catch(e => process.stderr.write(`  [learning] ${e.message}\n`));
    }

    // Record suppression events if R2+
    if (isR2Plus && mergedResult._suppression) {
      recordSuppressionEvents(cloudRunId, mergedResult._suppression).catch(e => process.stderr.write(`  [learning] ${e.message}\n`));
    }
  }

  // Attach cloud run ID to result for orchestrator reference
  if (cloudRunId) mergedResult._cloudRunId = cloudRunId;

  // Phase C: surface tool-pre-pass capability state
  mergedResult._toolCapability = toolCapability;

  // Phase 5: Flush bandit state + sync learning systems to cloud
  if (bandit) {
    bandit.flush();
    syncBanditArms(bandit.arms).catch(e => process.stderr.write(`  [learning] ${e.message}\n`));
  }
  if (fpTracker) {
    syncFalsePositivePatterns(null, fpTracker.patterns).catch(e => process.stderr.write(`  [learning] ${e.message}\n`));
  }

  // Phase 3 — adaptive-learning convergence_predict telemetry.  Emit ONE
  // decision per round capturing this round's findings + delta vs prior
  // round.  outcome=null at emit time; backfilled at run-end below with
  // {converged_at, hit_max, hit_rigor_pressure} once the next round (or
  // stop signal) is known.  Best-effort; never throws into audit pipeline.
  if (cloudRunId) {
    try {
      const highCount   = allFindings.filter(f => f.severity === 'HIGH').length;
      const mediumCount = allFindings.filter(f => f.severity === 'MEDIUM').length;
      const dismissed   = allFindings.filter(f => f.adjudicationOutcome === 'dismissed').length;
      _learningRecordDecision({
        decisionType: 'convergence_predict',
        repoId: cloudRepoId,
        auditRunId: cloudRunId,
        round: round || 1,
        sequence: 0,
        context: {
          round: round || 1,
          highCount,
          mediumCount,
          dismissed,
          totalFindings: allFindings.length,
          // deltaPattern is filled by the reconciler comparing to prior rounds.
        },
        choice: { chose: 'continue' }, // telemetry-only in v1: never stop
        outcome: null,
      });
    } catch { /* validation failure — best-effort telemetry */ }
  }

  // Phase 5b: Finalise cloud run record with counts + run metadata
  if (cloudRunId) {
    recordRunComplete(cloudRunId, {
      rounds: round,
      totalFindings: allFindings.length,
      accepted: allFindings.filter(f => f.adjudicationOutcome === 'accepted').length,
      dismissed: allFindings.filter(f => f.adjudicationOutcome === 'dismissed').length,
      fixed: allFindings.filter(f => f.remediationState === 'fixed').length,
      geminiVerdict: null, // updated by gemini-review after Step 7
      durationMs: totalLatency,
      diffLinesChanged,
      diffFilesChanged,
      sessionCacheHit,
      mapReducePasses: mapReducePasses.length > 0 ? mapReducePasses : null,
      // Cache telemetry (migration 20260511120000_audit_runs_cache_metrics)
      cacheInputTokens: cacheMetrics?.totalInputTokens ?? null,
      cacheCachedTokens: cacheMetrics?.totalCachedTokens ?? null,
      cacheHitRate: cacheMetrics?.hitRate ?? null,
      cacheEstimatedSavingsPct: cacheMetrics?.estimatedSavingsPct ?? null,
    }).catch(e => process.stderr.write(`  [learning] recordRunComplete: ${e.message}\n`));

    // Phase 1 — adaptive-learning-v1.  Backfill the pass_selection decision
    // outcome with kept/dismissed counts and flush all queued telemetry to
    // the cloud (or outbox on failure).  Best-effort.
    try {
      const decisionKey = _learningBuildKey({
        decisionType: 'pass_selection',
        auditRunId: cloudRunId,
        round: round || 1,
        sequence: 0,
      });
      await backfillLearningOutcome({
        decisionKey,
        outcome: {
          totalFindings: allFindings.length,
          highKept: allFindings.filter(f => f.severity === 'HIGH' && f.adjudicationOutcome !== 'dismissed').length,
          mediumKept: allFindings.filter(f => f.severity === 'MEDIUM' && f.adjudicationOutcome !== 'dismissed').length,
          dismissed: allFindings.filter(f => f.adjudicationOutcome === 'dismissed').length,
          durationMs: totalLatency,
        },
      }).catch(() => {});
      const flushSummary = await _learningFlush({
        store: { insertLearningDecision, backfillLearningOutcome, isCloudEnabled },
      });
      if (flushSummary && (flushSummary.dropped > 0 || flushSummary.outboxed > 0 || flushSummary.lostInCI > 0)) {
        process.stderr.write(
          `  [learning] flush: ${flushSummary.flushed} ok, ${flushSummary.outboxed} outbox, ${flushSummary.dropped} dropped, ${flushSummary.lostInCI} CI-lost\n`
        );
      }
    } catch { /* best-effort telemetry */ }
  }

  // P0-B: Session manifest + meta (written by openai-audit.mjs, not audit-loop.mjs)
  // debtRunId is the stable SID for this session (audit-<timestamp>).
  const sid = debtRunId;
  mergedResult._sid = sid;

  // Always increment runsSinceDebtReview in the stable session ledger
  try {
    fs.mkdirSync(path.resolve(AUDIT_DIR), { recursive: true });
    const sessionLedgerPath = path.resolve(AUDIT_DIR, SESSION_LEDGER_FILE);
    let currentRuns = 0;
    try {
      const sessionData = JSON.parse(fs.readFileSync(sessionLedgerPath, 'utf-8'));
      currentRuns = sessionData?.meta?.runsSinceDebtReview ?? 0;
    } catch { /* file absent or unreadable — start from 0 */ }
    batchWriteLedger(sessionLedgerPath, [], {
      meta: { runsSinceDebtReview: currentRuns + 1 },
      targetMetaPath: sessionLedgerPath,
    });
  } catch (err) {
    process.stderr.write(`  [session] meta update failed (non-blocking): ${err.message}\n`);
  }

  // Write SID-scoped session manifest so R2 can resolve the ledger path
  if (round === 1 && ledgerFile) {
    try {
      const manifestPath = path.resolve(AUDIT_DIR, `${SESSION_MANIFEST_PREFIX}${sid}.json`);
      const manifest = {
        sid,
        ledgerPath: ledgerFile,
        startedAt: new Date().toISOString(),
        round: 1,
      };
      fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
      process.stderr.write(`  [session] manifest written: ${manifestPath}\n`);
    } catch (err) {
      process.stderr.write(`  [session] manifest write failed (non-blocking): ${err.message}\n`);
    }
  }

  // Persist cache metrics to a stable append-only log (.audit/cache-metrics.jsonl)
  // so future analysis (`npm run cache:check`) can correlate hit rates over
  // time without depending on Temp-dir result files (which Windows cleans).
  // Every round emits one line — analysis filters by round >= 2 since cold-start
  // R1 always reports 0%.
  try {
    const cacheMetrics = mergedResult._cacheMetrics;
    if (cacheMetrics) {
      const logPath = path.resolve(AUDIT_DIR, 'cache-metrics.jsonl');
      const entry = {
        sid,
        round,
        startedAt: new Date().toISOString(),
        mode,
        plan: planFile ? path.basename(planFile) : null,
        totalInputTokens: cacheMetrics.totalInputTokens,
        totalCachedTokens: cacheMetrics.totalCachedTokens,
        hitRate: cacheMetrics.hitRate,
        estimatedSavingsPct: cacheMetrics.estimatedSavingsPct,
        perPassCount: Object.keys(cacheMetrics.perPass).length,
      };
      fs.appendFileSync(logPath, JSON.stringify(entry) + '\n', 'utf8');
    }
  } catch (err) {
    process.stderr.write(`  [cache] log append failed (non-blocking): ${err.message}\n`);
  }

  // 6. Output
  if (outFile) {
    const summaryLine = `Verdict: ${verdict} | H:${high} M:${medium} L:${low} | ${(totalLatency / 1000).toFixed(0)}s`;
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

    console.log('\n## Pass Summaries\n');
    console.log(mergedResult.overall_reasoning);
  }

  // Phase 7 readiness nudge (every 10 runs)
  try {
    const outcomes = loadOutcomes('.audit/outcomes.jsonl');
    const runCount = new Set(outcomes.map(o => Math.floor(o.timestamp / 300000))).size;
    if (runCount > 0 && runCount % 10 === 0 && runCount < 50) {
      process.stderr.write(`\n  [phase-7] ${runCount}/50 audit runs completed — ${50 - runCount} more for predictive strategy\n`);
    } else if (runCount >= 50) {
      process.stderr.write(`\n  [phase-7] ✓ ${runCount} runs — Phase 7 (predictive strategy) is ready to implement!\n`);
    }
  } catch { /* ignore */ }

  // Clean up pass result cache on successful completion.
  // On crash, the cache survives in the --out dir for manual recovery.
  cleanupCache();
}

// resolveLedgerPath imported from lib/robustness.mjs

// ── Main ───────────────────────────────────────────────────────────────────────

async function main() {
  // Live-catalog refresh: populate session cache so providers' newest models
  // are visible to resolveModel(). Module-load resolution (config.mjs) used
  // STATIC_POOL only — the warning below surfaces drift so operators can
  // restart with the env var pointing at the live newest. Set
  // MODEL_CATALOG_REFRESH=skip in air-gapped CI / when API quota is scarce.
  if (process.env.MODEL_CATALOG_REFRESH !== 'skip') {
    try { await refreshModelCatalog(); } catch { /* silent — falls back to static */ }
    try {
      const liveResolution = resolveModel(process.env.OPENAI_AUDIT_MODEL || 'latest-gpt', { silent: true });
      if (liveResolution !== MODEL) {
        process.stderr.write(
          `  [startup] Live catalog suggests "${liveResolution}" but session uses "${MODEL}" ` +
          '(resolved at module load before refresh). Restart to apply the newer model.\n'
        );
      }
    } catch { /* ignore — never block audit on resolver introspection */ }
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

  // --ledger <file>: adjudication ledger — single canonical read+write path
  const ledgerIdx = args.indexOf('--ledger');
  const ledgerFileArg = ledgerIdx !== -1 && args[ledgerIdx + 1] ? args[ledgerIdx + 1] : null;
  const noLedger = args.includes('--no-ledger');

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

  // --base <ref>: git ref to diff against for --scope diff (default: HEAD~1)
  const baseIdx = args.indexOf('--base');
  const diffBase = baseIdx !== -1 && args[baseIdx + 1] ? args[baseIdx + 1] : 'HEAD~1';

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
    console.error('         --scope diff (default): auto-scope to git-changed files (vs HEAD~1)');
    console.error('         --scope plan          : audit all plan-referenced files');
    console.error('         --scope full          : audit entire repo (slowest, most comprehensive)');
    console.error('       node scripts/openai-audit.mjs code <plan-file> --round 2 --ledger <ledger.json> --diff <diff.patch> --changed <file1,file2>');
    console.error('       node scripts/openai-audit.mjs rebuttal <plan-file> <rebuttal-file> [--json] [--out <file>]');
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
  const bandit = new PromptBandit();
  const fpTracker = new FalsePositiveTracker();

  const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

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
          .filter(f => !isAuditInfraFile(f));
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
    await runMultiPassCodeAudit(openai, planContent, projectContext, jsonMode, outFile, historyContext, { passFilter, fileFilter: effectiveFileFilter, round, ledgerFile: ledgerPath, diffFile, changedFiles, repoProfile, bandit, fpTracker, noLedger, noTools, strictLint, noDebtLedger, readOnlyDebt, debtLedgerPath, debtEventsPath, escalateRecurring, sessionCacheHit: cacheHit, scopeMode, planFile });
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

    // R2+ rulings injection for plan mode
    let rulingsBlock = '';
    if (round >= 2 && ledgerPath) {
      rulingsBlock = buildRulingsBlock(ledgerPath, 'plan');
      if (rulingsBlock) {
        rulingsBlock = `\n\n${rulingsBlock}`;
        process.stderr.write(`  [plan-r2] Injected ${rulingsBlock.split('\n').length} rulings from ledger\n`);
      }
    }

    const r2Modifier = round >= 2 ? `\n\n${R2_ROUND_MODIFIER}` : '';

    systemPrompt = PLAN_AUDIT_SYSTEM + r2Modifier;
    schema = PlanAuditResultSchema;
    schemaName = 'plan_audit_result';
    userPrompt = `## Project Context\n${planContext}${depsBlock}${rulingsBlock}\n\n${historyContext ? `---\n\n${historyContext}\n` : ''}---\n\n## Plan to Audit\n${planContent}`;
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
  ? { _callGPTOnce, callGPT, safeCallGPT, normalisePromptInput }
  : undefined;

// CLI entry — only fire main() when this module is executed directly,
// not when imported (e.g. by tests). Uses node:url pathToFileURL for
// cross-platform robustness.
import { pathToFileURL } from 'node:url';
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
