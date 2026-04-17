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
import { readFileOrDie, readFilesAsContext, extractPlanPaths, writeOutput } from './lib/file-io.mjs';
import { semanticId, formatFindings, appendOutcome, FalsePositiveTracker } from './lib/findings.mjs';
import { readProjectContext, initAuditBrief, generateRepoProfile } from './lib/context.mjs';
import { geminiConfig, claudeConfig } from './lib/config.mjs';
import { PromptBandit } from './bandit.mjs';
import { getActivePrompt, getActiveRevisionId, bootstrapFromConstants } from './lib/prompt-registry.mjs';
// NOTE: lib/llm-wrappers.mjs provides shared wrappers for learning/refinement/evolution paths.
// This module keeps specialized callGemini/callClaudeOpus with thinkingConfig + abort controller
// because the final review requires high-budget reasoning and precise timeout handling.
// Future: extract shared patterns to llm-wrappers while keeping specialized configs here.

// ── Configuration (from centralized config) ─────────────────────────────────

const MODEL = geminiConfig.model;
const CLAUDE_OPUS_MODEL = claudeConfig.finalReviewModel;
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
   can be detected. If you cite "line 132" of a file, it must actually contain relevant code.`;

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
    const msg = isAbort
      ? `[${passName ?? 'gemini'}] Timeout after ${(TIMEOUT_MS / 1000).toFixed(0)}s`
      : `[${passName ?? 'gemini'}] ${err.message} (${(latencyMs / 1000).toFixed(1)}s)`;
    process.stderr.write(`  [${passName ?? 'gemini'}] FAILED: ${msg}\n`);
    throw new Error(msg);
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
    const msg = `[${passName ?? 'claude-opus'}] ${err.message} (${(latencyMs / 1000).toFixed(1)}s)`;
    process.stderr.write(`  [${passName ?? 'claude-opus'}] FAILED: ${msg}\n`);
    throw new Error(msg);
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
    const allFiles = [...new Set([...found, ...transcript.code_files])];
    codeContext = readFilesAsContext(allFiles, { maxPerFile: 8000, maxTotal: 100000 });
  } else {
    // Fall back to extracting from plan
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

  const modelMap = { gemini: MODEL, 'claude-opus': CLAUDE_OPUS_MODEL };
  const labelMap = { gemini: 'Gemini', 'claude-opus': 'Claude Opus' };
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
  const selectedModel = provider === 'gemini' ? MODEL : CLAUDE_OPUS_MODEL;
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

async function main() {
  const args = process.argv.slice(2);
  const mode = args[0];

  // Ping mode — quick connectivity test
  if (mode === 'ping') {
    if (process.env.GEMINI_API_KEY) {
      try {
        const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
        const response = await ai.models.generateContent({
          model: MODEL,
          contents: 'Reply with exactly: Gemini ready'
        });
        console.log(`✓ ${MODEL}: ${response.text.trim()}`);
        process.exit(0);
      } catch (err) {
        console.error(`✗ ${MODEL}: ${err.message}`);
        process.exit(1);
      }
    }

    if (process.env.ANTHROPIC_API_KEY) {
      try {
        const { default: Anthropic } = await import('@anthropic-ai/sdk');
        const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
        const response = await anthropic.messages.create({
          model: CLAUDE_OPUS_MODEL,
          max_tokens: 32,
          messages: [{ role: 'user', content: 'Reply with exactly: Claude ready' }]
        });
        const text = response.content?.[0]?.text?.trim() || '';
        console.log(`✓ ${CLAUDE_OPUS_MODEL}: ${text}`);
        process.exit(0);
      } catch (err) {
        console.error(`✗ ${CLAUDE_OPUS_MODEL}: ${err.message}`);
        process.exit(1);
      }
    }

    console.error('Error: set GEMINI_API_KEY or ANTHROPIC_API_KEY');
    process.exit(1);
  }

  // Review mode
  const planFile = args[1];
  const transcriptFile = args[2];
  const jsonMode = args.includes('--json');
  const outIdx = args.indexOf('--out');
  const outFile = outIdx !== -1 && args[outIdx + 1] ? args[outIdx + 1] : null;
  const providerIdx = args.indexOf('--provider');
  const providerOverride = providerIdx !== -1 && args[providerIdx + 1] ? args[providerIdx + 1] : null;
  const modeIdx = args.indexOf('--mode');
  const auditMode = modeIdx !== -1 && args[modeIdx + 1] ? args[modeIdx + 1] : 'code';

  if (mode !== 'review' || !planFile || !transcriptFile) {
    console.error('Usage: node scripts/gemini-review.mjs review <plan-file> <transcript-file> [--json] [--out <file>] [--provider gemini|anthropic] [--mode plan|code]');
    console.error('       node scripts/gemini-review.mjs ping');
    process.exit(1);
  }

  if (auditMode !== 'plan' && auditMode !== 'code') {
    console.error(`Error: --mode must be "plan" or "code", got "${auditMode}"`);
    process.exit(1);
  }

  // --provider flag overrides env var auto-detection
  let provider = null;
  if (providerOverride === 'anthropic' || providerOverride === 'claude-opus') {
    if (!process.env.ANTHROPIC_API_KEY) {
      console.error('Error: --provider anthropic requires ANTHROPIC_API_KEY');
      process.exit(1);
    }
    provider = 'claude-opus';
  } else if (providerOverride === 'gemini') {
    if (!process.env.GEMINI_API_KEY) {
      console.error('Error: --provider gemini requires GEMINI_API_KEY');
      process.exit(1);
    }
    provider = 'gemini';
  } else if (providerOverride) {
    console.error(`Error: Unknown provider "${providerOverride}". Use "gemini" or "anthropic".`);
    process.exit(1);
  } else if (process.env.GEMINI_API_KEY) {
    // Auto-detect from env vars (existing behavior)
    provider = 'gemini';
  } else if (process.env.ANTHROPIC_API_KEY) {
    provider = 'claude-opus';
  }
  if (!provider) {
    console.error('Error: Final review requires GEMINI_API_KEY, ANTHROPIC_API_KEY, or OPENAI_API_KEY');
    console.error('Set GEMINI_API_KEY for Gemini, or ANTHROPIC_API_KEY for Claude Opus fallback.');
    console.error('Or use --provider gemini|anthropic to force a specific provider.');
    process.exit(1);
  }

  const planContent = readFileOrDie(planFile);
  let transcriptContent = readFileOrDie(transcriptFile);
  await initAuditBrief(); // Pre-generate context brief
  const projectContext = readProjectContext();
  let client;
  if (provider === 'gemini') {
    client = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
  } else {
    const { default: Anthropic } = await import('@anthropic-ai/sdk');
    client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
    process.stderr.write(`  [final-review] GEMINI_API_KEY missing; using Claude Opus fallback (${CLAUDE_OPUS_MODEL}).\n`);
  }

  try {
    // Auto-retry on JSON truncation (Gemini verbosity can exceed output limits)
    let result, usage, latencyMs;
    const MAX_REVIEW_ATTEMPTS = 2;
    for (let attempt = 1; attempt <= MAX_REVIEW_ATTEMPTS; attempt++) {
      try {
        ({ result, usage, latencyMs } = await runFinalReview(provider, client, planContent, transcriptContent, projectContext, auditMode));
        break; // Success
      } catch (err) {
        const isTruncation = err.message?.includes('Unterminated string') ||
          err.message?.includes('JSON') ||
          err.message?.includes('parse');
        if (isTruncation && attempt < MAX_REVIEW_ATTEMPTS) {
          process.stderr.write(`  [final-review] JSON truncation on attempt ${attempt} — retrying with conciseness instruction...\n`);
          // Append conciseness hint to transcript for retry
          transcriptContent = JSON.stringify({
            ...JSON.parse(transcriptContent),
            _retryHint: 'IMPORTANT: Your previous response was truncated. Be MORE CONCISE in all string fields. Keep quality_summary under 500 chars and overall_reasoning under 1500 chars.'
          });
          continue;
        }
        throw err;
      }
    }

    // Phase D.4 defense-in-depth: re-suppress Gemini new_findings that match
    // pre-filtered debt topics, even if the reviewer ignored our warning.
    // Fuzzy match on category+section+detail against the transcript envelope.
    try {
      const transcriptObj = JSON.parse(transcriptContent);
      const suppressionCtx = transcriptObj._debtMemory?.suppressionContext
        || transcriptObj.debt_memory?.suppressionContext
        || [];
      if (Array.isArray(suppressionCtx) && suppressionCtx.length > 0 && Array.isArray(result.new_findings)) {
        const { jaccardSimilarity } = await import('./lib/ledger.mjs');
        // Threshold 0.30 (slightly lower than suppressReRaises' 0.35) because
        // debt envelope signatures are short (category+section) while Gemini's
        // new_findings include long detail text — asymmetric signature lengths
        // dilute Jaccard. 0.30 captures real matches without over-suppressing.
        const THRESHOLD = 0.3;
        const before = result.new_findings.length;
        const kept = [];
        const debtSuppressed = [];
        for (const f of result.new_findings) {
          const fSig = `${f.category} ${f.section} ${f.detail}`;
          let match = null;
          let bestScore = 0;
          for (const d of suppressionCtx) {
            const dSig = `${d.category} ${d.section}`;
            const score = jaccardSimilarity(fSig, dSig);
            if (score > bestScore) { bestScore = score; match = d; }
          }
          if (match && bestScore > THRESHOLD) {
            debtSuppressed.push({ finding: f, matchedTopic: match.topicId, score: bestScore });
          } else {
            kept.push(f);
          }
        }
        if (debtSuppressed.length > 0) {
          process.stderr.write(`  [final-review] Debt re-suppression: ${debtSuppressed.length}/${before} new_findings matched pre-filtered debt\n`);
          for (const s of debtSuppressed.slice(0, 3)) {
            process.stderr.write(`    [debt-suppressed] ${s.matchedTopic.slice(0, 8)} score=${s.score.toFixed(2)}\n`);
          }
          result.new_findings = kept;
          result._debtSuppressedCount = debtSuppressed.length;
        }
      }
    } catch { /* transcript not JSON or no _debtMemory — skip */ }

    // Add semantic hashes to new findings for cross-model tracking
    if (result.new_findings) {
      for (let i = 0; i < result.new_findings.length; i++) {
        const f = result.new_findings[i];
        f.id = `${provider === 'gemini' ? 'G' : 'C'}${i + 1}`;
        f._hash = semanticId(f);
        f._source = provider;
      }
    }

    if (jsonMode || outFile) {
      const selectedModel = provider === 'gemini' ? MODEL : CLAUDE_OPUS_MODEL;
      const data = { ...result, _model: selectedModel, _provider: provider, _usage: usage };
      if (outFile) {
        const newCount = result.new_findings?.length ?? 0;
        const dismissedCount = result.wrongly_dismissed?.length ?? 0;
        const summaryLine = `Verdict: ${result.verdict} | New: ${newCount} | Wrongly dismissed: ${dismissedCount} | ${(latencyMs / 1000).toFixed(0)}s`;
        writeOutput(data, outFile, summaryLine);
      } else {
        console.log(JSON.stringify(data, null, 2));
      }
    } else {
      console.log(formatReviewResult(result, usage, latencyMs, provider));
    }

    // ── Learning: record Gemini findings as outcomes ──────────────────────
    // This feeds the bandit, FP tracker, meta-assessment, and prompt refinement
    // for the 'gemini-review' pass — same pipeline as GPT audit passes.
    try {
      const repoProfile = generateRepoProfile();
      const repoFP = repoProfile?.repoFingerprint || null;
      const bandit = new PromptBandit();
      const fpTracker = new FalsePositiveTracker();
      const revId = getActiveRevisionId('gemini-review') || 'default';

      // Record new_findings as outcomes (initially accepted=true, updated after deliberation)
      if (Array.isArray(result.new_findings)) {
        for (const f of result.new_findings) {
          appendOutcome('.audit/outcomes.jsonl', {
            findingId: f.id,
            severity: f.severity,
            category: f.category,
            section: f.section,
            pass: 'gemini-review',
            accepted: true, // Will be updated by orchestrator after Step 7.1 deliberation
            round: 0, // Final review = post-convergence
            promptVariant: revId,
            promptRevisionId: revId,
            semanticHash: f._hash,
          });
          fpTracker.record(f, true, repoFP);
        }
      }

      // Record wrongly_dismissed as high-signal outcomes (Gemini caught what GPT missed)
      if (Array.isArray(result.wrongly_dismissed)) {
        for (const w of result.wrongly_dismissed) {
          appendOutcome('.audit/outcomes.jsonl', {
            findingId: w.original_finding_id,
            severity: w.recommended_severity,
            category: `[wrongly-dismissed] ${w.original_finding_id}`,
            section: w.reason_claude_was_wrong?.slice(0, 120) || '',
            pass: 'gemini-review',
            accepted: true, // Wrongly dismissed = Gemini was right
            round: 0,
            promptVariant: revId,
            promptRevisionId: revId,
            semanticHash: semanticId({ category: w.original_finding_id, section: w.reason_claude_was_wrong || '', detail: '' }),
          });
        }
      }

      // Update bandit for the review prompt variant
      // Reward based on verdict: APPROVE (fair deliberation) = good, REJECT (missed issues) = bad
      const VERDICT_REWARDS = { APPROVE: 0.8, CONCERNS: 0.5, CONCERNS_REMAINING: 0.35, REJECT: 0.2 };
      const verdictReward = VERDICT_REWARDS[result.verdict] ?? 0.5;
      bandit.update('gemini-review', revId, verdictReward);
      bandit.flush();

      // Persist FP tracker
      fpTracker.flush?.();

      const newCount = result.new_findings?.length ?? 0;
      const wrongCount = result.wrongly_dismissed?.length ?? 0;
      if (newCount > 0 || wrongCount > 0) {
        process.stderr.write(`  [learning] Recorded ${newCount} new + ${wrongCount} wrongly-dismissed outcomes for gemini-review pass\n`);
      }
    } catch (learnErr) {
      process.stderr.write(`  [learning] ${learnErr.message?.slice(0, 100)}\n`);
    }

  } catch (err) {
    console.error(`Error: ${err.message}`);
    process.exit(1);
  }
}

main();
