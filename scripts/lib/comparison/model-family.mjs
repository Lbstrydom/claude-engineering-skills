/**
 * @fileoverview Same-family model-identity check — a LEAF module deliberately
 * separated from `fingerprint.mjs` (Cluster A round 6, M3).
 *
 * `sameFamilyAmbiguity` used to live in `fingerprint.mjs`, which imports
 * `isScoredArm` from `arms.mjs`. `arms.mjs`'s own `checkArmSetSemantics` needs
 * the SAME same-family test for its replicate-backing rule (see below), and
 * `arms.mjs` importing `fingerprint.mjs` would be circular. This module has no
 * dependency on `arms.mjs` — only on `model-resolver.mjs` — so both
 * `fingerprint.mjs` and `arms.mjs` can import it without a cycle.
 *
 * Plan: docs/plans/role-agnostic-comparison-core.md D2/D4.
 *
 * @module scripts/lib/comparison/model-family
 */

import {
  isSentinel, SENTINEL_TO_TIER,
  parseClaudeModel, parseGeminiModel, parseOpenAIModel,
} from '../model-resolver.mjs';

/**
 * Does a SENTINEL and a CONCRETE id name the same first-party {provider,tier}
 * family — offline, deterministic, no live catalog (Cluster A round 5, H2/H3).
 *
 * Deliberately narrow to the three families where both a sentinel's
 * `SENTINEL_TO_TIER` entry and a parsed concrete id expose a comparable shape:
 * anthropic/google (`.tier`) and openai (mini-vs-not, via `isLite`). xAI/OSS/
 * gateway ids are explicitly EXCLUDED — `SENTINEL_TO_TIER['latest-grok']` has
 * no `.tier` (xai is one undifferentiated pool, not a ladder), and there is no
 * exported parser giving a gateway/xAI concrete id a comparable identity.
 * Guessing one would risk a false positive that refuses a legitimate
 * multi-vendor campaign (this repo's own committed one mixes five providers) —
 * a worse failure than the narrower residual gap this leaves undetected,
 * which stays documented rather than silently claimed as closed.
 *
 * @param {string} sentinel
 * @param {string} concrete
 * @returns {boolean}
 */
function sentinelNamesSameFamily(sentinel, concrete) {
  const info = SENTINEL_TO_TIER[sentinel.toLowerCase()];
  if (!info) return false;
  if (info.provider === 'anthropic') {
    const p = parseClaudeModel(concrete);
    return Boolean(p) && p.tier === info.tier;
  }
  if (info.provider === 'google') {
    const p = parseGeminiModel(concrete);
    return Boolean(p) && p.tier === info.tier;
  }
  if (info.provider === 'openai') {
    const p = parseOpenAIModel(concrete);
    if (!p) return false;
    // Round 8, H4: mini-vs-not alone treated EVERY non-mini OpenAI model as
    // one family, so a distinct generation/series (an 'o'-series reasoning
    // model, say) could false-positive against `latest-gpt`. `family` (the
    // 'gpt'|'o' prefix `parseOpenAIModel` already captures) is a real,
    // zero-cost tightening: both OpenAI sentinels (`latest-gpt`,
    // `latest-gpt-mini`) only ever resolve within STATIC_POOL's `gpt-*`
    // entries (see model-resolver.mjs), never 'o'-series, so requiring
    // `family === 'gpt'` matches how the sentinel is actually used rather
    // than inventing a distinction it doesn't have. Generation number
    // (gpt-4 vs gpt-5.6) is DELIBERATELY still not compared: `latest-gpt`
    // means "whichever is newest," so ambiguity against any non-mini
    // gpt-family model is the correct conservative read, not a bug — there
    // is no generation-specific sentinel to disambiguate further, and
    // inventing one here would be guessing at a semantics the sentinel
    // design does not express.
    return p.family === 'gpt' && (info.variant === 'mini') === p.isLite;
  }
  return false; // xai / oss / anything without a comparable shape
}

/**
 * Does this pair of arm models risk being the SAME model under different
 * spellings — a sentinel and a concrete id from the same family?
 *
 * @param {string} modelA
 * @param {string} modelB
 * @returns {boolean}
 */
export function sameFamilyAmbiguity(modelA, modelB) {
  const aIsSentinel = isSentinel(modelA);
  const bIsSentinel = isSentinel(modelB);
  if (aIsSentinel === bIsSentinel) return false; // both or neither — not this check's job
  return aIsSentinel ? sentinelNamesSameFamily(modelA, modelB) : sentinelNamesSameFamily(modelB, modelA);
}
