/**
 * @fileoverview Versioned model-pricing table + usage→cost derivation.
 *
 * Plan: docs/plans/model-ab-experiment-harness.md (decision R1-M3). The
 * model-A/B/C burn-in must compare arms on COST as well as quality, and the
 * spend ledger enforces a hard EUR ceiling — both need a single, auditable
 * price source that covers the GPT/Gemini/Claude families AND the OpenRouter
 * OSS models the harness introduces.
 *
 * Design:
 *   - The family-keyed table in config.mjs (`modelPricing`) stays the SSoT for
 *     the closed-catalog providers (GPT/Claude/Gemini) — this module layers the
 *     OSS ids on top rather than forking a second table (#5 SSoT).
 *   - Capture universal token **usage** always; **derive** cost. A model whose
 *     price is unknown yields a **null** cost (logged by the caller, never 0 —
 *     plan decision 8 / R1-M3), so an unpriced arm is excluded from the cost
 *     ratio rather than silently mis-scored as free.
 *   - Currency: prices are USD / 1M tokens. `toEur()` applies a coarse FIXED
 *     rate — the €ceiling is a safety cap, not accounting, so a fixed rate is
 *     structurally honest here (avoids a live-FX dependency the requirement
 *     doesn't need).
 *
 * @module scripts/lib/model-pricing
 */

import { modelPricing as familyPricing } from './config.mjs';
import { pricingKey } from './model-resolver.mjs';

/**
 * OSS (OpenRouter open-weight) prices, keyed by the FULL OpenRouter id — these
 * ids do not parse into a family key, so `pricingKey()` returns them verbatim
 * and the lookup lands here. Prices are USD / 1M tokens and APPROXIMATE (2026-07
 * ballpark; OpenRouter routes to multiple upstream providers whose prices drift).
 * The null-cost policy covers anything unlisted — an unlisted id is not an
 * error, just an unpriced run excluded from the cost ratio. Keep these roughly
 * current when refreshing the OSS_POOL heads in model-resolver.mjs.
 * @type {Readonly<Record<string,{input:number,output:number}>>}
 */
export const OSS_PRICING = Object.freeze({
  'qwen/qwen3-coder':                  { input: 0.20, output: 0.80 },
  'deepseek/deepseek-chat-v3.1':       { input: 0.20, output: 0.80 },
  'z-ai/glm-4.6':                      { input: 0.40, output: 1.75 },
  'deepseek/deepseek-r1':              { input: 0.40, output: 2.00 },
  'moonshotai/kimi-k2-thinking':       { input: 0.55, output: 2.20 },
  'qwen/qwen3-235b-a22b-thinking':     { input: 0.20, output: 0.80 },
  // OSS reasoner candidates (verified live on OpenRouter 2026-07-01). GLM-5.2 is
  // the pool HEAD (best open-weight on the Intelligence Index + SWE-bench Pro);
  // DeepSeek-v4-pro (cheapest) + Qwen3.7-max are rotation. All ≪ the GPT baseline
  // ($5/$30), so the cost gate ("no OSS arm pricier than baseline") holds.
  'z-ai/glm-5.2':                      { input: 0.93,  output: 3.00 },
  'qwen/qwen3.7-max':                  { input: 1.25,  output: 3.75 },
  'deepseek/deepseek-v4-pro':          { input: 0.435, output: 0.87 },
  'deepseek/deepseek-v4-flash':        { input: 0.098, output: 0.196 },
});

/**
 * Prompt-cache multipliers against the model's BASE input price.
 *
 * Anthropic 5-minute ephemeral caching: a cache WRITE is 1.25x base and a cache
 * READ is 0.10x. Both are multipliers, not separate prices, so they compose with
 * whatever the model's input price is.
 *
 * The write premium is the load-bearing half. It is why caching is opt-in
 * (finalReviewConfig.promptCache): one send that is never re-read costs 1.25x,
 * a 25% penalty. Two identical sends cost 1.25 + 0.10 = 1.35x instead of 2.0x.
 * Pricing the write at 1.0 — or ignoring these fields entirely — would report
 * that as a 90% saving, which is the number the raw read discount suggests and
 * roughly triple the real one.
 *
 * Only the Anthropic transport emits these usage fields today; every other
 * provider leaves them absent, which sanitizes to 0 and leaves its cost
 * arithmetic byte-identical to before caching existed. If a second provider
 * starts reporting cache usage, check its multipliers before reusing these —
 * OpenAI and Google price cache reads differently and charge no write premium.
 */
export const CACHE_MULTIPLIER = Object.freeze({ write: 1.25, read: 0.10 });

/** Coarse fixed USD→EUR rate for the burn-in spend cap (safety ceiling, not accounting). */
export const EUR_PER_USD = 0.92;

/** Effective-date stamp for the price table — bump when refreshing OSS_PRICING (audit R1 L4). */
export const PRICING_VERSION = '2026-07-01';

/**
 * Multiple of the priciest KNOWN model used to derive the spend-cap fallback.
 * 2x is a judgement call, not a proof (see FALLBACK_PRICE_USD) — it is the
 * headroom by which a brand-new model may exceed today's most expensive one
 * before the reservation stops being an over-estimate.
 */
export const FALLBACK_MARGIN = 2;

/**
 * Conservative fallback price (USD/1M) for an UNPRICED model, used ONLY by the
 * spend-cap path (never the analytics cost ratio), so an unknown-price arm can
 * never UNDER-count against the hard € ceiling (audit R1 H7 — "can't meter it →
 * over-estimate, never treat as free").
 *
 * DERIVED from the price tables (`max(listed) × FALLBACK_MARGIN`), not
 * hand-picked — debt `f68a6dbc`. It was the literal `{15, 75}`, and the
 * priciest listed model (claude-opus) is also `{15, 75}`: **headroom had
 * decayed to exactly 1.0x**, and the invariant below threw only on `>`, so the
 * tie passed. `costForBudget` reserves an unlisted model at this rate, so any
 * model above Opus — the ordinary case for a new frontier release, which is
 * what an unpriced id usually IS — under-reserved against the ceiling, the one
 * direction that function exists to prevent. A hand-maintained constant beside
 * a table that grows toward it will always drift back into that tie; deriving
 * it means it cannot.
 *
 * **What this does and does not establish.** It CANNOT prove a bound on a
 * price nobody has: no finite constant can, and the original debt entry is
 * right about that. What it now guarantees is (1) the fallback strictly
 * dominates every KNOWN price, checked below rather than remembered, (2) it
 * tracks the table automatically, so adding a pricier model raises it, and
 * (3) every use is still flagged `estimated: true` by `costForBudget` and
 * persisted by the spend ledger, so a reservation made this way is always
 * identifiable as a guess rather than a measurement. A model priced above
 * `FALLBACK_MARGIN ×` the current maximum remains under-reserved — the residual
 * is bounded and visible instead of silent and zero.
 */
export const FALLBACK_PRICE_USD = (() => {
  const listed = [...Object.entries(OSS_PRICING), ...Object.entries(familyPricing)];
  if (listed.length === 0) {
    throw new Error('[model-pricing] cannot derive FALLBACK_PRICE_USD: both price tables are empty, so there is no maximum to bound the spend cap with.');
  }
  for (const [id, px] of listed) {
    if (!Number.isFinite(px?.input) || !Number.isFinite(px?.output) || px.input < 0 || px.output < 0) {
      throw new Error(`[model-pricing] price["${id}"] is not a finite non-negative {input,output} (${JSON.stringify(px)}) — a spend-cap floor derived from it would be meaningless.`);
    }
  }
  const maxInput = Math.max(...listed.map(([, px]) => px.input));
  const maxOutput = Math.max(...listed.map(([, px]) => px.output));
  if (!(maxInput > 0) || !(maxOutput > 0)) {
    throw new Error(`[model-pricing] every listed price is 0 on one side (max in=${maxInput}, out=${maxOutput}) — refusing to derive a 0 spend-cap floor, which would treat unpriced models as free.`);
  }
  return Object.freeze({ input: maxInput * FALLBACK_MARGIN, output: maxOutput * FALLBACK_MARGIN });
})();

// Self-enforcing invariant (audit R4 M5 / R5 M3, tightened for f68a6dbc): the
// budget fallback must STRICTLY dominate every known price — OSS *and* the
// family table. `>` allowed a tie, which is how the margin reached 1.0x
// unnoticed; `>=` makes a tie the failure it always was. Now that the value is
// derived this is a post-condition on the derivation rather than a reminder to
// a human, so it can only fire on a real bug above.
for (const [id, px] of [...Object.entries(OSS_PRICING), ...Object.entries(familyPricing)]) {
  if (px.input >= FALLBACK_PRICE_USD.input || px.output >= FALLBACK_PRICE_USD.output) {
    throw new Error(`[model-pricing] FALLBACK_PRICE_USD {${FALLBACK_PRICE_USD.input}/${FALLBACK_PRICE_USD.output}} must STRICTLY exceed price["${id}"] {${px.input}/${px.output}} — a tie is not an over-estimate.`);
  }
}

/** A trustworthy meterable token count: an actual finite non-negative NUMBER.
 * Strict `typeof` (consolidated Gemini gate R5): `Number(null|false|''|[])` all
 * coerce to 0, so a `Number()`-based check would accept junk as a valid 0-count. */
export function isValidCount(v) {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0;
}

/**
 * Clamp a raw token count to a finite, non-negative integer (audit R1 H4).
 * Exported so the OSS adapter's usage normalizer shares ONE clamp (audit R2 M3)
 * — no second `?? 0` path that could pass through negative/garbage tokens.
 */
export function sanitizeTokens(v) {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.floor(n);
}

/**
 * Look up the {input, output} per-1M-token price for a resolved model id.
 * Tries the OSS table (full id) first, then the family-keyed config table via
 * `pricingKey()`, then a bare-id lookup. Returns null when the model is unpriced.
 * @param {string} modelId - resolved concrete model id (NOT a sentinel)
 * @returns {{input:number, output:number}|null}
 */
export function priceFor(modelId) {
  if (!modelId || typeof modelId !== 'string') return null;
  if (Object.hasOwn(OSS_PRICING, modelId)) return OSS_PRICING[modelId];
  const key = pricingKey(modelId);
  // adbda8c8 fix — these two were bare bracket lookups while the OSS_PRICING
  // check one line up already used Object.hasOwn: two different lookup
  // disciplines inside one function. A model id colliding with an
  // Object.prototype member ('constructor', 'toString', 'valueOf') returned a
  // truthy NON-price whose .input/.output are undefined, which then priced as
  // NaN while still reporting priced:true — a fabricated cost, not a caught
  // error. Match the safer adjacent pattern.
  if (Object.hasOwn(familyPricing, key)) return familyPricing[key];
  if (Object.hasOwn(familyPricing, modelId)) return familyPricing[modelId];
  return null;
}

/** True iff the model has a known price (i.e. the cost ratio may include it). */
export function isPriced(modelId) {
  return priceFor(modelId) !== null;
}

/**
 * Derive USD cost from a token-usage object. Accepts either the audit-loop's
 * usage shape ({input_tokens, output_tokens, ...}) or an OpenAI-style
 * ({prompt_tokens, completion_tokens}). Reasoning tokens are already counted
 * in output_tokens by the providers, so they are NOT double-charged here.
 *
 * Cache-aware: when the provider reports `cache_creation_input_tokens` /
 * `cache_read_input_tokens`, those tokens are NOT in `input_tokens` (Anthropic
 * moves them out), so they are priced separately at CACHE_MULTIPLIER rather
 * than dropped. Dropping them is not a rounding error — on a cache hit it
 * reports a full-size review as near-free. `inputTokens` is returned as the
 * TOTAL prompt size across all three buckets, so a caller comparing prompt
 * sizes across runs sees the same number cached or not.
 *
 * `priced` and `unmeterable` are ORTHOGONAL and are never collapsed into one
 * flag: `priced` is a property of the MODEL (is there a price for it?),
 * `unmeterable` a property of the USAGE (can it be trusted?). All four
 * combinations occur. The monetary fields are non-null iff
 * `priced && !unmeterable`; token counts are always the sanitized observation,
 * because they describe what was seen, not what was billable.
 *
 * @param {object|null} usage
 * @param {string} modelId - resolved concrete model id
 * @returns {{ totalUsd: number|null, inputUsd: number|null, outputUsd: number|null,
 *            priced: boolean, unmeterable: boolean, inputTokens: number, outputTokens: number,
 *            cacheWriteTokens: number, cacheReadTokens: number }}
 */
export function costFromUsage(usage, modelId) {
  const rawIn = usage?.input_tokens ?? usage?.prompt_tokens;
  const rawOut = usage?.output_tokens ?? usage?.completion_tokens;
  // c5808479 fix — this function had no missing-usage guard at all, unlike its
  // sibling costForBudget (see its `unmeterable` below, from which this test is
  // copied verbatim so the two can never disagree). sanitizeTokens() clamps
  // absent/garbage counts to 0, so costFromUsage(null, <priced model>) returned
  // `priced: true, totalUsd: 0` — a FALSE REPORT OF SUCCESSFUL $0 PRICING,
  // indistinguishable from a genuinely free call, which is strictly worse than
  // the honest null this module's own null-cost policy demands for the
  // unpriced case. A true zero (`{input_tokens: 0, output_tokens: 0}`) is
  // meterable and still prices to a real 0 — "zero" and "absent" are now
  // distinguishable, which is the entire point.
  const unmeterable = !usage || usage.usageMissing === true || !isValidCount(rawIn) || !isValidCount(rawOut);
  // Sanitize FIRST (audit R1 H4): non-finite / negative / NaN token counts →
  // 0, floored to integers — otherwise a garbage `usage` yields a negative or
  // Infinity cost while still reporting priced:true.
  const uncachedTokens = sanitizeTokens(rawIn);
  const cacheWriteTokens = sanitizeTokens(usage?.cache_creation_input_tokens);
  const cacheReadTokens = sanitizeTokens(usage?.cache_read_input_tokens);
  const inputTokens = uncachedTokens + cacheWriteTokens + cacheReadTokens;
  const outputTokens = sanitizeTokens(rawOut);
  const px = priceFor(modelId);
  if (!px || unmeterable) {
    // Null-cost policy (plan decision 8): unknown price → null, NEVER 0 — now
    // extended to unknown USAGE for the same reason.
    return {
      totalUsd: null, inputUsd: null, outputUsd: null, priced: !!px, unmeterable,
      inputTokens, outputTokens, cacheWriteTokens, cacheReadTokens,
    };
  }
  const inputUsd = (
    uncachedTokens * px.input
    + cacheWriteTokens * px.input * CACHE_MULTIPLIER.write
    + cacheReadTokens * px.input * CACHE_MULTIPLIER.read
  ) / 1_000_000;
  const outputUsd = (outputTokens * px.output) / 1_000_000;
  return {
    totalUsd: inputUsd + outputUsd,
    inputUsd,
    outputUsd,
    priced: true,
    unmeterable: false,
    inputTokens,
    outputTokens,
    cacheWriteTokens,
    cacheReadTokens,
  };
}

/**
 * Cost for the SPEND-CAP path — never null (audit R1 H7). An unknown price
 * falls back to FALLBACK_PRICE_USD (a conservative OVER-estimate) so the hard €
 * ceiling can never be silently overshot by an unmetered arm. `estimated:true`
 * flags the fallback so the ledger/CLI can surface it. Distinct from
 * `costFromUsage` (analytics), which stays null-honest and excludes unpriced
 * runs from the cost RATIO.
 *
 * @param {object|null} usage
 * @param {string} modelId
 * @returns {{ totalUsd:number, estimated:boolean, inputTokens:number, outputTokens:number }}
 */
export function costForBudget(usage, modelId) {
  const rawIn = usage?.input_tokens ?? usage?.prompt_tokens;
  const rawOut = usage?.output_tokens ?? usage?.completion_tokens;
  // Honor the adapter's EXPLICIT `usageMissing` flag FIRST (consolidated Gemini
  // gate R3): normaliseUsage sanitizes missing usage to 0 — a VALID count — so
  // re-deriving from token validity alone would read a successful-but-unmeterable
  // call as a real €0 (defeating the reserve-then-reconcile ceiling). The flag is
  // authoritative when present.
  // `unmeterable` (audit R5 H4): flag set OR usage absent OR either field absent/invalid.
  // When true, `totalUsd` is NOT authoritative (it can only reflect the 0s that
  // absent counts sanitize to) — the reserve-then-reconcile ledger MUST keep
  // its pre-flight reservation instead of reconciling down to this figure, so
  // an unmetered call can never zero the burn against the € ceiling.
  const unmeterable = !usage || usage.usageMissing === true || !isValidCount(rawIn) || !isValidCount(rawOut);
  // Cached prompt tokens are billed but live OUTSIDE `input_tokens`, so omitting
  // them UNDER-reserves against the hard € ceiling — the one direction this
  // function exists to make impossible. Absent on every non-Anthropic provider,
  // where they sanitize to 0 and the arithmetic is unchanged. Their absence is
  // NOT part of the `unmeterable` test: they are optional fields, and treating a
  // provider that never reports them as unmeterable would pin every run to its
  // pre-flight reservation.
  const cacheWriteTokens = sanitizeTokens(usage?.cache_creation_input_tokens);
  const cacheReadTokens = sanitizeTokens(usage?.cache_read_input_tokens);
  const inputTokens = sanitizeTokens(rawIn) + cacheWriteTokens + cacheReadTokens;
  const outputTokens = sanitizeTokens(rawOut);
  const px = priceFor(modelId);
  const estimated = !px;
  const rate = px || FALLBACK_PRICE_USD;
  const billableInput = sanitizeTokens(rawIn)
    + cacheWriteTokens * CACHE_MULTIPLIER.write
    + cacheReadTokens * CACHE_MULTIPLIER.read;
  const totalUsd = (billableInput * rate.input + outputTokens * rate.output) / 1_000_000;
  return { totalUsd, estimated, unmeterable, inputTokens, outputTokens, cacheWriteTokens, cacheReadTokens };
}

/** Convert a USD amount to EUR via the fixed burn-in rate. null passes through. */
export function toEur(usd) {
  return (usd == null || !Number.isFinite(usd)) ? null : usd * EUR_PER_USD;
}
