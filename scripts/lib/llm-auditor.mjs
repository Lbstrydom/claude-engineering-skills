/**
 * @fileoverview Unified LLM auditor abstraction for A/B testing pipeline variants.
 *
 * Provides a single `callAuditor()` function that dispatches to GPT or Gemini,
 * keeping the same return contract: { result, usage, latencyMs }.
 *
 * Pipeline variants:
 *   A (control):   GPT-5.4 audits → Gemini final review
 *   B (treatment): Gemini audits  → GPT final review
 *
 * @module scripts/lib/llm-auditor
 */
import fs from 'node:fs';
import path from 'node:path';
import { zodTextFormat } from 'openai/helpers/zod';
import { zodToGeminiSchema } from './schemas.mjs';
import { openaiConfig, geminiConfig } from './config.mjs';

// ── Pipeline Variant ────────────────────────────────────────────────────────

/**
 * Pipeline variant definitions.
 * Each variant specifies which provider handles auditing vs final review.
 */
export const PIPELINE_VARIANTS = Object.freeze({
  A: { auditor: 'gpt', reviewer: 'gemini', label: 'GPT-audit + Gemini-review (control)' },
  B: { auditor: 'gemini', reviewer: 'gpt', label: 'Gemini-audit + GPT-review (treatment)' },
});

/** State file for deterministic alternation between pipeline variants. */
const PIPELINE_STATE_FILE = '.audit/pipeline-state.json';

/**
 * Select a pipeline variant. Priority:
 *   1. Explicit --pipeline flag
 *   2. AUDIT_PIPELINE_VARIANT env var
 *   3. Deterministic alternation (A → B → A → B) persisted in .audit/pipeline-state.json
 *
 * @param {string|null} explicit - From --pipeline CLI flag
 * @returns {{ variant: string, config: object, source: string }}
 */
export function selectPipelineVariant(explicit = null) {
  if (explicit && PIPELINE_VARIANTS[explicit.toUpperCase()]) {
    const v = explicit.toUpperCase();
    return { variant: v, config: PIPELINE_VARIANTS[v], source: 'cli' };
  }
  const envVar = process.env.AUDIT_PIPELINE_VARIANT;
  if (envVar && PIPELINE_VARIANTS[envVar.toUpperCase()]) {
    const v = envVar.toUpperCase();
    return { variant: v, config: PIPELINE_VARIANTS[v], source: 'env' };
  }

  // Deterministic alternation: read last variant, flip it
  const statePath = path.resolve(PIPELINE_STATE_FILE);
  let lastVariant = null;
  try {
    const state = JSON.parse(fs.readFileSync(statePath, 'utf-8'));
    lastVariant = state.lastVariant;
  } catch { /* no state file yet */ }

  const v = lastVariant === 'A' ? 'B' : 'A'; // First run defaults to A

  // Persist for next run — read existing state to preserve runCount
  try {
    const dir = path.dirname(statePath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    let existingState = {};
    try { existingState = JSON.parse(fs.readFileSync(statePath, 'utf-8')); } catch { /* first run */ }
    fs.writeFileSync(statePath, JSON.stringify({
      ...existingState,
      lastVariant: v,
      updatedAt: new Date().toISOString(),
      runCount: (existingState.runCount || 0) + 1,
    }, null, 2));
  } catch { /* non-fatal — next run will just pick A again */ }

  return { variant: v, config: PIPELINE_VARIANTS[v], source: 'alternation' };
}

/**
 * Increment the run counter in pipeline state without changing variant.
 * Called after each completed audit to track total runs for meta-assessment.
 * @param {string} [statePath]
 */
export function incrementRunCounter(statePath = path.resolve(PIPELINE_STATE_FILE)) {
  try {
    const state = JSON.parse(fs.readFileSync(statePath, 'utf-8'));
    state.runCount = (state.runCount || 0) + 1;
    state.lastRunAt = new Date().toISOString();
    fs.writeFileSync(statePath, JSON.stringify(state, null, 2));
  } catch { /* non-fatal */ }
}

// ── Unified Auditor Call ────────────────────────────────────────────────────

/**
 * Error class for structured LLM errors (mirrors LlmError from robustness.mjs).
 */
class AuditorError extends Error {
  constructor(message, { category, usage, retryable = false } = {}) {
    super(message);
    this.name = 'AuditorError';
    this.category = category;
    this.llmUsage = usage;
    this.retryable = retryable;
  }
}

/**
 * Call GPT as auditor using OpenAI structured output.
 * @private
 */
async function _callGPTAuditor(openai, { systemPrompt, userPrompt, schema, schemaName, reasoning, maxTokens, timeoutMs, passName }) {
  const effort = reasoning ?? openaiConfig.reasoning;
  const tokens = maxTokens ?? openaiConfig.maxOutputTokensCap;
  const timeout = timeoutMs ?? openaiConfig.timeoutMsCap;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  const startMs = Date.now();

  if (passName) {
    process.stderr.write(`  [${passName}] GPT auditor (reasoning: ${effort}, timeout: ${(timeout / 1000).toFixed(0)}s)...\n`);
  }

  try {
    const requestParams = {
      model: openaiConfig.model,
      input: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt }
      ],
      text: { format: zodTextFormat(schema, schemaName) },
      max_output_tokens: tokens
    };

    if (openaiConfig.model.startsWith('gpt-5')) {
      requestParams.reasoning = { effort };
    }

    const response = await openai.responses.parse(requestParams, { signal: controller.signal });
    clearTimeout(timer);
    const latencyMs = Date.now() - startMs;

    const usage = {
      input_tokens: response.usage?.input_tokens ?? 0,
      output_tokens: response.usage?.output_tokens ?? 0,
      reasoning_tokens: response.usage?.output_tokens_details?.reasoning_tokens ?? 0,
      latency_ms: latencyMs,
      provider: 'gpt',
      model: openaiConfig.model,
    };

    if (response.status === 'incomplete') {
      throw new AuditorError(`Response incomplete: ${response.incomplete_details?.reason ?? 'unknown'}`,
        { category: 'incomplete', usage, retryable: true });
    }

    for (const item of (response.output ?? [])) {
      if (item?.status === 'incomplete') {
        throw new AuditorError(`Output truncated: ${item.incomplete_details?.reason ?? 'max_tokens'}`,
          { category: 'truncated', usage, retryable: true });
      }
    }

    const result = response.output_parsed;
    if (!result) throw new AuditorError('No parsed output', { category: 'empty', usage });

    if (result.findings !== undefined && !Array.isArray(result.findings)) {
      throw new AuditorError(`findings is ${typeof result.findings}, expected array`,
        { category: 'schema', usage });
    }

    if (passName) {
      process.stderr.write(`  [${passName}] Done in ${(latencyMs / 1000).toFixed(1)}s (${usage.input_tokens} in / ${usage.output_tokens} out)\n`);
    }

    return { result, usage, latencyMs };

  } catch (err) {
    clearTimeout(timer);
    if (err instanceof AuditorError) throw err;
    const latencyMs = Date.now() - startMs;
    const isAbort = err.name === 'AbortError' || err.message?.toLowerCase().includes('abort');
    throw new AuditorError(
      isAbort ? `Timeout after ${(timeout / 1000).toFixed(0)}s` : err.message,
      { category: isAbort ? 'timeout' : 'api', retryable: isAbort }
    );
  }
}

/**
 * Call Gemini as auditor using structured JSON output.
 * @private
 */
async function _callGeminiAuditor(geminiClient, { systemPrompt, userPrompt, schema, schemaName, reasoning, maxTokens, timeoutMs, passName }) {
  const timeout = timeoutMs ?? geminiConfig.timeoutMs;
  const tokens = maxTokens ?? geminiConfig.maxOutputTokens;

  // Map reasoning effort to thinking budget
  const thinkingBudget = reasoning === 'low' ? 4096
    : reasoning === 'medium' ? 8192
    : 16384;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  const startMs = Date.now();

  // Convert Zod schema to Gemini JSON Schema
  const jsonSchema = zodToGeminiSchema(schema);

  if (passName) {
    process.stderr.write(`  [${passName}] Gemini auditor (thinking: ${thinkingBudget}, timeout: ${(timeout / 1000).toFixed(0)}s)...\n`);
  }

  try {
    const response = await geminiClient.models.generateContent({
      model: geminiConfig.model,
      contents: userPrompt,
      config: {
        systemInstruction: systemPrompt,
        responseMimeType: 'application/json',
        responseSchema: jsonSchema,
        maxOutputTokens: tokens,
        thinkingConfig: { thinkingBudget }
      }
    }, { signal: controller.signal });
    clearTimeout(timer);
    const latencyMs = Date.now() - startMs;

    const text = response.text;
    let result;
    try {
      result = JSON.parse(text);
    } catch (parseErr) {
      throw new AuditorError(`JSON parse failed: ${parseErr.message}`, { category: 'parse' });
    }

    // Validate with Zod
    const validated = schema.safeParse(result);
    if (validated.success) {
      result = validated.data;
    } else {
      const errMsg = validated.error.message.slice(0, 300);
      process.stderr.write(`  [${passName ?? 'gemini'}] Zod validation FAILED: ${errMsg}\n`);
      throw new AuditorError(`Schema validation failed: ${errMsg}`, { category: 'schema' });
    }

    const usage = {
      input_tokens: response.usageMetadata?.promptTokenCount ?? 0,
      output_tokens: response.usageMetadata?.candidatesTokenCount ?? 0,
      reasoning_tokens: response.usageMetadata?.thoughtsTokenCount ?? 0,
      latency_ms: latencyMs,
      provider: 'gemini',
      model: geminiConfig.model,
    };

    if (passName) {
      process.stderr.write(`  [${passName}] Done in ${(latencyMs / 1000).toFixed(1)}s (${usage.input_tokens} in / ${usage.output_tokens} out / ${usage.reasoning_tokens} thinking)\n`);
    }

    return { result, usage, latencyMs };

  } catch (err) {
    clearTimeout(timer);
    if (err instanceof AuditorError) throw err;
    const latencyMs = Date.now() - startMs;
    const isAbort = err.name === 'AbortError' || err.message?.toLowerCase().includes('abort');
    throw new AuditorError(
      isAbort ? `Timeout after ${(timeout / 1000).toFixed(0)}s` : err.message,
      { category: isAbort ? 'timeout' : 'api', retryable: isAbort }
    );
  }
}

// ── Public API ──────────────────────────────────────────────────────────────

/**
 * Unified auditor call — dispatches to GPT or Gemini based on provider.
 * Same return contract: { result, usage, latencyMs }
 *
 * @param {string} provider - 'gpt' or 'gemini'
 * @param {object} client - OpenAI or GoogleGenAI client instance
 * @param {object} opts
 * @param {string} opts.systemPrompt
 * @param {string} opts.userPrompt
 * @param {import('zod').ZodType} opts.schema - Zod schema (converted to Gemini JSON Schema automatically)
 * @param {string} opts.schemaName
 * @param {string} [opts.reasoning] - 'low' | 'medium' | 'high'
 * @param {number} [opts.maxTokens]
 * @param {number} [opts.timeoutMs]
 * @param {string} [opts.passName]
 * @returns {Promise<{result: object, usage: object, latencyMs: number}>}
 */
export async function callAuditor(provider, client, opts) {
  if (provider === 'gpt') {
    return _callGPTAuditor(client, opts);
  } else if (provider === 'gemini') {
    return _callGeminiAuditor(client, opts);
  }
  throw new Error(`Unknown auditor provider: ${provider}`);
}

/**
 * Safe wrapper — catches failures and returns empty results.
 * Same pattern as safeCallGPT but provider-agnostic.
 *
 * @param {string} provider
 * @param {object} client
 * @param {object} opts
 * @param {object} emptyResult - Fallback result on failure
 * @returns {Promise<{result: object, usage: object, latencyMs: number}>}
 */
export async function safeCallAuditor(provider, client, opts, emptyResult) {
  try {
    return await callAuditor(provider, client, opts);
  } catch (err) {
    process.stderr.write(`  [${opts.passName}] Graceful degradation — using empty result (${err.message?.slice(0, 100)})\n`);
    return {
      result: emptyResult,
      usage: { input_tokens: 0, output_tokens: 0, reasoning_tokens: 0, latency_ms: 0, provider, model: 'fallback' },
      latencyMs: 0,
      failed: true,
      error: err.message
    };
  }
}

/**
 * Create the appropriate LLM client for a provider.
 * @param {string} provider - 'gpt' or 'gemini'
 * @returns {Promise<object>} Client instance
 */
export async function createAuditorClient(provider) {
  if (provider === 'gpt') {
    const OpenAI = (await import('openai')).default;
    return new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  } else if (provider === 'gemini') {
    const { GoogleGenAI } = await import('@google/genai');
    return new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
  }
  throw new Error(`Unknown provider: ${provider}`);
}

/**
 * Check if a provider has the required API key configured.
 * @param {string} provider - 'gpt' or 'gemini'
 * @returns {boolean}
 */
export function hasProviderKey(provider) {
  if (provider === 'gpt') return !!process.env.OPENAI_API_KEY;
  if (provider === 'gemini') return !!process.env.GEMINI_API_KEY;
  return false;
}
