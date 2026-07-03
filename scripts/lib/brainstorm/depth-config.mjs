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
 * Token caps per depth tier. `standard` matches the existing helper default
 * (1500) so no-flag invocations preserve prior behaviour. `deep` exceeds it
 * (4000) so auto-promote on technical topics actually expands context.
 */
export const DEPTH_TOKENS = Object.freeze({
  shallow: 500,
  standard: 1500,
  deep: 4000,
});

/**
 * Per-depth OpenAI `reasoning_effort`. Reasoning models (gpt-5.x) count
 * thinking tokens against `max_completion_tokens`, so at shallow's 500-token
 * cap the model can burn the whole budget reasoning and return an EMPTY
 * response with `finish_reason: length` (field-found on gpt-5.5,
 * wine-cellar-app 2026-07-03). `low` leaves headroom for actual output at
 * small caps. `null` = omit the param (model default) — standard/deep
 * behaviour unchanged.
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

/**
 * Resolve a depth value (and optionally the topic) to a maxTokens cap.
 * Precedence:
 *   - explicitDepth wins if provided
 *   - else autoPromote on topic if it matches
 *   - else 'standard'
 *
 * @param {{explicitDepth?: 'shallow'|'standard'|'deep'|null, topic?: string}} args
 * @returns {{depth: 'shallow'|'standard'|'deep', maxTokens: number, reasoningEffort: string|null, autoPromoted: boolean}}
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
    return { depth: explicitDepth, maxTokens: DEPTH_TOKENS[explicitDepth], reasoningEffort: DEPTH_REASONING_EFFORT[explicitDepth], autoPromoted: false };
  }
  const promoted = autoPromoteDepth(topic);
  if (promoted) {
    return { depth: promoted, maxTokens: DEPTH_TOKENS[promoted], reasoningEffort: DEPTH_REASONING_EFFORT[promoted], autoPromoted: true };
  }
  return { depth: 'standard', maxTokens: DEPTH_TOKENS.standard, reasoningEffort: DEPTH_REASONING_EFFORT.standard, autoPromoted: false };
}
