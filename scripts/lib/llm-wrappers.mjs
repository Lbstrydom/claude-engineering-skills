/**
 * @fileoverview Shared LLM wrapper module — standard {result, usage, latencyMs} envelope.
 * All new LLM calls in refinement/evolution must go through createLearningAdapter().
 * Adapter accepts injected provider clients — no self-created clients.
 * @module scripts/lib/llm-wrappers
 */

import { z } from 'zod';
import { zodTextFormat } from 'openai/helpers/zod';
import { openaiConfig, briefConfig } from './config.mjs';

/**
 * Lazily construct + cache a single Gemini (`GoogleGenAI`) client for the
 * process. Returns `null` when `GEMINI_API_KEY` is unset (callers degrade
 * gracefully). One client per process — never construct per call/batch.
 * @returns {Promise<import('@google/genai').GoogleGenAI|null>}
 */
let _geminiClient = null;
export async function getGeminiClient() {
  if (_geminiClient) return _geminiClient;
  if (!process.env.GEMINI_API_KEY) return null;
  const { GoogleGenAI } = await import('@google/genai');
  _geminiClient = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
  return _geminiClient;
}

/**
 * Make a safe GPT call with structured output. Extracted from openai-audit.mjs.
 * Returns standard envelope or null on failure.
 * @param {import('openai').default} openai - Pre-configured OpenAI client
 * @param {string} systemPrompt
 * @param {string} userPrompt
 * @param {import('zod').ZodSchema} schema
 * @param {object} options
 * @returns {Promise<{result: object, usage: object, latencyMs: number}|null>}
 */
export async function safeCallGPT(openai, systemPrompt, userPrompt, schema, options = {}) {
  const { model = openaiConfig.model, maxOutputTokens = 8000, timeoutMs = 120000 } = options;
  const start = Date.now();
  try {
    const response = await openai.responses.parse({
      model,
      instructions: systemPrompt,
      input: userPrompt,
      text: { format: zodTextFormat(schema, 'result') },
      max_output_tokens: maxOutputTokens,
      timeout: timeoutMs
    });

    const parsed = response.output_parsed;
    const usage = response.usage || {};
    return { result: parsed, usage, latencyMs: Date.now() - start };
  } catch (err) {
    process.stderr.write(`  [llm-wrapper] GPT call failed: ${err.message}\n`);
    return null;
  }
}

/**
 * Call Gemini with structured output. Extracted from gemini-review.mjs.
 * @param {import('@google/genai').GoogleGenAI} ai - Pre-configured Gemini client
 * @param {string} systemPrompt
 * @param {string} userPrompt
 * @param {object} jsonSchema - Gemini-compatible JSON Schema (from zodToGeminiSchema)
 * @param {object} options
 * @returns {Promise<{result: object, usage: object, latencyMs: number}|null>}
 */
export async function callGemini(ai, systemPrompt, userPrompt, jsonSchema, options = {}) {
  const { model = briefConfig.geminiModel, maxOutputTokens = 8000, timeoutMs = 120000, zodSchema = null } = options;
  const start = Date.now();
  try {
    const response = await ai.models.generateContent({
      model,
      contents: userPrompt,
      config: {
        systemInstruction: systemPrompt,
        maxOutputTokens,
        responseMimeType: 'application/json',
        responseSchema: jsonSchema
      }
    });

    const parsed = JSON.parse(response.text);

    // Validate parsed response with Zod schema if provided
    if (zodSchema) {
      const validation = zodSchema.safeParse(parsed);
      if (!validation.success) {
        process.stderr.write(`  [llm-wrapper] Gemini response failed Zod validation: ${validation.error.message}\n`);
        return null;
      }
    }

    const usage = response.usageMetadata || {};
    return { result: parsed, usage, latencyMs: Date.now() - start };
  } catch (err) {
    process.stderr.write(`  [llm-wrapper] Gemini call failed: ${err.message}\n`);
    return null;
  }
}

/**
 * Call Claude with structured output.
 *
 * Accepts either a raw `@anthropic-ai/sdk` instance or an adapter from
 * `createAnthropicClient()` — both expose the same `.messages.create()` shape.
 * Use the factory for new code so `CLAUDE_BACKEND=cli` can flip the whole
 * codebase onto the Max 20x Agent SDK credit pool from 2026-06-15.
 *
 * @param {{messages: {create: Function}}} anthropic - Pre-configured client or factory adapter
 * @param {string} systemPrompt
 * @param {string} userPrompt
 * @param {import('zod').ZodSchema} schema - Used for post-parse validation
 * @param {object} options
 * @returns {Promise<{result: object, usage: object, latencyMs: number}|null>}
 */
export async function callClaude(anthropic, systemPrompt, userPrompt, schema, options = {}) {
  const { model = briefConfig.claudeModel, maxTokens = 4000 } = options;
  const start = Date.now();
  try {
    const response = await anthropic.messages.create({
      model,
      max_tokens: maxTokens,
      system: systemPrompt,
      messages: [{ role: 'user', content: userPrompt }]
    });

    let text = response.content?.[0]?.text || '';
    // Extract JSON block if wrapped in markdown code fences or conversational text
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (jsonMatch) text = jsonMatch[0];
    const parsed = JSON.parse(text);
    if (schema) {
      const result = schema.safeParse(parsed);
      if (!result.success) {
        process.stderr.write(`  [llm-wrapper] Claude response failed validation: ${result.error.message}\n`);
        return null;
      }
    }
    const usage = response.usage || {};
    return { result: parsed, usage, latencyMs: Date.now() - start };
  } catch (err) {
    process.stderr.write(`  [llm-wrapper] Claude call failed: ${err.message}\n`);
    return null;
  }
}

/**
 * Create a learning adapter with injected provider clients.
 * Used by refinement/evolution — never creates its own clients.
 * @param {object} providers - { openai?, gemini?, anthropic? } pre-configured instances
 * @returns {{ generateViaLLM: Function }}
 */
export function createLearningAdapter(providers = {}) {
  const { openai, gemini, anthropic } = providers;

  return {
    /**
     * Generate structured output via best available LLM.
     * Try Gemini Flash first (cheaper), fall back to Claude Haiku, then GPT.
     * @param {string} systemPrompt
     * @param {string} userPrompt
     * @param {import('zod').ZodSchema} schema
     * @param {object} [jsonSchema] - Gemini-compatible schema (from zodToGeminiSchema)
     * @returns {Promise<{result: object, usage: object, latencyMs: number}|null>}
     */
    async generateViaLLM(systemPrompt, userPrompt, schema, jsonSchema) {
      if (gemini && jsonSchema) {
        const result = await callGemini(gemini, systemPrompt, userPrompt, jsonSchema);
        if (result) return result;
      }
      if (anthropic) {
        const result = await callClaude(anthropic, systemPrompt, userPrompt, schema);
        if (result) return result;
      }
      if (openai) {
        const result = await safeCallGPT(openai, systemPrompt, userPrompt, schema);
        if (result) return result;
      }
      process.stderr.write('  [llm-wrapper] No LLM provider available\n');
      return null;
    }
  };
}
