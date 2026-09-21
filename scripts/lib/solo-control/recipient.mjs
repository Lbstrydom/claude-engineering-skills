/**
 * @fileoverview Recipient classification for experiment 5 — the single oracle
 * that answers "which third party does this model id reach". A RECIPIENT is
 * the party that receives repository content, distinct from wire protocol:
 * `openrouter` is one recipient regardless of which upstream model it routes
 * to, and `deepseek-flash` reached directly is recipient `deepseek`, while
 * the same model reached via an OpenRouter slug (`deepseek/deepseek-flash`)
 * would be recipient `openrouter`. This distinction is why classification
 * checks the DIRECT-route patterns before the generic '/' catch-all.
 *
 * docs/plans/reviewer-cost-value-experiment.md §2/§3 ("Recipient vocabulary").
 *
 * @module scripts/lib/solo-control/recipient
 */

/** Every recipient this experiment's vocabulary recognises. `alibaba`/`xai`
 * are recognised (so a policy file naming them validates) even though no
 * exp-5 arm currently dispatches to them. */
export const RECIPIENTS = Object.freeze(['anthropic', 'openai', 'gemini', 'deepseek', 'alibaba', 'xai', 'openrouter']);

/**
 * Classify a RESOLVED model id (never a sentinel — resolve first, classify
 * the resolved id, so the manifest and the recipient check agree) by which
 * recipient receives it. Throws rather than guessing on an id that matches
 * no known pattern — a silent misclassification here is a silent egress-
 * policy bypass, so an unrecognised id must block, not fall through.
 *
 * @param {string} model resolved model id, e.g. "claude-sonnet-5", "gpt-6-astra",
 *   "gemini-pro-latest", "deepseek-flash", "qwen/qwen3.8-max".
 * @returns {typeof RECIPIENTS[number]}
 */
export function classifyRecipient(model) {
  if (typeof model !== 'string' || model.length === 0) {
    throw new Error(`classifyRecipient: model id must be a non-empty string, got ${JSON.stringify(model)}`);
  }
  // Direct-route patterns checked BEFORE the generic '/' catch-all — an
  // OpenRouter id is the only one carrying a '/' among the direct patterns,
  // so checking direct patterns first is enough; there is no ordering
  // ambiguity to resolve the other way (unlike bakeoff/arms.mjs's
  // ALIBABA_POOL/DEEPSEEK_POOL allowlist check, which guards against a
  // FUTURE pool entry containing '/' — no such entry exists in this
  // experiment's fixed arm set, so a plain prefix match is enough here).
  if (/^claude-/.test(model)) return 'anthropic';
  if (/^gpt-/.test(model)) return 'openai';
  if (/^gemini-/.test(model)) return 'gemini';
  if (/^deepseek-/.test(model)) return 'deepseek';
  if (model.includes('/')) return 'openrouter';
  throw new Error(`classifyRecipient: cannot classify model id "${model}" — no known recipient pattern matched (anthropic/openai/gemini/deepseek prefix, or a '/' OpenRouter slug)`);
}
