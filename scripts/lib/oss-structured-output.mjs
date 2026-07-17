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
import { sanitizeTokens, isValidCount } from './model-pricing.mjs';
import { getOssOperationPolicy, RETRY_BACKOFF_BASE_MS } from './oss-call-policy.mjs';

const DEFAULT_SCHEDULER = Object.freeze({ setTimeout, clearTimeout, setInterval, clearInterval });
const HEARTBEAT_INTERVAL_MS = 15000;

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

/**
 * Strip a markdown code fence wrapping a JSON reply, if present. Some
 * OpenRouter-hosted backends (GLM-5.2 is proxied across 27 different
 * providers, not one consistent one — live-verified 2026-07-15) wrap valid
 * JSON in ```json ... ``` even under `response_format: json_schema`, which
 * previously hard-failed as "reply was not valid JSON" and discarded an
 * otherwise-good response. Only strips an EXACT whole-string fence (anchored
 * start/end) — never touches fence-like text legitimately inside a JSON
 * string value, and a genuinely malformed reply still fails JSON.parse.
 */
function stripJsonMarkdownFence(text) {
  const m = /^\s*```(?:json)?\s*\n([\s\S]*?)\n?```\s*$/i.exec(text);
  return m ? m[1] : text;
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
  return { text: stripJsonMarkdownFence(choice.message?.content ?? ''), truncated };
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
 * @param {number} [opts.timeoutMs]  - explicit override; wins over the resolved policy
 * @param {number} [opts.maxRetries]  - explicit override; wins over the resolved policy
 * @param {string} [opts.operation]  - semantic operation key resolved against
 *   oss-call-policy.json (docs/plans/oss-call-reliability-hardening.md). Omitted →
 *   today's literal defaults (300s/2 retries), byte-identical for dormant callers.
 *   Present but unrecognized → throws immediately (never silently falls back).
 * @param {{setTimeout:Function, clearTimeout:Function, setInterval:Function, clearInterval:Function}} [opts.scheduler]
 *   - injectable timer source (default: native globals) for deterministic tests.
 * @param {string} [opts.passName]
 * @param {object|null} [opts.providerPreferences]  - OpenRouter provider-routing
 *   preferences (e.g. `{ order: ['z-ai'], quantizations: ['fp8'],
 *   require_parameters: true, allow_fallbacks: false }`), sent verbatim as the
 *   request body's `provider` field. Added for experiment-4's gate-1
 *   availability screen (docs/research/experiment-4-discovery-model-glm-disqualification.md):
 *   every GLM measurement to date was taken against OpenRouter's unfiltered
 *   ~26-host fleet (fp8/fp4/undisclosed quantizations), so pinning is the
 *   control that separates model-vs-router. Omit → today's behaviour,
 *   byte-identical (no `provider` field is ever sent). Non-OpenRouter
 *   OpenAI-compatible endpoints ignore unknown body fields, but callers
 *   should still only set this for OpenRouter bases.
 * @param {'low'|'medium'|'high'|null} [opts.reasoningEffort]  - REASONING PARITY
 *   (plan D4a): OpenRouter's unified `reasoning:{effort}` param, normalized
 *   across providers → DeepSeek V4's native reasoning mode. Set to the SAME
 *   per-pass effort tier the production GPT pipeline uses, so the experiment
 *   measures model quality, not reasoning-effort. Omit → provider default (and
 *   `requestedReasoningEffort:null` records that the knob was not set).
 * @returns {Promise<{result:object|null, usage:object, latencyMs:number,
 *   conformant:boolean, failed:boolean, error:string|null, mode:'json_schema'|'tool'|null,
 *   requestedReasoningEffort:string|null, category?:string}>} `category` is present
 *   (never `null`) only on a `classifyLlmError`-routed failure; absent on success and
 *   on the non-classified early-return failure paths (schema derivation/truncation/
 *   JSON-parse/schema-validation).
 */
export async function ossStructuredCall(client, opts) {
  const {
    model, system, userPrompt, schema, schemaName,
    maxTokens = 16000, operation, passName = 'oss',
    reasoningEffort = null, scheduler = DEFAULT_SCHEDULER,
    providerPreferences = null,
  } = opts;

  const resolvedPolicy = getOssOperationPolicy(operation);
  const timeoutMs = opts.timeoutMs ?? resolvedPolicy.timeoutMs;
  const maxRetries = opts.maxRetries ?? resolvedPolicy.maxRetries;
  // JSON.stringify drops `undefined`-valued keys — a heartbeat record for an
  // omitted operation must use a canonical label instead (round-2 L1), so it
  // doesn't silently vanish from serialized log output.
  const heartbeatOperationLabel = operation ?? 'legacy_default';

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
      requestedReasoningEffort: reasoningEffort,
    };
  }

  let mode = 'json_schema';
  let lastErr;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const controller = new AbortController();
    const attemptStartMs = Date.now();
    const timer = scheduler.setTimeout(() => controller.abort(), timeoutMs);
    // In-flight heartbeat (round-1 M4): logs progress while THIS attempt is
    // outstanding, independent of the abort timer. Cleared in the same
    // try/finally scope as `timer` on every exit path.
    const heartbeat = scheduler.setInterval(() => {
      process.stderr.write(`  [${passName}] OSS heartbeat: ${JSON.stringify({
        operation: heartbeatOperationLabel, model, attempt: attempt + 1, maxRetries,
        elapsedMs: Date.now() - attemptStartMs, timeoutMs,
      })}\n`);
    }, HEARTBEAT_INTERVAL_MS);
    try {
      const params = {
        model,
        messages,
        max_tokens: maxTokens,
      };
      // Reasoning parity (plan D4a) — OpenRouter's unified reasoning param maps
      // to DeepSeek V4's native reasoning mode. Set only when an effort tier was
      // requested so a provider that ignores it stays at its own default.
      if (reasoningEffort) params.reasoning = { effort: reasoningEffort };
      // Provider pinning (experiment-4 gate 1) — only when explicitly given,
      // so every existing caller's request body stays byte-identical.
      if (providerPreferences) params.provider = providerPreferences;
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
      const latencyMs = Date.now() - startMs;
      const usage = normaliseUsage(completion.usage, latencyMs);

      const { text, truncated } = extractRawJson(completion, mode);
      if (truncated) {
        // Truncated output is a conformance MISS, not a crash (silent-clean guard).
        return { result: null, usage, latencyMs, conformant: false, failed: false, error: 'output truncated (max_tokens)', mode, requestedReasoningEffort: reasoningEffort };
      }

      let parsedJson;
      try {
        parsedJson = JSON.parse(text);
      } catch {
        return { result: null, usage, latencyMs, conformant: false, failed: false, error: 'reply was not valid JSON', mode, requestedReasoningEffort: reasoningEffort };
      }

      const validated = schema.safeParse(parsedJson);
      if (!validated.success) {
        return {
          result: null, usage, latencyMs, conformant: false, failed: false,
          error: `schema validation failed: ${validated.error.issues.slice(0, 3).map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`,
          mode, requestedReasoningEffort: reasoningEffort,
        };
      }
      return { result: validated.data, usage, latencyMs, conformant: true, failed: false, error: null, mode, requestedReasoningEffort: reasoningEffort };
    } catch (err) {
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
        const delayMs = RETRY_BACKOFF_BASE_MS * (attempt + 1);
        process.stderr.write(`  [${passName}] OSS retry ${attempt + 1}/${maxRetries} in ${(delayMs / 1000).toFixed(1)}s [${category}]\n`);
        await new Promise((r) => scheduler.setTimeout(r, delayMs));
        continue;
      }
      // Non-retryable (4xx except 429) or retries exhausted → surface the real error + classification.
      const latencyMs = Date.now() - startMs;
      return {
        result: null, usage: { ...EMPTY_USAGE, latency_ms: latencyMs }, latencyMs,
        conformant: false, failed: true, error: describeProviderError(err), mode,
        requestedReasoningEffort: reasoningEffort, category,
      };
    } finally {
      // Both timers always cleared on every exit path (success, error return,
      // or a `continue` back to the top of the loop) — a `finally` block runs
      // before ANY of those, unlike scattered manual clearTimeout() calls.
      scheduler.clearTimeout(timer);
      scheduler.clearInterval(heartbeat);
    }
  }

  const latencyMs = Date.now() - startMs;
  return {
    result: null, usage: { ...EMPTY_USAGE, latency_ms: latencyMs }, latencyMs,
    conformant: false, failed: true, error: describeProviderError(lastErr), mode,
    requestedReasoningEffort: reasoningEffort,
  };
}
