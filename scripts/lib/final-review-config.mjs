/**
 * @fileoverview The final reviewer's model + timeout resolvers, and the ONE
 * place their defaults live.
 *
 * Its own module rather than more weight in `config.mjs`, which is past the
 * 1000-line ratchet: these two are cohesive (one role, one canonical/alias
 * pair each) and config.mjs only needs to call them.
 *
 * @module scripts/lib/final-review-config
 */

import { readEnvWithAlias } from './env-alias.mjs';

/** Parse an int, falling back rather than yielding NaN. */
function safeInt(value, fallback) {
  const n = Number.parseInt(value ?? '', 10);
  return Number.isFinite(n) ? n : fallback;
}

/**
 * The final reviewer's model SPEC (a sentinel or concrete id), before
 * resolution. Exported because `gemini-review.mjs` must RE-RESOLVE it after
 * refreshing the live catalog, and it previously did so against its own
 * hardcoded `'latest-pro'` default. Two defaults for one setting is not a
 * style problem: on 2026-09-07 the committed default moved to `latest-flash`
 * and that second copy silently reassigned MODEL back to pro at runtime,
 * undoing the switch and printing it as an `upgraded` notice.
 *
 * The default is `latest-pro` again since 2026-10-10 (owner decision: the
 * final reviewer runs the BEST available Gemini, resolved at runtime to
 * Google's always-newest Pro alias — never a pinned id). Rationale and the
 * reversal of experiment-6's cost swap: docs/research/experiment-6-*.md §9.
 *
 * `FINAL_REVIEW_MODEL` is the canonical name -- the role is provider-agnostic
 * (FINAL_REVIEW_PROVIDER, selectProvider(), an Opus fallback, a grok shadow
 * arm), so naming its model after one vendor is legacy. `GEMINI_REVIEW_MODEL`
 * stays a working alias; nothing needs renaming to keep working.
 */
export function finalReviewModelSpec(env = process.env) {
  return readEnvWithAlias({
    canonical: 'FINAL_REVIEW_MODEL', alias: 'GEMINI_REVIEW_MODEL',
    subsystem: 'final-review', env,
  }) || 'latest-pro';
}

/** The final reviewer's per-attempt timeout. Same canonical/alias pair. */
export function finalReviewTimeoutMs(env = process.env) {
  return safeInt(readEnvWithAlias({
    canonical: 'FINAL_REVIEW_TIMEOUT_MS', alias: 'GEMINI_REVIEW_TIMEOUT_MS',
    subsystem: 'final-review', env,
  }), 270000);
}

