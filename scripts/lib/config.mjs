/**
 * @fileoverview Centralized, validated runtime configuration.
 * All environment variable reads and defaults live here — no scattered process.env
 * reads across modules. Import the config object you need.
 * @module scripts/lib/config
 */

import { safeInt } from './file-io.mjs';
import { resolveModel, isSentinel } from './model-resolver.mjs';
import { loadSharedEnv } from './load-shared-env.mjs';
import { PREVIEW_GATE_MODES } from './cycle/topology.mjs';

// ── Environment layering (worktree-safe) ────────────────────────────────────
// All env loading now lives in ONE place: load-shared-env.mjs. It layers the
// cwd/git-root `.env` then the per-user shared `~/.audit-loop.env`
// (`override:false`, gated by `AUDIT_LOOP_DISABLE_SHARED=1`), with the DB-group
// provenance guard. The SAME loader is called at the DB-URL reader
// (`db/client.mjs::resolveDbUrl`) so the shared DSN resolves regardless of
// entrypoint — not just when config.mjs happens to be imported. Calling it at
// config.mjs module-load preserves the prior behaviour for every config reader
// below.
loadSharedEnv();

// ── Validation helpers ──────────────────────────────────────────────────────

const VALID_REASONING = new Set(['low', 'medium', 'high']);

function validatedEnum(envVar, validSet, fallback) {
  const val = process.env[envVar];
  if (val && !validSet.has(val)) {
    process.stderr.write(`  [config] WARNING: Invalid ${envVar}="${val}" — using "${fallback}"\n`);
    return fallback;
  }
  return val || fallback;
}

// ── Model resolution ────────────────────────────────────────────────────────
// Defaults are sentinels (latest-gpt, latest-pro, …) so this config doesn't go
// stale when new models ship. Users may override with concrete IDs via env.
// resolveModel() applies DEPRECATED_REMAP first (warns on stale env values),
// then picks the newest concrete ID from the merged live+static catalog.
// Live catalog is opt-in via refreshModelCatalog() called at process startup.

// ── OpenAI / GPT Audit Config ──────────────────────────────────────────────

export const openaiConfig = Object.freeze({
  model: resolveModel(process.env.OPENAI_AUDIT_MODEL || 'latest-gpt'),
  reasoning: validatedEnum('OPENAI_AUDIT_REASONING', VALID_REASONING, 'high'),
  maxOutputTokensCap: safeInt(process.env.OPENAI_AUDIT_MAX_TOKENS, 32000),
  timeoutMsCap: safeInt(process.env.OPENAI_AUDIT_TIMEOUT_MS, 300000),
  backendSplitThreshold: safeInt(process.env.OPENAI_AUDIT_SPLIT_THRESHOLD, 12),
  mapReduceThreshold: safeInt(process.env.OPENAI_AUDIT_MAP_REDUCE_THRESHOLD, 15),
  mapReduceTokenThreshold: safeInt(process.env.OPENAI_AUDIT_MAP_REDUCE_TOKEN_THRESHOLD, 50000),
  // Lower thresholds for reasoning:high passes (backend, frontend).
  // These time out at ~36% on Windows with single 280s calls — split earlier.
  highReasoningMapReduceThreshold: safeInt(process.env.OPENAI_AUDIT_HIGH_REASONING_MAP_REDUCE_THRESHOLD, 8),
  highReasoningMapReduceTokenThreshold: safeInt(process.env.OPENAI_AUDIT_HIGH_REASONING_MAP_REDUCE_TOKEN_THRESHOLD, 25000),
  // P1-B: Per-unit file caps for frontend/backend map-reduce passes.
  // Prevents single large files from saturating a unit and causing timeouts.
  frontendMaxFilesPerUnit: safeInt(process.env.OPENAI_AUDIT_FRONTEND_MAX_FILES_PER_UNIT, 4),
  backendMaxFilesPerUnit: safeInt(process.env.OPENAI_AUDIT_BACKEND_MAX_FILES_PER_UNIT, 6),
  // P1-B: Minimum token floor for reduce computePassLimits to prevent reduce starvation.
  reduceMinTokens: safeInt(process.env.OPENAI_AUDIT_REDUCE_MIN_TOKENS, 10000),
});

// ── Gemini / Final Review Config ────────────────────────────────────────────

export const geminiConfig = Object.freeze({
  model: resolveModel(process.env.GEMINI_REVIEW_MODEL || 'latest-pro'),
  timeoutMs: safeInt(process.env.GEMINI_REVIEW_TIMEOUT_MS, 120000),
  maxOutputTokens: safeInt(process.env.GEMINI_REVIEW_MAX_TOKENS, 32000),
});

// ── Claude Opus Fallback Config ─────────────────────────────────────────────

export const claudeConfig = Object.freeze({
  finalReviewModel: resolveModel(process.env.CLAUDE_FINAL_REVIEW_MODEL || 'latest-opus'),
});

// ── Shadow Final-Review Config (A/B test — observation-only) ─────────────────
//
// Opt-in second reviewer that runs blind-parallel with the primary final
// review (plan: docs/completed/final-review-shadow-reviewer.md). Deliberately
// PERMISSIVE — raw strings, NO allow-list validation, NO resolveModel() here,
// NO injected default model. An unknown/garbage provider must never throw at
// import (it would break the MANDATORY audit path for an OPTIONAL feature);
// resolveShadow() in gemini-review.mjs handles unknown values as a logged
// no-op (_shadow.state='skipped-unsupported-provider'). The per-provider
// default model is derived in resolveShadow(), NOT here, so it can tell
// "user explicitly pinned a model" from "unset → derive from provider"
// (plan Gemini R2 G3). `model` is null when unset — never 'latest-opus'.
export const shadowReviewConfig = Object.freeze({
  provider: (process.env.FINAL_REVIEW_SHADOW || '').trim() || null,
  model: (process.env.FINAL_REVIEW_SHADOW_MODEL || '').trim() || null,
});

// ── Brief Generation Config ─────────────────────────────────────────────────

export const briefConfig = Object.freeze({
  geminiModel: resolveModel(process.env.BRIEF_MODEL_GEMINI || 'latest-flash'),
  claudeModel: resolveModel(process.env.BRIEF_MODEL_CLAUDE || 'latest-haiku'),
});

// ── Suppression Config ──────────────────────────────────────────────────────

export const suppressionConfig = Object.freeze({
  similarityThreshold: parseFloat(process.env.SUPPRESS_SIMILARITY_THRESHOLD || '0.35'),
});

// ── Learning System v2 Constants ────────────────────────────────────────────

/** Sentinel constants — used instead of NULL for DB uniqueness constraints. */
export const GLOBAL_CONTEXT_BUCKET = 'global';
export const GLOBAL_REPO_ID = '00000000-0000-0000-0000-000000000000';
export const UNKNOWN_FILE_EXT = 'unknown';

/** Canonical list of audit pass names. */
export const PASS_NAMES = Object.freeze(['structure', 'wiring', 'backend', 'frontend', 'sustainability', 'gemini-review']);

/** Normalized language enum for bandit context bucketing. */
export const LANGUAGES = Object.freeze(['js', 'ts', 'py', 'go', 'java', 'rust', 'mixed', 'other']);

/**
 * Normalize a language string to canonical enum value.
 * Handles common aliases (javascript -> js, typescript -> ts, etc.).
 */
export function normalizeLanguage(lang) {
  if (!lang) return 'other';
  const lower = lang.toLowerCase().trim();
  const aliases = {
    javascript: 'js', jsx: 'js', mjs: 'js', cjs: 'js',
    typescript: 'ts', tsx: 'ts',
    python: 'py', python3: 'py',
    golang: 'go',
    'c#': 'other', csharp: 'other', cpp: 'other', c: 'other',
    ruby: 'other', php: 'other', swift: 'other', kotlin: 'other'
  };
  const normalized = aliases[lower] || lower;
  return LANGUAGES.includes(normalized) ? normalized : 'other';
}

// ── Learning System v2 Config ───────────────────────────────────────────────

// ── Meta-Assessment Config ─────────────────────────────────────────────────

export const assessmentConfig = Object.freeze({
  interval: safeInt(process.env.META_ASSESS_INTERVAL, 4),
  minOutcomes: safeInt(process.env.META_ASSESS_MIN_OUTCOMES, 20),
  windowSize: safeInt(process.env.META_ASSESS_WINDOW, 50),
  model: resolveModel(process.env.META_ASSESS_MODEL || 'latest-flash'),
  fallbackGptModel: resolveModel(process.env.META_ASSESS_GPT_FALLBACK || 'latest-gpt-mini'),
});

// ── /cycle deploy-topology Config (GREEN ≠ REALIZED #7) ──────────────────────
// Declares whether /cycle's persona-test can gate before merge. Repo property, not
// a secret — validated against the three honest states; unknown → not_applicable
// (the safe silent default, opt-in). Consumed via resolvePreviewGate (topology.mjs).
const _rawPreviewGateMode = process.env.PREVIEW_GATE_MODE;
if (_rawPreviewGateMode && !PREVIEW_GATE_MODES.includes(_rawPreviewGateMode)) {
  // A PRESENT-but-invalid value must NOT silently disable the gate (the green≠realized trap):
  // surface it so a typo'd PREVIEW_GATE_MODE doesn't read as "protected" while the gate is OFF.
  process.stderr.write(
    `[config] PREVIEW_GATE_MODE='${_rawPreviewGateMode}' is not a valid mode ` +
    `(${PREVIEW_GATE_MODES.join('|')}); treating as not_applicable — the /cycle preview gate is OFF.\n`,
  );
}
export const cycleConfig = Object.freeze({
  previewGateMode: PREVIEW_GATE_MODES.includes(_rawPreviewGateMode) ? _rawPreviewGateMode : 'not_applicable',
});

// ── Learning System v2 Config ─────────────────────────────────────────────

export const learningConfig = Object.freeze({
  outcomeHalfLifeMs: safeInt(process.env.OUTCOME_HALF_LIFE_DAYS, 30) * 24 * 60 * 60 * 1000,
  outcomeMaxAgeMs: safeInt(process.env.OUTCOME_MAX_AGE_DAYS, 180) * 24 * 60 * 60 * 1000,
  outcomePruneEnabled: process.env.OUTCOME_PRUNE_ENABLED !== 'false',
  ucbMinPulls: safeInt(process.env.UCB_MIN_PULLS, 3),
  minBucketSamples: safeInt(process.env.MIN_BUCKET_SAMPLES, 5),
  minFpSamples: safeInt(process.env.MIN_FP_SAMPLES, 5),
  minExamplesThreshold: safeInt(process.env.MIN_EXAMPLES_THRESHOLD, 3),
});

// ── Outcome Reward Weights ──────────────────────────────────────────────────

export const rewardWeights = Object.freeze({
  HIGH: 1,
  MEDIUM: 0.7,
  LOW: 0.4,
  default: 0.5,
});

// ── Model Pricing (per 1M tokens) ───────────────────────────────────────────
// Keyed by family/tier so sentinel resolution never lands on an unpriced key.
// Callers look up via pricingKey(modelId) from model-resolver.mjs, with a
// coarse family-level fallback when the exact key is absent.

export const modelPricing = Object.freeze({
  // OpenAI
  'gpt-5':         { input: 2.5,  output: 10  },
  'gpt-5-mini':    { input: 0.25, output: 2   },
  'gpt-4':         { input: 2.5,  output: 10  },
  'gpt-4-mini':    { input: 0.15, output: 0.6 },

  // Anthropic (per-tier)
  'claude-opus':   { input: 15,   output: 75  },
  'claude-sonnet': { input: 3,    output: 15  },
  'claude-haiku':  { input: 1,    output: 5   },
  // Legacy key preserved for callers not yet migrated
  'claude':        { input: 3,    output: 15  },

  // Google (per-tier; covers aliases + versioned variants)
  'gemini-pro':        { input: 1.25, output: 5   },
  'gemini-flash':      { input: 0.15, output: 0.6 },
  'gemini-flash-lite': { input: 0.075, output: 0.3 },
  // Legacy key preserved for callers still reading `gemini-3.1`
  'gemini-3.1':        { input: 1.25, output: 5   },
});

// ── Architectural Memory Config ─────────────────────────────────────────────
// Per docs/plans/architectural-memory.md §5 file-level plan.

export const symbolIndexConfig = Object.freeze({
  summariseModel:        resolveModel(process.env.ARCH_INDEX_SUMMARY_MODEL || 'latest-haiku'),
  // embedModel default kept loose — concrete provider id resolved + persisted at refresh time (Gemini G2)
  // text-embedding-004 was retired (404 on v1beta as of 2026-05). gemini-embedding-001 is its
  // successor, supports `outputDimensionality` so we can keep VECTOR(768) schema compatibility.
  embedModel:            process.env.ARCH_INDEX_EMBED_MODEL || 'gemini-embedding-001',
  embedDim:              safeInt(process.env.ARCH_INDEX_EMBED_DIM, 768),
  llmConcurrency:        safeInt(process.env.ARCH_INDEX_LLM_CONCURRENCY, 4),
  batchSize:             safeInt(process.env.ARCH_INDEX_BATCH_SIZE, 50),
  driftThreshold:        Number.parseFloat(process.env.ARCH_DRIFT_SCORE_THRESHOLD || '20'),
  driftSimDup:           Number.parseFloat(process.env.ARCH_DRIFT_SIM_DUP || '0.85'),
  driftSimName:          Number.parseFloat(process.env.ARCH_DRIFT_SIM_NAME || '0.90'),
  driftNameLev:          Number.parseFloat(process.env.ARCH_DRIFT_NAME_LEVENSHTEIN || '0.50'),
  auditFullTopN:         safeInt(process.env.ARCH_AUDIT_FULL_TOPN, 200),
  serviceRoleKey:        process.env.SUPABASE_AUDIT_SERVICE_ROLE_KEY || null,
  intentEmbedCacheTtlMs: safeInt(process.env.ARCH_INTENT_EMBED_CACHE_TTL_MS, 24 * 60 * 60 * 1000),
  refreshIncrementalDefault: process.env.ARCH_REFRESH_INCREMENTAL_DEFAULT !== 'false',
  // Renderer page cap — total symbols pulled into one architecture-map.md.
  // The original 5000 was a "sanity" cap that silently truncated wine-cellar
  // (5377 symbols). Raised to 50000 by default; configurable for huge repos.
  // Per-domain Mermaid diagrams still cap their visual nodes at 50→15 for
  // readability, but flat tables and totals respect this cap.
  renderMaxSymbols:      safeInt(process.env.ARCH_RENDER_MAX_SYMBOLS, 50000),
});

// ── Predictive Strategy Config ──────────────────────────────────────────────

export const predictiveConfig = Object.freeze({
  explorationInterval: safeInt(process.env.PREDICTIVE_EXPLORATION_INTERVAL, 10),
  freshnessWindowDays: safeInt(process.env.PREDICTIVE_FRESHNESS_DAYS, 14),
  minLabeledRuns: safeInt(process.env.PREDICTIVE_MIN_LABELED_RUNS, 20),
  skipFpThreshold: Number.parseFloat(process.env.PREDICTIVE_SKIP_FP_THRESHOLD || '0.7'),
});

// ── Postgres / `db/` layer Config ──────────────────────────────────────────
// postgres-parity plan §7 Phase 1. v1 supports the `public` schema only;
// arbitrary schema is §10 Out of Scope — no AUDIT_DB_SCHEMA env exposed
// here.
//
// `url` is read eagerly (so test code that overrides process.env before
// `import` works), but `scripts/lib/db/client.mjs` re-reads `process.env`
// at pool-init time — that's the resolver of record (it also enforces the
// legacy-only fail-fast). Treat the values here as documentation +
// convenience for callers that just want to ask "is cloud configured?".

export const dbConfig = Object.freeze({
  url: process.env.AUDIT_DB_URL || null,
  sslMode: (process.env.AUDIT_DB_SSL_MODE || 'require').trim(),
  poolMax: safeInt(process.env.AUDIT_DB_POOL_MAX, 4),
});

// ── Azure AI Foundry Work Profile (opt-in) ──────────────────────────────────
// Plan: docs/plans/azure-work-profile.md §1.5. The ENTIRE Azure path is gated
// on presence of AZURE_OPENAI_ENDPOINT. With it absent, `active` is false and
// every consumer falls back to its public construction — byte-identical to the
// pre-Azure behaviour (the load-bearing opt-in invariant).
//
// Pure builder (exported for tests — ESM reads process.env once at import, so
// the frozen `azureConfig` below is a snapshot; tests call buildAzureConfig
// with a synthetic env instead of re-importing the module).

const VALID_CLAUDE_SHAPES = new Set(['openai', 'anthropic']);

/**
 * Build the Azure config from an env-like object. Throws (fail-fast, redacted —
 * never echoes key material) when Azure is half-configured.
 * @param {Record<string,string|undefined>} env
 * @returns {Readonly<{active:boolean, openaiEndpoint:string|null, aiEndpoint:string|null,
 *   apiKey:string|null, apiVersion:string, gptDeployment:string|null,
 *   claudeDeployment:string|null, embedDeployment:string, claudeApiShape:string,
 *   foundryApiPath:string}>}
 */
export function buildAzureConfig(env = process.env) {
  const openaiEndpoint = (env.AZURE_OPENAI_ENDPOINT || '').trim() || null;
  const active = !!openaiEndpoint;

  if (!active) {
    // Inert snapshot — no validation, no env mutation. Public path unchanged.
    return Object.freeze({
      active: false,
      openaiEndpoint: null, aiEndpoint: null, apiKey: null,
      apiVersion: 'preview', gptDeployment: null, claudeDeployment: null,
      summaryDeployment: 'claude-sonnet-4-6',
      embedDeployment: 'text-embedding-3-small', claudeApiShape: 'anthropic',
      claudeBaseUrl: null, foundryApiPath: '/openai/v1',
    });
  }

  const apiKey = (env.AZURE_OPENAI_API_KEY || '').trim() || null;

  // Deployment resolution (forgiving): prefer the dedicated AZURE_*_DEPLOYMENT
  // var, else fall back to a CONCRETE (non-sentinel) OPENAI_AUDIT_MODEL /
  // CLAUDE_FINAL_REVIEW_MODEL. This lets the natural `OPENAI_AUDIT_MODEL=gpt-5.3-chat`
  // config work without a second var, while still keeping sentinels (latest-*)
  // out of the wire path (they'd 404 as Azure deployment names).
  const concrete = (v) => { const s = (v || '').trim(); return s && !isSentinel(s) ? s : null; };
  const gptDeployment = (env.AZURE_OPENAI_GPT_DEPLOYMENT || '').trim() || concrete(env.OPENAI_AUDIT_MODEL);
  const claudeDeployment = (env.AZURE_FOUNDRY_CLAUDE_DEPLOYMENT || '').trim()
    || concrete(env.CLAUDE_FINAL_REVIEW_MODEL) || 'claude-opus-4-7';

  // All-or-nothing (§1.5): endpoint set ⇒ key + a GPT deployment required.
  const missing = [];
  if (!apiKey) missing.push('AZURE_OPENAI_API_KEY');
  if (!gptDeployment) missing.push('AZURE_OPENAI_GPT_DEPLOYMENT (or a concrete OPENAI_AUDIT_MODEL)');
  if (missing.length > 0) {
    throw new Error(
      `[config] AZURE_OPENAI_ENDPOINT is set (Azure work profile active) but ` +
      `${missing.join(' + ')} ${missing.length > 1 ? 'are' : 'is'} missing. ` +
      `Set ${missing.length > 1 ? 'them' : 'it'} or unset AZURE_OPENAI_ENDPOINT to use the public profile.`,
    );
  }

  // Foundry serves Claude as the NATIVE Anthropic API at `/anthropic/v1/messages`
  // with `Authorization: Bearer` (verified against ai-organiser's azureClaudeAdapter).
  // So `anthropic` is the correct default, NOT the OpenAI-shaped surface.
  const claudeApiShape = (env.AZURE_CLAUDE_API_SHAPE || 'anthropic').trim();
  if (!VALID_CLAUDE_SHAPES.has(claudeApiShape)) {
    throw new Error(
      `[config] Invalid AZURE_CLAUDE_API_SHAPE="${claudeApiShape}". ` +
      `Valid values: ${[...VALID_CLAUDE_SHAPES].join(', ')}.`,
    );
  }

  const aiEndpoint = (env.AZURE_AI_ENDPOINT || '').trim() || null;
  return Object.freeze({
    active: true,
    openaiEndpoint,
    aiEndpoint,
    apiKey,
    apiVersion: (env.AZURE_OPENAI_API_VERSION || 'preview').trim(),
    gptDeployment,
    claudeDeployment,
    // Arch-index summariser deployment (Sonnet on Foundry by default).
    summaryDeployment: (env.AZURE_FOUNDRY_SUMMARY_DEPLOYMENT || 'claude-sonnet-4-6').trim(),
    embedDeployment: (env.AZURE_OPENAI_EMBED_DEPLOYMENT || 'text-embedding-3-small').trim(),
    claudeApiShape,
    // Native-Anthropic base for the Foundry Claude path — the SDK appends
    // `/v1/messages`, yielding `…/anthropic/v1/messages`.
    claudeBaseUrl: aiEndpoint ? `${aiEndpoint.replace(/\/+$/, '')}/anthropic` : null,
    foundryApiPath: (env.AZURE_FOUNDRY_API_PATH || '/openai/v1').trim(),
  });
}

export const azureConfig = buildAzureConfig(process.env);

// When the Azure profile is active, the live model catalog (api.openai.com /
// generativelanguage / api.anthropic.com) would 404 against Azure-only access,
// so default the catalog refresh to skip unless the operator overrode it.
if (azureConfig.active && process.env.MODEL_CATALOG_REFRESH === undefined) {
  process.env.MODEL_CATALOG_REFRESH = 'skip';
}
