/**
 * @fileoverview Depth → maxTokens map + auto-promote heuristic.
 * Plan: docs/plans/brainstorm-quickfix-v1.md §10.B + §13.D.
 *
 * Single source of truth for depth-to-tokens mapping. Both helper CLI
 * and SKILL.md auto-promote logic read these constants.
 *
 * @module scripts/lib/brainstorm/depth-config
 */

/**
 * Prose length ASKED FOR per depth tier — the real lever. Injected into the
 * system prompt by `buildBrainstormSystemPrompt`.
 *
 * Before 2026-07-19 the prompt hardcoded "250–500 words" at every tier and
 * depth moved only the token ceiling. That made `--depth deep` inert (same
 * request, higher cap) and `--depth shallow` a truncator rather than a
 * shortener. Depth must change the instruction; the ceiling follows from it.
 */
export const DEPTH_WORD_TARGETS = Object.freeze({
  shallow: '150–250 words',
  standard: '250–500 words',
  deep: '600–1000 words',
});

/**
 * Tokens the requested prose can occupy — the upper word count with room to
 * spare (English averages ~1.33 tokens/word). This is bookkeeping for the
 * ceiling calculation, NOT a value sent to any provider.
 */
export const DEPTH_VISIBLE_TOKENS = Object.freeze({
  shallow: 400,
  standard: 800,
  deep: 1600,
});

/**
 * Extra ceiling reserved for reasoning/thinking tokens.
 *
 * Load-bearing: `max_completion_tokens` (OpenAI) and `maxOutputTokens`
 * (Gemini) are TOTAL output budgets that reasoning tokens are drawn from
 * FIRST. A ceiling sized for prose alone gets consumed by thinking and
 * returns an empty or mid-sentence response — the field failure that
 * motivated this (gpt-5.6 returned nothing at all at a 500 cap).
 *
 * Generous by design: a ceiling is a LIMIT, not a reservation. Unused
 * headroom costs nothing, while too little silently destroys the response.
 * Length is governed by the prompt's word target, not by this number — so
 * the ceiling's only job is to never be the thing that truncates.
 */
export const REASONING_HEADROOM_TOKENS = Object.freeze({
  shallow: 2000,
  standard: 2500,
  deep: 3000,
});

/**
 * Total per-tier output ceiling sent to the provider: prose + reasoning.
 */
export const DEPTH_TOKENS = Object.freeze({
  shallow: DEPTH_VISIBLE_TOKENS.shallow + REASONING_HEADROOM_TOKENS.shallow,
  standard: DEPTH_VISIBLE_TOKENS.standard + REASONING_HEADROOM_TOKENS.standard,
  deep: DEPTH_VISIBLE_TOKENS.deep + REASONING_HEADROOM_TOKENS.deep,
});

/**
 * Per-depth OpenAI `reasoning_effort`. Retained as a cost/latency hint for
 * the shortest tier — a 150–250-word answer rarely needs deep deliberation.
 *
 * It is NO LONGER the defence against budget exhaustion. That was its
 * original 2026-07-03 job (wine-cellar-app, gpt-5.5) and it proved
 * insufficient: gpt-5.6 still exhausted a 500-token cap *with* `low` set,
 * and the knob is OpenAI-only so Gemini was never covered at all. The
 * structural fix is `REASONING_HEADROOM_TOKENS` above, which is
 * provider-agnostic. `null` = omit the param (model default).
 */
export const DEPTH_REASONING_EFFORT = Object.freeze({
  shallow: 'low',
  standard: null,
  deep: null,
});

/**
 * Architecture-intent keyword regex. The trigger words cover
 * architecture / schema / migration / refactor / design questions.
 *
 * Single source of truth, two consumers:
 *   - `autoPromoteDepth()` below — promotes such topics to `deep`.
 *   - `shouldAttachArch()` in `arch-context.mjs` — decides whether to
 *     auto-attach the repo's architecture section to the prompt.
 *
 * The two consumers share this *constant* but each runs its own test —
 * neither calls the other — so depth and arch-attach policies stay
 * behaviourally independent (plan §2, audit M1 / R3-M2).
 */
export const ARCH_INTENT_RE = /(architect|schema|migration|refactor|design|how\s+should\s+we\s+structure|what['']?s\s+the\s+best\s+approach)/i;

/**
 * Returns 'deep' if the topic matches the auto-promote heuristic, else null.
 * Caller's default applies when null is returned.
 *
 * @param {string} topic
 * @returns {'deep'|null}
 */
export function autoPromoteDepth(topic) {
  if (typeof topic !== 'string' || topic.length === 0) return null;
  return ARCH_INTENT_RE.test(topic) ? 'deep' : null;
}

/** Assemble the full resolved-tier record. One place, so the four per-tier
 * tables can never disagree about which tier a caller asked for. */
function tierResult(depth, autoPromoted) {
  return {
    depth,
    wordTarget: DEPTH_WORD_TARGETS[depth],
    visibleTokens: DEPTH_VISIBLE_TOKENS[depth],
    maxTokens: DEPTH_TOKENS[depth],
    reasoningEffort: DEPTH_REASONING_EFFORT[depth],
    autoPromoted,
  };
}

/**
 * Resolve a depth value (and optionally the topic) to a prose target and a
 * provider output ceiling. Precedence:
 *   - explicitDepth wins if provided
 *   - else autoPromote on topic if it matches
 *   - else 'standard'
 *
 * @param {{explicitDepth?: 'shallow'|'standard'|'deep'|null, topic?: string}} args
 * @returns {{depth: 'shallow'|'standard'|'deep', wordTarget: string,
 *   visibleTokens: number, maxTokens: number, reasoningEffort: string|null,
 *   autoPromoted: boolean}}
 */
export function resolveDepth(args = {}) {
  // Audit R1-H2: defensive null/undefined handling. Caller may pass null
  // for the args object itself or for individual fields; treat all as
  // "no override" rather than throwing on `null in DEPTH_TOKENS`.
  const safeArgs = (args && typeof args === 'object') ? args : {};
  const explicitDepth = safeArgs.explicitDepth ?? null;
  const topic = (typeof safeArgs.topic === 'string') ? safeArgs.topic : '';

  if (explicitDepth !== null && explicitDepth !== undefined) {
    // Audit R4-M7: use Object.hasOwn instead of `in` so inherited keys
    // like 'constructor' / 'toString' / '__proto__' don't pass validation.
    if (typeof explicitDepth !== 'string' || !Object.hasOwn(DEPTH_TOKENS, explicitDepth)) {
      throw new Error(`Unknown depth: ${JSON.stringify(explicitDepth)} (allowed: ${Object.keys(DEPTH_TOKENS).join(', ')})`);
    }
    return tierResult(explicitDepth, false);
  }
  const promoted = autoPromoteDepth(topic);
  if (promoted) {
    return tierResult(promoted, true);
  }
  return tierResult('standard', false);
}

/**
 * Resolve the full output budget for a run: the depth tier ALWAYS applies;
 * an explicit `--max-tokens` overrides only the provider ceiling.
 *
 * Why this is a function and not three lines at the call site: depth's real
 * levers are the prose length asked for (`wordTarget`), the reasoning-effort
 * hint, and topic auto-promotion. Those are properties of the TIER, not of
 * the ceiling. Resolving them in an `else` branch of "did the user pass
 * --max-tokens?" silently reverted every `--max-tokens` run to the default
 * ask — so `--depth deep --max-tokens N` produced standard-depth prose. That
 * bug was introduced once, then re-introduced when `wordTarget` was added to
 * the same branch; a single tested seam is what stops a third recurrence.
 *
 * @param {{explicitDepth?: string|null, topic?: string,
 *          explicitMaxTokens?: boolean, maxTokens?: number|null}} args
 * @returns {{depth: string, wordTarget: string, visibleTokens: number,
 *   maxTokens: number, reasoningEffort: string|null, autoPromoted: boolean,
 *   ceilingOverridden: boolean, tierMaxTokens: number,
 *   ceilingBelowProseBudget: boolean}}
 */
export function resolveOutputBudget(args = {}) {
  const safe = (args && typeof args === 'object') ? args : {};
  const tier = resolveDepth({ explicitDepth: safe.explicitDepth ?? null, topic: safe.topic });

  if (!safe.explicitMaxTokens) {
    return { ...tier, ceilingOverridden: false, tierMaxTokens: tier.maxTokens, ceilingBelowProseBudget: false };
  }

  const maxTokens = safe.maxTokens;
  return {
    ...tier,
    maxTokens,                       // the ONLY field --max-tokens may change
    tierMaxTokens: tier.maxTokens,   // what the tier would have used
    ceilingOverridden: true,
    // A ceiling below the tier's own prose budget guarantees a mid-sentence
    // finish — the ceiling must never be the truncator (REASONING_HEADROOM_TOKENS).
    ceilingBelowProseBudget: Number.isFinite(maxTokens) && maxTokens < tier.visibleTokens,
  };
}
