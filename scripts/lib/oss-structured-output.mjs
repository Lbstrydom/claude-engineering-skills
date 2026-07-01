/**
 * @fileoverview Chat-Completions structured-output adapter for OSS auditor arms.
 *
 * Plan: docs/plans/model-ab-experiment-harness.md (decision 9 — R1-H2, a real
 * blocker). OpenRouter / OSS routers support `/chat/completions`, generally NOT
 * the OpenAI Responses API our GPT passes use — so an OSS arm cannot baseURL-
 * swap into `responses.parse()`. This adapter is the ONE seam that differs:
 * it issues `chat.completions.create` with `response_format: json_schema`
 * (falling back to tool-calling for models lacking it) using the SAME Zod
 * schema the GPT passes use, then validates the reply with Zod.
 *
 * CONFORMANCE (decision 6 — a HARD pre-filter) is measured precisely here: did
 * the reply parse + Zod-validate (`conformant:true`), or degrade to empty
 * (`conformant:false`)? A low-conformance arm is disqualified before quality is
 * scored — a model silently dropping passes to malformed JSON is a coverage
 * loss (the silent-clean class).
 *
 * Egress: the adapter runs `assertEgressSafe` on the outgoing payload BEFORE the
 * request (defence-in-depth over redact-once upstream — Security §). Errors
 * reuse `classifyLlmError`: NO 4xx retry except 429; the provider's real
 * `error.message` + `status` are surfaced, never collapsed to `"API error N"`.
 *
 * Return shape mirrors the GPT `callGPT` contract: `{result, usage, latencyMs,
 * conformant, failed, error, mode}` so audit-shadow treats both symmetrically.
 *
 * @module scripts/lib/oss-structured-output
 */

import { z } from 'zod';
import { classifyLlmError } from './robustness.mjs';
import { assertEgressSafe } from './sensitive-egress-gate.mjs';
import { sanitizeTokens } from './model-pricing.mjs';

/** Derive a plain JSON Schema from a Zod schema for the provider's structured-output field. */
export function zodToOpenAiJsonSchema(zodSchema) {
  // Zod 4: z.toJSONSchema returns a standard draft schema. OpenAI-compatible
  // routers accept it directly (unlike Gemini, no key-stripping needed).
  return z.toJSONSchema(zodSchema);
}

const EMPTY_USAGE = Object.freeze({ input_tokens: 0, cached_tokens: 0, output_tokens: 0, reasoning_tokens: 0, latency_ms: 0, usageMissing: true });

/**
 * Normalise an OpenAI-compatible chat `usage` block into the audit-loop shape.
 * Token fields go through the SHARED `sanitizeTokens` clamp (audit R2 M3) so a
 * negative/garbage provider value can't pass through as a real count.
 *
 * `usageMissing` (audit R2 H3) flags a reply that carried NO usage — the
 * spend-cap ledger MUST NOT treat that as 0 tokens (= free); it applies the
 * pre-flight estimate / conservative fallback instead, so an unmetered call
 * can never silently zero the burn against the hard € ceiling.
 */
/** A trustworthy meterable token count: an actual finite non-negative NUMBER.
 * Strict `typeof` (Gemini gate R5): `Number(null|false|''|[])` coerce to 0. */
function isValidCount(v) {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0;
}

function normaliseUsage(u, latencyMs) {
  const usage = u || {};
  // Fail-safe for the spend cap (audit R3 H4 / R4 H3): usage is "missing" if the
  // block is absent, a field is absent, OR a field is present-but-INVALID
  // (negative/NaN/Infinity). Presence ≠ validity — an invalid value is as
  // unmeterable as an absent one, and `sanitizeTokens` would silently clamp it
  // to 0, so it MUST also trip usageMissing or the € ceiling under-charges.
  const usageMissing = !u || !isValidCount(u.prompt_tokens) || !isValidCount(u.completion_tokens);
  // Only a finite, non-negative provider cost is trustworthy (audit R3 L1) —
  // NaN/Infinity/negative → null (advisory field; the ledger derives cost anyway).
  const cost = usage.cost;
  const providerCost = (typeof cost === 'number' && Number.isFinite(cost) && cost >= 0) ? cost : null;
  return {
    input_tokens: sanitizeTokens(usage.prompt_tokens),
    cached_tokens: sanitizeTokens(usage.prompt_tokens_details?.cached_tokens),
    output_tokens: sanitizeTokens(usage.completion_tokens),
    reasoning_tokens: sanitizeTokens(usage.completion_tokens_details?.reasoning_tokens),
    latency_ms: latencyMs,
    usageMissing,
    provider_cost_usd: providerCost,
  };
}

/** Extract the raw JSON text from a chat completion, whether json_schema or tool-call mode. */
function extractRawJson(completion, mode) {
  const choice = completion?.choices?.[0];
  if (!choice) return { text: '', truncated: false };
  const truncated = choice.finish_reason === 'length';
  if (mode === 'tool') {
    const call = choice.message?.tool_calls?.[0];
    return { text: call?.function?.arguments ?? '', truncated };
  }
  return { text: choice.message?.content ?? '', truncated };
}

/** Sanitize a name to the OpenAI-compatible tool/schema name shape `^[a-zA-Z0-9_-]{1,64}$` (audit R1 M6). */
export function sanitizeSchemaName(name) {
  const cleaned = String(name || '').replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 64);
  return cleaned || 'schema';
}

/**
 * Does this error SPECIFICALLY indicate the router rejected
 * `response_format: json_schema`? Requires a structured-output keyword in the
 * message (audit R1 M8) — a bare "not supported" is NOT enough, so an unrelated
 * 400 (bad model, quota) is not silently masked as a format downgrade.
 */
function isResponseFormatUnsupported(err) {
  if (!err) return false;
  const status = err.status ?? err.response?.status;
  if (status !== 400 && status !== 404 && status !== 422) return false;
  const msg = (err.message || err.error?.message || '').toLowerCase();
  return msg.includes('response_format') || msg.includes('json_schema') || msg.includes('json schema')
    || msg.includes('structured output') || msg.includes('response format');
}

/** Surface the provider's real status + message (never collapse to "API error N"). */
function describeProviderError(err) {
  const status = err?.status ?? err?.response?.status ?? null;
  const message = err?.error?.message || err?.message || String(err);
  return status != null ? `HTTP ${status}: ${message}` : message;
}

/**
 * Issue one OSS structured-output call.
 *
 * @param {import('openai').OpenAI} client - an OSS client (createOpenAIClient({oss}))
 * @param {object} opts
 * @param {string}  opts.model         - resolved concrete OpenRouter model id
 * @param {string}  opts.system        - system prompt
 * @param {string}  opts.userPrompt    - user prompt (already redacted context)
 * @param {import('zod').ZodType} opts.schema
 * @param {string}  opts.schemaName
 * @param {number} [opts.maxTokens=16000]
 * @param {number} [opts.timeoutMs=300000]
 * @param {number} [opts.maxRetries=2]  - retries for RETRYABLE categories only
 * @param {string} [opts.passName]
 * @returns {Promise<{result:object|null, usage:object, latencyMs:number,
 *   conformant:boolean, failed:boolean, error:string|null, mode:'json_schema'|'tool'|null}>}
 */
export async function ossStructuredCall(client, opts) {
  const {
    model, system, userPrompt, schema, schemaName,
    maxTokens = 16000, timeoutMs = 300000, maxRetries = 2, passName = 'oss',
  } = opts;

  if (!model) throw new Error('[oss-structured-output] opts.model (resolved id) is required');
  if (typeof system !== 'string' || typeof userPrompt !== 'string') {
    throw new Error('[oss-structured-output] opts.system and opts.userPrompt must be strings');
  }
  const messages = [
    { role: 'system', content: system },
    { role: 'user', content: userPrompt },
  ];

  // Egress gate — refuse before the request if a secret slipped past redact-once.
  assertEgressSafe(messages, { label: `oss:${passName}` });

  const safeName = sanitizeSchemaName(schemaName);
  const startMs = Date.now();

  // Derive the JSON Schema INSIDE guarded scope (audit R1 M3): a Zod construct
  // that can't be represented would otherwise throw uncaught before any error
  // normalization. A derivation failure is a conformance miss, not a crash.
  let jsonSchema;
  try {
    jsonSchema = zodToOpenAiJsonSchema(schema);
  } catch (err) {
    return {
      result: null, usage: { ...EMPTY_USAGE }, latencyMs: Date.now() - startMs,
      conformant: false, failed: true, error: `schema derivation failed: ${err.message}`, mode: null,
    };
  }

  let mode = 'json_schema';
  let lastErr;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const params = {
        model,
        messages,
        max_tokens: maxTokens,
      };
      if (mode === 'json_schema') {
        params.response_format = {
          type: 'json_schema',
          json_schema: { name: safeName, schema: jsonSchema, strict: false },
        };
      } else {
        // Tool-call fallback: a single forced function whose params ARE the schema.
        params.tools = [{ type: 'function', function: { name: safeName, description: `Return the ${safeName} object.`, parameters: jsonSchema } }];
        params.tool_choice = { type: 'function', function: { name: safeName } };
      }

      // Egress gate over the COMPLETE outgoing body (audit R5 H5), not just
      // `messages` — the request also carries the derived JSON schema (in
      // response_format / tool params). Scan the full `params` right before the
      // wire call so nothing egresses unchecked.
      assertEgressSafe(params, { label: `oss:${passName}:${mode}` });
      const completion = await client.chat.completions.create(params, { signal: controller.signal });
      clearTimeout(timer);
      const latencyMs = Date.now() - startMs;
      const usage = normaliseUsage(completion.usage, latencyMs);

      const { text, truncated } = extractRawJson(completion, mode);
      if (truncated) {
        // Truncated output is a conformance MISS, not a crash (silent-clean guard).
        return { result: null, usage, latencyMs, conformant: false, failed: false, error: 'output truncated (max_tokens)', mode };
      }

      let parsedJson;
      try {
        parsedJson = JSON.parse(text);
      } catch {
        return { result: null, usage, latencyMs, conformant: false, failed: false, error: 'reply was not valid JSON', mode };
      }

      const validated = schema.safeParse(parsedJson);
      if (!validated.success) {
        return {
          result: null, usage, latencyMs, conformant: false, failed: false,
          error: `schema validation failed: ${validated.error.issues.slice(0, 3).map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`,
          mode,
        };
      }
      return { result: validated.data, usage, latencyMs, conformant: true, failed: false, error: null, mode };
    } catch (err) {
      clearTimeout(timer);
      lastErr = err;

      // An egress-gate refusal must NEVER be swallowed into a graceful "failed"
      // result (audit R5 H5) — re-throw it so a secret-carrying payload aborts
      // loudly rather than degrading to a benign empty pass.
      if (err && typeof err.message === 'string' && err.message.includes('[egress-gate]')) throw err;

      // One-time downgrade json_schema → tool-calling if the router rejects it.
      // Roll `attempt` back so the downgrade does NOT consume a retry (audit R1
      // H5) — the `continue` would otherwise increment it. This can fire at most
      // once (mode flips to 'tool'), so no infinite loop.
      if (mode === 'json_schema' && isResponseFormatUnsupported(err)) {
        process.stderr.write(`  [${passName}] OSS model "${model}" rejected json_schema — falling back to tool-calling\n`);
        mode = 'tool';
        attempt--;
        continue;
      }

      const { retryable, category } = classifyLlmError(err);
      if (attempt < maxRetries && retryable) {
        const delayMs = 800 * (attempt + 1);
        process.stderr.write(`  [${passName}] OSS retry ${attempt + 1}/${maxRetries} in ${(delayMs / 1000).toFixed(1)}s [${category}]\n`);
        await new Promise((r) => setTimeout(r, delayMs));
        continue;
      }
      // Non-retryable (4xx except 429) or retries exhausted → surface the real error.
      const latencyMs = Date.now() - startMs;
      return {
        result: null, usage: { ...EMPTY_USAGE, latency_ms: latencyMs }, latencyMs,
        conformant: false, failed: true, error: describeProviderError(err), mode,
      };
    }
  }

  const latencyMs = Date.now() - startMs;
  return {
    result: null, usage: { ...EMPTY_USAGE, latency_ms: latencyMs }, latencyMs,
    conformant: false, failed: true, error: describeProviderError(lastErr), mode,
  };
}
