/**
 * Per-model pricing for cost estimation — a thin wrapper over the repo-wide
 * pricing SSoT (model-pricing.mjs / config.mjs's `modelPricing`) instead of a
 * second hand-maintained rate table.
 *
 * The old local RATES table matched by raw `modelId.startsWith(key)` with no
 * key-length preference: `'gpt-5.6-terra'.startsWith('gpt-5')` matched the
 * bare 'gpt-5' entry — no 'gpt-5.6' key existed to take priority — silently
 * under-pricing every gpt-5.6-terra cost estimate by ~2x on input tokens.
 * `priceFor()` here delegates to `pricingKey()` (model-resolver.mjs), which
 * resolves a model id to its FAMILY before lookup, so a future dated release
 * prices correctly with no per-release table edit.
 */
import { priceFor as resolvePrice, FALLBACK_PRICE_USD } from '../model-pricing.mjs';

/**
 * @param {string} modelId
 * @returns {{input:number, output:number}|null} null when the model is
 * unpriced — every caller already treats a null/absent estimatedCostUsd as
 * "unknown", per the SSoT's null-cost policy (never a guessed fallback rate).
 */
export function priceFor(modelId) {
  return resolvePrice(modelId);
}

/**
 * Estimate cost in USD for a single provider call, or null when the model is
 * unpriced. Includes input AND output tokens (Gemini-G2 v2 — naive output-only
 * estimate misled by 10–100x on large topic-paste inputs).
 */
export function estimateCostUsd({ modelId, inputTokens, outputTokens }) {
  const rate = priceFor(modelId);
  if (!rate) return null;
  return (inputTokens * rate.input + outputTokens * rate.output) / 1_000_000;
}

/**
 * Pre-call estimate when token counts aren't known yet — uses char/4 as
 * a rough token proxy for English text. Always returns a number (never
 * null): this feeds a pre-call spend ceiling, so an unpriced model falls
 * back to the SSoT's conservative FALLBACK_PRICE_USD over-estimate instead
 * of being excluded from the ceiling.
 */
export function preflightEstimateUsd({ modelId, inputChars, maxOutputTokens }) {
  const inputTokens = Math.ceil(inputChars / 4);
  const rate = priceFor(modelId) || FALLBACK_PRICE_USD;
  return (inputTokens * rate.input + maxOutputTokens * rate.output) / 1_000_000;
}
