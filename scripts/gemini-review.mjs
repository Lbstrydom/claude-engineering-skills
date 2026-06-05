#!/usr/bin/env node
/**
 * @fileoverview Independent final reviewer for the audit loop.
 *
 * This script provides an unbiased third-model perspective after Claude (author)
 * and GPT-5.4 (auditor) have converged. It prefers Gemini 3.1 Pro and falls back
 * to Claude Opus when Gemini credentials are unavailable.
 *
 * Usage:
 *   node scripts/gemini-review.mjs review <plan-file> <transcript-file>         # Full review
 *   node scripts/gemini-review.mjs review <plan-file> <transcript-file> --json   # JSON output
 *   node scripts/gemini-review.mjs review <plan-file> <transcript-file> --out <file>  # File output
 *   node scripts/gemini-review.mjs ping                                          # Verify API connectivity
 *
 * Requires: GEMINI_API_KEY or ANTHROPIC_API_KEY in .env or environment
 *
 * @module scripts/gemini-review
 */

// dotenv loaded by lib/config.mjs (worktree-safe discovery)
import { GoogleGenAI } from '@google/genai';
import { z } from 'zod';
import { ProducerFindingSchema, zodToGeminiSchema } from './lib/schemas.mjs';
import { buildClassificationRubric } from './lib/prompt-seeds.mjs';
import { readFileOrDie, readFilesAsContext, extractPlanPaths, writeOutput, isAuditInfraFile } from './lib/file-io.mjs';
import { semanticId, formatFindings, appendOutcome, FalsePositiveTracker } from './lib/findings.mjs';
import { readProjectContext, initAuditBrief, generateRepoProfile } from './lib/context.mjs';
import { geminiConfig, claudeConfig, azureConfig } from './lib/config.mjs';
import { refreshModelCatalog, resolveModel } from './lib/model-resolver.mjs';
import { createOpenAIClient } from './lib/openai-client.mjs';
import { createAnthropicClient } from './lib/anthropic-client.mjs';
import { PromptBandit } from './bandit.mjs';
import { getActivePrompt, getActiveRevisionId, bootstrapFromConstants } from './lib/prompt-registry.mjs';
import { getRepoContext } from './lib/repo-context.mjs';
import { assertRepoRoot } from './lib/assert-repo-root.mjs';
// NOTE: lib/llm-wrappers.mjs provides shared wrappers for learning/refinement/evolution paths.
// This module keeps specialized callGemini/callClaudeOpus with thinkingConfig + abort controller
// because the final review requires high-budget reasoning and precise timeout handling.
// Future: extract shared patterns to llm-wrappers while keeping specialized configs here.

// ── Configuration (from centralized config) ─────────────────────────────────

// `let` not `const` — reassigned in main() after refreshModelCatalog()
// pulls the live provider catalog, so we always use the newest available
// model instead of whatever STATIC_POOL knew about at last commit.
let MODEL = geminiConfig.model;
let CLAUDE_OPUS_MODEL = claudeConfig.finalReviewModel;
const TIMEOUT_MS = geminiConfig.timeoutMs;
const MAX_OUTPUT_TOKENS = geminiConfig.maxOutputTokens;

// ── Schemas ────────────────────────────────────────────────────────────────────
// FindingSchema + FindingJsonSchema imported from shared.mjs (single source of truth).
// Gemini-specific schemas use explicit JSON Schema — no Zod private API walking.

const WronglyDismissedSchema = z.object({
  original_finding_id: z.string().max(10).describe('The GPT finding ID that was dismissed (e.g. H3, M5)'),
  reason_claude_was_wrong: z.string().max(800).describe('Why Claude should not have dismissed this'),
  recommended_severity: z.enum(['HIGH', 'MEDIUM', 'LOW']),
  evidence_basis: z.string().max(600).optional().describe(
    'Required if the transcript shows Claude challenged this finding with cited evidence. ' +
    'Explain NEW counter-evidence not already addressed in Claude\'s challenge. ' +
    'Omitting this on a previously-challenged finding signals reassertion without new evidence.'
  ),
  cited_lines: z.array(z.string().max(100)).max(10).optional().describe(
    'Specific line references cited in your reasoning (e.g. ["auth.js:132", "auth.js:137"]). ' +
    'Include these so hallucinated citations can be detected and flagged post-hoc.'
  ),
});

const GeminiFinalReviewSchema = z.object({
  verdict: z.enum(['APPROVE', 'CONCERNS', 'CONCERNS_REMAINING', 'REJECT']),

  deliberation_quality: z.object({
    claude_bias_detected: z.boolean().describe('Did Claude dismiss valid findings to protect its own code?'),
    gpt_false_positive_count: z.number().describe('How many GPT findings were noise or incorrect?'),
    deliberation_was_fair: z.boolean().describe('Was the Claude-GPT deliberation balanced overall?'),
    quality_summary: z.string().max(2000).describe('Brief assessment of the deliberation process')
  }),

  new_findings: z.array(ProducerFindingSchema).max(10).describe('Issues neither Claude nor GPT caught. Max 10, only genuinely new.'),

  wrongly_dismissed: z.array(WronglyDismissedSchema).max(10).describe('GPT findings Claude dismissed but were actually valid'),

  over_engineering_flags: z.array(z.string().max(500)).max(10).describe('Places where audit pressure caused unnecessary complexity'),

  architectural_coherence: z.enum(['Strong', 'Adequate', 'Weak']),
  overall_reasoning: z.string().max(3000).describe('Comprehensive final assessment')
});

// Derived from GeminiFinalReviewSchema — single source of truth via Zod → JSON Schema
const GeminiFinalReviewJsonSchema = zodToGeminiSchema(GeminiFinalReviewSchema);

// ── Schema-driven truncation ──────────────────────────────────────────────────
// Gemini verbosity regularly exceeds field maxLength constraints, causing Zod to
// reject the entire response. Instead of failing, we truncate verbose fields and
// log what was shortened. Map is built from the raw JSON Schema (before Gemini
// stripping removes maxLength) so it stays in sync with the Zod definitions.

/**
 * Walk a JSON Schema tree and collect all path → maxLength entries.
 * Handles nested objects, arrays (path[]), and $defs references.
 * @param {object} schema - Raw JSON Schema node
 * @param {string} path - Dot-path to current node
 * @param {Map<string,number>} map - Accumulator
 * @param {object} [defs] - Top-level $defs for $ref resolution
 */
function _collectMaxLengths(schema, path, map, defs) {
  if (!schema || typeof schema !== 'object') return;
  if (schema.$ref) {
    const refName = schema.$ref.replace('#/$defs/', '');
    if (defs?.[refName]) _collectMaxLengths(defs[refName], path, map, defs);
    return;
  }
  if (schema.type === 'string' && schema.maxLength) {
    map.set(path, schema.maxLength);
  }
  if (schema.properties) {
    for (const [k, v] of Object.entries(schema.properties)) {
      _collectMaxLengths(v, path ? `${path}.${k}` : k, map, defs);
    }
  }
  if (schema.items) {
    _collectMaxLengths(schema.items, `${path}[]`, map, defs);
  }
}

const _rawGeminiReviewSchema = z.toJSONSchema(GeminiFinalReviewSchema);
const _maxLengthMap = new Map();
_collectMaxLengths(_rawGeminiReviewSchema, '', _maxLengthMap, _rawGeminiReviewSchema.$defs);

/**
 * Recursively walk a parsed JSON result and truncate strings that exceed their
 * schema-defined maxLength. Returns a new object (no mutation). Logs truncations.
 * @param {*} obj
 * @param {string} path
 * @param {string[]} truncated - Accumulator for log messages
 * @returns {*}
 */
function truncateToSchema(obj, path, truncated) {
  if (typeof obj === 'string') {
    const max = _maxLengthMap.get(path);
    if (max && obj.length > max) {
      truncated.push(`${path} (${obj.length} → ${max})`);
      return obj.slice(0, max);
    }
    return obj;
  }
  if (Array.isArray(obj)) {
    return obj.map(item => truncateToSchema(item, `${path}[]`, truncated));
  }
  if (obj && typeof obj === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(obj)) {
      out[k] = truncateToSchema(v, path ? `${path}.${k}` : k, truncated);
    }
    return out;
  }
  return obj;
}

// No verifySchemaSync needed — JSON Schema is derived from Zod, drift is impossible.

// ── System Prompt ──────────────────────────────────────────────────────────────

const REVIEW_SYSTEM = `You are an independent quality reviewer — the FINAL GATE in a multi-model audit pipeline.

CONTEXT: A software engineer (Claude) created work based on a plan. A separate auditor (GPT-5.4) reviewed it and raised findings. Claude then deliberated on each finding — accepting some, challenging others. GPT ruled on the challenges (sustain/overrule/compromise). The loop repeated until convergence.

IMPORTANT — AUDIT MODE AWARENESS:
If the transcript contains a PLAN audit (no code files, only plan text), your job is to assess PLAN QUALITY — completeness, soundness, specificity, risk coverage. Do NOT judge whether code implements the plan. A plan audit evaluates the plan itself. The plan describes what WILL BE built — absent implementations are expected.
If the transcript contains a CODE audit (code files present), assess CODE QUALITY — correctness, security, architecture, maintainability.

YOUR JOB: Review the FULL audit transcript and render an independent verdict. You have NO stake in either model's output.

WHAT TO LOOK FOR:

1. **Claude Bias Detection** — Did Claude dismiss valid GPT findings with motivated reasoning?
   Signs: vague rebuttals ("this is fine"), appeals to authority ("I know this codebase"),
   severity downgrades without evidence, accepting the letter but not spirit of a finding.

2. **GPT False Positives** — Did GPT raise findings that were genuinely wrong?
   Not everything GPT flags is real. Count the noise.

3. **Missed Issues** — What did BOTH models miss? Look for:
   - Security: injection, auth bypass, data leaks, missing input validation
   - Data integrity: race conditions, missing transactions, partial updates
   - Error handling: swallowed errors, missing edge cases
   - Architecture: god functions, tight coupling, leaky abstractions
   - Performance: N+1 queries, unbounded loops, missing pagination

4. **Wrongly Dismissed** — GPT findings that Claude dismissed but were actually valid.
   Check the dismissed/overruled findings especially carefully.

5. **Over-Engineering** — Did the audit pressure cause Claude to add unnecessary complexity?
   Extra abstractions nobody asked for, premature optimisation, defensive code for impossible scenarios.

6. **Architectural Coherence** — Does the final code hang together as a system?
   Cross-file consistency, naming patterns, data flow clarity.

VERDICT GUIDE:
- APPROVE: Plan/code is production-ready. Minor issues at most. Deliberation was fair.
- CONCERNS: Fixable issues found, Gemini is confident they need attention before proceeding.
- CONCERNS_REMAINING: Mixed picture — at least one valid finding, but other findings were challenged
  by the author with cited evidence. Use this when a blanket REJECT would be unfair because some
  findings are legitimately disputed. Author decides whether disputed items need fixing before proceeding.
- REJECT: Significant unambiguous issues — missed bugs, clear bias in deliberation, or architectural
  problems that need human judgment. A single valid finding alongside legitimately challenged others
  does NOT warrant REJECT — use CONCERNS_REMAINING instead.

RULES:
1. Be ruthlessly honest but fair. Neither model is always right or always wrong.
2. Only raise genuinely NEW findings — do not re-raise what GPT already found (even if phrased differently).
3. Quality over quantity — 3 real findings beat 10 vague ones.
4. Quick-fix detection still applies — flag band-aids.
5. If the deliberation was fair and the plan/code is good, say APPROVE. Don't manufacture issues.
6. If the prompt includes a "Pre-filtered Debt" section, DO NOT re-raise any topic listed there.
   Those concerns are pre-existing, operator-deferred, and tracked outside this audit's scope.
   They were explicitly filtered from the transcript by the upstream pipeline.
7. Wrongly-dismissed escalation cap: If the transcript shows Claude challenged a dismissed finding
   with cited code evidence (file paths, line numbers, existing code), you MUST either:
   (a) Accept the challenge — do not include it in wrongly_dismissed, OR
   (b) Provide genuinely NEW counter-evidence in the evidence_basis field that was NOT addressed
       by Claude's challenge. Re-asserting the prior position without new evidence is not acceptable.
   Populate cited_lines with any specific line references you use, so hallucinated citations
   can be detected. If you cite "line 132" of a file, it must actually contain relevant code.
   PROVENANCE REQUIREMENT: every wrongly_dismissed entry must EITHER (i) cite a concrete
   prior dismissed finding by its original_finding_id, OR (ii) name an explicit deliberation
   error in the transcript. If the entry's evidence_basis cites code in a file NOT in
   "Files In Scope (PR diff)", the evidence_basis MUST also state the linkage to a
   changed file (e.g. "imported by <changed-file>", "consumed by <changed-file>'s call to X").
   Entries that are neither traceable to a prior finding nor linked to in-scope code
   should NOT be raised — they are scope-creep, not missed cross-cutting analysis.
8. Scope discipline: when the prompt contains a "Files In Scope (PR diff)" section, every
   new_findings entry MUST cite a file from that list. Files outside that list are inlined ONLY
   for context (e.g. referenced by the plan or used as dependencies) — issues there are
   pre-existing, NOT this PR's responsibility. Cross-cutting concerns that a PR change BREAKS
   in an in-scope-adjacent file belong in the in-scope file's finding (cite both files in the
   description), not as a standalone finding pointing at the unchanged file. Findings whose
   primary file is out-of-scope will be filtered post-hoc and counted as scope errors.`;

// Bootstrap prompt registry for Gemini review (enables variant selection + evolution)
bootstrapFromConstants({ 'gemini-review': REVIEW_SYSTEM });

// ── Plan Audit Mode Override ───────────────────────────────────────────────────
// Appended to system prompt when --mode plan is passed. Overrides the generic
// "AUDIT MODE AWARENESS" section with an explicit, hard-to-ignore constraint.

const PLAN_MODE_BLOCK = `

## PLAN AUDIT MODE — MANDATORY CONSTRAINTS

You are reviewing a PLAN DOCUMENT, not implemented code.

THE PLAN DESCRIBES FUTURE INTENT. Everything in the plan is describing what WILL BE built.
Items the plan says "add", "create", "implement" or "define" DO NOT EXIST YET — that is the
entire point of the plan. Their absence from the current codebase is expected and correct.

WHAT THIS MEANS FOR YOUR REVIEW:
- DO NOT flag absent implementations as bugs. If the plan says "add SolverInvariantError to
  domainErrors.js", the absence of SolverInvariantError in domainErrors.js is not a bug —
  it is what the plan is for.
- DO NOT cite current codebase line numbers as evidence of plan flaws. The plan is not the code.
  If you cite a line number, it must be a line in the PLAN DOCUMENT itself, not in a source file.
- DO evaluate: Is the plan internally consistent? Are its contracts complete? Are there logical
  gaps, ambiguous APIs, missing error paths, or unresolved dependencies between proposed components?
- DO flag: Missing contracts between components the plan introduces, ambiguous data flows,
  steps that assume dependencies not defined in the plan, or logical impossibilities.

VERDICT CALIBRATION FOR PLAN AUDITS:
- REJECT requires genuine logical flaws in the plan (circular dependencies, ambiguous contracts,
  missing critical error paths). It does NOT apply when the plan simply hasn't been implemented yet.
- CONCERNS_REMAINING is appropriate when some findings are about plan soundness and others
  are disputed (e.g. one model expected code to exist, another correctly identified a plan gap).`;

/**
 * Get the active review prompt — from registry if a promoted variant exists,
 * otherwise falls back to the static REVIEW_SYSTEM constant.
 * @returns {string}
 */
function getReviewPrompt() {
  return getActivePrompt('gemini-review') || REVIEW_SYSTEM;
}

// ── Gemini API Helper ──────────────────────────────────────────────────────────

/**
 * Make a single Gemini call with structured JSON output.
 * Follows the same {result, usage, latencyMs} contract as callGPT in openai-audit.mjs.
 *
 * @param {GoogleGenAI} ai - GoogleGenAI client instance
 * @param {object} opts
 * @param {string} opts.systemPrompt
 * @param {string} opts.userPrompt
 * @param {z.ZodType} opts.zodSchema - Zod schema for response validation
 * @param {object} opts.jsonSchema - Explicit JSON Schema for Gemini's responseSchema
 * @param {string} [opts.passName] - For logging
 * @returns {Promise<{result: object, usage: object, latencyMs: number}>}
 */
async function callGemini(ai, { systemPrompt, userPrompt, zodSchema, jsonSchema, passName }) {
  const startMs = Date.now();

  if (passName) {
    process.stderr.write(`  [${passName}] Starting Gemini ${MODEL} (timeout: ${(TIMEOUT_MS / 1000).toFixed(0)}s)...\n`);
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    // Use streaming to support maxOutputTokens > 21333 (SDK hard limit for
    // non-streaming). Accumulate chunks then parse the final JSON.
    const stream = await ai.models.generateContentStream({
      model: MODEL,
      contents: userPrompt,
      config: {
        systemInstruction: systemPrompt,
        responseMimeType: 'application/json',
        responseSchema: jsonSchema,
        maxOutputTokens: MAX_OUTPUT_TOKENS,
        thinkingConfig: { thinkingBudget: 16384 }
      }
    }, { signal: controller.signal });

    const textParts = [];
    let usageMetadata = null;
    for await (const chunk of stream) {
      if (chunk.text) textParts.push(chunk.text);
      if (chunk.usageMetadata) usageMetadata = chunk.usageMetadata;
    }
    clearTimeout(timer);
    const latencyMs = Date.now() - startMs;

    // Parse the accumulated JSON response
    const text = textParts.join('');
    let result;
    try {
      result = JSON.parse(text);
    } catch (parseErr) {
      throw new Error(`Failed to parse Gemini JSON response: ${parseErr.message}\nRaw: ${text.slice(0, 500)}`);
    }

    // Auto-truncate verbose fields before Zod validation.
    // Gemini regularly exceeds per-field maxLength limits causing whole-response
    // rejection. Truncating here prevents that without losing structural validity.
    const truncated = [];
    result = truncateToSchema(result, '', truncated);
    if (truncated.length > 0) {
      process.stderr.write(`  [${passName ?? 'gemini'}] Auto-truncated ${truncated.length} fields: ${truncated.join(', ')}\n`);
    }

    // Validate against Zod schema — reject invalid responses at the trust boundary
    if (zodSchema) {
      const validated = zodSchema.safeParse(result);
      if (validated.success) {
        result = validated.data;
      } else {
        const errMsg = validated.error.message.slice(0, 300);
        process.stderr.write(`  [${passName ?? 'gemini'}] Zod validation FAILED: ${errMsg}\n`);
        throw new Error(`Gemini response failed schema validation: ${errMsg}`);
      }
    }

    const usage = {
      input_tokens: usageMetadata?.promptTokenCount ?? 0,
      output_tokens: usageMetadata?.candidatesTokenCount ?? 0,
      thinking_tokens: usageMetadata?.thoughtsTokenCount ?? 0,
      latency_ms: latencyMs
    };

    if (passName) {
      process.stderr.write(`  [${passName}] Done in ${(latencyMs / 1000).toFixed(1)}s (${usage.input_tokens} in / ${usage.output_tokens} out / ${usage.thinking_tokens} thinking)\n`);
    }

    return { result, usage, latencyMs };

  } catch (err) {
    clearTimeout(timer);
    const latencyMs = Date.now() - startMs;
    const isAbort = err.name === 'AbortError' || err.message?.toLowerCase().includes('abort');
    // Surface provider error detail so model-not-found / bad-key don't look like generic failures.
    // Extract structured fields from SDK error (GoogleGenAI attaches .status on HTTP failures).
    const detail = err.status
      ? `HTTP ${err.status}${err.message ? `: ${err.message}` : ''}`
      : (err.message || 'unknown error');
    const msg = isAbort
      ? `[${passName ?? 'gemini'}] Timeout after ${(TIMEOUT_MS / 1000).toFixed(0)}s`
      : `[${passName ?? 'gemini'}] ${detail} (${(latencyMs / 1000).toFixed(1)}s)`;
    process.stderr.write(`  [${passName ?? 'gemini'}] FAILED: ${msg}\n`);
    const wrapped = new Error(msg);
    if (err.status) wrapped.status = err.status; // preserve for classifyLlmError (404 → non-retryable)
    throw wrapped;
  }
}

/**
 * Make a single Claude Opus call with JSON output.
 * Uses the same response contract as callGemini.
 *
 * @param {object} anthropic - Anthropic client instance
 * @param {object} opts
 * @param {string} opts.systemPrompt
 * @param {string} opts.userPrompt
 * @param {z.ZodType} opts.zodSchema
 * @param {string} [opts.passName]
 * @returns {Promise<{result: object, usage: object, latencyMs: number}>}
 */
async function callClaudeOpus(anthropic, { systemPrompt, userPrompt, zodSchema, passName }) {
  const startMs = Date.now();

  if (passName) {
    process.stderr.write(`  [${passName}] Starting Claude ${CLAUDE_OPUS_MODEL} (timeout: ${(TIMEOUT_MS / 1000).toFixed(0)}s)...\n`);
  }

  const timeoutPromise = new Promise((_, reject) => {
    setTimeout(() => reject(new Error(`Timeout after ${(TIMEOUT_MS / 1000).toFixed(0)}s`)), TIMEOUT_MS);
  });

  const requestPromise = anthropic.messages.create({
    model: CLAUDE_OPUS_MODEL,
    max_tokens: MAX_OUTPUT_TOKENS,
    system: `${systemPrompt}\n\nOutput strictly valid JSON. No markdown fences.`,
    messages: [{ role: 'user', content: userPrompt }]
  });

  try {
    const response = await Promise.race([requestPromise, timeoutPromise]);
    const latencyMs = Date.now() - startMs;
    const text = response.content?.[0]?.text?.trim() || '{}';

    let result;
    try {
      result = JSON.parse(text);
    } catch (parseErr) {
      throw new Error(`Failed to parse Claude JSON response: ${parseErr.message}\nRaw: ${text.slice(0, 500)}`);
    }

    if (zodSchema) {
      const validated = zodSchema.safeParse(result);
      if (validated.success) {
        result = validated.data;
      } else {
        process.stderr.write(`  [${passName ?? 'claude-opus'}] Zod validation warning: ${validated.error.message.slice(0, 200)}\n`);
      }
    }

    const usage = {
      input_tokens: response.usage?.input_tokens ?? 0,
      output_tokens: response.usage?.output_tokens ?? 0,
      thinking_tokens: response.usage?.cache_creation_input_tokens ?? 0,
      latency_ms: latencyMs
    };

    if (passName) {
      process.stderr.write(`  [${passName}] Done in ${(latencyMs / 1000).toFixed(1)}s (${usage.input_tokens} in / ${usage.output_tokens} out)\n`);
    }

    return { result, usage, latencyMs };
  } catch (err) {
    const latencyMs = Date.now() - startMs;
    // Surface provider error detail so model-not-found / bad-key don't look like generic failures.
    const detail = err.status
      ? `HTTP ${err.status}${err.message ? `: ${err.message}` : ''}`
      : (err.message || 'unknown error');
    const msg = `[${passName ?? 'claude-opus'}] ${detail} (${(latencyMs / 1000).toFixed(1)}s)`;
    process.stderr.write(`  [${passName ?? 'claude-opus'}] FAILED: ${msg}\n`);
    const wrapped = new Error(msg);
    if (err.status) wrapped.status = err.status;
    throw wrapped;
  }
}

/**
 * Final review via Claude Opus on Azure AI Foundry (replaces Gemini on the work
 * profile). Two transports per `AZURE_CLAUDE_API_SHAPE`:
 *   - `openai` (default): OpenAI-shaped chat-completions on the Foundry endpoint.
 *   - `anthropic`: native Anthropic Messages via an Azure-baseURL'd client.
 * JSON is requested via the system prompt + parsed (not strict response_format),
 * matching `callClaudeOpus` — Foundry Claude may not honour OpenAI strict mode.
 * Same `{result, usage, latencyMs}` contract as the other providers.
 */
async function callAzureClaude(client, { systemPrompt, userPrompt, zodSchema, passName }) {
  const startMs = Date.now();
  const model = azureConfig.claudeDeployment;
  const shape = azureConfig.claudeApiShape;
  if (!model) {
    throw new Error('[azure-claude] AZURE_FOUNDRY_CLAUDE_DEPLOYMENT is required for the Azure final reviewer.');
  }
  if (passName) {
    process.stderr.write(`  [${passName}] Starting Azure Foundry Claude ${model} (${shape} shape, timeout: ${(TIMEOUT_MS / 1000).toFixed(0)}s)...\n`);
  }
  const sys = `${systemPrompt}\n\nOutput strictly valid JSON. No markdown fences.`;
  const timeoutPromise = new Promise((_, reject) => {
    setTimeout(() => reject(new Error(`Timeout after ${(TIMEOUT_MS / 1000).toFixed(0)}s`)), TIMEOUT_MS);
  });

  let requestPromise, extractText, extractUsage;
  if (shape === 'anthropic') {
    requestPromise = client.messages.create({
      model, max_tokens: MAX_OUTPUT_TOKENS, system: sys,
      messages: [{ role: 'user', content: userPrompt }],
    });
    extractText = (r) => r.content?.[0]?.text?.trim() || '{}';
    extractUsage = (r) => ({ input_tokens: r.usage?.input_tokens ?? 0, output_tokens: r.usage?.output_tokens ?? 0, thinking_tokens: 0 });
  } else {
    requestPromise = client.chat.completions.create({
      model, max_tokens: MAX_OUTPUT_TOKENS,
      messages: [{ role: 'system', content: sys }, { role: 'user', content: userPrompt }],
    });
    extractText = (r) => r.choices?.[0]?.message?.content?.trim() || '{}';
    extractUsage = (r) => ({ input_tokens: r.usage?.prompt_tokens ?? 0, output_tokens: r.usage?.completion_tokens ?? 0, thinking_tokens: 0 });
  }

  try {
    const response = await Promise.race([requestPromise, timeoutPromise]);
    const latencyMs = Date.now() - startMs;
    const text = extractText(response);
    let result;
    try {
      result = JSON.parse(text);
    } catch (parseErr) {
      throw new Error(`Failed to parse Azure Claude JSON response: ${parseErr.message}\nRaw: ${text.slice(0, 500)}`);
    }
    if (zodSchema) {
      const validated = zodSchema.safeParse(result);
      if (validated.success) result = validated.data;
      else process.stderr.write(`  [${passName ?? 'azure-claude'}] Zod validation warning: ${validated.error.message.slice(0, 200)}\n`);
    }
    const usage = { ...extractUsage(response), latency_ms: latencyMs };
    if (passName) {
      process.stderr.write(`  [${passName}] Done in ${(latencyMs / 1000).toFixed(1)}s (${usage.input_tokens} in / ${usage.output_tokens} out)\n`);
    }
    return { result, usage, latencyMs };
  } catch (err) {
    const latencyMs = Date.now() - startMs;
    const detail = err.status ? `HTTP ${err.status}${err.message ? `: ${err.message}` : ''}` : (err.message || 'unknown error');
    const msg = `[${passName ?? 'azure-claude'}] ${detail} (${(latencyMs / 1000).toFixed(1)}s)`;
    process.stderr.write(`  [${passName ?? 'azure-claude'}] FAILED: ${msg}\n`);
    const wrapped = new Error(msg);
    if (err.status) wrapped.status = err.status;
    throw wrapped;
  }
}

// ── Review Orchestrator ────────────────────────────────────────────────────────

/**
 * Run the final review with Gemini or Claude Opus.
 * @param {string} provider - 'gemini' | 'claude-opus' | 'gpt'
 * @param {object} client - Provider-specific client
 * @param {string} planContent
 * @param {string} transcriptContent - JSON string of full audit transcript
 * @param {string} projectContext
 * @returns {Promise<{result: object, usage: object, latencyMs: number}>}
 */
async function runFinalReview(provider, client, planContent, transcriptContent, projectContext, auditMode = 'code') {
  // Parse transcript to extract code file paths for direct code inclusion
  let transcript;
  try {
    transcript = JSON.parse(transcriptContent);
  } catch {
    // If not JSON, treat as markdown transcript
    transcript = { raw: transcriptContent };
  }

  // Read code files if paths are listed in transcript
  let codeContext = '';
  if (transcript.code_files && Array.isArray(transcript.code_files)) {
    const { found } = extractPlanPaths(planContent);
    // Filter out audit-loop infrastructure files — they bleed into scope when
    // consumer repos have synced copies of scripts/ and cause false findings.
    const allFiles = [...new Set([...found, ...transcript.code_files])].filter(f => !isAuditInfraFile(f));
    codeContext = readFilesAsContext(allFiles, { maxPerFile: 8000, maxTotal: 100000 });
  } else {
    // Fall back to extracting from plan (already filtered by extractPlanPaths)
    const { found } = extractPlanPaths(planContent);
    if (found.length > 0) {
      codeContext = readFilesAsContext(found, { maxPerFile: 8000, maxTotal: 100000 });
    }
  }

  // Phase D.4: extract debt-suppression context from transcript envelope.
  // When the upstream audit already filtered debt, tell the reviewer so they
  // don't re-surface the same topics.
  const suppressionContext = transcript._debtMemory?.suppressionContext
    || transcript.debt_memory?.suppressionContext
    || [];
  let debtBlock = '';
  if (Array.isArray(suppressionContext) && suppressionContext.length > 0) {
    const lines = suppressionContext.slice(0, 50).map(s =>
      `- [${s.topicId}] ${s.category} (${s.section}) — ${s.deferredReason}`
    );
    debtBlock = [
      '## Pre-filtered Debt (already suppressed this round — DO NOT resurface)',
      `The following ${suppressionContext.length} topics were matched against the repo's`,
      'persistent debt ledger and filtered from the transcript above. They are',
      'pre-existing concerns explicitly deferred by the operator. If you see new',
      'findings in your review that match any of these topics, EXCLUDE them —',
      'the pipeline already handled them.',
      '',
      ...lines,
      '',
    ].join('\n');
  }

  // Scope block: when the transcript declares changed_files, surface them
  // explicitly so the reviewer knows which files are this PR's responsibility
  // vs which are inlined for context.  Filtered post-hoc by applyScopeFilter().
  const changedFiles = Array.isArray(transcript.changed_files) ? transcript.changed_files : [];
  let scopeBlock = '';
  if (changedFiles.length > 0) {
    scopeBlock = [
      '## Files In Scope (PR diff)',
      'These are the files this PR modified.  new_findings[] entries MUST cite one of these.',
      'Other files in "Code Files" below are inlined for context only — issues there are',
      'pre-existing and out-of-scope for this audit.',
      '',
      ...changedFiles.map(f => `- ${f}`),
      '',
    ].join('\n');
  }

  // Adaptive repo-context (Phase 3 — adaptive-context-blast-radius): give
  // the final reviewer the repo file inventory so it can FALSIFY factual
  // "missing module" claims in the transcript instead of only judging the
  // deliberation. T1 (with the changed files) for a code review; T0 for a
  // plan review. Non-blocking — a failure just omits the block.
  let repoContextBlock = '';
  try {
    const rc = getRepoContext({
      tier: auditMode === 'plan' ? 'T0' : 'T1',
      scope: auditMode === 'plan' ? 'plan' : 'diff',
      targetPaths: changedFiles, baseDir: process.cwd(),
    });
    if (rc.block) {
      repoContextBlock = `## Repository Context (tier ${rc.resolvedTier})\n${rc.block}`;
    }
  } catch { /* non-blocking */ }

  const userPrompt = [
    '## Project Context',
    projectContext,
    '',
    '---',
    '',
    '## Plan',
    planContent,
    '',
    '---',
    '',
    repoContextBlock,
    repoContextBlock ? '---' : '',
    scopeBlock,
    scopeBlock ? '---' : '',
    '## Audit Transcript (Claude-GPT Deliberation)',
    typeof transcript === 'object' && transcript.raw
      ? transcript.raw
      : JSON.stringify(transcript, null, 2),
    '',
    '---',
    '',
    debtBlock,
    debtBlock ? '---' : '',
    '## Code Files',
    codeContext || '(No code files found — review based on transcript only)',
  ].filter(Boolean).join('\n');

  const modelMap = { gemini: MODEL, 'claude-opus': CLAUDE_OPUS_MODEL, 'azure-claude': azureConfig.claudeDeployment };
  const labelMap = { gemini: 'Gemini', 'claude-opus': 'Claude Opus', 'azure-claude': 'Azure Foundry Claude' };
  const selectedModel = modelMap[provider] || provider;
  const providerLabel = labelMap[provider] || provider;
  process.stderr.write(`\n── ${providerLabel} Final Review ──\n`);
  process.stderr.write(`  Model: ${selectedModel}\n`);
  process.stderr.write(`  Context: ~${(userPrompt.length / 4).toFixed(0)} tokens (estimated)\n`);

  // Append classification rubric so new_findings populate the required envelope.
  const classificationBlock = buildClassificationRubric({
    sourceKind: 'REVIEWER',
    sourceName: selectedModel
  });
  let systemPrompt = getReviewPrompt() + classificationBlock;
  if (auditMode === 'plan') {
    systemPrompt += PLAN_MODE_BLOCK;
  }

  if (provider === 'gemini') {
    return callGemini(client, {
      systemPrompt,
      userPrompt,
      zodSchema: GeminiFinalReviewSchema,
      jsonSchema: GeminiFinalReviewJsonSchema,
      passName: 'gemini-review'
    });
  }

  if (provider === 'azure-claude') {
    return callAzureClaude(client, {
      systemPrompt,
      userPrompt,
      zodSchema: GeminiFinalReviewSchema,
      passName: 'azure-claude-review'
    });
  }

  return callClaudeOpus(client, {
    systemPrompt,
    userPrompt,
    zodSchema: GeminiFinalReviewSchema,
    passName: 'claude-opus-review'
  });
}

// ── Output Formatting ──────────────────────────────────────────────────────────

function formatReviewResult(result, usage, latencyMs, provider) {
  const lines = [];
  const selectedModel = provider === 'gemini' ? MODEL : (provider === 'azure-claude' ? azureConfig.claudeDeployment : CLAUDE_OPUS_MODEL);
  const title = provider === 'gemini'
    ? 'Gemini 3.1 Pro — Independent Final Review'
    : 'Claude Opus — Independent Final Review';
  lines.push(`# ${title}`);
  lines.push(`- **Model**: ${selectedModel} | **Latency**: ${(latencyMs / 1000).toFixed(1)}s`);
  lines.push(`- **Tokens**: ${usage.input_tokens} in / ${usage.output_tokens} out (${usage.thinking_tokens} thinking)`);
  lines.push('');

  // Verdict
  const VERDICT_ICONS = { APPROVE: '✅', CONCERNS: '⚠️', CONCERNS_REMAINING: '⚠️', REJECT: '❌' };
  const icon = VERDICT_ICONS[result.verdict] ?? '❌';
  lines.push(`## Verdict: ${icon} **${result.verdict}**`);
  lines.push('');

  // Deliberation quality
  const dq = result.deliberation_quality;
  lines.push('## Deliberation Quality');
  lines.push(`- **Claude bias detected**: ${dq.claude_bias_detected ? 'YES' : 'No'}`);
  lines.push(`- **GPT false positives**: ${dq.gpt_false_positive_count}`);
  lines.push(`- **Deliberation fair**: ${dq.deliberation_was_fair ? 'Yes' : 'NO'}`);
  lines.push(`- **Summary**: ${dq.quality_summary}`);
  lines.push('');

  // Architectural coherence
  lines.push(`## Architectural Coherence: **${result.architectural_coherence}**`);
  lines.push('');

  // Wrongly dismissed
  if (result.wrongly_dismissed?.length > 0) {
    lines.push('## Wrongly Dismissed Findings');
    lines.push('');
    for (const wd of result.wrongly_dismissed) {
      lines.push(`### [${wd.original_finding_id}] → Should be ${wd.recommended_severity}`);
      lines.push(`- **Why**: ${wd.reason_claude_was_wrong}`);
      lines.push('');
    }
  }

  // New findings
  if (result.new_findings?.length > 0) {
    lines.push('## New Findings (missed by both models)');
    lines.push(formatFindings(result.new_findings));
  }

  // Over-engineering
  if (result.over_engineering_flags?.length > 0) {
    lines.push('## Over-Engineering Flags');
    lines.push('');
    for (const flag of result.over_engineering_flags) {
      lines.push(`- ${flag}`);
    }
    lines.push('');
  }

  // Overall reasoning
  lines.push('## Overall Assessment');
  lines.push('');
  lines.push(result.overall_reasoning);

  return lines.join('\n');
}

// ── Main ───────────────────────────────────────────────────────────────────────

// ── main() helpers — keep main() under cognitive-complexity 15 ────────────

async function refreshCatalogAndWarn() {
  if (process.env.MODEL_CATALOG_REFRESH === 'skip') return;
  try { await refreshModelCatalog(); } catch { /* silent */ }
  // Re-resolve BOTH the Gemini reviewer model + the Claude Opus fallback
  // against the freshly-populated live catalog, then reassign. "Always
  // use the latest" path — operators no longer have to update STATIC_POOL
  // manually when a provider ships a new model.
  try {
    const liveGemini = resolveModel(process.env.GEMINI_REVIEW_MODEL || 'latest-pro', { silent: true });
    if (liveGemini !== MODEL) {
      process.stderr.write(`  [model-resolver] upgraded Gemini reviewer ${MODEL} → ${liveGemini}\n`);
      MODEL = liveGemini;
    }
  } catch { /* ignore */ }
  try {
    const liveOpus = resolveModel(process.env.CLAUDE_FINAL_REVIEW_MODEL || 'latest-opus', { silent: true });
    if (liveOpus !== CLAUDE_OPUS_MODEL) {
      process.stderr.write(`  [model-resolver] upgraded Claude Opus fallback ${CLAUDE_OPUS_MODEL} → ${liveOpus}\n`);
      CLAUDE_OPUS_MODEL = liveOpus;
    }
  } catch { /* ignore */ }
}

async function runPingGemini() {
  try {
    const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
    const response = await ai.models.generateContent({ model: MODEL, contents: 'Reply with exactly: Gemini ready' });
    console.log(`✓ ${MODEL}: ${response.text.trim()}`);
    process.exit(0);
  } catch (err) {
    console.error(`✗ ${MODEL}: ${err.message}`);
    process.exit(1);
  }
}

async function runPingClaude() {
  try {
    const { default: Anthropic } = await import('@anthropic-ai/sdk');
    const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
    const response = await anthropic.messages.create({
      model: CLAUDE_OPUS_MODEL,
      max_tokens: 32,
      messages: [{ role: 'user', content: 'Reply with exactly: Claude ready' }],
    });
    const text = response.content?.[0]?.text?.trim() || '';
    console.log(`✓ ${CLAUDE_OPUS_MODEL}: ${text}`);
    process.exit(0);
  } catch (err) {
    console.error(`✗ ${CLAUDE_OPUS_MODEL}: ${err.message}`);
    process.exit(1);
  }
}

async function runPing() {
  if (process.env.GEMINI_API_KEY) await runPingGemini();
  if (process.env.ANTHROPIC_API_KEY) await runPingClaude();
  console.error('Error: set GEMINI_API_KEY or ANTHROPIC_API_KEY');
  process.exit(1);
}

function parseReviewArgs(args) {
  const planFile = args[1];
  const transcriptFile = args[2];
  const jsonMode = args.includes('--json');
  const outIdx = args.indexOf('--out');
  const outFile = outIdx !== -1 && args[outIdx + 1] ? args[outIdx + 1] : null;
  const providerIdx = args.indexOf('--provider');
  const providerOverride = providerIdx !== -1 && args[providerIdx + 1] ? args[providerIdx + 1] : null;
  const modeIdx = args.indexOf('--mode');
  const auditMode = modeIdx !== -1 && args[modeIdx + 1] ? args[modeIdx + 1] : 'code';
  return { planFile, transcriptFile, jsonMode, outFile, providerOverride, auditMode };
}

function selectProvider(providerOverride) {
  if (providerOverride === 'anthropic' || providerOverride === 'claude-opus') {
    if (!process.env.ANTHROPIC_API_KEY) {
      console.error('Error: --provider anthropic requires ANTHROPIC_API_KEY');
      process.exit(1);
    }
    return 'claude-opus';
  }
  if (providerOverride === 'gemini') {
    if (!process.env.GEMINI_API_KEY) {
      console.error('Error: --provider gemini requires GEMINI_API_KEY');
      process.exit(1);
    }
    return 'gemini';
  }
  if (providerOverride === 'azure-claude') {
    assertAzureClaudeReady();
    return 'azure-claude';
  }
  if (providerOverride) {
    console.error(`Error: Unknown provider "${providerOverride}". Use "gemini", "anthropic", or "azure-claude".`);
    process.exit(1);
  }
  // §1.5 precedence: Azure work profile replaces Gemini as the final reviewer
  // (above auto Gemini/Claude selection; CLI override above still wins).
  if (azureConfig.active) {
    assertAzureClaudeReady();
    return 'azure-claude';
  }
  if (process.env.GEMINI_API_KEY) return 'gemini';
  if (process.env.ANTHROPIC_API_KEY) return 'claude-opus';
  console.error('Error: Final review requires GEMINI_API_KEY, ANTHROPIC_API_KEY, or OPENAI_API_KEY');
  console.error('Set GEMINI_API_KEY for Gemini, or ANTHROPIC_API_KEY for Claude Opus fallback.');
  console.error('Or use --provider gemini|anthropic to force a specific provider.');
  process.exit(1);
  return null;
}

/**
 * Fail-fast (Cluster-A audit H3): the azure-claude final reviewer needs the
 * Foundry endpoint + deployment regardless of which transport shape is used.
 */
function assertAzureClaudeReady() {
  const missing = [];
  if (!azureConfig.aiEndpoint) missing.push('AZURE_AI_ENDPOINT');
  if (!azureConfig.claudeDeployment) missing.push('AZURE_FOUNDRY_CLAUDE_DEPLOYMENT');
  if (missing.length > 0) {
    console.error(
      `Error: Azure final reviewer requires ${missing.join(' + ')}. ` +
      `Set ${missing.length > 1 ? 'them' : 'it'} or unset AZURE_OPENAI_ENDPOINT to use Gemini/Claude.`,
    );
    process.exit(1);
  }
}

async function buildClient(provider) {
  if (provider === 'gemini') {
    return new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
  }
  if (provider === 'azure-claude') {
    process.stderr.write(`  [final-review] Azure work profile — Opus via Foundry (${azureConfig.claudeApiShape} shape, ${azureConfig.claudeDeployment}).\n`);
    if (azureConfig.claudeApiShape === 'anthropic') {
      return createAnthropicClient({ baseURL: azureConfig.aiEndpoint });
    }
    return createOpenAIClient({ purpose: 'foundry-claude' });
  }
  const { default: Anthropic } = await import('@anthropic-ai/sdk');
  process.stderr.write(`  [final-review] GEMINI_API_KEY missing; using Claude Opus fallback (${CLAUDE_OPUS_MODEL}).\n`);
  return new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
}

function isJsonTruncationError(err) {
  return err.message?.includes('Unterminated string')
    || err.message?.includes('JSON')
    || err.message?.includes('parse');
}

async function runReviewWithRetry(provider, client, planContent, transcriptContent, projectContext, auditMode) {
  const MAX_ATTEMPTS = 2;
  let txContent = transcriptContent;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      const r = await runFinalReview(provider, client, planContent, txContent, projectContext, auditMode);
      return { ...r, transcriptContent: txContent };
    } catch (err) {
      if (!isJsonTruncationError(err) || attempt >= MAX_ATTEMPTS) throw err;
      process.stderr.write(`  [final-review] JSON truncation on attempt ${attempt} — retrying with conciseness instruction...\n`);
      txContent = JSON.stringify({
        ...JSON.parse(txContent),
        _retryHint: 'IMPORTANT: Your previous response was truncated. Be MORE CONCISE in all string fields. Keep quality_summary under 500 chars and overall_reasoning under 1500 chars.',
      });
    }
  }
  throw new Error('unreachable');
}

async function applyDebtSuppression(result, transcriptContent) {
  try {
    const transcriptObj = JSON.parse(transcriptContent);
    const suppressionCtx = transcriptObj._debtMemory?.suppressionContext
      || transcriptObj.debt_memory?.suppressionContext
      || [];
    if (!Array.isArray(suppressionCtx) || suppressionCtx.length === 0) return;
    if (!Array.isArray(result.new_findings)) return;
    const { jaccardSimilarity } = await import('./lib/ledger.mjs');
    // Threshold 0.30 vs suppressReRaises' 0.35 — debt envelope signatures
    // (category+section) are shorter than new_findings (which include detail
    // text), so asymmetric lengths dilute Jaccard.
    const THRESHOLD = 0.3;
    const before = result.new_findings.length;
    const kept = [];
    const debtSuppressed = [];
    for (const f of result.new_findings) {
      const fSig = `${f.category} ${f.section} ${f.detail}`;
      let match = null;
      let bestScore = 0;
      for (const d of suppressionCtx) {
        const score = jaccardSimilarity(fSig, `${d.category} ${d.section}`);
        if (score > bestScore) { bestScore = score; match = d; }
      }
      if (match && bestScore > THRESHOLD) debtSuppressed.push({ finding: f, matchedTopic: match.topicId, score: bestScore });
      else kept.push(f);
    }
    if (debtSuppressed.length === 0) return;
    process.stderr.write(`  [final-review] Debt re-suppression: ${debtSuppressed.length}/${before} new_findings matched pre-filtered debt\n`);
    for (const s of debtSuppressed.slice(0, 3)) {
      process.stderr.write(`    [debt-suppressed] ${s.matchedTopic.slice(0, 8)} score=${s.score.toFixed(2)}\n`);
    }
    result.new_findings = kept;
    result._debtSuppressedCount = debtSuppressed.length;
  } catch { /* transcript not JSON or no _debtMemory — skip */ }
}

async function applyScopeFilter(result, transcriptContent) {
  try {
    const transcriptObj = JSON.parse(transcriptContent);
    const changedFiles = Array.isArray(transcriptObj.changed_files) ? transcriptObj.changed_files : [];
    if (changedFiles.length === 0) return;
    if (!Array.isArray(result.new_findings)) return;
    // Normalise paths for comparison: trim whitespace, strip leading ./.
    const inScope = new Set(changedFiles.map(f => f.trim().replace(/^\.\//, '')));
    const before = result.new_findings.length;
    const kept = [];
    const scopeFiltered = [];
    for (const f of result.new_findings) {
      const file = (f.file || f.location || '').trim().replace(/^\.\//, '');
      // Empty file → keep (deliberation-level finding, not file-specific).
      if (!file) { kept.push(f); continue; }
      const matched = inScope.has(file) || [...inScope].some(s => file === s || file.endsWith('/' + s) || s.endsWith('/' + file));
      if (matched) kept.push(f);
      else scopeFiltered.push({ finding: f, file });
    }
    if (scopeFiltered.length === 0) return;
    process.stderr.write(`  [final-review] Scope filter: ${scopeFiltered.length}/${before} new_findings cited out-of-scope files (dropped)\n`);
    for (const s of scopeFiltered.slice(0, 3)) {
      process.stderr.write(`    [scope-dropped] ${s.finding.id || '?'} → ${s.file}\n`);
    }
    result.new_findings = kept;
    result._scopeFilteredCount = scopeFiltered.length;
    result._scopeFilteredFindings = scopeFiltered.map(s => ({ id: s.finding.id, file: s.file, hash: s.finding._hash }));
  } catch { /* transcript not JSON or no changed_files — skip */ }
}

function addSemanticIds(result, provider) {
  if (!result.new_findings) return;
  for (let i = 0; i < result.new_findings.length; i++) {
    const f = result.new_findings[i];
    f.id = `${provider === 'gemini' ? 'G' : 'C'}${i + 1}`;
    f._hash = semanticId(f);
    f._source = provider;
  }
}

function emitReviewOutput(result, usage, latencyMs, provider, jsonMode, outFile) {
  if (jsonMode || outFile) {
    const selectedModel = provider === 'gemini' ? MODEL : (provider === 'azure-claude' ? azureConfig.claudeDeployment : CLAUDE_OPUS_MODEL);
    const data = { ...result, _model: selectedModel, _provider: provider, _usage: usage };
    if (outFile) {
      const newCount = result.new_findings?.length ?? 0;
      const dismissedCount = result.wrongly_dismissed?.length ?? 0;
      const summaryLine = `Verdict: ${result.verdict} | New: ${newCount} | Wrongly dismissed: ${dismissedCount} | ${(latencyMs / 1000).toFixed(0)}s`;
      writeOutput(data, outFile, summaryLine);
    } else {
      console.log(JSON.stringify(data, null, 2));
    }
    return;
  }
  console.log(formatReviewResult(result, usage, latencyMs, provider));
}

function recordNewFindings(result, fpTracker, repoFP, revId) {
  if (!Array.isArray(result.new_findings)) return;
  for (const f of result.new_findings) {
    appendOutcome('.audit/outcomes.jsonl', {
      findingId: f.id,
      severity: f.severity,
      category: f.category,
      section: f.section,
      pass: 'gemini-new',
      model: 'gemini',
      accepted: null,
      gemini_reconfirmed: true,
      round: 0,
      promptVariant: revId,
      promptRevisionId: revId,
      semanticHash: f._hash,
    });
    fpTracker.record(f, true, repoFP);
  }
}

function recordWronglyDismissed(result, revId) {
  if (!Array.isArray(result.wrongly_dismissed)) return;
  for (const w of result.wrongly_dismissed) {
    appendOutcome('.audit/outcomes.jsonl', {
      findingId: w.original_finding_id,
      severity: w.recommended_severity,
      category: `[wrongly-dismissed] ${w.original_finding_id}`,
      section: w.reason_claude_was_wrong?.slice(0, 120) || '',
      pass: 'gemini-wrongly-dismissed',
      model: 'gemini',
      accepted: null,
      gemini_reconfirmed: true,
      round: 0,
      promptVariant: revId,
      promptRevisionId: revId,
      semanticHash: semanticId({
        category: w.original_finding_id,
        section: w.reason_claude_was_wrong || '',
        detail: '',
      }),
    });
  }
}

function recordGeminiOutcomes(result) {
  try {
    const repoProfile = generateRepoProfile();
    const repoFP = repoProfile?.repoFingerprint || null;
    const bandit = new PromptBandit();
    const fpTracker = new FalsePositiveTracker();
    const revId = getActiveRevisionId('gemini-review') || 'default';
    recordNewFindings(result, fpTracker, repoFP, revId);
    recordWronglyDismissed(result, revId);
    const VERDICT_REWARDS = { APPROVE: 0.8, CONCERNS: 0.5, CONCERNS_REMAINING: 0.35, REJECT: 0.2 };
    const verdictReward = VERDICT_REWARDS[result.verdict] ?? 0.5;
    bandit.update('gemini-review', revId, verdictReward);
    bandit.flush();
    fpTracker.flush?.();
    const newCount = result.new_findings?.length ?? 0;
    const wrongCount = result.wrongly_dismissed?.length ?? 0;
    if (newCount > 0 || wrongCount > 0) {
      process.stderr.write(`  [learning] Recorded ${newCount} new + ${wrongCount} wrongly-dismissed outcomes for gemini-review pass\n`);
    }
  } catch (learnErr) {
    process.stderr.write(`  [learning] ${learnErr.message?.slice(0, 100)}\n`);
  }
}

async function main() {
  assertRepoRoot(import.meta.url);
  await refreshCatalogAndWarn();

  const args = process.argv.slice(2);
  const mode = args[0];
  if (mode === 'ping') return runPing();

  const { planFile, transcriptFile, jsonMode, outFile, providerOverride, auditMode } = parseReviewArgs(args);
  if (mode !== 'review' || !planFile || !transcriptFile) {
    console.error('Usage: node scripts/gemini-review.mjs review <plan-file> <transcript-file> [--json] [--out <file>] [--provider gemini|anthropic] [--mode plan|code]');
    console.error('       node scripts/gemini-review.mjs ping');
    process.exit(1);
  }
  if (auditMode !== 'plan' && auditMode !== 'code') {
    console.error(`Error: --mode must be "plan" or "code", got "${auditMode}"`);
    process.exit(1);
  }

  const provider = selectProvider(providerOverride);
  const planContent = readFileOrDie(planFile);
  const transcriptContent = readFileOrDie(transcriptFile);
  await initAuditBrief();
  const projectContext = readProjectContext();
  const client = await buildClient(provider);

  try {
    const r = await runReviewWithRetry(provider, client, planContent, transcriptContent, projectContext, auditMode);
    const { result, usage, latencyMs, transcriptContent: usedTranscript } = r;
    await applyDebtSuppression(result, usedTranscript);
    await applyScopeFilter(result, usedTranscript);
    addSemanticIds(result, provider);
    emitReviewOutput(result, usage, latencyMs, provider, jsonMode, outFile);
    recordGeminiOutcomes(result);
  } catch (err) {
    console.error(`Error: ${err.message}`);
    process.exit(1);
  }
}

main();
