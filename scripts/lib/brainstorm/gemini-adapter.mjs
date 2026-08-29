import { GoogleGenAI } from '@google/genai';
import { BRAINSTORM_SYSTEM_PROMPT } from './prompt.mjs';
import { estimateCostUsd } from './pricing.mjs';
import { normalizeGeminiUsage } from '../gemini-usage.mjs';
import { isAbortFailure, abortMessage } from './error-classify.mjs';

let _client = null;
function client() {
  if (!_client) _client = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
  return _client;
}

/**
 * Call Gemini with the brainstorm system prompt + user topic.
 * Always returns a ProviderResult — never throws to the caller (Plan v6
 * §2.1 / R2-H4 total output contract).
 */
export async function callGemini({ topic, model, maxTokens, timeoutMs = 60000, systemPrompt = BRAINSTORM_SYSTEM_PROMPT }) {
  const startMs = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await client().models.generateContent(
      {
        model,
        contents: topic,
        config: {
          systemInstruction: systemPrompt,
          maxOutputTokens: maxTokens,
        },
      },
      { signal: controller.signal },
    );
    clearTimeout(timer);
    const latencyMs = Date.now() - startMs;

    const text = response?.text ?? null;
    // camelCase is this adapter's ESTABLISHED contract — its consumers read
    // `inputTokens`/`outputTokens`, so the oracle's snake_case result is MAPPED
    // rather than passed through (converging the shapes would trade an
    // under-metering bug for a zeroed-field one). `usageMissing` is added, not
    // optional: it is what stops an unmeterable call reconciling to a fake €0.
    const g = normalizeGeminiUsage(response?.usageMetadata);
    const usage = {
      inputTokens: g.input_tokens,
      outputTokens: g.output_tokens,      // BILLED: candidates + thoughts
      thinkingTokens: g.thinking_tokens,  // the reasoning share WITHIN the above
      usageMissing: g.usageMissing,
    };
    // NULL cost when the usage is unmeterable (audit H1). Costing the zeros
    // that absent metadata sanitizes to would report a successful call as
    // costing $0.00 — a fabricated measurement in the shape of a real one, and
    // the precise failure `usageMissing` was added to prevent. `null` is
    // already this field's contract for the error paths below, so consumers
    // handle it.
    const estimatedCostUsd = usage.usageMissing ? null : estimateCostUsd({
      modelId: model,
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
    });

    const finishReason = response?.candidates?.[0]?.finishReason ?? null;
    return {
      provider: 'gemini',
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

/** Gemini finish reasons that mean the content was withheld, not produced. */
const BLOCKED_REASONS = new Set(['SAFETY', 'PROHIBITED_CONTENT', 'BLOCKLIST', 'SPII', 'IMAGE_SAFETY']);

/**
 * Map (text, finishReason) → {state, text, errorMessage}.
 *
 * Exported for test (`_` prefix = internal, mirrors the project pattern):
 * the truncation rule is the kind of success-path branch that must be
 * verifiable without a live provider.
 *
 * Order is load-bearing: `blocked` outranks everything (withheld content
 * must never surface), then no-text is `empty`, then a length-capped finish
 * WITH text is `truncated` — never `success`. A fragment rendered beside a
 * complete answer reads as a finished peer view; it is not one. The partial
 * text is KEPT because it is still worth reading — the bug was the label,
 * not the content.
 *
 * @param {{text: string|null, finishReason: string|null}} args
 * @returns {{state: string, text: string|null, errorMessage: string|null}}
 */
export function _classifyCompletion({ text, finishReason }) {
  if (finishReason && BLOCKED_REASONS.has(finishReason)) {
    return { state: 'blocked', text: null, errorMessage: `Blocked by safety filter: ${finishReason}` };
  }
  if (!text || text.trim().length === 0) {
    return { state: 'empty', text: null, errorMessage: `Empty response (finish_reason: ${finishReason ?? 'unknown'})` };
  }
  if (finishReason === 'MAX_TOKENS') {
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
    provider: 'gemini',
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

  // Google SDK surfaces HTTP errors via err.status or in the message
  const statusMatch = (err?.message ?? '').match(/\[(\d{3})\b/);
  const status = err?.status ?? (statusMatch ? Number(statusMatch[1]) : null);
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
