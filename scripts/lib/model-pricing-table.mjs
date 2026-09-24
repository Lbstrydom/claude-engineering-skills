/**
 * @fileoverview The rate card: USD per 1M tokens for every closed-catalog model
 * this repo can resolve to (OpenAI / Anthropic / Google / xAI). Data only — no
 * imports, no logic. Lookup lives in model-pricing.mjs (`priceFor`, which walks
 * `pricingKeys`), and OpenRouter/native-OSS rows live there too
 * (`OSS_PRICING`). Split out of config.mjs 2026-09-23.
 *
 * @module scripts/lib/model-pricing-table
 */

// Read through `priceFor()` (model-pricing.mjs), which walks
// `pricingKeys(modelId)` (same module) MOST specific first —
// `gpt-6-sol` before `gpt-5`, `claude-opus-5-5` before `claude-opus` — never by
// indexing this object with a raw id.
//
// Two kinds of row. A VERSION+SKU row (`gpt-6-sol`, `claude-opus-5-5`) is the
// published rate of that exact model; every OpenAI/Anthropic id in
// model-resolver's STATIC_POOL must have one — enforced by
// tests/model-pricing-pool-coverage.test.mjs, so a new pool entry without a
// row fails at push. A FAMILY row (`gpt-5`, `claude-opus`) is the coarse
// fallback for an id outside the pool (an operator pin the table has never
// seen) and, for OpenAI, doubles as the bare model's own rate (`gpt-5` IS a
// model). Fallbacks err cheap, so a premium OpenAI SKU never takes one (see
// pricingKeys in model-pricing.mjs). The 2026-09-23 refresh is the reason the two kinds exist:
// until then the family rows were the ONLY rows and dated from the 4.x/5.0
// generation — `claude-opus` at $15/$75 (Opus 4.1's rate; Opus 5.5 is $4/$20)
// and `gpt-5` at $2.50/$10 while `latest-gpt` was resolving to gpt-5.6-terra
// ($2/$12) and then gpt-6-astra ($10/$50).
//
// Sources, read 2026-09-23: developers.openai.com/api/docs/pricing and
// platform.claude.com/docs/en/about-claude/pricing. OpenAI prices the 5.6/6
// SKUs by prompt size (a `<272K` rate and a long-context rate), so those rows
// are TIERED like grok-4.6 below; the boundary is carried as 272_000 input
// tokens. `cachedInput` is OpenAI's published cached-input rate (0.1x base) —
// documentary until an OpenAI transport in this repo reports cache-read
// tokens, which none does today.

export const modelPricing = Object.freeze({
  // OpenAI — GPT-6 (astra = premium, sol = balanced, luna = lite)
  'gpt-6-astra': {
    tiers: [
      { maxInputTokens: 272_000, input: 10.00, output: 50.00, cachedInput: 1.00 },
      { maxInputTokens: Infinity, input: 20.00, output: 75.00, cachedInput: 2.00 },
    ],
  },
  'gpt-6-sol': {
    tiers: [
      { maxInputTokens: 272_000, input: 2.00, output: 10.00, cachedInput: 0.20 },
      { maxInputTokens: Infinity, input: 4.00, output: 15.00, cachedInput: 0.40 },
    ],
  },
  'gpt-6-luna': {
    tiers: [
      { maxInputTokens: 272_000, input: 0.10, output: 0.50, cachedInput: 0.01 },
      { maxInputTokens: Infinity, input: 0.20, output: 0.75, cachedInput: 0.02 },
    ],
  },
  // OpenAI — GPT-5.6 (sol = premium, terra = balanced, luna = lite)
  'gpt-5.6-sol': {
    tiers: [
      { maxInputTokens: 272_000, input: 4.00, output: 20.00, cachedInput: 0.40 },
      { maxInputTokens: Infinity, input: 8.00, output: 30.00, cachedInput: 0.80 },
    ],
  },
  'gpt-5.6-terra': {
    tiers: [
      { maxInputTokens: 272_000, input: 2.00, output: 12.00, cachedInput: 0.20 },
      { maxInputTokens: Infinity, input: 4.00, output: 18.00, cachedInput: 0.40 },
    ],
  },
  'gpt-5.6-luna': {
    tiers: [
      { maxInputTokens: 272_000, input: 0.20, output: 1.20, cachedInput: 0.02 },
      { maxInputTokens: Infinity, input: 0.40, output: 1.80, cachedInput: 0.04 },
    ],
  },
  // OpenAI — GPT-5.5 (the page lists a <272K rate only). gpt-5.5-pro
  // ($30/$180) is deliberately absent: it left STATIC_POOL, and as a premium
  // SKU it takes no fallback, so a pin prices as null → the spend-cap
  // over-estimate rather than a 6x under-count off the gpt-5.5 row.
  'gpt-5.5':       { input: 5.00, output: 30.00, cachedInput: 0.50 },
  // OpenAI — family rows, which are also the bare models' own rates.
  'gpt-5':         { input: 1.25, output: 10,  cachedInput: 0.125 },
  'gpt-5-mini':    { input: 0.25, output: 2,   cachedInput: 0.025 },
  'gpt-4':         { input: 2.5,  output: 10  },
  'gpt-4-mini':    { input: 0.15, output: 0.6 },

  // Anthropic — per model. Cache write 1.25x / read 0.10x of base come from
  // CACHE_MULTIPLIER (model-pricing.mjs); Opus 5.5's read is 0.05x, carried
  // as a real `cachedInput` rate so costFromUsage uses it over the multiplier.
  'claude-opus-5-5':   { input: 4, output: 20, cachedInput: 0.20 },
  'claude-opus-5':     { input: 5, output: 25 },
  'claude-opus-4-8':   { input: 5, output: 25 },
  'claude-opus-4-7':   { input: 5, output: 25 },
  'claude-sonnet-5':   { input: 2, output: 10 }, // launch $2/$10 made permanent (the 2026-09-01 rise to $3/$15 was cancelled)
  'claude-sonnet-4-6': { input: 3, output: 15 },
  'claude-haiku-4-5':  { input: 1, output: 5  },
  // Anthropic — family fallbacks at the predecessor generation's rate, which
  // is exact for Opus 5/4.x and Sonnet 4.6 and errs HIGH for Opus 5.5 and
  // Sonnet 5 (the safe direction). Also the rate of the bare `claude-opus`
  // arm id campaign configs use. The old $15/$75 was Opus 4.1's — retired.
  'claude-opus':   { input: 5,    output: 25  },
  'claude-sonnet': { input: 3,    output: 15  },
  'claude-haiku':  { input: 1,    output: 5   },
  // Legacy key preserved for callers not yet migrated
  'claude':        { input: 3,    output: 15  },

  // Google — refreshed 2026-09-07 from ai.google.dev/gemini-api/docs/pricing. The
  // prior values (flash 0.15/0.60, pro 1.25/5, set 2026-04-23 in 900f58e5) priced
  // the 2.x generation, so 3.x flash was costed at ~1/5 of its real rate — the
  // exact axis `switchIfCostImprovesByPct` decides a model swap on.
  //
  // TWO CAVEATS. (1) The flash rates are PROMOTIONAL through 2026-12-31, then
  // $1.50/$7.50 — re-check before acting on any cost delta. (2) `pricingKey()`
  // keys on TIER not version, so every *-flash id shares this row and 3.5 Flash
  // ($1.50/$9.00) is mis-priced — tolerable only while `latest-flash` resolves to
  // the always-current alias.
  //
  // `gemini-pro` is TIERED for the same reason `grok-4.6` below is: Google
  // prices Pro by prompt size, and a flat row under-counts every long audit
  // diff — precisely the call shape the final-review gate makes.
  'gemini-pro': {
    tiers: [
      { maxInputTokens: 200_000, input: 2.00, output: 12.00 },
      { maxInputTokens: Infinity, input: 4.00, output: 18.00 },
    ],
  },
  'gemini-flash':      { input: 0.75, output: 3.75 },
  'gemini-flash-lite': { input: 0.30, output: 2.50 },
  // Legacy key for callers still reading `gemini-3.1` — 3.1 Pro, same schedule.
  'gemini-3.1': {
    tiers: [
      { maxInputTokens: 200_000, input: 2.00, output: 12.00 },
      { maxInputTokens: Infinity, input: 4.00, output: 18.00 },
    ],
  },

  'grok-4.6': {
    tiers: [
      { maxInputTokens: 200_000, input: 2.00, output: 6.00, cachedInput: 0.50 },
      { maxInputTokens: Infinity, input: 4.00, output: 12.00, cachedInput: 1.00 },
    ],
  },
});
