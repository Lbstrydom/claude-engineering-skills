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
 * Per-depth Anthropic `output_config.effort` for the azure-claude voice.
 *
 * **Why explicit** (storyline field report, 2026-10-01): the adapter sent no
 * effort, so Claude thought at its API default — `high` on Opus 5, which
 * thinks whenever `thinking` is omitted (Opus 5.5 defaults to `medium`). Five
 * deep rounds hit 4,310–4,600 of a 4,600 ceiling, two of them truncated, while
 * GPT in the same rounds used 1,507–2,195. A provider default is also a
 * default that can move under us; stating it puts this voice on a known dial,
 * the same reasoning as `final-review/transport.mjs`.
 *
 * Measured 2026-10-01 against the public API with the brainstorm prompt
 * (output tokens incl. thinking, worst case per cell, 3–15 calls each):
 *
 *   tier      model    default(omitted)  low     medium
 *   deep      opus-5   4,421 (2,187 th)  3,155   4,423 (1,990 th)
 *   deep      opus-5.5 3,186             2,661   3,440 (1,216 th)
 *   standard  opus-5   2,625 (1,266 th)  1,230   2,081
 *   shallow   opus-5   1,244               868   —
 *
 * `low` for shallow (a 150–250-word take needs little deliberation and low
 * thinks ~0–200 tokens); `medium` above it, where the point of the tier is a
 * considered view. Effort alone does not make deep safe — across 29 medium
 * deep calls the worst reached 4,423, 96% of the old 4,600 ceiling — which is
 * why `CLAUDE_VISIBLE_TOKENS` below exists too.
 *
 * A deployment that rejects effort (Sonnet/Haiku 4.5 do) is retried once
 * without it by the adapter, mirroring the OpenAI adapter's reasoning_effort
 * fallback.
 */
export const CLAUDE_DEPTH_EFFORT = Object.freeze({
  shallow: 'low',
  standard: 'medium',
  deep: 'medium',
});

/**
 * Tokens Claude's prose occupies per tier. `DEPTH_VISIBLE_TOKENS` assumes
 * ~1.33–1.6 tokens/word, which is right for the OpenAI/Gemini tokenizers and
 * wrong for Claude: measured 2026-10-01, a 958-word deep answer with 14 tokens
 * of thinking cost 2,208 output tokens — ~2.3 tokens/word in the markdown-heavy
 * style brainstorm answers take. At that density the shared deep budget (1,600)
 * holds ~700 words, below the tier's own 1,000-word target, BEFORE any
 * thinking. Sized here at ~2.3 tokens/word on the upper target plus the
 * ~30% overshoot storyline observed on deep (1,000–1,300 words).
 *
 * Reasoning headroom is unchanged (`REASONING_HEADROOM_TOKENS`) — the ceiling
 * grows because the PROSE is denser, not to buy more thinking.
 */
export const CLAUDE_VISIBLE_TOKENS = Object.freeze({
  shallow: 800,
  standard: 1400,
  deep: 3000,
});

/**
 * The azure-claude per-tier ceiling. Deep: 3000 + 3000 = 6000, where the worst
 * measured medium-effort deep call (4,423) sits at 74% and the median (~3,100)
 * near 52%. Worst latency in that run was 70s against the 120s timeout this
 * ceiling scales to.
 *
 * Upper bound to respect if these ever grow: the adapter calls the
 * NON-streaming `messages.create()`, which the SDK refuses above its
 * non-streaming max_tokens ceiling (`final-review/transport.mjs` streams for
 * exactly that reason), and the per-call timeout scales with the ceiling at
 * `TIMEOUT_MS_PER_TOKEN` (6000 → 120s). Both are far off today; a ceiling in
 * the tens of thousands would need the adapter moved to streaming first.
 */
export const CLAUDE_DEPTH_TOKENS = Object.freeze({
  shallow: CLAUDE_VISIBLE_TOKENS.shallow + REASONING_HEADROOM_TOKENS.shallow,
  standard: CLAUDE_VISIBLE_TOKENS.standard + REASONING_HEADROOM_TOKENS.standard,
  deep: CLAUDE_VISIBLE_TOKENS.deep + REASONING_HEADROOM_TOKENS.deep,
});

/**
 * Wall-clock floor for a provider call, unchanged from the CLI's historical
 * flat default — shallow/standard asks (≤3300 ceiling tokens) fit inside it
 * on every provider observed so far.
 */
export const TIMEOUT_FLOOR_MS = 60000;

/**
 * Extra wall-clock allowance per ceiling token, for asks above the floor.
 *
 * **Why this exists** (consumer report, 2026-09-08): the CLI's timeout was a
 * flat 60000ms regardless of the requested ceiling. A `--depth deep` call
 * (4600 ceiling tokens) legitimately needs more wall-clock than a `standard`
 * one (3300) on a non-streaming API — the caller gets nothing back until the
 * WHOLE completion is generated, so a bigger ask is a longer wait by
 * construction, not a sign anything is wrong. One azure-claude leg was
 * aborted at exactly the 60000ms ceiling (not a natural failure) while an
 * OpenAI leg in the SAME round, asked for the same ceiling, returned in time
 * — read as "this provider is categorically slower" that would be a guess
 * this repo has no throughput data to back; read as "a 4600-token
 * non-streaming ask deserves more than 60s regardless of provider" it is not.
 *
 * 20ms/token (~50 tok/s) is a conservative floor for a slow non-streaming
 * hop, NOT a measured p95 — no adapter here records real generation
 * throughput yet. It only ever raises the timeout above `TIMEOUT_FLOOR_MS`,
 * never below it, so a call that already met the historical default is
 * unaffected. Revisit with a fitted number once an adapter records latency
 * vs. output-token counts.
 */
export const TIMEOUT_MS_PER_TOKEN = 20;

/**
 * Resolve the per-provider call timeout. An explicit `--timeout-ms` always
 * wins verbatim (the operator asked for a specific number and gets it,
 * including a value below the floor); otherwise the timeout scales with the
 * ceiling this run actually asked for, floored at the CLI's historical
 * default so shallow/standard asks are unaffected.
 *
 * @param {{explicit?: boolean, timeoutMs?: number, maxTokens: number}} args
 * @returns {number}
 */
export function resolveTimeoutMs({ explicit = false, timeoutMs, maxTokens } = {}) {
  if (explicit) return timeoutMs;
  return Math.max(TIMEOUT_FLOOR_MS, Math.round(maxTokens * TIMEOUT_MS_PER_TOKEN));
}

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

/** Tier order, shallowest first — the ladder `truncationRemedy` climbs. */
const DEPTH_ORDER = Object.freeze(['shallow', 'standard', 'deep']);

/**
 * Resolve ONE provider's call parameters from the run's output budget. Round 1
 * and the debate round both go through here, so a per-provider setting cannot
 * be wired into one and forgotten in the other.
 *
 * - Ceiling: azure-claude takes its own tier table (`CLAUDE_DEPTH_TOKENS` —
 *   denser prose); everyone else the shared tier ceiling. An explicit
 *   `--max-tokens` is honoured verbatim for every provider.
 * - Effort: each provider's own knob, or null. Gemini has none here.
 * - Timeout: scaled from THIS provider's ceiling, so a larger Claude ceiling
 *   is not cut off by a timeout sized for a smaller one; `--timeout-ms` wins.
 *
 * @param {{budget: ReturnType<typeof resolveOutputBudget>, provider: string,
 *          explicitTimeoutMs?: boolean, timeoutMs?: number}} args
 * @returns {{maxTokens: number, reasoningEffort: string|null, timeoutMs: number,
 *   truncationRemedy: string}}
 */
export function resolveProviderCall({ budget, provider, explicitTimeoutMs = false, timeoutMs } = {}) {
  const claude = provider === 'azure-claude';
  const maxTokens = (claude && !budget.ceilingOverridden) ? CLAUDE_DEPTH_TOKENS[budget.depth] : budget.maxTokens;
  const reasoningEffort = claude ? CLAUDE_DEPTH_EFFORT[budget.depth]
    : provider === 'openai' ? (budget.reasoningEffort ?? null)
      : null;
  return {
    maxTokens,
    reasoningEffort,
    timeoutMs: resolveTimeoutMs({ explicit: explicitTimeoutMs, timeoutMs, maxTokens }),
    truncationRemedy: truncationRemedy({ depth: budget.depth, ceilingOverridden: budget.ceilingOverridden, maxTokens }),
  };
}

/**
 * The remedy a truncated response should name. "Raise --depth" was the only
 * advice every adapter gave, and it is unactionable at the top tier — which is
 * where every storyline truncation happened. Below deep, the next tier; at
 * deep, or once the ceiling was set by hand, `--max-tokens` is the only lever
 * left, so name it with the number to beat.
 *
 * @param {{depth: string, ceilingOverridden?: boolean, maxTokens: number}} args
 * @returns {string}
 */
export function truncationRemedy({ depth, ceilingOverridden = false, maxTokens }) {
  if (ceilingOverridden) {
    return `re-run with a --max-tokens above ${maxTokens} for a full answer`;
  }
  const next = DEPTH_ORDER[DEPTH_ORDER.indexOf(depth) + 1];
  if (next) return `re-run with --depth ${next} for a full answer`;
  return `${depth} is already the top tier — re-run with --max-tokens above ${maxTokens} for a full answer`;
}

/**
 * The truncated-state message every adapter shows. `thinkingTokens` (null when
 * the provider reported none) is named so a cut-off answer says whether
 * reasoning or prose spent the budget.
 *
 * @param {{maxTokens?: number|null, thinkingTokens?: number|null, remedy?: string|null}} args
 * @returns {string}
 */
export function truncatedMessage({ maxTokens = null, thinkingTokens = null, remedy = null } = {}) {
  const ceiling = Number.isFinite(maxTokens) ? `the ${maxTokens}-token output ceiling` : 'the output-token ceiling';
  const spent = Number.isFinite(thinkingTokens) ? ` (${thinkingTokens} of it spent on thinking)` : '';
  return `Response hit ${ceiling}${spent} and is incomplete — ${remedy ?? 'raise --depth or --max-tokens for a full answer'}.`;
}
