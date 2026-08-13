/**
 * Per-model pricing for cost estimation. Mirrors `modelPricing` in
 * scripts/openai-audit.mjs (Plan v6 R3-M1 deferral rationale: only 2 callers
 * need pricing today; centralisation is v2 work).
 *
 * Rates are USD per 1M tokens. Update quarterly with the static-pool refresh
 * in scripts/lib/model-resolver.mjs.
 */
const RATES = {
  // OpenAI
  'gpt-5': { input: 1.25, output: 10.0 },
  'gpt-5.4': { input: 2.5, output: 10.0 },
  'gpt-5.5': { input: 2.5, output: 10.0 },
  'gpt-5-mini': { input: 0.25, output: 2.0 },
  // Gemini
  'gemini-pro-latest': { input: 1.25, output: 10.0 },
  'gemini-3.1-pro': { input: 1.25, output: 10.0 },
  'gemini-3-pro': { input: 1.25, output: 10.0 },
  'gemini-flash-latest': { input: 0.075, output: 0.30 },
  // Claude — keyed by DEPLOYMENT-NAME prefix, because that is what the Azure
  // voice reports as its model id (`claude-opus-4-7`, `claude-sonnet-4-6`).
  // List prices; a Foundry tenant's negotiated rate may differ, so treat the
  // azure-claude line as an order-of-magnitude ceiling, not an invoice.
  'claude-opus': { input: 15.0, output: 75.0 },
  'claude-sonnet': { input: 3.0, output: 15.0 },
  'claude-haiku': { input: 1.0, output: 5.0 },
};

const FALLBACK = { input: 1.25, output: 10.0 };

export function priceFor(modelId) {
  if (!modelId) return FALLBACK;
  if (RATES[modelId]) return RATES[modelId];
  for (const key of Object.keys(RATES)) {
    if (modelId.startsWith(key)) return RATES[key];
  }
  return FALLBACK;
}

/**
 * Estimate cost in USD for a single provider call.
 * Includes input AND output tokens (Gemini-G2 v2 — naive output-only
 * estimate misled by 10–100x on large topic-paste inputs).
 */
export function estimateCostUsd({ modelId, inputTokens, outputTokens }) {
  const rate = priceFor(modelId);
  return (inputTokens * rate.input + outputTokens * rate.output) / 1_000_000;
}

/**
 * Pre-call estimate when token counts aren't known yet — uses char/4 as
 * a rough token proxy for English text.
 */
export function preflightEstimateUsd({ modelId, inputChars, maxOutputTokens }) {
  const inputTokens = Math.ceil(inputChars / 4);
  return estimateCostUsd({ modelId, inputTokens, outputTokens: maxOutputTokens });
}
