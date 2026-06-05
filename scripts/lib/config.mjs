/**
 * @fileoverview Centralized, validated runtime configuration.
 * All environment variable reads and defaults live here — no scattered process.env
 * reads across modules. Import the config object you need.
 * @module scripts/lib/config
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { safeInt } from './file-io.mjs';
import { resolveModel } from './model-resolver.mjs';

// ── .env Discovery (worktree-safe) ──────────────────────────────────────────

// R1-audit M9/M11/M15: ONE walk-up + git-root resolver lives in
// scripts/lib/shared-cloud-config.mjs (`discoverLocalEnvPath`). This function
// is a thin adapter that sets the `DOTENV_CONFIG_PATH` env var as a side
// effect for `dotenv.config()` to pick up — that side-effect is config.mjs-
// specific, hence the wrapper. Resolution rule itself is shared.
import { discoverLocalEnvPath } from './shared-cloud-config.mjs';
function discoverDotenv() {
  if (process.env.DOTENV_CONFIG_PATH) return;
  const found = discoverLocalEnvPath();
  if (found) process.env.DOTENV_CONFIG_PATH = found;
}

// Run discovery then load .env (uses dotenv package directly, not 'dotenv/config')
discoverDotenv();
import dotenv from 'dotenv';
dotenv.config({ path: process.env.DOTENV_CONFIG_PATH || '.env', quiet: true });

// ── Shared cross-repo cloud config (Layer 2) ───────────────────────────────
// Per docs/plans/shared-cloud-config.md: ~/.audit-loop.env is a per-user
// shared file holding DSN + LLM keys. Consumer repos auto-inherit. Silent
// when absent; one-time stderr note when present + set ≥1 var. Layer 1
// (cwd .env above) wins via override:false.
//
// Hermeticity escape hatch: `AUDIT_LOOP_DISABLE_SHARED=1` skips the autoload
// entirely. Used by test helpers (`tests/cross-skill-persona.test.mjs`
// runCli) so the operator's actual `~/.audit-loop.env` doesn't leak into
// the subprocess and make "cloud unavailable" tests pass cloud-data through.
const SHARED_CLOUD_ENV = path.join(os.homedir(), '.audit-loop.env');
if (process.env.AUDIT_LOOP_DISABLE_SHARED !== '1' && fs.existsSync(SHARED_CLOUD_ENV)) {
  const before = new Set(Object.keys(process.env));
  dotenv.config({ path: SHARED_CLOUD_ENV, override: false, quiet: true });
  const added = Object.keys(process.env).filter(k => !before.has(k));
  if (added.length > 0 && process.env._AUDIT_LOOP_SHARED_LOADED !== '1') {
    process.stderr.write(
      `  [config] loaded shared cloud config from ~/.audit-loop.env (sets: ${added.join(', ')})\n`
    );
    // Sentinel propagates to spawned subprocesses (env inherits) so each
    // child doesn't re-log the same notice.
    process.env._AUDIT_LOOP_SHARED_LOADED = '1';
  }
}

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
      embedDeployment: 'text-embedding-3-small', claudeApiShape: 'openai',
      foundryApiPath: '/openai/v1',
    });
  }

  const apiKey = (env.AZURE_OPENAI_API_KEY || '').trim() || null;
  const gptDeployment = (env.AZURE_OPENAI_GPT_DEPLOYMENT || '').trim() || null;

  // All-or-nothing (§1.5): endpoint set ⇒ key + GPT deployment required.
  // Error names the missing var(s) only — never the values.
  const missing = [];
  if (!apiKey) missing.push('AZURE_OPENAI_API_KEY');
  if (!gptDeployment) missing.push('AZURE_OPENAI_GPT_DEPLOYMENT');
  if (missing.length > 0) {
    throw new Error(
      `[config] AZURE_OPENAI_ENDPOINT is set (Azure work profile active) but ` +
      `${missing.join(' + ')} ${missing.length > 1 ? 'are' : 'is'} missing. ` +
      `Set ${missing.length > 1 ? 'them' : 'it'} or unset AZURE_OPENAI_ENDPOINT to use the public profile.`,
    );
  }

  const claudeApiShape = (env.AZURE_CLAUDE_API_SHAPE || 'openai').trim();
  if (!VALID_CLAUDE_SHAPES.has(claudeApiShape)) {
    throw new Error(
      `[config] Invalid AZURE_CLAUDE_API_SHAPE="${claudeApiShape}". ` +
      `Valid values: ${[...VALID_CLAUDE_SHAPES].join(', ')}.`,
    );
  }

  return Object.freeze({
    active: true,
    openaiEndpoint,
    aiEndpoint: (env.AZURE_AI_ENDPOINT || '').trim() || null,
    apiKey,
    apiVersion: (env.AZURE_OPENAI_API_VERSION || 'preview').trim(),
    gptDeployment,
    claudeDeployment: (env.AZURE_FOUNDRY_CLAUDE_DEPLOYMENT || '').trim() || null,
    embedDeployment: (env.AZURE_OPENAI_EMBED_DEPLOYMENT || 'text-embedding-3-small').trim(),
    claudeApiShape,
    // Foundry Serverless non-OpenAI models may route at /models rather than
    // /openai/v1 (Gemini-R3-M, manual-verification-required). Overridable for
    // the live-smoke without a code change.
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
