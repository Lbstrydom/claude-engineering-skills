/**
 * @fileoverview Model ID resolution — sentinels, deprecated remap, live catalog.
 *
 * Replaces concrete pins like `gemini-3.1-pro-preview` with sentinel-based
 * resolution (`latest-pro`) so the pipeline doesn't go stale when new models ship.
 *
 * Sentinels:
 *   - OpenAI:    latest-gpt, latest-gpt-mini
 *   - Anthropic: latest-opus, latest-sonnet, latest-haiku
 *   - Google:    latest-pro, latest-flash, latest-flash-lite
 *
 * Flow:
 *   1. deprecatedRemap() — stale concrete IDs → sentinel (warns user).
 *   2. If result is a sentinel, resolveLatestModel() picks newest from pool.
 *   3. Pool = live catalog (if refreshed) ∪ static fallback.
 *   4. Gemini short-circuit: if `gemini-{tier}-latest` exists, return it
 *      directly — Google's alias is authoritative over version heuristics.
 *
 * Call refreshModelCatalog({ openai, google, anthropic }) once at startup to
 * populate the live pool; otherwise resolution uses STATIC_POOL.
 *
 * @module scripts/lib/model-resolver
 */

// Load .env when this module is the process entry point (its documented
// CLI self-check: `node scripts/lib/model-resolver.mjs resolve|catalog`).
// When imported as a library, the actual entry point (config.mjs's
// loadSharedEnv, or another script's own `import 'dotenv/config'`) has
// already populated process.env by the time refreshModelCatalog() reads
// it — this import is a harmless idempotent no-op in that case. Without
// it, a standalone CLI invocation reads undefined API keys, so
// refreshModelCatalog() silently queues zero fetch tasks and falls back
// to STATIC_POOL with no error at all — the self-check reports "no live
// catalog" even when the keys and network are both fine.
import 'dotenv/config';

// ── Static fallback pool ────────────────────────────────────────────────────
// IMPORTANT: only pin model IDs that exist in the provider's current catalog.
// Do NOT pin IDs derived by stripping `-preview` suffix — Google returns 404
// when a bare model name hasn't shipped yet (the -preview suffix is load-bearing).
// Updated quarterly.

// Pruning policy (2026-07-14): STATIC_POOL is an offline-only fallback (the
// live-catalog refresh, when it succeeds, already picks the true newest —
// see `refreshModelCatalog`); `compareVersions` always sorts newest-first
// regardless of list order or how many entries exist, so an entry more than
// one generation behind the current head can NEVER be selected by any
// sentinel — it's dead weight, not a safety net. Kept depth: current
// generation + one generation back per tier (resilience if the newest
// generation is retired unexpectedly), everything older removed. Verified
// via `npm run models:freshness` (HIGH: 0) before and after this prune.
export const STATIC_POOL = Object.freeze({
  openai: Object.freeze([
    // GPT-5.6 (2026-07-09) renamed the three-tier family to sol/terra/luna
    // (see parseOpenAIModel above) — terra is the plain/balanced SKU
    // (isPremium=false), so compareVersions' premium tiebreak correctly
    // prefers it over sol for `latest-gpt`; luna is the isLite SKU, so it
    // correctly wins `latest-gpt-mini`. 5.5 kept one generation back;
    // 5.4/4.1-mini/4o-mini removed — strictly dominated, never selectable.
    'gpt-5.6-terra', 'gpt-5.6-sol', 'gpt-5.6-luna',
    'gpt-5.5', 'gpt-5.5-pro',
  ]),
  anthropic: Object.freeze([
    // Claude 5 family (2026-07-14): `claude-sonnet-5`/`claude-opus-4-8`
    // added — this pool is a fallback ONLY, used when live-catalog refresh
    // fails or a call site never invokes it (e.g. the tiered-recall
    // pipeline's `sonnetCall` in tiered-pipeline.mjs); confirmed live via
    // `refreshModelCatalog()` that both ids exist in Anthropic's real
    // catalog. `claude-opus-4-6`/`claude-opus-4-1`/`claude-sonnet-4-5`
    // removed — more than one generation behind 4-8/5, never selectable.
    // Haiku's dated/undated pair is intentional (model-resolver.mjs's
    // `resolveModel` doc: "prefers undated alias"), not staleness — kept.
    'claude-opus-4-8', 'claude-opus-4-7',
    'claude-sonnet-5', 'claude-sonnet-4-6',
    'claude-haiku-4-5', 'claude-haiku-4-5-20251001',
  ]),
  google: Object.freeze([
    // Google's `gemini-{tier}-latest` alias is authoritative (isAlias:true
    // → major:Infinity in parseGeminiModel, always wins compareVersions) —
    // these three entries win every `latest-*` sentinel resolution
    // regardless of what else is in this list. The 3.x numbered entries are
    // kept as an explicit one-generation-back fallback in case an alias is
    // ever absent from a given catalog snapshot; the 2.5 generation was
    // removed as strictly older and unreachable behind both the aliases and
    // the 3.x entries.
    'gemini-pro-latest', 'gemini-flash-latest', 'gemini-flash-lite-latest',
    'gemini-3.1-pro-preview', 'gemini-3-flash-preview',
  ]),
});

// ── OSS pool (model-A/B/C harness — OpenRouter-hosted open-weight auditors) ──
// Role-partitioned rather than version-parsed: OSS ids are provider-namespaced
// (`vendor/model`) with no uniform version grammar, so "newest" == list head.
// MAINTAINER CONTRACT: keep the PREFERRED model at index 0 of each role — the
// `latest-oss-coder` / `latest-oss-reasoner` sentinels resolve to it. These are
// SENTINELS (plan decision 2): arm config never pins a concrete OSS id; refresh
// the head here (or override per-run via env, see resolveModel's OSS branch) as
// OpenRouter ships newer open-weight models. Every id below must (a) exist on
// OpenRouter and (b) support `response_format: json_schema` OR tool-calling —
// the OSS structured-output adapter (oss-structured-output.mjs) needs one of
// them, and conformance is a HARD pre-filter (plan decision 6).
export const OSS_POOL = Object.freeze({
  // Instruction/coder-tuned open weights — the "coder" auditor arm.
  coder: Object.freeze([
    'qwen/qwen3-coder',
    'deepseek/deepseek-chat-v3.1',
    'z-ai/glm-4.6',
  ]),
  // Reasoning-tuned open weights — the "reasoner" auditor arm (full reasoning
  // ON; reasoning-ablation is a KNOWN-dead end — never reintroduced).
  // HEAD = z-ai/glm-5.2 (docs/plans/arm-eval-framework.md D0): the strongest
  // open-weight model on BOTH the Artificial-Analysis Intelligence Index (51.1)
  // and SWE-bench Pro (62.1%) as of 2026-07-01, and still ~5-10x cheaper than the
  // GPT baseline ($0.93/$3.00 vs $5/$30 per 1M). deepseek/deepseek-v4-pro
  // (cheapest, ~$0.43/$0.87 — best €-frontier if it ties) and qwen/qwen3.7-max
  // follow as cost/quality ROTATION candidates; the burn-in decides the winner on
  // OUR tasks, so this head is just the evidence-based default. Every id must
  // exist on OpenRouter (verified live) + support structured output.
  reasoner: Object.freeze([
    'z-ai/glm-5.2',
    'deepseek/deepseek-v4-pro',
    'qwen/qwen3.7-max',
    'deepseek/deepseek-r1',
    'moonshotai/kimi-k2-thinking',
    'qwen/qwen3-235b-a22b-thinking',
  ]),
});

// Per-role env override so a burn-in operator can pin a concrete OpenRouter id
// (or a comma-list whose head wins) WITHOUT editing source — e.g.
// `OSS_CODER_MODEL=qwen/qwen3-coder`. Unset → the static OSS_POOL head.
const OSS_ROLE_ENV = Object.freeze({ coder: 'OSS_CODER_MODEL', reasoner: 'OSS_REASONER_MODEL' });

// ── Deprecated remap ────────────────────────────────────────────────────────
// When a user's .env has a stale concrete ID, remap to a sentinel and warn.
// Prevents 404s when providers retire models.

export const DEPRECATED_REMAP = Object.freeze({
  'gpt-5.0': 'latest-gpt',
  'gpt-5.1': 'latest-gpt',
  'gpt-5.2': 'latest-gpt',
  'gpt-5.3': 'latest-gpt',
  'gpt-4-turbo': 'latest-gpt',
  'gpt-4-1106-preview': 'latest-gpt',
  'gpt-4o': 'latest-gpt',

  'claude-opus-3': 'latest-opus',
  'claude-3-opus-20240229': 'latest-opus',
  'claude-opus-4-0': 'latest-opus',
  'claude-sonnet-3.5': 'latest-sonnet',
  'claude-3-5-sonnet-20241022': 'latest-sonnet',
  'claude-haiku-3': 'latest-haiku',
  'claude-3-haiku-20240307': 'latest-haiku',

  'gemini-3-flash': 'latest-flash',
  'gemini-3.1-pro': 'latest-pro',
  'gemini-3-pro': 'latest-pro',
  'gemini-2.0-flash': 'latest-flash',
  'gemini-2.0-flash-lite': 'latest-flash-lite',
  'gemini-2.0-pro': 'latest-pro',
  'gemini-1.5-pro': 'latest-pro',
  'gemini-1.5-flash': 'latest-flash',
  'gemini-1.5-flash-8b': 'latest-flash-lite',
});

// ── Sentinels ──────────────────────────────────────────────────────────────

export const SENTINEL_TO_TIER = Object.freeze({
  'latest-gpt':         { provider: 'openai',    variant: null   },
  'latest-gpt-mini':    { provider: 'openai',    variant: 'mini' },
  'latest-opus':        { provider: 'anthropic', tier: 'opus'    },
  'latest-sonnet':      { provider: 'anthropic', tier: 'sonnet'  },
  'latest-haiku':       { provider: 'anthropic', tier: 'haiku'   },
  'latest-pro':         { provider: 'google',    tier: 'pro'     },
  'latest-flash':       { provider: 'google',    tier: 'flash'   },
  'latest-flash-lite':  { provider: 'google',    tier: 'flash-lite' },
  // OSS auditor sentinels (model-A/B/C harness). `role` selects the OSS_POOL
  // partition; there is no logical economy/standard/frontier tier for OSS
  // (tierForModel/describeModel return 'unknown'/null — acceptable, they are
  // never partitioned by the author-tier observation).
  'latest-oss-coder':    { provider: 'oss', role: 'coder'    },
  'latest-oss-reasoner': { provider: 'oss', role: 'reasoner' },
});

export function isSentinel(modelId) {
  return typeof modelId === 'string' && Object.hasOwn(SENTINEL_TO_TIER, modelId.toLowerCase());
}

// ── ID parsers ──────────────────────────────────────────────────────────────

/** Parse a Claude model ID. `claude-{tier}-{major}-{minor}[-{YYYYMMDD}]` */
export function parseClaudeModel(id) {
  const m = /^claude-(opus|sonnet|haiku)-(\d+)(?:-(\d+))?(?:-(\d{8}))?$/.exec(id);
  if (!m) return null;
  return {
    provider: 'anthropic',
    family: 'claude',
    tier: m[1],
    major: Number.parseInt(m[2], 10),
    minor: m[3] ? Number.parseInt(m[3], 10) : 0,
    date: m[4] || null,
    isPreview: false,
    original: id,
  };
}

/** Parse a Gemini model ID. Handles both aliases and version-numbered forms. */
export function parseGeminiModel(id) {
  const aliasMatch = /^gemini-(pro|flash|flash-lite)-latest$/.exec(id);
  if (aliasMatch) {
    return {
      provider: 'google',
      family: 'gemini',
      tier: aliasMatch[1],
      major: Number.POSITIVE_INFINITY, // aliases win the version tiebreaker
      minor: 0,
      suffix: null,
      isAlias: true,
      isPreview: false,
      original: id,
    };
  }

  // Alternation order matters: `flash-lite` MUST precede `flash`, else `flash`
  // matches first and `-lite` is swallowed as a suffix → flash-lite mis-tiered
  // as flash (audit Cluster-A finding).
  //
  // The trailing suffix is captured as ONE opaque `.+` group rather than a
  // fixed alternation (`preview|lite|tts|image|exp|\d+`) — a single-token
  // alternation cannot match multi-segment legacy suffixes like
  // `-preview-tts` or `-lite-001` (two dash-segments, only one capture
  // group), so ids like `gemini-2.5-flash-preview-tts` failed to parse at
  // all under the old regex and fell through to check-model-freshness.mjs's
  // "can't tell how old this is, flag it" fallback — permanent false-
  // positive noise for models that were, in fact, straightforwardly old
  // (model-freshness noise fix, 2026-07-14). `isPreview` now substring-
  // tests the whole suffix instead of requiring an exact single-token match.
  const m = /^gemini-(\d+)(?:\.(\d+))?-(pro|flash-lite|flash)(?:-(.+))?$/.exec(id);
  if (!m) return null;
  const suffix = m[4] || null;
  return {
    provider: 'google',
    family: 'gemini',
    tier: m[3],
    major: Number.parseInt(m[1], 10),
    minor: m[2] ? Number.parseInt(m[2], 10) : 0,
    suffix,
    isAlias: false,
    isPreview: /(^|-)preview(-|$)/.test(suffix || ''),
    original: id,
  };
}

/** Parse an OpenAI model ID. */
export function parseOpenAIModel(id) {
  // `o?` after the major handles the omni family shape (`gpt-4o`, `gpt-4o-mini`);
  // `pro` is an accepted variant (`gpt-5.5-pro`). Both were STATIC_POOL ids the
  // prior digit-only regex rejected (audit Cluster-A finding).
  // `sol|terra|luna` — GPT-5.6's named three-tier family (2026-07-09 release):
  // sol=premium flagship, terra=balanced/everyday, luna=cheapest/fastest —
  // same tier shape as pro/plain/mini, just renamed. Without these the regex
  // returns null for every gpt-5.6-* id (falls back to a stale STATIC_POOL
  // pick with NO error surfaced — see model-resolver.mjs's dotenv-load fix).
  //
  // The trailing suffix is captured as ONE opaque `.+` group rather than a
  // fixed single-token alternation — a single-token alternation cannot match
  // multi-segment legacy suffixes (`-turbo-16k`, `-turbo-instruct-0914`), so
  // those ids failed to parse at all and fell through to check-model-
  // freshness.mjs's "can't tell how old this is, flag it" fallback —
  // permanent false-positive noise for models that were, in fact,
  // straightforwardly old (model-freshness noise fix, 2026-07-14).
  // isLite/isPremium classify on the FIRST dash-segment only (`turbo-16k`'s
  // SKU is `turbo`, not a new unrecognised one; trailing segments are
  // snapshot dates / context-window tags, not distinct SKUs); isPreview
  // substring-tests the whole suffix.
  const m = /^(gpt|o)-?(\d+)o?(?:\.(\d+))?(?:-(.+))?$/.exec(id);
  if (!m) return null;
  const variant = m[4] || null;
  const firstSeg = variant ? variant.split('-')[0] : null;
  return {
    provider: 'openai',
    family: m[1],
    major: Number.parseInt(m[2], 10),
    minor: m[3] ? Number.parseInt(m[3], 10) : 0,
    variant,
    isLite: /^(mini|nano|luna)$/.test(firstSeg || ''),
    // Premium/flagship SKU at the same version as the plain/balanced SKU
    // (pro, sol). TIER_MAP's own documented design: for OpenAI, latest-gpt's
    // tier axis is reasoning effort, not model SKU — a premium SKU must be
    // pinned explicitly, never silently auto-selected by the standard/
    // frontier sentinel. See compareVersions' isPremium tiebreak.
    isPremium: /^(pro|sol)$/.test(firstSeg || ''),
    isPreview: /(^|-)preview(-|$)/.test(variant || ''),
    original: id,
  };
}

// ── Logical-tier abstraction (provider-agnostic) ─────────────────────────────
// Provider-neutral tiers so routing/observation logic is written ONCE, in
// logical space, and bound to concrete models per active provider. See
// docs/completed/model-tier-observation.md.

export const LOGICAL_TIERS = Object.freeze(['economy', 'standard', 'frontier']);

// Logical tier → concrete sentinel, per provider. Every sentinel here already
// exists in SENTINEL_TO_TIER — no new sentinels. OpenAI standard===frontier
// (===latest-gpt): the tier axis there is reasoning effort, not model id.
export const TIER_MAP = Object.freeze({
  anthropic: Object.freeze({ economy: 'latest-haiku',      standard: 'latest-sonnet', frontier: 'latest-opus' }),
  google:    Object.freeze({ economy: 'latest-flash-lite', standard: 'latest-flash',  frontier: 'latest-pro'  }),
  openai:    Object.freeze({ economy: 'latest-gpt-mini',   standard: 'latest-gpt',    frontier: 'latest-gpt'  }),
});

// Anthropic/Google tiers map 1:1; OpenAI mini/nano→economy, other gpt→standard.
const _CLAUDE_TIER_TO_LOGICAL = { opus: 'frontier', sonnet: 'standard', haiku: 'economy' };
const _GEMINI_TIER_TO_LOGICAL = { pro: 'frontier', flash: 'standard', 'flash-lite': 'economy' };

/** Try each provider parser; null if none match. */
function parseAnyModel(id) {
  return parseClaudeModel(id) || parseGeminiModel(id) || parseOpenAIModel(id) || null;
}

function logicalFromParsed(p) {
  if (!p) return 'unknown';
  if (p.provider === 'anthropic') return _CLAUDE_TIER_TO_LOGICAL[p.tier] ?? 'unknown';
  if (p.provider === 'google')    return _GEMINI_TIER_TO_LOGICAL[p.tier] ?? 'unknown';
  if (p.provider === 'openai')    return p.isLite ? 'economy' : 'standard';
  return 'unknown';
}

/**
 * Classify any model id (sentinel or concrete) into a logical tier.
 * Never throws; returns 'unknown' for unrecognised ids.
 * @returns {'economy'|'standard'|'frontier'|'unknown'}
 */
export function tierForModel(modelId) {
  if (typeof modelId !== 'string' || !modelId) return 'unknown';
  // Canonicalise deprecated ids to their sentinel FIRST so classification and
  // resolution agree (audit R3-M: a deprecated concrete id must tier the same as
  // the sentinel it remaps to — the bias-partition key depends on this).
  modelId = deprecatedRemap(modelId, { silent: true });
  if (isSentinel(modelId)) {
    const s = SENTINEL_TO_TIER[modelId.toLowerCase()];
    if (s.tier) return { ..._CLAUDE_TIER_TO_LOGICAL, ..._GEMINI_TIER_TO_LOGICAL }[s.tier] ?? 'unknown';
    if (s.provider === 'openai') return s.variant === 'mini' ? 'economy' : 'standard';
    return 'unknown';
  }
  const parsed = parseAnyModel(modelId);
  if (parsed) return logicalFromParsed(parsed);
  // Coarse OpenAI fallback — the strict parser doesn't cover every variant
  // (e.g. `gpt-4o-mini`, `gpt-5.5-pro`). Classify by family + mini/nano marker;
  // non-mini gpt → standard (consistent with the OpenAI standard≡frontier
  // collapse). Non-OpenAI unrecognised ids stay 'unknown' (e.g. local Qwen).
  const lc = modelId.toLowerCase();
  if (/^(gpt-|o\d|chatgpt)/.test(lc)) return /mini|nano/.test(lc) ? 'economy' : 'standard';
  return 'unknown';
}

/**
 * Logical tier → the matching `latest-*` sentinel for a provider, or null when
 * the provider/tier isn't in TIER_MAP (degrade, never throw). For all three
 * current providers every tier resolves (OpenAI frontier→latest-gpt collapse).
 */
export function sentinelForTier(logicalTier, opts) {
  // Normalise inside the body — a `= {}` default only catches `undefined`, so an
  // explicit `null` options arg would throw on destructure. Contract: degrade to
  // null for any unsupported input, never throw (audit R3-H).
  const provider = (opts && typeof opts === 'object') ? opts.provider : undefined;
  const ladder = TIER_MAP[provider];
  if (!ladder || !LOGICAL_TIERS.includes(logicalTier)) return null;
  return ladder[logicalTier] ?? null;
}

/**
 * The bias-partition key: provider + family + concrete model + logical tier for
 * a model id (resolving a sentinel to its concrete id first). null if
 * unrecognised. Used by the author-tier observation so per-ladder data is never
 * pooled across distinct models.
 * @returns {{provider:string, family:string, tier:string, concreteModel:string}|null}
 */
export function describeModel(modelId) {
  if (typeof modelId !== 'string' || !modelId) return null;
  // Remap deprecated ids first so the partition key for a stale id matches the
  // key for its live sentinel (audit R3-M: no bias-data split across the same
  // effective model).
  modelId = deprecatedRemap(modelId, { silent: true });
  const concrete = isSentinel(modelId) ? resolveModel(modelId, { silent: true }) : modelId;
  const p = parseAnyModel(concrete);
  if (!p) {
    // Coarse OpenAI fallback (mirrors tierForModel) so variant shapes the strict
    // parser misses (`gpt-4o-mini`, `gpt-5.5-pro`) still yield a partition key.
    const lc = concrete.toLowerCase();
    if (/^(gpt-|o\d|chatgpt)/.test(lc)) {
      return { provider: 'openai', family: 'gpt', tier: tierForModel(concrete), concreteModel: concrete };
    }
    return null;
  }
  return { provider: p.provider, family: p.family, tier: tierForModel(concrete), concreteModel: concrete };
}

// ── Tier pickers ────────────────────────────────────────────────────────────

// Exported so check-model-freshness.mjs can reuse the SAME newer-than
// comparison the resolver itself uses to pick a sentinel's model — a
// separate, ad-hoc "is this id notable" heuristic in the checker would
// silently diverge from what actually drives resolution (model-freshness
// noise fix, 2026-07-14).
export function compareVersions(a, b) {
  if (a.major !== b.major) return b.major - a.major;
  if ((a.minor ?? 0) !== (b.minor ?? 0)) return (b.minor ?? 0) - (a.minor ?? 0);
  // Prefer the plain/balanced SKU over a premium one (pro/sol) at the same
  // version — was an unintentional tie broken by API/pool list order before
  // this field existed; now deterministic per the isPremium doc above.
  if ((a.isPremium ?? false) !== (b.isPremium ?? false)) return a.isPremium ? 1 : -1;
  // Prefer GA over preview at same version
  if ((a.isPreview ?? false) !== (b.isPreview ?? false)) return a.isPreview ? 1 : -1;
  // Prefer undated (rolling alias) over dated snapshot at same version
  const aDated = !!a.date;
  const bDated = !!b.date;
  if (aDated !== bDated) return aDated ? 1 : -1;
  return 0;
}

export function pickNewestGemini(pool, tier) {
  if (!pool || pool.length === 0) return null;
  // Short-circuit: Google's alias is authoritative when present
  const aliasId = `gemini-${tier}-latest`;
  if (pool.includes(aliasId)) return aliasId;
  const parsed = pool.map(parseGeminiModel).filter(p => p && p.tier === tier);
  if (parsed.length === 0) return null;
  parsed.sort(compareVersions);
  return parsed[0].original;
}

/**
 * Resolve an OSS role ('coder'|'reasoner') to a concrete OpenRouter model id.
 * Env override (`OSS_CODER_MODEL` / `OSS_REASONER_MODEL`, comma-list head wins)
 * takes precedence over the static OSS_POOL head. Returns null for an unknown
 * role or an exhausted pool (never throws — resolveModel decides the error).
 * @param {'coder'|'reasoner'} role
 * @returns {string|null}
 */
export function pickOssModel(role) {
  const envVar = OSS_ROLE_ENV[role];
  if (envVar) {
    const override = (process.env[envVar] || '').split(',').map((s) => s.trim()).filter(Boolean)[0];
    if (override) return override;
  }
  const pool = OSS_POOL[role];
  return (pool && pool.length > 0) ? pool[0] : null;
}

export function pickNewestClaude(pool, tier) {
  if (!pool || pool.length === 0) return null;
  const parsed = pool.map(parseClaudeModel).filter(p => p && p.tier === tier);
  if (parsed.length === 0) return null;
  parsed.sort(compareVersions);
  return parsed[0].original;
}

/**
 * @param {string[]} pool
 * @param {null|'mini'|'nano'} variant - null excludes every lite SKU (mini/nano/
 *   luna/…); 'mini' selects the newest LITE SKU regardless of its literal
 *   suffix (mini/nano/luna all satisfy SENTINEL_TO_TIER's `latest-gpt-mini`
 *   request) — an exact string match would go stale the moment a provider
 *   renames its cheap tier (as GPT-5.6 did: mini → luna). Any other literal
 *   variant string (e.g. 'pro') still requires an exact match.
 */
export function pickNewestOpenAI(pool, variant = null) {
  if (!pool || pool.length === 0) return null;
  const parsed = pool.map(parseOpenAIModel).filter(p => {
    if (!p) return false;
    if (variant === null) return !p.isLite;
    if (variant === 'mini') return p.isLite;
    return p.variant === variant;
  });
  if (parsed.length === 0) return null;
  parsed.sort(compareVersions);
  return parsed[0].original;
}

// ── Deprecated remap + warning ──────────────────────────────────────────────

const _remapWarned = new Set();

/**
 * Check if an ID is in the deprecated remap table; return the sentinel if so,
 * or the input unchanged. Warns once per unique stale ID per process.
 */
export function deprecatedRemap(modelId, { silent = false } = {}) {
  if (!modelId || typeof modelId !== 'string') return modelId;
  // Audit Gemini-G-M1: Object.hasOwn so 'toString'/'constructor' don't
  // return Object.prototype function references via DEPRECATED_REMAP.
  if (!Object.hasOwn(DEPRECATED_REMAP, modelId)) return modelId;
  const remapped = DEPRECATED_REMAP[modelId];
  if (!remapped || typeof remapped !== 'string') return modelId;
  if (!silent && !_remapWarned.has(modelId)) {
    _remapWarned.add(modelId);
    process.stderr.write(
      `  [model-resolver] WARNING: "${modelId}" is deprecated or retired — remapped to "${remapped}". ` +
      `Update your .env to clear this warning.\n`
    );
  }
  return remapped;
}

// ── Session catalog cache ───────────────────────────────────────────────────

const CATALOG_CACHE = { openai: null, anthropic: null, google: null };
const TTL_MS = 60 * 60 * 1000;

/** Merge dynamic catalog with STATIC_POOL — dynamic takes precedence, duplicates deduped. */
function mergedPool(provider) {
  const entry = CATALOG_CACHE[provider];
  const fresh = entry && (Date.now() - entry.fetchedAt) < TTL_MS;
  const live = fresh ? entry.ids : [];
  const combined = [...live, ...STATIC_POOL[provider]];
  return Array.from(new Set(combined));
}

/**
 * Populate the session cache for one provider. Silent failure — returns false,
 * caller falls back to STATIC_POOL.
 * @param {'openai'|'anthropic'|'google'} provider
 * @param {string[]} ids - Model IDs from the provider's /models endpoint
 */
export function setCatalog(provider, ids) {
  if (!['openai', 'anthropic', 'google'].includes(provider)) return false;
  if (!Array.isArray(ids) || ids.length === 0) return false;
  CATALOG_CACHE[provider] = { ids: ids.slice(), fetchedAt: Date.now() };
  return true;
}

/** For tests — reset cached catalogs. */
export function _resetCatalogCache() {
  CATALOG_CACHE.openai = null;
  CATALOG_CACHE.anthropic = null;
  CATALOG_CACHE.google = null;
  _remapWarned.clear();
}

/**
 * Read the live catalog for a provider (populated by `refreshModelCatalog`).
 * Returns an empty array if the cache is empty or stale. Used by the
 * model-freshness checker to compare live vs STATIC_POOL.
 * @param {'openai'|'anthropic'|'google'} provider
 * @returns {string[]}
 */
export function getLiveCatalog(provider) {
  const entry = CATALOG_CACHE[provider];
  if (!entry) return [];
  if ((Date.now() - entry.fetchedAt) >= TTL_MS) return [];
  return entry.ids.slice();
}

// ── Live catalog fetcher ────────────────────────────────────────────────────
// Each fetch has its own short timeout. Failures degrade gracefully to static.
// Empty API key → silently return empty pool (never throw).

async function fetchWithTimeout(url, opts = {}, timeoutMs = 8000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...opts, signal: controller.signal });
    clearTimeout(timer);
    return res;
  } catch (err) {
    clearTimeout(timer);
    throw err;
  }
}

async function fetchOpenAIModels(apiKey) {
  const res = await fetchWithTimeout('https://api.openai.com/v1/models', {
    headers: { Authorization: `Bearer ${apiKey}` },
  });
  if (!res.ok) throw new Error(`OpenAI /v1/models: HTTP ${res.status}`);
  const body = await res.json();
  return (body?.data || []).map(m => m.id).filter(Boolean);
}

async function fetchGoogleModels(apiKey) {
  const res = await fetchWithTimeout(
    `https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(apiKey)}`
  );
  if (!res.ok) throw new Error(`Google /v1beta/models: HTTP ${res.status}`);
  const body = await res.json();
  return (body?.models || [])
    .map(m => m.name || m.baseModelId)
    .filter(Boolean)
    .map(n => n.replace(/^models\//, '')); // Strip `models/` prefix
}

async function fetchAnthropicModels(apiKey) {
  const res = await fetchWithTimeout('https://api.anthropic.com/v1/models', {
    headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
  });
  if (!res.ok) throw new Error(`Anthropic /v1/models: HTTP ${res.status}`);
  const body = await res.json();
  return (body?.data || []).map(m => m.id).filter(Boolean);
}

/**
 * Refresh the live catalog for any provider whose API key is present. Silent
 * failures; logs at debug level (stderr) on error, not warn.
 * Call once at process startup — resolution thereafter uses cached results.
 *
 * @param {object} [keys] - { openai?, google?, anthropic? } API keys; defaults to env
 * @returns {Promise<{openai: number, google: number, anthropic: number}>} counts loaded per provider
 */
export async function refreshModelCatalog(keys = {}) {
  const openaiKey = keys.openai ?? process.env.OPENAI_API_KEY;
  const googleKey = keys.google ?? process.env.GEMINI_API_KEY;
  const anthropicKey = keys.anthropic ?? process.env.ANTHROPIC_API_KEY;

  const results = { openai: 0, google: 0, anthropic: 0 };
  const tasks = [];

  if (openaiKey) tasks.push(
    fetchOpenAIModels(openaiKey)
      .then(ids => { if (setCatalog('openai', ids)) results.openai = ids.length; })
      .catch(err => process.stderr.write(`  [model-resolver] OpenAI catalog fetch failed (falling back to static): ${err.message}\n`))
  );
  if (googleKey) tasks.push(
    fetchGoogleModels(googleKey)
      .then(ids => { if (setCatalog('google', ids)) results.google = ids.length; })
      .catch(err => process.stderr.write(`  [model-resolver] Google catalog fetch failed (falling back to static): ${err.message}\n`))
  );
  if (anthropicKey) tasks.push(
    fetchAnthropicModels(anthropicKey)
      .then(ids => { if (setCatalog('anthropic', ids)) results.anthropic = ids.length; })
      .catch(err => process.stderr.write(`  [model-resolver] Anthropic catalog fetch failed (falling back to static): ${err.message}\n`))
  );

  await Promise.all(tasks);
  return results;
}

// ── Sentinel resolution ─────────────────────────────────────────────────────

/**
 * Resolve a possibly-sentinel model ID to a concrete provider ID.
 * - Concrete IDs pass through (after deprecated remap).
 * - Sentinels are resolved against merged pool (live ∪ static).
 * - If a sentinel cannot be resolved, returns the first static-pool entry for
 *   that provider as a last-resort fallback; throws only if pool is empty.
 *
 * @param {string} modelId
 * @param {object} [opts] - { silent?: boolean } — suppress deprecation warning
 */
export function resolveModel(modelId, opts = {}) {
  if (!modelId || typeof modelId !== 'string') {
    throw new Error(`resolveModel: modelId must be a non-empty string, got ${typeof modelId}`);
  }

  const afterRemap = deprecatedRemap(modelId, opts);
  if (!isSentinel(afterRemap)) return afterRemap;

  const spec = SENTINEL_TO_TIER[afterRemap.toLowerCase()];

  // OSS sentinels resolve from the role-partitioned OSS_POOL (no provider
  // catalog / version parser). Env override wins (comma-list head), else the
  // static pool head. Throws only if the pool is somehow empty (misconfig).
  if (spec.provider === 'oss') {
    const picked = pickOssModel(spec.role);
    if (picked) return picked;
    throw new Error(`resolveModel: cannot resolve OSS sentinel "${afterRemap}" — OSS_POOL.${spec.role} is empty`);
  }

  const pool = mergedPool(spec.provider);

  let picked = null;
  if (spec.provider === 'openai') picked = pickNewestOpenAI(pool, spec.variant);
  else if (spec.provider === 'anthropic') picked = pickNewestClaude(pool, spec.tier);
  else if (spec.provider === 'google') picked = pickNewestGemini(pool, spec.tier);

  if (picked) return picked;

  // Last-resort: first static entry matching tier. This guards against an empty
  // live catalog returning fewer entries than expected on partial provider outage.
  const fallbackPool = STATIC_POOL[spec.provider];
  let fallback = null;
  if (spec.provider === 'openai') fallback = pickNewestOpenAI(fallbackPool, spec.variant);
  else if (spec.provider === 'anthropic') fallback = pickNewestClaude(fallbackPool, spec.tier);
  else if (spec.provider === 'google') fallback = pickNewestGemini(fallbackPool, spec.tier);

  if (fallback) {
    process.stderr.write(`  [model-resolver] WARNING: "${afterRemap}" resolved via static fallback (${fallback}); live catalog had no match\n`);
    return fallback;
  }

  throw new Error(`resolveModel: cannot resolve sentinel "${afterRemap}" — both live and static pools empty for ${spec.provider}`);
}

// ── Capability detection ────────────────────────────────────────────────────

/**
 * Does this OpenAI model support the `reasoning.effort` parameter?
 * Covers gpt-5+, o-series (o1, o3, etc.). Future gpt-6 inherits support.
 */
export function supportsReasoningEffort(modelId) {
  if (!modelId) return false;
  const parsed = parseOpenAIModel(modelId);
  if (!parsed) return false;
  if (parsed.family === 'o') return true;                 // o1, o3, …
  if (parsed.family === 'gpt' && parsed.major >= 5) return true; // gpt-5, gpt-6, …
  return false;
}

/**
 * Get a human-readable pricing tier key for a model.
 * Used by the modelPricing table; maps any concrete ID to a stable family key.
 */
export function pricingKey(modelId) {
  const claude = parseClaudeModel(modelId);
  if (claude) return `claude-${claude.tier}`;
  const gemini = parseGeminiModel(modelId);
  if (gemini) return `gemini-${gemini.tier}`;
  const openai = parseOpenAIModel(modelId);
  if (openai) return openai.isLite ? `${openai.family}-${openai.major}-mini` : `${openai.family}-${openai.major}`;
  return modelId;
}

// ── CLI self-check ──────────────────────────────────────────────────────────
// Usage:
//   node scripts/lib/model-resolver.mjs resolve [sentinel]   # show what a sentinel resolves to
//   node scripts/lib/model-resolver.mjs catalog              # fetch live catalog + diff vs static

async function _cli() {
  const args = process.argv.slice(2);
  const cmd = args[0];

  if (cmd === 'resolve') {
    // Live entry points (openai-audit.mjs, brainstorm, gemini-review) refresh
    // the catalog at their own startup before resolving. This standalone CLI
    // is its own process with an empty CATALOG_CACHE — without refreshing
    // here too, `resolve` always silently resolves from STATIC_POOL alone,
    // misleadingly looking authoritative for its documented self-check role.
    await refreshModelCatalog();
    const sentinels = args.length > 1
      ? args.slice(1)
      : Object.keys(SENTINEL_TO_TIER);
    const lines = [];
    for (const s of sentinels) {
      try {
        lines.push(`${s.padEnd(20)} → ${resolveModel(s, { silent: true })}`);
      } catch (err) {
        lines.push(`${s.padEnd(20)} → ERROR: ${err.message}`);
      }
    }
    process.stdout.write(lines.join('\n') + '\n');
    return 0;
  }

  if (cmd === 'catalog') {
    process.stderr.write('Fetching live catalogs (or static-pool fallback on failure)...\n');
    const results = await refreshModelCatalog();
    const lines = [];
    for (const provider of ['openai', 'anthropic', 'google']) {
      const live = CATALOG_CACHE[provider]?.ids || [];
      const statik = STATIC_POOL[provider];
      const livenew = live.filter(id => !statik.includes(id));
      lines.push(`\n─ ${provider} (live: ${results[provider]}) ─`);
      if (live.length === 0) {
        lines.push('  (no live catalog — using static pool)');
      } else {
        lines.push(`  live-only (not in static pool): ${livenew.length ? livenew.slice(0, 20).join(', ') : '(none)'}`);
      }
      lines.push(`  static pool: ${statik.join(', ')}`);
    }
    process.stdout.write(lines.join('\n') + '\n');
    return 0;
  }

  process.stderr.write([
    'Usage:',
    '  node scripts/lib/model-resolver.mjs resolve [sentinel...]   # default: all sentinels',
    '  node scripts/lib/model-resolver.mjs catalog                 # show live vs static pool',
    '',
    'Sentinels: ' + Object.keys(SENTINEL_TO_TIER).join(', '),
  ].join('\n') + '\n');
  return 1;
}

// Run CLI only when executed directly (Windows-safe check)
const invokedDirectly = (() => {
  try {
    const metaPath = new URL(import.meta.url).pathname;
    const argvPath = process.argv[1] ? new URL(`file://${process.argv[1].replaceAll(/\\/g, '/')}`).pathname : '';
    // Compare basenames to avoid path-separator mismatches
    return metaPath.toLowerCase().endsWith('/model-resolver.mjs') &&
      argvPath.toLowerCase().endsWith('/model-resolver.mjs');
  } catch { return false; }
})();

if (invokedDirectly) {
  _cli().then(code => process.exit(code ?? 0)).catch(err => {
    process.stderr.write(`Error: ${err.message}\n`);
    process.exit(1);
  });
}
