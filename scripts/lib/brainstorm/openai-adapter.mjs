import { createOpenAIClient } from '../openai-client.mjs';
import { azureConfig } from '../config.mjs';
import { BRAINSTORM_SYSTEM_PROMPT } from './prompt.mjs';
import { estimateCostUsd } from './pricing.mjs';
import { isAbortFailure, abortMessage } from './error-classify.mjs';

// Routed through the shared Azure-aware seam, not a raw `new OpenAI()` —
// the 2026-07-14 fresh-installer audit found this adapter was the one
// remaining OpenAI call site bypassing the work profile, so /brainstorm's
// OpenAI voice silently reported `misconfigured` on Azure-only installs
// while the README promised the whole bundle runs on Azure.
let _client = null;
async function client() {
  if (!_client) _client = await createOpenAIClient({ purpose: 'gpt' });
  return _client;
}

// Wire-level model id: Azure serves deployments, not public model ids —
// same substitution rule as lib/audit/llm-helpers.mjs `wireModel()` (the
// resolved sentinel stays for logging/pricing only).
function wireModel(model) {
  return azureConfig.active ? azureConfig.gptDeployment : model;
}

/**
 * Call OpenAI with the brainstorm system prompt + user topic.
 * Always returns a ProviderResult — never throws to the caller (Plan v6
 * §2.1 / R2-H4 total output contract).
 *
 * @param {object} args
 * @param {string} args.topic    Post-redaction user topic
 * @param {string} args.model    Resolved concrete model ID
 * @param {number} args.maxTokens Cap for output tokens
 * @param {number} args.timeoutMs Abort after this many ms (default 60000)
 * @param {string|null} [args.reasoningEffort] Optional `reasoning_effort` for
 *   reasoning models (depth-config maps shallow → 'low' so thinking tokens
 *   don't consume the whole small `max_completion_tokens` budget). Omitted
 *   when null. A model that rejects the param (400) is retried once without.
 * @returns {Promise<ProviderResult>}
 */
export async function callOpenAI({ topic, model, maxTokens, timeoutMs = 60000, reasoningEffort = null, systemPrompt = BRAINSTORM_SYSTEM_PROMPT }) {
  const startMs = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  const payload = {
    model: wireModel(model),
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: topic },
    ],
    max_completion_tokens: maxTokens,
    ...(reasoningEffort ? { reasoning_effort: reasoningEffort } : {}),
  };

  try {
    const oai = await client();
    let response;
    try {
      response = await oai.chat.completions.create(payload, { signal: controller.signal });
    } catch (err) {
      // Non-reasoning models reject reasoning_effort with a 400 — retry once
      // without it rather than failing the whole leg on an optional hint.
      const msg = String(err?.message || '');
      if (payload.reasoning_effort && (err?.status === 400) && /reasoning[_.]?effort|unsupported|unrecognized/i.test(msg)) {
        const { reasoning_effort: _dropped, ...bare } = payload;
        response = await oai.chat.completions.create(bare, { signal: controller.signal });
      } else {
        throw err;
      }
    }
    clearTimeout(timer);

    const text = response.choices?.[0]?.message?.content ?? null;
    const finishReason = response.choices?.[0]?.finish_reason ?? null;
    const usage = {
      inputTokens: response.usage?.prompt_tokens ?? 0,
      outputTokens: response.usage?.completion_tokens ?? 0,
      // Reasoning is billed inside outputTokens, so cost is already right; this
      // is the diagnostic half. A reasoning model that returns a thin answer
      // under a small depth budget is indistinguishable from a model with
      // little to say unless the split is recorded.
      reasoningTokens: response.usage?.completion_tokens_details?.reasoning_tokens ?? 0,
    };
    const latencyMs = Date.now() - startMs;
    const estimatedCostUsd = estimateCostUsd({
      modelId: model,
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
    });

    return {
      provider: 'openai',
      ..._classifyCompletion({ text, finishReason }),
      httpStatus: null,
      usage,
      latencyMs,
      estimatedCostUsd,
    };
  } catch (err) {
    clearTimeout(timer);
    const latencyMs = Date.now() - startMs;
    return classifyError({ err, latencyMs, signal: controller.signal, timeoutMs });
  }
}

/**
 * Map (text, finish_reason) → {state, text, errorMessage}. Mirror of the
 * Gemini adapter's classifier; see that file for the full rationale.
 *
 * Order is load-bearing: `blocked` first, then no-text `empty`, then a
 * `length` finish WITH text is `truncated` — never `success`. The partial
 * text is kept; only the label was wrong.
 *
 * @param {{text: string|null, finishReason: string|null}} args
 * @returns {{state: string, text: string|null, errorMessage: string|null}}
 */
export function _classifyCompletion({ text, finishReason }) {
  if (finishReason === 'content_filter') {
    return { state: 'blocked', text: null, errorMessage: 'Content blocked by safety filter' };
  }
  if (!text || text.trim().length === 0) {
    return { state: 'empty', text: null, errorMessage: `Empty response (finish_reason: ${finishReason ?? 'unknown'})` };
  }
  if (finishReason === 'length') {
    return {
      state: 'truncated',
      text,
      errorMessage: 'Response hit the output-token ceiling and is incomplete — raise --depth for a full answer.',
    };
  }
  return { state: 'success', text, errorMessage: null };
}

function classifyError({ err, latencyMs, signal = null, timeoutMs = null }) {
  const base = {
    provider: 'openai',
    text: null,
    usage: null,
    latencyMs,
    estimatedCostUsd: null,
  };

  // Signal-first: the adapter aborted on its own timeout, so `signal.aborted`
  // is authoritative regardless of how the SDK wrapped the rejection. Sniffing
  // the error shape alone read an OpenAI `APIUserAbortError` as `malformed`.
  if (isAbortFailure({ err, signal })) {
    return { ...base, state: 'timeout', errorMessage: abortMessage(timeoutMs), httpStatus: null };
  }

  const status = err?.status ?? err?.response?.status ?? null;
  if (status) {
    return {
      ...base,
      state: 'http_error',
      errorMessage: err?.message ?? `HTTP ${status}`,
      httpStatus: status,
    };
  }

  return {
    ...base,
    state: 'malformed',
    errorMessage: err?.message ?? 'Unknown adapter error',
    httpStatus: null,
  };
}
