import OpenAI from 'openai';
import { BRAINSTORM_SYSTEM_PROMPT } from './prompt.mjs';
import { estimateCostUsd } from './pricing.mjs';

let _client = null;
function client() {
  if (!_client) _client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  return _client;
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
export async function callOpenAI({ topic, model, maxTokens, timeoutMs = 60000, reasoningEffort = null }) {
  const startMs = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  const payload = {
    model,
    messages: [
      { role: 'system', content: BRAINSTORM_SYSTEM_PROMPT },
      { role: 'user', content: topic },
    ],
    max_completion_tokens: maxTokens,
    ...(reasoningEffort ? { reasoning_effort: reasoningEffort } : {}),
  };

  try {
    let response;
    try {
      response = await client().chat.completions.create(payload, { signal: controller.signal });
    } catch (err) {
      // Non-reasoning models reject reasoning_effort with a 400 — retry once
      // without it rather than failing the whole leg on an optional hint.
      const msg = String(err?.message || '');
      if (payload.reasoning_effort && (err?.status === 400) && /reasoning[_.]?effort|unsupported|unrecognized/i.test(msg)) {
        const { reasoning_effort: _dropped, ...bare } = payload;
        response = await client().chat.completions.create(bare, { signal: controller.signal });
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
    };
    const latencyMs = Date.now() - startMs;
    const estimatedCostUsd = estimateCostUsd({
      modelId: model,
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
    });

    if (finishReason === 'content_filter') {
      return {
        provider: 'openai',
        state: 'blocked',
        text: null,
        errorMessage: 'Content blocked by safety filter',
        httpStatus: null,
        usage,
        latencyMs,
        estimatedCostUsd,
      };
    }

    if (!text || text.trim().length === 0) {
      return {
        provider: 'openai',
        state: 'empty',
        text: null,
        errorMessage: `Empty response (finish_reason: ${finishReason ?? 'unknown'})`,
        httpStatus: null,
        usage,
        latencyMs,
        estimatedCostUsd,
      };
    }

    return {
      provider: 'openai',
      state: 'success',
      text,
      errorMessage: null,
      httpStatus: null,
      usage,
      latencyMs,
      estimatedCostUsd,
    };
  } catch (err) {
    clearTimeout(timer);
    const latencyMs = Date.now() - startMs;
    return classifyError({ err, latencyMs });
  }
}

function classifyError({ err, latencyMs }) {
  const base = {
    provider: 'openai',
    text: null,
    usage: null,
    latencyMs,
    estimatedCostUsd: null,
  };

  if (err?.name === 'AbortError' || err?.code === 'ABORT_ERR') {
    return { ...base, state: 'timeout', errorMessage: 'Aborted after timeout', httpStatus: null };
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
