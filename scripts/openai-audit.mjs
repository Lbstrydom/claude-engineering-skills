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

import 'dotenv/config';  // Auto-load .env — no manual export needed
import fs from 'node:fs';
import path from 'node:path';
import OpenAI from 'openai';
import { z } from 'zod';
import { zodTextFormat } from 'openai/helpers/zod';
import { FindingSchema, WiringIssueSchema, LedgerEntrySchema } from './lib/schemas.mjs';
import {
  safeInt, readFileOrDie, readFilesAsContext, readFilesAsAnnotatedContext,
  writeOutput, normalizePath, parseDiffFile, extractPlanPaths, classifyFiles
} from './lib/file-io.mjs';
import {
  generateTopicId, populateFindingMetadata, jaccardSimilarity,
  suppressReRaises, buildRulingsBlock, R2_ROUND_MODIFIER, buildR2SystemPrompt,
  computeImpactSet
} from './lib/ledger.mjs';
import {
  estimateTokens, chunkLargeFile, extractExportsOnly, buildAuditUnits,
  buildDependencyGraph, REDUCE_SYSTEM_PROMPT, measureContextChars
} from './lib/code-analysis.mjs';
import { semanticId, formatFindings, appendOutcome, loadOutcomes, FalsePositiveTracker } from './lib/findings.mjs';
import {
  generateRepoProfile, initAuditBrief, readProjectContext, readProjectContextForPass,
  extractPlanForPass, buildHistoryContext
} from './lib/context.mjs';
import { initLearningStore, isCloudEnabled, upsertRepo, recordRunStart, recordRunComplete, recordFindings, recordPassStats, recordSuppressionEvents, recordAdjudicationEvent, syncBanditArms, syncFalsePositivePatterns } from './learning-store.mjs';
import { PromptBandit, computeReward, buildContext } from './bandit.mjs';
import { openaiConfig, PASS_NAMES } from './lib/config.mjs';
import {
  PASS_PROMPTS,
  PASS_STRUCTURE_SYSTEM as SEED_STRUCTURE, PASS_WIRING_SYSTEM as SEED_WIRING,
  PASS_BACKEND_SYSTEM as SEED_BACKEND, PASS_BACKEND_RUBRIC,
  PASS_FRONTEND_SYSTEM as SEED_FRONTEND, PASS_FRONTEND_RUBRIC,
  PASS_SUSTAINABILITY_SYSTEM as SEED_SUSTAINABILITY, PASS_SUSTAINABILITY_RUBRIC
} from './lib/prompt-seeds.mjs';
import { getActivePrompt, getActiveRevisionId, bootstrapFromConstants } from './lib/prompt-registry.mjs';

// ── Configuration (from centralized config) ─────────────────────────────────

const MODEL = openaiConfig.model;
const REASONING_EFFORT = openaiConfig.reasoning;
const MAX_OUTPUT_TOKENS_CAP = openaiConfig.maxOutputTokensCap;
const TIMEOUT_MS_CAP = openaiConfig.timeoutMsCap;
const BACKEND_SPLIT_THRESHOLD = openaiConfig.backendSplitThreshold;
const MAP_REDUCE_THRESHOLD = openaiConfig.mapReduceThreshold;
const MAP_REDUCE_TOKEN_THRESHOLD = openaiConfig.mapReduceTokenThreshold;

/** Check if a file set should use map-reduce (by count OR total size). */
function shouldMapReduce(files) {
  if (files.length > MAP_REDUCE_THRESHOLD) return true;
  const totalChars = measureContextChars(files, 10000);
  return totalChars > MAP_REDUCE_TOKEN_THRESHOLD;
}

// ── Adaptive Sizing ────────────────────────────────────────────────────────────

/**
 * Compute per-pass token limits and timeouts based on actual file content size.
 * This makes the script portable across codebases — a 3-file project gets small
 * limits, a 30-file project gets large ones, all within hard ceilings.
 *
 * Heuristics (calibrated from live GPT-5.4 runs):
 *   - ~4 chars per token (input estimation)
 *   - reasoning: high uses ~40-60% of output tokens for thinking
 *   - GPT-5.4 generates ~150-250 tokens/sec depending on reasoning effort
 *   - Each finding in the schema is ~200-400 output tokens
 *
 * @param {number} contextChars - Total chars being sent as user prompt
 * @param {string} reasoning - 'low' | 'medium' | 'high'
 * @returns {{ maxTokens: number, timeoutMs: number }}
 */
function computePassLimits(contextChars, reasoning = 'high') {
  const estimatedInputTokens = Math.ceil(contextChars / 4);

  // Reasoning multiplier: high reasoning needs more output tokens for thinking
  const reasoningMultiplier = reasoning === 'high' ? 0.4 : reasoning === 'medium' ? 0.25 : 0.1;

  // Output tokens: base for findings + proportional to input size for reasoning
  // High reasoning needs a higher base because ~60% of tokens go to internal thinking
  // Minimum: low=4000, medium=6000, high=10000
  const baseOutputTokens = reasoning === 'high' ? 10000 : reasoning === 'medium' ? 6000 : 4000;
  const reasoningOverhead = Math.ceil(estimatedInputTokens * reasoningMultiplier);
  const maxTokens = Math.min(
    MAX_OUTPUT_TOKENS_CAP,
    baseOutputTokens + reasoningOverhead
  );

  // Timeout: based on expected generation speed + reasoning overhead
  // GPT-5.4 with reasoning: high spends 90-150s thinking BEFORE output starts
  // low: ~250 tok/s, medium: ~150 tok/s, high: ~100 tok/s (conservative — includes reasoning pauses)
  const tokensPerSec = reasoning === 'high' ? 100 : reasoning === 'medium' ? 150 : 250;
  const estimatedGenerationSec = maxTokens / tokensPerSec;
  // Reasoning think-time floor: high=150s, medium=60s, low=30s (before output starts)
  // Calibrated from real audit runs: 15K token input + high reasoning routinely takes 200s+
  const reasoningFloorSec = reasoning === 'high' ? 150 : reasoning === 'medium' ? 60 : 30;
  const minTimeoutMs = (reasoningFloorSec + 60) * 1000; // floor + generous network buffer
  const timeoutMs = Math.min(
    TIMEOUT_MS_CAP,
    Math.max(minTimeoutMs, Math.ceil((estimatedGenerationSec + reasoningFloorSec) * 1000))
  );

  return { maxTokens, timeoutMs };
}

// ── Schemas (FindingSchema imported from shared.mjs) ─────────────────────────

// ── Plan Audit Schema ──────────────────────────────────────────────────────────

const PlanAuditResultSchema = z.object({
  verdict: z.enum(['READY_TO_IMPLEMENT', 'NEEDS_REVISION', 'SIGNIFICANT_GAPS']),
  structural_completeness: z.string().max(100).describe('e.g. "8/10 sections present"'),
  principle_coverage_pct: z.number().min(0).max(100),
  specificity: z.enum(['High', 'Medium', 'Low']),
  sustainability: z.enum(['Strong', 'Adequate', 'Weak', 'Missing']),
  findings: z.array(FindingSchema).max(25),
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
  findings: z.array(FindingSchema).max(15).describe('Top 15 findings, sorted by severity (HIGH first). Prefer fewer deep findings over many shallow ones.'),
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
  findings: z.array(FindingSchema).max(15),
  summary: z.string().max(500)
});

const WiringPassSchema = z.object({
  pass_name: z.literal('wiring'),
  wiring_issues: z.array(WiringIssueSchema).max(20),
  findings: z.array(FindingSchema).max(10),
  summary: z.string().max(500)
});

const SustainabilityPassSchema = z.object({
  pass_name: z.literal('sustainability'),
  findings: z.array(FindingSchema).max(15),
  dead_code: z.array(z.string().max(200)).max(20),
  quick_fix_warnings: z.array(z.string().max(300)).max(10),
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
- HIGH: Implementation will fail, produce bugs, or require significant rework
- MEDIUM: Implementation will work but quality/maintainability/UX will suffer
- LOW: Plan is functional but could be clearer or more thorough

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

// ── GPT API Call Helper ────────────────────────────────────────────────────────

/**
 * Make a single GPT-5.4 call with structured output.
 * @param {OpenAI} openai
 * @param {object} opts
 * @param {string} opts.systemPrompt
 * @param {string} opts.userPrompt
 * @param {z.ZodType} opts.schema
 * @param {string} opts.schemaName
 * @param {string} [opts.reasoning='high']
 * @param {number} [opts.maxTokens]
 * @param {number} [opts.timeoutMs]
 * @param {string} [opts.passName] - For logging
 * @returns {Promise<{result: object, usage: object, latencyMs: number}>}
 */
async function callGPT(openai, { systemPrompt, userPrompt, schema, schemaName, reasoning, maxTokens, timeoutMs, passName }) {
  const effort = reasoning ?? REASONING_EFFORT;
  const tokens = maxTokens ?? MAX_OUTPUT_TOKENS_CAP;
  const timeout = timeoutMs ?? TIMEOUT_MS_CAP;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  const startMs = Date.now();

  if (passName) {
    process.stderr.write(`  [${passName}] Starting (reasoning: ${effort}, timeout: ${(timeout / 1000).toFixed(0)}s)...\n`);
  }

  try {
    const requestParams = {
      model: MODEL,
      input: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt }
      ],
      text: { format: zodTextFormat(schema, schemaName) },
      max_output_tokens: tokens
    };

    if (MODEL.startsWith('gpt-5')) {
      requestParams.reasoning = { effort };
    }

    const response = await openai.responses.parse(requestParams, { signal: controller.signal });
    clearTimeout(timer);
    const latencyMs = Date.now() - startMs;

    if (response.status === 'incomplete') {
      throw new Error(`Response incomplete: ${response.incomplete_details?.reason ?? 'unknown'}`);
    }

    const result = response.output_parsed;
    if (!result) throw new Error('No parsed output from model');

    const usage = {
      input_tokens: response.usage?.input_tokens ?? 0,
      output_tokens: response.usage?.output_tokens ?? 0,
      reasoning_tokens: response.usage?.output_tokens_details?.reasoning_tokens ?? 0,
      latency_ms: latencyMs
    };

    if (passName) {
      process.stderr.write(`  [${passName}] Done in ${(latencyMs / 1000).toFixed(1)}s (${usage.input_tokens} in / ${usage.output_tokens} out)\n`);
    }

    return { result, usage, latencyMs };

  } catch (err) {
    clearTimeout(timer);
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
 * Wrapper that catches pass failures and returns empty results instead of crashing.
 * Allows the audit to continue even if one pass fails.
 */
async function safeCallGPT(openai, opts, emptyResult) {
  try {
    return await callGPT(openai, opts);
  } catch (err) {
    process.stderr.write(`  [${opts.passName}] Graceful degradation — using empty result\n`);
    return {
      result: emptyResult,
      usage: { input_tokens: 0, output_tokens: 0, reasoning_tokens: 0, latency_ms: 0 },
      latencyMs: 0,
      failed: true,
      error: err.message
    };
  }
}

// ── Map-Reduce Pass ──────────────────────────────────────────────────────────

/**
 * Run a single pass using map-reduce when file count exceeds MAP_REDUCE_THRESHOLD.
 * MAP: parallel GPT calls per audit unit (chunked file groups).
 * REDUCE: single synthesis call to deduplicate, elevate patterns, rank findings.
 *
 * @param {OpenAI} openai - OpenAI client
 * @param {string[]} files - Files to audit in this pass
 * @param {string} systemPrompt - System prompt for map units
 * @param {string} projectBrief - Project context brief
 * @param {string} planContent - Plan content for context
 * @param {string} passName - Name of the pass (for logging)
 * @returns {Promise<{result: object, usage: object, latencyMs: number}>}
 */
async function runMapReducePass(openai, files, systemPrompt, projectBrief, planContent, passName) {
  const units = buildAuditUnits(files);

  // MAP phase: parallel calls with concurrency limit
  const CONCURRENCY_LIMIT = safeInt(process.env.MAP_REDUCE_CONCURRENCY, 5);
  let active = 0;
  const queue = [];
  const acquireSlot = () => active < CONCURRENCY_LIMIT ? (active++, Promise.resolve()) : new Promise(r => queue.push(r));
  const releaseSlot = () => queue.length > 0 ? queue.shift()() : active--;

  process.stderr.write(`  [${passName}] MAP: ${units.length} units, concurrency=${CONCURRENCY_LIMIT}\n`);
  const mapStart = Date.now();

  const results = await Promise.allSettled(
    units.map(async (unit, i) => {
      await acquireSlot();
      try {
        const context = unit.chunk
          ? `// ${unit.files[0]} (chunk)\n${unit.chunk.imports}\n\n${unit.chunk.items.map(it => it.source).join('\n\n')}`
          : readFilesAsContext(unit.files, { maxPerFile: 10000, maxTotal: 80000 });

        const limits = computePassLimits(context.length, 'high');
        return await callGPT(openai, {
          systemPrompt,
          userPrompt: `## Project Brief\n${projectBrief}\n\n## Audit Unit ${i + 1}/${units.length} (${unit.files.length} files)\n\n## Code\n${context}`,
          schema: PassFindingsSchema,
          schemaName: `map_${passName}_${i}`,
          reasoning: 'high',
          ...limits,
          passName: `map-${passName}-${i}`
        });
      } finally {
        releaseSlot();
      }
    })
  );

  // Collect findings
  const allFindings = [];
  let failedUnits = 0;
  for (let i = 0; i < results.length; i++) {
    if (results[i].status === 'fulfilled') {
      for (const f of (results[i].value.result.findings || [])) {
        f._mapUnit = i;
        allFindings.push(f);
      }
    } else {
      failedUnits++;
      process.stderr.write(`  [map-${passName}-${i}] FAILED: ${results[i].reason?.message || 'unknown'}\n`);
    }
  }

  process.stderr.write(`  [${passName}] MAP done: ${allFindings.length} findings from ${units.length - failedUnits}/${units.length} units (${((Date.now() - mapStart) / 1000).toFixed(1)}s)\n`);

  if (allFindings.length === 0) {
    return {
      result: { pass_name: passName, findings: [], quick_fix_warnings: [], summary: `Map-reduce: ${units.length} units, 0 findings. ${failedUnits} units failed.` },
      usage: { input_tokens: 0, output_tokens: 0, reasoning_tokens: 0 },
      latencyMs: Date.now() - mapStart
    };
  }

  // REDUCE phase: single synthesis call
  process.stderr.write(`  [${passName}] REDUCE: synthesizing ${allFindings.length} findings\n`);

  // Token budget: cap findings at ~30K tokens
  const findingsForReduce = allFindings.sort((a, b) => {
    const sevOrder = { HIGH: 0, MEDIUM: 1, LOW: 2 };
    return (sevOrder[a.severity] ?? 2) - (sevOrder[b.severity] ?? 2);
  });
  let findingsJson = JSON.stringify(findingsForReduce.map(f => ({
    id: f.id, severity: f.severity, category: f.category,
    section: f.section, detail: f.detail?.slice(0, 200),
    is_quick_fix: f.is_quick_fix, _mapUnit: f._mapUnit
  })), null, 2);
  if (findingsJson.length > 120000) {
    findingsJson = findingsJson.slice(0, 120000) + '\n... [truncated]';
  }

  // Reduce uses low reasoning — it's dedup/ranking, not deep analysis. Higher timeout for large finding sets.
  const reduceLimits = computePassLimits(findingsJson.length + 2000, 'low');
  reduceLimits.timeoutMs = Math.max(reduceLimits.timeoutMs, 180000); // Min 3 min for reduce
  const reduceResult = await safeCallGPT(openai, {
    systemPrompt: REDUCE_SYSTEM_PROMPT,
    userPrompt: `## Findings from ${units.length} audit units (${failedUnits} failed):\n\n${findingsJson}\n\n## Tasks:\n1. Deduplicate\n2. Elevate systemic patterns (3+ occurrences)\n3. Flag cross-file issues\n4. Rank by severity`,
    schema: PassFindingsSchema,
    schemaName: `reduce_${passName}`,
    reasoning: 'low',
    ...reduceLimits,
    passName: `reduce-${passName}`
  }, { pass_name: passName, findings: allFindings, quick_fix_warnings: [], summary: 'Reduce phase failed — returning raw map findings' });

  const totalLatency = Date.now() - mapStart;
  return {
    result: reduceResult.result,
    usage: { input_tokens: 0, output_tokens: 0, reasoning_tokens: 0, latency_ms: totalLatency },
    latencyMs: totalLatency
  };
}

// ── Multi-Pass Code Audit ──────────────────────────────────────────────────────

/**
 * Run multi-pass parallel code audit.
 * Large backend file sets are split into route+service sub-passes.
 * Each pass uses safeCallGPT for graceful degradation on timeout/error.
 */
async function runMultiPassCodeAudit(openai, planContent, projectContext, jsonMode, outFile, historyContext = '', { passFilter = null, fileFilter = null, round = 1, ledgerFile = null, diffFile = null, changedFiles = [], repoProfile = null, bandit = null, fpTracker = null } = {}) {
  const totalStart = Date.now();
  const EMPTY_FINDINGS = { pass_name: 'empty', findings: [], quick_fix_warnings: [], summary: 'Pass skipped or failed.' };
  const EMPTY_STRUCTURE = { pass_name: 'structure', files_planned: 0, files_found: 0, files_missing: 0, missing_files: [], export_mismatches: [], findings: [], summary: 'Pass skipped.' };
  const EMPTY_WIRING = { pass_name: 'wiring', wiring_issues: [], findings: [], summary: 'Pass skipped.' };
  const EMPTY_SUSTAIN = { pass_name: 'sustainability', findings: [], dead_code: [], quick_fix_warnings: [], summary: 'Pass skipped.' };

  // 1. Gather and classify files
  const { found, missing, allPaths } = extractPlanPaths(planContent);
  const { backend, frontend, shared } = classifyFiles(found);

  // Record audit start in cloud store (fire-and-forget)
  let cloudRunId = null;
  if (isCloudEnabled() && repoProfile) {
    const repoId = await upsertRepo(repoProfile, path.basename(path.resolve('.'))).catch(() => null);
    if (repoId) {
      cloudRunId = await recordRunStart(repoId, 'plan', 'code').catch(() => null);
    }
  }

  // Split backend into routes vs services for manageable chunk sizes
  const backendRoutes = backend.filter(f => f.includes('/routes/'));
  const backendServices = backend.filter(f => !f.includes('/routes/'));
  const splitBackend = backend.length > BACKEND_SPLIT_THRESHOLD;

  // ── R2+ initialization ──────────────────────────────────────────────────────
  const isR2Plus = round >= 2;
  let ledger = null, diffMap = null, impactSet = [];

  if (isR2Plus) {
    process.stderr.write(`\n═══ R${round} MODE ═══\n`);

    // Load ledger
    if (ledgerFile) {
      try {
        ledger = JSON.parse(fs.readFileSync(path.resolve(ledgerFile), 'utf-8'));
        process.stderr.write(`  [ledger] Loaded ${ledger.entries?.length ?? 0} entries\n`);
      } catch (err) {
        process.stderr.write(`  [ledger] Failed: ${err.message} — proceeding without suppression\n`);
        ledger = { version: 1, entries: [] };
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
  const focusBlock = repoProfile?.focusAreas?.length > 0
    ? `\n\nPRIORITY CHECKS for this codebase:\n${repoProfile.focusAreas.map(f => `- ${f}`).join('\n')}\n`
    : '';

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
        systemPrompt: PASS_STRUCTURE_SYSTEM + focusBlock,
        userPrompt: `## Project Context\n${readProjectContextForPass('structure')}\n${historyBlock}\n## Plan\n${extractPlanForPass(planContent, 'structure')}\n\n${fileListContext}\n\n## File Signatures\n${structureFiles}`,
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
    wave1Promises.push(
      safeCallGPT(openai, {
        systemPrompt: PASS_WIRING_SYSTEM + focusBlock,
        userPrompt: `## Project Context\n${readProjectContextForPass('wiring')}\n${historyBlock}\n## Plan\n${extractPlanForPass(planContent, 'wiring')}\n\n${fileListContext}\n\n## API & Route Files\n${readFilesAsContext(wiringFiles, { maxPerFile: 8000, maxTotal: 60000 })}\n\n## Shared Files\n${sharedContext}`,
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
        if (shouldMapReduce(effectiveRoutes)) {
          process.stderr.write(`  [be-routes] ${effectiveRoutes.length} files — using map-reduce\n`);
          const beRoutesSystemPrompt = (isR2Plus
            ? buildR2SystemPrompt(PASS_BACKEND_RUBRIC, buildRulingsBlock(ledgerFile, 'be-routes', impactSet))
            : PASS_BACKEND_SYSTEM) + focusBlock;
          wave2Promises.push(
            runMapReducePass(openai, effectiveRoutes, beRoutesSystemPrompt, beCtx, bePlan, 'be-routes')
          );
        } else {
          const limits = computePassLimits(baseContextChars + measureContextChars(effectiveRoutes, 8000) + sharedContext.length, 'high');
          process.stderr.write(`  be-routes: ${effectiveRoutes.length} files → ${limits.maxTokens} tok / ${(limits.timeoutMs/1000).toFixed(0)}s\n`);
          wave2Promises.push(
            safeCallGPT(openai, {
              systemPrompt: (isR2Plus
                ? buildR2SystemPrompt(PASS_BACKEND_RUBRIC, buildRulingsBlock(ledgerFile, 'be-routes', impactSet))
                : PASS_BACKEND_SYSTEM) + focusBlock,
              userPrompt: `## Project Context\n${beCtx}\n${historyBlock}\n## Plan\n${bePlan}\n\n## Backend ROUTES\n${isR2Plus && diffMap ? readFilesAsAnnotatedContext(effectiveRoutes, diffMap, { maxPerFile: 8000, maxTotal: 60000 }) : readFilesAsContext(effectiveRoutes, { maxPerFile: 8000, maxTotal: 60000 })}\n\n## Shared Files\n${sharedContext}`,
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
        if (shouldMapReduce(effectiveServices)) {
          process.stderr.write(`  [be-services] ${effectiveServices.length} files — using map-reduce\n`);
          const beServicesSystemPrompt = (isR2Plus
            ? buildR2SystemPrompt(PASS_BACKEND_RUBRIC, buildRulingsBlock(ledgerFile, 'be-services', impactSet))
            : PASS_BACKEND_SYSTEM) + focusBlock;
          wave2Promises.push(
            runMapReducePass(openai, effectiveServices, beServicesSystemPrompt, beCtx, bePlan, 'be-services')
          );
        } else {
          const limits = computePassLimits(baseContextChars + measureContextChars(effectiveServices, 8000), 'high');
          process.stderr.write(`  be-services: ${effectiveServices.length} files → ${limits.maxTokens} tok / ${(limits.timeoutMs/1000).toFixed(0)}s\n`);
          wave2Promises.push(
            safeCallGPT(openai, {
              systemPrompt: (isR2Plus
                ? buildR2SystemPrompt(PASS_BACKEND_RUBRIC, buildRulingsBlock(ledgerFile, 'be-services', impactSet))
                : PASS_BACKEND_SYSTEM) + focusBlock,
              userPrompt: `## Project Context\n${beCtx}\n${historyBlock}\n## Plan\n${bePlan}\n\n## Backend SERVICES\n${isR2Plus && diffMap ? readFilesAsAnnotatedContext(effectiveServices, diffMap, { maxPerFile: 8000, maxTotal: 80000 }) : readFilesAsContext(effectiveServices, { maxPerFile: 8000, maxTotal: 80000 })}`,
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
      if (shouldMapReduce(effectiveBackend)) {
        process.stderr.write(`  [backend] ${effectiveBackend.length} files — using map-reduce\n`);
        const beSystemPrompt = (isR2Plus
          ? buildR2SystemPrompt(PASS_BACKEND_RUBRIC, buildRulingsBlock(ledgerFile, 'backend', impactSet))
          : PASS_BACKEND_SYSTEM) + focusBlock;
        wave2Promises.push(
          runMapReducePass(openai, effectiveBackend, beSystemPrompt, beCtx, bePlan, 'backend')
        );
      } else {
        const limits = computePassLimits(baseContextChars + measureContextChars(effectiveBackend, 8000) + sharedContext.length, 'high');
        process.stderr.write(`  backend: ${effectiveBackend.length} files → ${limits.maxTokens} tok / ${(limits.timeoutMs/1000).toFixed(0)}s\n`);
        wave2Promises.push(
          safeCallGPT(openai, {
            systemPrompt: (isR2Plus
              ? buildR2SystemPrompt(PASS_BACKEND_RUBRIC, buildRulingsBlock(ledgerFile, 'backend', impactSet))
              : PASS_BACKEND_SYSTEM) + focusBlock,
            userPrompt: `## Project Context\n${beCtx}\n${historyBlock}\n## Plan\n${bePlan}\n\n## Backend Implementation Files\n${isR2Plus && diffMap ? readFilesAsAnnotatedContext(effectiveBackend, diffMap, { maxPerFile: 8000, maxTotal: 80000 }) : readFilesAsContext(effectiveBackend, { maxPerFile: 8000, maxTotal: 80000 })}\n\n## Shared Files\n${sharedContext}`,
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
    if (shouldMapReduce(effectiveFrontend)) {
      process.stderr.write(`  [frontend] ${effectiveFrontend.length} files — using map-reduce\n`);
      const feSystemPrompt = (isR2Plus
        ? buildR2SystemPrompt(PASS_FRONTEND_RUBRIC, buildRulingsBlock(ledgerFile, 'frontend', impactSet))
        : PASS_FRONTEND_SYSTEM) + focusBlock;
      const feCtx = readProjectContextForPass('frontend');
      const fePlan = extractPlanForPass(planContent, 'frontend');
      wave2Promises.push(
        runMapReducePass(openai, effectiveFrontend, feSystemPrompt, feCtx, fePlan, 'frontend')
      );
    } else {
      const limits = computePassLimits(baseContextChars + measureContextChars(effectiveFrontend, 10000) + sharedContext.length, 'high');
      process.stderr.write(`  frontend: ${effectiveFrontend.length} files → ${limits.maxTokens} tok / ${(limits.timeoutMs/1000).toFixed(0)}s\n`);
      wave2Promises.push(
        safeCallGPT(openai, {
          systemPrompt: (isR2Plus
            ? buildR2SystemPrompt(PASS_FRONTEND_RUBRIC, buildRulingsBlock(ledgerFile, 'frontend', impactSet))
            : PASS_FRONTEND_SYSTEM) + focusBlock,
          userPrompt: `## Project Context\n${readProjectContextForPass('frontend')}\n${historyBlock}\n## Plan\n${extractPlanForPass(planContent, 'frontend')}\n\n## Frontend Implementation Files\n${isR2Plus && diffMap ? readFilesAsAnnotatedContext(effectiveFrontend, diffMap, { maxPerFile: 10000, maxTotal: 80000 }) : readFilesAsContext(effectiveFrontend, { maxPerFile: 10000, maxTotal: 80000 })}\n\n## Shared Files\n${sharedContext}`,
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

  // 4. Wave 3: Sustainability (reasoning: medium)
  let sustainResult;
  if (shouldRunPass('sustainability')) {
    const sustainFiles = fileFilter ? found.filter(f => fileFilter.some(ff => f.includes(ff) || ff.includes(f))) : found;

    process.stderr.write(`\n── Wave 3: Sustainability (reasoning: medium) ──\n`);

    if (shouldMapReduce(sustainFiles)) {
      process.stderr.write(`  [sustainability] ${sustainFiles.length} files — using map-reduce\n`);
      const sustainSystemPrompt = (isR2Plus
        ? buildR2SystemPrompt(PASS_SUSTAINABILITY_RUBRIC, buildRulingsBlock(ledgerFile, 'sustainability', impactSet))
        : PASS_SUSTAINABILITY_SYSTEM) + focusBlock;
      const sustainCtx = readProjectContextForPass('sustainability');
      const sustainPlan = extractPlanForPass(planContent, 'sustainability');
      sustainResult = await runMapReducePass(openai, sustainFiles, sustainSystemPrompt, sustainCtx, sustainPlan, 'sustainability');
    } else {
      const sustainContextChars = baseContextChars + measureContextChars(sustainFiles, 4000);
      const sustainLimits = computePassLimits(sustainContextChars, 'medium');
      process.stderr.write(`  ${sustainFiles.length} files → ${sustainLimits.maxTokens} tok / ${(sustainLimits.timeoutMs/1000).toFixed(0)}s\n`);

      sustainResult = await safeCallGPT(openai, {
        systemPrompt: (isR2Plus
          ? buildR2SystemPrompt(PASS_SUSTAINABILITY_RUBRIC, buildRulingsBlock(ledgerFile, 'sustainability', impactSet))
          : PASS_SUSTAINABILITY_SYSTEM) + focusBlock,
        userPrompt: `## Project Context\n${readProjectContextForPass('sustainability')}\n${historyBlock}\n## Plan\n${extractPlanForPass(planContent, 'sustainability')}\n\n## All Implementation Files\n${isR2Plus && diffMap ? readFilesAsAnnotatedContext(sustainFiles, diffMap, { maxPerFile: 4000, maxTotal: 60000 }) : readFilesAsContext(sustainFiles, { maxPerFile: 4000, maxTotal: 60000 })}`,
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

  // 5. Merge all pass results with semantic dedup
  const totalLatency = Date.now() - totalStart;
  const allResults = [structureResult, wiringResult, ...backendResults, frontendResult, sustainResult];
  const failedPasses = allResults.filter(r => r.failed).map(r => r.error);

  process.stderr.write(`\n── Merge (${allResults.length} passes, ${failedPasses.length} failed) ──\n`);
  if (failedPasses.length > 0) {
    process.stderr.write(`  Failed passes: ${failedPasses.join('; ')}\n`);
  }

  // Cross-pass dedup: if two passes flag the same issue (>80% word overlap on
  // section+detail), keep the higher-severity one
  function tokenize(s) {
    return (s ?? '').toLowerCase().replace(/[^a-z0-9\s]/g, '').split(/\s+/).filter(Boolean);
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

  addFindings(structureResult.result.findings, 'Structure');
  addFindings(wiringResult.result.findings, 'Wiring');
  for (let i = 0; i < backendResults.length; i++) {
    addFindings(backendResults[i].result.findings, backendPassNames[i] ?? 'Backend');
  }
  addFindings(frontendResult.result.findings, 'Frontend');
  addFindings(sustainResult.result.findings, 'Sustainability');

  if (dedupCount > 0) {
    process.stderr.write(`  Deduped ${dedupCount} cross-pass duplicate(s)\n`);
  }

  // 5.5 Post-output suppression (R2+ only)
  if (isR2Plus && ledger && ledger.entries.length > 0) {
    // Enrich findings with structured metadata
    for (const f of allFindings) {
      populateFindingMetadata(f, f._pass);
    }

    let { kept, suppressed, reopened } = suppressReRaises(allFindings, ledger, { changedFiles, impactSet });

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
    if (fpTracker) {
      const fpSuppressed = [];
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

    // Recalculate counts (the existing code after this point uses allFindings for counting)
  }

  const high = allFindings.filter(f => f.severity === 'HIGH').length;
  const medium = allFindings.filter(f => f.severity === 'MEDIUM').length;
  const low = allFindings.filter(f => f.severity === 'LOW').length;

  let verdict = 'PASS';
  if (high > 0) verdict = 'SIGNIFICANT_ISSUES';
  else if (medium > 2) verdict = 'NEEDS_FIXES';
  // Failed passes mean incomplete audit — don't report PASS with 0 findings if passes failed
  if (verdict === 'PASS' && failedPasses.length > 0) verdict = 'INCOMPLETE';

  const totalUsage = {
    input_tokens: allResults.reduce((s, r) => s + (r.usage?.input_tokens ?? 0), 0),
    output_tokens: allResults.reduce((s, r) => s + (r.usage?.output_tokens ?? 0), 0),
    reasoning_tokens: allResults.reduce((s, r) => s + (r.usage?.reasoning_tokens ?? 0), 0),
    latency_ms: totalLatency
  };

  // Build per-pass timing map
  const passTimings = {};
  passTimings.structure = `${(structureResult.latencyMs / 1000).toFixed(1)}s`;
  passTimings.wiring = `${(wiringResult.latencyMs / 1000).toFixed(1)}s`;
  for (let i = 0; i < backendResults.length; i++) {
    passTimings[backendPassNames[i] ?? `backend_${i}`] = `${(backendResults[i].latencyMs / 1000).toFixed(1)}s`;
  }
  passTimings.frontend = `${(frontendResult.latencyMs / 1000).toFixed(1)}s`;
  passTimings.sustainability = `${(sustainResult.latencyMs / 1000).toFixed(1)}s`;
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
    _usage: totalUsage
  };

  // Phase 3-4: Record outcomes for learning (v2: include primaryFile + revision ID)
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
      accepted: true, // Will be updated by orchestrator after deliberation
      round,
      promptVariant: revId,
      promptRevisionId: revId,
      semanticHash: f._hash
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
      { name: 'sustainability', result: sustainResult }
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
        reasoning: pr.name === 'sustainability' ? 'medium' : 'high'
      }).catch(e => process.stderr.write(`  [learning] ${e.message}\n`));
    }

    // Record suppression events if R2+
    if (isR2Plus && mergedResult._suppression) {
      recordSuppressionEvents(cloudRunId, mergedResult._suppression).catch(e => process.stderr.write(`  [learning] ${e.message}\n`));
    }
  }

  // Attach cloud run ID to result for orchestrator reference
  if (cloudRunId) mergedResult._cloudRunId = cloudRunId;

  // Phase 5: Flush bandit state + sync learning systems to cloud
  if (bandit) {
    bandit.flush();
    syncBanditArms(bandit.arms).catch(e => process.stderr.write(`  [learning] ${e.message}\n`));
  }
  if (fpTracker) {
    syncFalsePositivePatterns(null, fpTracker.patterns).catch(e => process.stderr.write(`  [learning] ${e.message}\n`));
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
}

// ── Main ───────────────────────────────────────────────────────────────────────

async function main() {
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
  const round = roundIdx !== -1 && args[roundIdx + 1] ? parseInt(args[roundIdx + 1], 10) : 1;

  // --ledger <file>: adjudication ledger for R2+ suppression of previously resolved findings
  const ledgerIdx = args.indexOf('--ledger');
  const ledgerFile = ledgerIdx !== -1 && args[ledgerIdx + 1] ? args[ledgerIdx + 1] : null;

  // --diff <file>: unified diff file for R2+ annotated context (highlights changed lines)
  const diffIdx = args.indexOf('--diff');
  const diffFile = diffIdx !== -1 && args[diffIdx + 1] ? args[diffIdx + 1] : null;

  // --changed <list>: comma-separated changed file paths for R2+ impact set computation
  const changedIdx = args.indexOf('--changed');
  const changedFiles = changedIdx !== -1 && args[changedIdx + 1] ? args[changedIdx + 1].split(',').map(s => s.trim()) : [];

  if (!mode || !planFile || !['plan', 'code', 'rebuttal'].includes(mode)) {
    console.error('Usage: node scripts/openai-audit.mjs <plan|code> <plan-file> [--json] [--out <file>] [--history <file>] [--passes <list>] [--files <list>]');
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
  await initAuditBrief(); // Pre-generate context brief (Gemini Flash → Claude Haiku → regex)
  const repoProfile = generateRepoProfile();
  const projectContext = readProjectContext();
  const historyContext = buildHistoryContext(historyFile);
  // Initialize learning systems (graceful — never blocks audit)
  const startMs = Date.now();
  await initLearningStore().catch(e => process.stderr.write(`  [learning] ${e.message}\n`)); // Cloud store (optional)
  const bandit = new PromptBandit();
  const fpTracker = new FalsePositiveTracker();

  const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

  // Code mode → multi-pass parallel audit
  if (mode === 'code') {
    await runMultiPassCodeAudit(openai, planContent, projectContext, jsonMode, outFile, historyContext, { passFilter, fileFilter, round, ledgerFile, diffFile, changedFiles, repoProfile, bandit, fpTracker });
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
    systemPrompt = PLAN_AUDIT_SYSTEM;
    schema = PlanAuditResultSchema;
    schemaName = 'plan_audit_result';
    userPrompt = `## Project Context\n${projectContext}\n\n${historyContext ? `---\n\n${historyContext}\n` : ''}---\n\n## Plan to Audit\n${planContent}`;
  }

  try {
    const { result, usage, latencyMs } = await callGPT(openai, {
      systemPrompt, userPrompt, schema, schemaName,
      passName: mode
    });

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

main();
