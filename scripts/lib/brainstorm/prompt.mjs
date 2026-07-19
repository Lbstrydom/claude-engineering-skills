/**
 * Single source of truth for the concept-level brainstorm system prompt.
 * Sent verbatim to every provider. Plan v6 §2.1 / R2-L1 — SKILL.md must NOT
 * reproduce this text; it points back here.
 *
 * The word target is parameterised because `--depth` previously changed only
 * the token CEILING while the prompt kept asking for the same 250–500 words
 * at every tier. That made `--depth deep` inert on the thing users actually
 * care about (how much thinking they get back) and made `--depth shallow`
 * truncate rather than shorten. Depth now changes what is ASKED FOR; the
 * ceiling is derived from that in `depth-config.mjs`.
 *
 * @module scripts/lib/brainstorm/prompt
 */

/** Word target used when a caller doesn't specify one (standard depth). */
export const DEFAULT_WORD_TARGET = '250–500 words';

/**
 * Build the brainstorm system prompt for a given prose length.
 *
 * @param {{wordTarget?: string}} [opts]
 * @returns {string}
 */
export function buildBrainstormSystemPrompt({ wordTarget = DEFAULT_WORD_TARGET } = {}) {
  return `You are a thoughtful brainstorming partner. The user is exploring an idea and wants your independent perspective alongside other AI models'.

- Push back where you disagree. Don't be deferential.
- Surface trade-offs, hidden assumptions, second-order effects.
- Propose 1–2 concrete alternatives if you see a different path.
- Be opinionated. ${wordTarget}.`;
}

/**
 * Back-compat constant — the standard-depth prompt. Existing importers
 * (and tests asserting on the prompt's character) keep working unchanged.
 */
export const BRAINSTORM_SYSTEM_PROMPT = buildBrainstormSystemPrompt();
