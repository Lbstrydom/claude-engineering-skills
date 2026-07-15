/**
 * @fileoverview GPT sentinel trigger — three independent paths that decide
 * whether the optional/exploratory GPT-5.5 generator fires for a given
 * commit, each logged with which one fired. Phase 6 of the tiered-recall
 * audit pipeline.
 *
 * Plan: docs/plans/tiered-recall-audit-pipeline.md Phase 6.
 *
 * **Scoped-Cluster-D note** (2026-07-10): this module is new, tested, and
 * NOT wired into `openai-audit.mjs`'s production chooser in this pass — that
 * wiring, and the `runLegacyProductionAudit` extraction it depends on, are
 * deferred to a dedicated follow-up (see `.audit/cycle-cluster-state.json`
 * for the full rationale). `shouldTriggerGpt`/`shouldFireSentinel` are pure
 * and fully testable in isolation regardless.
 *
 * @module scripts/lib/audit/gpt-sentinel-trigger
 */

import { seededDraw } from '../rng.mjs';

/**
 * Keyword groups that deterministically justify a GPT sentinel fire —
 * centralized here (tested, not inline strings scattered through a trigger
 * function) per round-1 finding #14.
 */
// Stem keywords (trailing `*`) intentionally match as a PREFIX of a longer
// word — "sanitiz*" matches "sanitize"/"sanitized"/"sanitization" — audit
// fix M5/M8, round 2: the round-1 word-boundary fix (`\bkeyword\b`) broke
// these by requiring an EXACT word match, so "sanitiz" (deliberately missing
// its final "e" in the original list — already a stem) stopped matching
// "sanitize" at all. Whole-word keywords (no `*`) still require an exact
// word-boundary match on both sides, preserving the L3 fix's actual goal:
// "auth" must not match inside "author", but "sanitiz*" must match
// "sanitized".
export const KEYWORD_GROUPS = Object.freeze({
  security: ['auth', 'authn', 'authz', 'token', 'password', 'secret', 'credential', 'jwt', 'oauth', 'csrf', 'xss', 'injection', 'sanitiz*', 'encrypt*', 'decrypt*'],
  concurrency: ['race', 'deadlock', 'mutex', 'lock', 'atomic', 'transaction', 'concurrent', 'async', 'await', 'promise.all', 'thread'],
  dataIntegrity: ['migration', 'schema', 'foreign key', 'cascade', 'rollback', 'idempotent', 'dedup'],
  payment: ['payment', 'billing', 'invoice', 'charge', 'refund', 'stripe', 'checkout'],
});

function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Word-boundary regex per keyword, built once and cached (audit fix L3 — raw
// `.includes()` substring matching let e.g. "auth" match inside "author",
// or "atomic" match inside a filename, firing the expensive exploratory GPT
// path for reasons unrelated to actual risk). `\b` correctly brackets
// multi-word/punctuated keywords like "promise.all" and "foreign key" too,
// since `.` and ` ` are already non-word characters. A trailing `*` (audit
// fix M5/M8) makes the keyword a STEM: the closing `\b` moves past an
// optional run of word characters, so it still requires a word-START
// boundary (never matches mid-word, so "auth" still can't hide inside
// "author") while allowing a real inflected suffix ("sanitiz*" → "sanitize",
// "sanitized", "sanitization").
const KEYWORD_REGEX_CACHE = new Map();
function keywordRegex(keyword) {
  if (!KEYWORD_REGEX_CACHE.has(keyword)) {
    const isStem = keyword.endsWith('*');
    const base = escapeRegex(isStem ? keyword.slice(0, -1) : keyword);
    const pattern = isStem ? `\\b${base}\\w*\\b` : `\\b${base}\\b`;
    KEYWORD_REGEX_CACHE.set(keyword, new RegExp(pattern, 'i'));
  }
  return KEYWORD_REGEX_CACHE.get(keyword);
}

/** Does `text` match any keyword in any `KEYWORD_GROUPS` entry, at a word
 * boundary (not as a substring of an unrelated word)? Returns the matched
 * group names. */
function matchKeywordGroups(text) {
  const str = String(text || '');
  const matched = [];
  for (const [group, keywords] of Object.entries(KEYWORD_GROUPS)) {
    if (keywords.some((kw) => keywordRegex(kw).test(str))) matched.push(group);
  }
  return matched;
}

/**
 * Deterministic trigger path — pure function, no I/O. Fires when the diff is
 * large (character-length threshold), matches a risk keyword group, or the
 * discovery portfolio's own generators disagreed with each other (a signal
 * that the commit is genuinely ambiguous, not just large).
 *
 * `changedFiles` is accepted (the plan's own `shouldTriggerGpt({diffSize,
 * changedFiles, keywordMatches, portfolioDisagreement})` signature names it
 * as an input) but is NOT currently a trigger signal on its own — the plan's
 * concrete config table (`AUDIT_GPT_DIFF_SIZE_TRIGGER_CHARS`) specifies only
 * a character-length threshold, no file-count threshold (audit fix M6 —
 * round 1 caught an earlier draft of this docstring overclaiming "touches
 * many files" without an implementation). Kept in the signature for forward
 * API compatibility should a file-count threshold be added later.
 *
 * @param {object} inputs
 * @param {number} inputs.diffSize - character length of the diff text
 * @param {string[]} inputs.changedFiles - accepted, not currently a trigger signal (see above)
 * @param {string} [inputs.diffText] - used only for keyword matching; not required
 * @param {boolean} [inputs.portfolioDisagreement] - true if the required generators
 *   (GLM + Sonnet) produced materially different candidate sets for the same commit
 * @param {{gptDiffSizeTriggerChars: number}} config - from `tieredAuditConfig`
 * @returns {{fire: boolean, reasonCodes: string[]}}
 */
export function shouldTriggerGpt({ diffSize = 0, changedFiles = [], diffText = '', portfolioDisagreement = false }, config) {
  const reasonCodes = [];
  if (diffSize >= config.gptDiffSizeTriggerChars) reasonCodes.push('diff_size_threshold');
  const keywordGroups = matchKeywordGroups(diffText);
  if (keywordGroups.length > 0) reasonCodes.push(...keywordGroups.map((g) => `keyword:${g}`));
  if (portfolioDisagreement) reasonCodes.push('portfolio_disagreement');
  return { fire: reasonCodes.length > 0, reasonCodes };
}

/**
 * Sentinel (bandit-backed) trigger path. Registers two arms
 * (`gpt-sentinel-trigger:fire` / `:skip`) on the injected `bandit` instance
 * (idempotent — `PromptBandit.addArm` is a no-op once an arm exists) and
 * Thompson-samples a decision on the GLOBAL context bucket. This function
 * performs I/O (bandit persistence via the `bandit` instance) so it is NOT
 * pure — callers that need pure trigger logic should use `shouldTriggerGpt`
 * instead.
 *
 * Deliberately global-bucket-only (not per-context-bucket): `PromptBandit`'s
 * `select(passName, context)` takes a context OBJECT built by the pass
 * system's own `buildContext()` — a shape this trigger has no reason to
 * replicate for a single global fire/skip decision, and `select(passName,
 * null)` already falls through correctly to the global bucket regardless of
 * sample count (bandit.mjs:114-117).
 *
 * @param {import('../../bandit.mjs').PromptBandit} bandit
 * @returns {{fire: boolean, variantId: 'fire'|'skip'}}
 */
export function shouldFireSentinel(bandit) {
  bandit.addArm('gpt-sentinel-trigger', 'fire');
  bandit.addArm('gpt-sentinel-trigger', 'skip');
  const selected = bandit.select('gpt-sentinel-trigger', null);
  const variantId = selected?.variantId ?? 'skip';
  return { fire: variantId === 'fire', variantId };
}

/**
 * Exploration-sample trigger path (round-1 finding #11 — fixes the bandit's
 * missing counterfactual): a seeded pure decision, independent of the
 * bandit's own `skip` choice, so a configurable fraction of commits force
 * GPT to fire regardless — generating the counterfactual label "would GPT
 * have found something the portfolio missed here." Only the caller's
 * bookkeeping of THIS path's outcome should feed the `skip` arm's reward
 * update (deterministic-trigger fires are forced, not exploratory, and never
 * count as bandit signal — this function only decides WHETHER to explore,
 * the caller is responsible for keeping that provenance distinct).
 *
 * @param {{seed: number, rate: number}} opts - `rate` from `tieredAuditConfig.gptExplorationRate`
 * @returns {boolean}
 */
export function isExplorationSample({ seed, rate }) {
  // Deterministic per-seed draw via the shared seeded-RNG module (audit fix
  // L1/L2 — was previously reimplemented inline here) — a given commit's
  // exploration-sample membership is reproducible, not re-rolled on every
  // invocation.
  return seededDraw(seed) < rate;
}

/**
 * Combine all three trigger paths into one decision, logging which fired
 * (round-1 finding #14's "each logged with which one fired"). Deterministic
 * and exploration paths are evaluated first (pure, cheap); the sentinel path
 * (bandit I/O) is evaluated only if neither already decided to fire, since a
 * deterministic/exploration fire makes the bandit's own choice moot for this
 * commit.
 *
 * @param {object} inputs - `shouldTriggerGpt`'s inputs
 * @param {{seed: number}} explorationOpts
 * @param {import('../../bandit.mjs').PromptBandit|null} bandit - null skips the sentinel path entirely
 * @param {import('../config.mjs').tieredAuditConfig} config
 * @returns {{fire: boolean, firedBy: 'deterministic'|'exploration'|'sentinel'|null, reasonCodes: string[], sentinelVariantId?: 'fire'|'skip'}}
 */
export function resolveGptTrigger(inputs, explorationOpts, bandit, config) {
  const deterministic = shouldTriggerGpt(inputs, config);
  if (deterministic.fire) return { fire: true, firedBy: 'deterministic', reasonCodes: deterministic.reasonCodes };

  const exploring = isExplorationSample({ seed: explorationOpts.seed, rate: config.gptExplorationRate });
  if (exploring) return { fire: true, firedBy: 'exploration', reasonCodes: ['exploration_sample'] };

  if (!bandit) return { fire: false, firedBy: null, reasonCodes: [] };
  const sentinel = shouldFireSentinel(bandit);
  return {
    fire: sentinel.fire,
    firedBy: sentinel.fire ? 'sentinel' : null,
    reasonCodes: sentinel.fire ? ['sentinel_bandit_fire'] : [],
    sentinelVariantId: sentinel.variantId,
  };
}
