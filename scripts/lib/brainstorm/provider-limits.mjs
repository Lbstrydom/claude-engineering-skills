/**
 * @fileoverview Provider input ceilings + token estimator.
 * Plan: docs/plans/brainstorm-quickfix-v1.md §10.B + §11.F.
 *
 * Canonical UNIT is tokens end-to-end. Char-to-token estimator is
 * documented and isolated here so changing it later (e.g. switching to
 * tiktoken) only touches one place.
 *
 * @module scripts/lib/brainstorm/provider-limits
 */

/**
 * Char/4 estimator — well-known rule of thumb for English text.
 * Returns ceiling-rounded so we never UNDER-estimate.
 *
 * @param {string} text
 * @param {string|null} [_model] - reserved for future model-specific tokenisers
 * @returns {number} estimated tokens
 */
export function estimateTokens(text, _model = null) {
  return Math.ceil((text || '').length / 4);
}

/**
 * Per-provider input ceilings in TOKENS. Single source of truth.
 * Models not listed fall back to `default`.
 */
export const PROVIDER_INPUT_CEILING_TOKENS = Object.freeze({
  openai: Object.freeze({
    'latest-gpt': 128_000,
    'latest-gpt-mini': 128_000,
    default: 100_000,
  }),
  gemini: Object.freeze({
    'latest-pro': 1_000_000,
    'latest-flash': 1_000_000,
    'latest-flash-lite': 1_000_000,
    default: 100_000,
  }),
});

/**
 * Fraction of the provider ceiling reserved for resume context (older
 * rounds + last-2-verbatim).
 */
export const RESUME_BUDGET_FRACTION = 0.4;

/**
 * Fraction of the provider ceiling reserved for `--with-context`.
 * Counted SEPARATELY from the resume budget.
 */
export const WITH_CONTEXT_FRACTION = 0.1;

/**
 * Fraction of the provider ceiling reserved for the auto/`--with-arch`
 * architecture-context block. Counted SEPARATELY from resume and
 * with-context. Resume + with-context + arch sum to 0.6 < 1.0, so the
 * combined-ceiling guard in `assembleResumeContext` is purely defensive
 * (plan §2 Context allocator).
 */
export const ARCH_CONTEXT_FRACTION = 0.1;

/**
 * Returns the input-token ceiling for a (provider, sentinel) pair.
 * Falls back to the provider's `default` when the specific sentinel
 * isn't in the table.
 *
 * @param {'openai'|'gemini'} provider
 * @param {string} modelSentinel
 * @returns {number}
 */
export function getCeilingTokens(provider, modelSentinel) {
  if (!Object.hasOwn(PROVIDER_INPUT_CEILING_TOKENS, provider)) {
    throw new Error(`Unknown provider: ${provider}`);
  }
  const table = PROVIDER_INPUT_CEILING_TOKENS[provider];
  // Audit Gemini-G-M1: Object.hasOwn so 'toString'/'constructor' don't
  // return Object.prototype function references.
  if (typeof modelSentinel === 'string' && Object.hasOwn(table, modelSentinel)) {
    return table[modelSentinel];
  }
  return table.default;
}

/**
 * Smallest ceiling among the requested (provider, sentinel) pairs.
 * Used to drive resume-context budget so the assembled prompt fits all
 * requested providers (most restrictive wins).
 *
 * @param {Array<{provider: 'openai'|'gemini', model: string}>} providers
 * @returns {{ceilingTokens: number, drivenBy: {provider: string, model: string}}}
 */
export function smallestCeilingTokens(providers) {
  if (!Array.isArray(providers) || providers.length === 0) {
    throw new Error('providers array required and non-empty');
  }
  let best = null;
  for (const p of providers) {
    const ceiling = getCeilingTokens(p.provider, p.model);
    if (best === null || ceiling < best.ceilingTokens) {
      best = { ceilingTokens: ceiling, drivenBy: { provider: p.provider, model: p.model } };
    }
  }
  return best;
}
