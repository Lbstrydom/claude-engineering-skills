/**
 * @fileoverview The final-review shadow provider table — the SINGLE oracle for
 * "which credential does this provider need", and the family check that guards
 * an explicit model against the wrong provider.
 *
 * **Why this is a module and not a `const` inside `gemini-review.mjs`** (moved
 * 2026-08-18, plan: `docs/plans/pinned-revision-fixture.md` §2 Decision 5). It
 * has a second reader: the pinned-revision fixture's credential preflight, which
 * must refuse to start a spend-bearing run when a declared arm's key is absent.
 *
 * That preflight exists because an absent key is NOT an error — `resolveShadow`
 * returns `state:'skipped-no-key'`, the arm records as SKIPPED, and the snapshot
 * is rejected by the completeness check only AFTER the other arms have been paid
 * for. Two snapshots and ~$13 of provider spend were lost that way on
 * 2026-08-17.
 *
 * The preflight therefore has to answer the same question `resolveShadow` does,
 * and it must answer it the SAME way. Re-spelling the variable names in the
 * fixture would be a contract with no compiler between two files nothing
 * compares — and its failure mode is precisely the bug: the preflight passes,
 * the arm skips, the money is spent. The concrete trap is `alibaba`, whose
 * `hasCredential` is an `&&` of TWO variables; a second list that checked only
 * `*_API_KEY` would read green while the arm skipped.
 *
 * Behaviour is unchanged by the move: `gemini-review.mjs` imports both symbols
 * and keeps re-exporting them through `_internals`, so its existing tests are
 * untouched.
 *
 * @module scripts/lib/final-review/provider-specs
 */
import { isAlibabaModel, isDeepseekModel } from '../model-resolver.mjs';

/**
 * Canonical provider specs keyed by the raw FINAL_REVIEW_SHADOW value.
 *
 * `canonical` is not cosmetic — it is the `PROVIDERS` key the shared review path
 * looks up (`runFinalReview`: `const descriptor = PROVIDERS[provider]`, then
 * `requestExtras: descriptor.requestExtras?.()`). So a spec whose canonical name
 * matches a PROVIDERS entry inherits that descriptor's wire behaviour for free —
 * which is exactly how `openrouter` gets its routing pins without any plumbing
 * here (verified by trace, docs/plans/final-review-credit-and-cheap-shadow.md §3).
 *
 * `hasCredential` replaces a bare `keyEnv` string because a GATEWAY has more than
 * one legitimate source for its key: the review-scoped `FINAL_REVIEW_API_KEY`
 * first, then the shared `OPENROUTER_API_KEY` other skills already use. It
 * returns a BOOLEAN only — the secret itself must never reach the resolver's
 * result object, the log line, or the persisted `_shadow` block.
 *
 * `gateway: true` marks a provider whose model ids are passed VERBATIM (descriptor
 * D6: no `resolveModel` sentinel rewrite), which has two consequences below: the
 * family regex cannot validate them, and there is no sensible per-provider
 * default, so an explicit `FINAL_REVIEW_SHADOW_MODEL` is required.
 */
export const SHADOW_PROVIDER_SPECS = Object.freeze({
  'claude-opus': { canonical: 'claude-opus', family: 'claude', defaultSentinel: 'latest-opus', hasCredential: (env) => Boolean(env.ANTHROPIC_API_KEY) },
  'anthropic':   { canonical: 'claude-opus', family: 'claude', defaultSentinel: 'latest-opus', hasCredential: (env) => Boolean(env.ANTHROPIC_API_KEY) },
  'gemini':      { canonical: 'gemini',      family: 'gemini', defaultSentinel: 'latest-pro',  hasCredential: (env) => Boolean(env.GEMINI_API_KEY) },
  'openrouter':  {
    canonical: 'openrouter', family: 'gateway', gateway: true, defaultSentinel: null,
    hasCredential: (env) => Boolean(env.FINAL_REVIEW_API_KEY || env.OPENROUTER_API_KEY),
  },
  // Native xAI — NOT a gateway (unlike openrouter): xai is a single known
  // endpoint with a real default model, so `defaultSentinel: 'latest-grok'`
  // means FINAL_REVIEW_SHADOW=xai with no FINAL_REVIEW_SHADOW_MODEL is
  // perfectly usable, matching claude-opus/gemini's behaviour above rather
  // than openrouter's "explicit model required" refusal.
  'xai': { canonical: 'xai', family: 'xai', defaultSentinel: 'latest-grok', hasCredential: (env) => Boolean(env.XAI_API_KEY) },
  // Native Alibaba — like `openrouter`, a `gateway` (verbatim model ids, no
  // sensible single default across Qwen/DeepSeek/GLM/Kimi) but NOT actually a
  // multi-backend router like OpenRouter is — see the PROVIDERS.alibaba
  // descriptor's own note on why its requestExtras stays empty. `gateway:
  // true` here buys the same "no default, explicit model required, bypass
  // resolveModel's sentinel rewrite" behaviour openrouter already gets from
  // `resolveShadow`, which is exactly what a verbatim-id, no-default provider
  // needs regardless of whether it is itself a router.
  'alibaba': {
    canonical: 'alibaba', family: 'alibaba', gateway: true, defaultSentinel: null,
    hasCredential: (env) => Boolean(env.ALIBABA_CLOUD_API_KEY && env.ALIBABA_CLOUD_BASE_URL),
  },
  // Native DeepSeek — also `gateway: true` (no single default across
  // v4-pro/v4-flash), but its own family so a mismatched model (e.g. a
  // qwen id) is rejected rather than silently accepted.
  'deepseek': {
    canonical: 'deepseek', family: 'deepseek', gateway: true, defaultSentinel: null,
    hasCredential: (env) => Boolean(env.DEEPSEEK_API_KEY),
  },
});

/** Cheap family check so an explicit model can't be paired with a wrong provider (R3 M1). */
export function shadowModelMatchesFamily(modelId, family) {
  const id = (modelId || '').toLowerCase();
  // A gateway serves every family and takes ids verbatim (`moonshotai/kimi-k2-thinking`),
  // so there is no family to match against — the guard here is the REQUIRED
  // explicit model in resolveShadow, not a name pattern.
  if (family === 'gateway') return true;
  if (family === 'gemini') return id.includes('gemini');
  if (family === 'xai') return id.includes('grok');
  // Unlike the gateway/xai/gemini checks above (name-pattern or blanket
  // accept), `alibaba` has an authoritative source of truth to defer to: the
  // SAME curated `ALIBABA_POOL` allowlist `transportForModel` consults, so
  // this check can never diverge from what the runner actually recognises.
  if (family === 'alibaba') return isAlibabaModel(id);
  if (family === 'deepseek') return isDeepseekModel(id);
  // claude family — opus/sonnet/haiku today, mythos/fable when they land.
  return /claude|opus|sonnet|haiku|mythos|fable/.test(id);
}

