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

/**
 * The largest per-attempt timeout accepted. The watchdog floor is `2 x timeout + 60000` and
 * Node's setTimeout caps at 2^31-1 ms; anything above this would overflow into an immediate fire.
 */
export const MAX_FINAL_REVIEW_TIMEOUT_MS = 1_000_000_000;

/**
 * A positive whole number of milliseconds, written as plain digits, within the cap — else the
 * fallback. `parseInt` alone accepted `-1`, `0`, read `1.5` as 1 and `1e5` as 1 (audit R1-H1/M1):
 * a timeout of 1 ms fails every review instantly, which reads as a provider outage.
 */
function positiveMsOr(value, fallback) {
  const s = String(value ?? '').trim();
  if (!/^\d+$/.test(s)) return fallback;
  const n = Number(s);
  return Number.isSafeInteger(n) && n > 0 && n <= MAX_FINAL_REVIEW_TIMEOUT_MS ? n : fallback;
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
export function finalReviewModelSpec(env = process.env, { write } = {}) {
  return readEnvWithAlias({
    canonical: 'FINAL_REVIEW_MODEL', alias: 'GEMINI_REVIEW_MODEL',
    subsystem: 'final-review', env, write,
  }) || 'latest-pro';
}

/** The final reviewer's per-attempt timeout. Same canonical/alias pair. */
export function finalReviewTimeoutMs(env = process.env, { write = (m) => process.stderr.write(m) } = {}) {
  const raw = readEnvWithAlias({
    canonical: 'FINAL_REVIEW_TIMEOUT_MS', alias: 'GEMINI_REVIEW_TIMEOUT_MS',
    subsystem: 'final-review', env, write,
  });
  const ms = positiveMsOr(raw, DEFAULT_TIMEOUT_MS);
  // A set-but-invalid value is a configuration error: SAY so (once per distinct value per
  // process) rather than substitute the default silently (audit R2-H1).
  if (raw !== undefined && ms === DEFAULT_TIMEOUT_MS && String(raw).trim() !== String(DEFAULT_TIMEOUT_MS) && !warnedTimeouts.has(raw)) {
    warnedTimeouts.add(raw);
    write(`  [final-review] FINAL_REVIEW_TIMEOUT_MS=${JSON.stringify(raw)} is not a positive whole number of ms <= ${MAX_FINAL_REVIEW_TIMEOUT_MS}; using the default ${DEFAULT_TIMEOUT_MS}\n`);
  }
  return ms;
}

const DEFAULT_TIMEOUT_MS = 270000;
const warnedTimeouts = new Set();
/** For tests — reset the invalid-timeout warning latch. */
export function _resetTimeoutWarnings() { warnedTimeouts.clear(); }

