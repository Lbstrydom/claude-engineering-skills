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

/**
 * Deterministic, bounds-validated numeric env-var reader (audit-orchestrator-
 * hardening Phase 7 — audit-plan fix M2/M3, Gemini gate fixes G1-G2).
 *
 * Order matters, each step closes a specific real bug found during this
 * plan's own audit rounds:
 *  1. `raw == null || raw === ''` → `fallback` IMMEDIATELY, before any
 *     `.trim()` call (Gemini gate fix, round 4 of that gate — an unset env
 *     var makes `process.env.X` literally `undefined`, and
 *     `undefined.trim()` throws; every env var this reads is optional with
 *     a documented default, so this is the common case, not an edge case).
 *  2. Only once `raw` is confirmed non-nullish/non-empty is it `.trim()`'d
 *     (Gemini gate fix G2, round 1 — env vars from shell/CI/.env files
 *     routinely carry leading/trailing whitespace or a trailing newline).
 *  3. The trimmed string is validated against a STRICT pattern before
 *     parsing (audit-plan fix M2, round 3 — `parseInt('10abc')` /
 *     `parseFloat('0.5%')` / `parseInt('1.5')` all silently accept a
 *     malformed value's numeric PREFIX, never triggering the fallback/clamp
 *     warning path). A pattern-rejected value is treated identically to a
 *     non-finite parse below — never partially accepted.
 *  4. Only a pattern-passing value reaches `parser(raw)`. `Number.isFinite`
 *     is checked FIRST — this single check catches BOTH `NaN` and
 *     `±Infinity` in one branch (audit-plan fix M3, round 2 — NaN has no
 *     "nearest bound" and `Number.parseFloat('Infinity')` returns the
 *     actual `Infinity` value, not `NaN`, so the two need one shared rule).
 *     A non-finite parse (or a pattern-rejected raw value) uses `fallback`
 *     (a DEFAULT, never a clamp — there is no nearest bound to an
 *     unparseable value); a finite-but-out-of-range parse is CLAMPED to
 *     `[min, max]`.
 *
 * One `process.stderr.write` warning fires on EITHER the defaulted or the
 * clamped path, naming the env var, the raw string value, and the
 * resulting value — consistent with this repo's existing config-warning
 * style (e.g. the model-resolver's deprecation-remap warnings).
 *
 * @param {string|undefined} raw - `process.env[envVar]`
 * @param {{fallback: number, min: number, max: number, parser: (s: string) => number, envVar?: string}} opts
 * @returns {number}
 */
export function clampConfigNumber(raw, { fallback, min, max, parser, envVar = 'unknown' }) {
  if (raw == null || raw === '') return fallback;
  const trimmed = String(raw).trim();
  if (trimmed === '') return fallback;
  const pattern = parser === Number.parseInt ? /^-?\d+$/ : /^-?\d+(\.\d+)?$/;
  if (!pattern.test(trimmed)) {
    process.stderr.write(`  [config] WARNING: ${envVar}="${raw}" is not a valid number — using default ${fallback}\n`);
    return fallback;
  }
  const parsed = parser(trimmed);
  if (!Number.isFinite(parsed)) {
    process.stderr.write(`  [config] WARNING: ${envVar}="${raw}" parsed to a non-finite value — using default ${fallback}\n`);
    return fallback;
  }
  if (parsed < min || parsed > max) {
    const clamped = Math.min(Math.max(parsed, min), max);
    process.stderr.write(`  [config] WARNING: ${envVar}="${raw}" (${parsed}) out of range [${min}, ${max}] — clamped to ${clamped}\n`);
    return clamped;
  }
  return parsed;
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

// ── Final-Review Provider + Lifecycle Config ────────────────────────────────
//
// Provider-neutral (deliberately NOT tucked into geminiConfig — final review is
// no longer Gemini-only; plan §M3). The gateway fields are RAW strings with NO
// resolveModel() and NO per-provider validation here — they are validated at
// selectProvider() by the chosen provider's descriptor, mirroring
// shadowReviewConfig's permissive discipline (an unset/garbage value must never
// throw at import and break the MANDATORY audit path).
//
// `hardDeadlineMs` is the process-level watchdog bound that guarantees
// background-safe termination (the harness gives detached runs no reaper). It
// must be able to contain a full run: MAX_ATTEMPTS(2) per-attempt timeouts +
// shadow + cloud slack. A value below that floor is raised (never silently
// accepted — a too-small deadline would kill legitimate runs).
function computeFinalReviewHardDeadline() {
  const FLOOR = 2 * geminiConfig.timeoutMs + 60000;
  const v = clampConfigNumber(process.env.FINAL_REVIEW_HARD_DEADLINE_MS, {
    fallback: 600000, min: 60000, max: 3600000,
    parser: Number.parseInt, envVar: 'FINAL_REVIEW_HARD_DEADLINE_MS',
  });
  if (v < FLOOR) {
    process.stderr.write(
      `  [config] FINAL_REVIEW_HARD_DEADLINE_MS=${v}ms is below the safe floor ${FLOOR}ms ` +
      `(2×${geminiConfig.timeoutMs} per-attempt + 60000 slack) — raising to the floor.\n`,
    );
    return FLOOR;
  }
  return v;
}

export const finalReviewConfig = Object.freeze({
  baseUrl: (process.env.FINAL_REVIEW_BASE_URL || '').trim() || null,
  apiKey: (process.env.FINAL_REVIEW_API_KEY || '').trim() || null,
  model: (process.env.FINAL_REVIEW_MODEL || '').trim() || null,
  hardDeadlineMs: computeFinalReviewHardDeadline(),
});

// ── Shadow Final-Review Config (A/B test — observation-only) ─────────────────
//
// Opt-in second reviewer that runs blind-parallel with the primary final
// review (plan: docs/plans/final-review-shadow-reviewer.md). Deliberately
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

// ── Model-A/B/C generation-shadow Config (observation-only burn-in) ──────────
//
// Plan: docs/plans/model-ab-experiment-harness.md. Generalizes the final-review
// shadow above to the GENERATION passes. Same permissiveness discipline: RAW
// strings, NO arm validation here (unknown arm ids are a `resolveArms(env)`
// caller-time error, NOT an import-time throw — an OPTIONAL experiment must
// never break the MANDATORY audit path at import). `arms` unset → the harness
// is inert and byte-identical to today (the load-bearing opt-in invariant).
//
// `budgetEur` defaults to €300 when the env var is unset (operator decision
// 2026-07-02) — the OPT-IN remains `arms` (unset → fully inert); the default
// only bounds spend once the experiment is explicitly enabled. The shadow
// layer still hard-refuses a null/absent ceiling at the library seam (no
// unbounded burn) — this default is a ceiling, not a blank check. Override
// with AUDIT_MODEL_SHADOW_BUDGET_EUR. The OpenRouter binding lives here so
// the OSS client seam reads one config, not scattered process.env.
export const DEFAULT_SPEND_BUDGET_EUR = 300;
export const auditShadowConfig = Object.freeze({
  arms: (process.env.AUDIT_MODEL_SHADOW || '').trim() || null,
  budgetEur: (() => {
    const v = Number.parseFloat(process.env.AUDIT_MODEL_SHADOW_BUDGET_EUR);
    return Number.isFinite(v) && v > 0 ? v : DEFAULT_SPEND_BUDGET_EUR;
  })(),
  openrouterApiKey: (process.env.OPENROUTER_API_KEY || '').trim() || null,
  openrouterBaseUrl: (process.env.OPENROUTER_BASE_URL || '').trim() || 'https://openrouter.ai/api/v1',
  // Bounded per-arm await before the CLI exits (decision 12 — a hung OSS
  // provider can't stall the process; the rest is marked `unverified`).
  perArmTimeoutMs: safeInt(process.env.AUDIT_MODEL_SHADOW_ARM_TIMEOUT_MS, 600000),
  // Reservation TTL — orphaned reservations older than this are released on
  // startup (crash-safety) and excluded from the active-cap sum.
  reservationTtlMs: safeInt(process.env.AUDIT_MODEL_SHADOW_RESERVATION_TTL_MS, 30 * 60 * 1000),
  // Per-pass max output tokens (the reservation estimates at THIS cap so it
  // never under-reserves) + per-call provider timeout.
  passMaxTokens: safeInt(process.env.AUDIT_MODEL_SHADOW_PASS_MAX_TOKENS, 8000),
  callTimeoutMs: safeInt(process.env.AUDIT_MODEL_SHADOW_CALL_TIMEOUT_MS, 300000),
});

// ── Arm-Eval Config ─────────────────────────────────────────────────────────
// Default budget for `arm-eval-run` sessions when `--budget-eur` is omitted.
// The run module (lib/arm-eval/run.mjs) still refuses a null budget at the
// library seam — the CLI supplies this default so the operator doesn't have
// to repeat the flag per session. Override with ARM_EVAL_BUDGET_EUR.
export const armEvalConfig = Object.freeze({
  budgetEur: (() => {
    const v = Number.parseFloat(process.env.ARM_EVAL_BUDGET_EUR);
    return Number.isFinite(v) && v > 0 ? v : DEFAULT_SPEND_BUDGET_EUR;
  })(),
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

/**
 * Per-pass reasoning-effort tier the PRODUCTION GPT pipeline runs (openai-audit.mjs:
 * structure/wiring=low ∥, backend/frontend=high ∥, sustainability=medium). SSoT
 * for the model-A/B/C reasoning-PARITY control (plan D4a): the generation shadow
 * feeds this effort to BOTH the OSS adapter (OpenRouter `reasoning:{effort}`) and
 * the independent GPT round, so the experiment measures model quality — not a
 * reasoning-effort confound. A pass absent here → the caller's own default.
 */
export const PASS_REASONING = Object.freeze({
  structure: 'low',
  wiring: 'low',
  backend: 'high',
  frontend: 'high',
  sustainability: 'medium',
});

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

// ── Friction-feedback loop (GREEN ≠ REALIZED sibling) ────────────────────────
// Recurrence × cost ranking thresholds + the protected-scope gate set + the
// breadcrumb TTL. Plan: docs/plans/friction-feedback-loop.md.
export const frictionConfig = Object.freeze({
  // Recurrence alarm: a cluster recurring >= recurrenceAlarmCount and older than
  // recurrenceAlarmAgeDays with no mitigation is the graveyard alarm.
  recurrenceWindowDays: safeInt(process.env.FRICTION_WINDOW_DAYS, 30),
  recurrenceAlarmCount: safeInt(process.env.FRICTION_ALARM_COUNT, 3),
  recurrenceAlarmAgeDays: safeInt(process.env.FRICTION_ALARM_AGE_DAYS, 14),
  // cost → numeric weight for `recurrence × cost` ranking.
  costWeight: Object.freeze({ S: 1, M: 2, L: 3 }),
  // Recurring-unmitigated friction in these scope_tags HARD-FAILS memory-health
  // (the only non-advisory path). Everything else WARNs.
  protectedScopeTags: Object.freeze(
    (process.env.FRICTION_PROTECTED_SCOPES || 'secret-egress,consumer-sync,false-green')
      .split(',').map((s) => s.trim()).filter(Boolean),
  ),
  // Injection match threshold for pg_trgm word_similarity(signature, prompt).
  // EMPIRICALLY tuned (friction-feedback-loop empirical verify, 2026-06-28):
  // a genuinely-relevant prompt scored ~0.38 vs ~0.03 for an unrelated one — a
  // ~10× separation — so the plan's 0.6 default would NEVER fire on real titles.
  // 0.3 catches strong matches and rejects noise; lower it for more recall.
  injectionWordSim: (() => {
    const v = Number.parseFloat(process.env.FRICTION_INJECTION_WORD_SIM);
    return Number.isFinite(v) && v > 0 && v <= 1 ? v : 0.3;
  })(),
  // Single rolling breadcrumb prune horizon.
  breadcrumbTtlDays: safeInt(process.env.FRICTION_BREADCRUMB_TTL_DAYS, 7),
  // Max body chars mirrored into body_excerpt / trgm_text.
  bodyExcerptMaxChars: safeInt(process.env.FRICTION_BODY_EXCERPT_CHARS, 2000),
});

// ── Learning System v2 Config ─────────────────────────────────────────────

/** Inclusive bounds for the per-scope FP-pattern read limit. */
export const FP_READ_LIMIT_MIN = 1;
export const FP_READ_LIMIT_MAX = 5000;
export const FP_READ_LIMIT_DEFAULT = 500;

/**
 * Range-validate the per-scope FP-pattern read limit — PURE FUNCTION.
 *
 * `safeInt` only guards NaN; it happily returns 999999999, which would defeat
 * the bounded-read guarantee, or 0/-5, which would make the SQL LIMIT inert or
 * invalid. This is the single validation seam, applied BOTH at config
 * resolution and at the loader's public API (a caller may pass `limit`
 * explicitly and must not be able to bypass the bound).
 *
 * Already-clamped input clamps to itself — a no-op that warns nothing, so the
 * normal config-derived path never double-warns.
 *
 * @param {unknown} value
 * @param {(msg: string) => void} [warn] - injected for tests; defaults to stderr
 * @returns {number} An integer within [FP_READ_LIMIT_MIN, FP_READ_LIMIT_MAX]
 */
export function clampFpReadLimit(value, warn = (m) => process.stderr.write(m)) {
  const n = safeInt(value, FP_READ_LIMIT_DEFAULT);
  if (!Number.isFinite(n)) return FP_READ_LIMIT_DEFAULT;
  if (n < FP_READ_LIMIT_MIN) {
    warn(`  [cloud-fp] FP read limit ${n} below minimum — clamped to ${FP_READ_LIMIT_MIN}\n`);
    return FP_READ_LIMIT_MIN;
  }
  if (n > FP_READ_LIMIT_MAX) {
    warn(`  [cloud-fp] FP read limit ${n} above maximum — clamped to ${FP_READ_LIMIT_MAX}\n`);
    return FP_READ_LIMIT_MAX;
  }
  return n;
}

export const learningConfig = Object.freeze({
  outcomeHalfLifeMs: safeInt(process.env.OUTCOME_HALF_LIFE_DAYS, 30) * 24 * 60 * 60 * 1000,
  outcomeMaxAgeMs: safeInt(process.env.OUTCOME_MAX_AGE_DAYS, 180) * 24 * 60 * 60 * 1000,
  outcomePruneEnabled: process.env.OUTCOME_PRUNE_ENABLED !== 'false',
  ucbMinPulls: safeInt(process.env.UCB_MIN_PULLS, 3),
  minBucketSamples: safeInt(process.env.MIN_BUCKET_SAMPLES, 5),
  minFpSamples: safeInt(process.env.MIN_FP_SAMPLES, 5),
  minExamplesThreshold: safeInt(process.env.MIN_EXAMPLES_THRESHOLD, 3),
  // Per-scope cap on the cloud FP-pattern read. Range-validated, not merely
  // parsed — a bound a typo can disable is not a bound.
  fpReadLimit: clampFpReadLimit(process.env.FP_READ_LIMIT ?? FP_READ_LIMIT_DEFAULT),
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

/**
 * Range-validated bound for the adjacency wave. Clamp-and-warn, NOT bare
 * `safeInt`/`parseFloat` — the sibling waves' knobs are parsed but unvalidated,
 * so `ARCH_DUPLICATION_MAX_FILES=999999` sails through and
 * `ARCH_DRIFT_SIM_DUP=abc` yields NaN, silently zeroing every candidate. By the
 * cloud-FP reader's own rule, "a bound that a typo can disable is not a bound".
 */
export function clampAdjacencyBound(value, { min, max, dflt, name }, warn = (m) => process.stderr.write(m)) {
  const n = safeInt(value, dflt);
  if (!Number.isFinite(n)) return dflt;
  if (n < min) { warn(`  [adjacency] ${name}=${n} below minimum — clamped to ${min}\n`); return min; }
  if (n > max) { warn(`  [adjacency] ${name}=${n} above maximum — clamped to ${max}\n`); return max; }
  return n;
}

/**
 * Containment-adjacency wave bounds. Deliberately NOT filed under
 * `symbolIndexConfig`: the duplication wave legitimately uses the symbol index
 * (snapshot, embeddings, RPC), but this detector provably does not — zero DB,
 * zero network, pure syntax. Filing audit-wave policy under an unrelated
 * subsystem is accidental coupling that teaches every future reader a false
 * relationship.
 *
 * Three families, and the ORDER matters: input bounds gate whether the
 * expensive work happens at all; enumeration and payload bounds shape it once
 * it does.
 */
export const adjacencyConfig = Object.freeze({
  // ── Input preflight — enforced against `git diff --numstat` BEFORE the
  //    unified diff is materialised. A bound applied to a string you already
  //    built does not bound building it.
  maxChangedFiles: clampAdjacencyBound(process.env.ADJACENCY_MAX_CHANGED_FILES, { min: 1, max: 2000, dflt: 60, name: 'maxChangedFiles' }),
  maxChangedLines: clampAdjacencyBound(process.env.ADJACENCY_MAX_CHANGED_LINES, { min: 1, max: 500000, dflt: 20000, name: 'maxChangedLines' }),
  maxDiffBytes: clampAdjacencyBound(process.env.ADJACENCY_MAX_DIFF_BYTES, { min: 1024, max: 200_000_000, dflt: 2_000_000, name: 'maxDiffBytes' }),
  maxSourceFileBytes: clampAdjacencyBound(process.env.ADJACENCY_MAX_SOURCE_FILE_BYTES, { min: 1024, max: 50_000_000, dflt: 1_000_000, name: 'maxSourceFileBytes' }),
  // ── Enumeration
  maxContainers: clampAdjacencyBound(process.env.ADJACENCY_MAX_CONTAINERS, { min: 1, max: 500, dflt: 20, name: 'maxContainers' }),
  maxStatementsPerContainer: clampAdjacencyBound(process.env.ADJACENCY_MAX_STATEMENTS, { min: 1, max: 500, dflt: 40, name: 'maxStatementsPerContainer' }),
  maxCandidates: clampAdjacencyBound(process.env.ADJACENCY_MAX_CANDIDATES, { min: 1, max: 200, dflt: 25, name: 'maxCandidates' }),
  // ── Payload (bytes leaving the process)
  maxExcerptChars: clampAdjacencyBound(process.env.ADJACENCY_MAX_EXCERPT_CHARS, { min: 200, max: 20000, dflt: 3000, name: 'maxExcerptChars' }),
  maxCandidateChars: clampAdjacencyBound(process.env.ADJACENCY_MAX_CANDIDATE_CHARS, { min: 400, max: 40000, dflt: 8000, name: 'maxCandidateChars' }),
  maxPromptChars: clampAdjacencyBound(process.env.ADJACENCY_MAX_PROMPT_CHARS, { min: 1000, max: 400000, dflt: 60000, name: 'maxPromptChars' }),
});

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
  intentEmbedCacheTtlMs: safeInt(process.env.ARCH_INTENT_EMBED_CACHE_TTL_MS, 24 * 60 * 60 * 1000),
  refreshIncrementalDefault: process.env.ARCH_REFRESH_INCREMENTAL_DEFAULT !== 'false',
  // Duplication audit wave (docs/plans/audit-code-duplication-wave.md §2) —
  // cheap preflight bound (checked before any Git extraction happens) and
  // the post-extraction candidate-count cap. Both return `unavailable`
  // rather than silently truncating when exceeded.
  maxDuplicationScanFiles:    safeInt(process.env.ARCH_DUPLICATION_MAX_FILES, 30),
  maxDuplicationCandidates:   safeInt(process.env.ARCH_DUPLICATION_MAX_CANDIDATES, 40),
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

// ── Tiered-Recall Audit Pipeline Config (Cluster D, scoped — new modules only;
// the chooser that would actually route production traffic to these modules
// is NOT wired in this pass, per docs/plans/tiered-recall-audit-pipeline.md
// §11 Cluster D scoping decision, 2026-07-10). `discoveryModel` is a raw
// OpenRouter model id, NOT a model-resolver sentinel — model-resolver has no
// GLM/OSS tier (see AGENTS.md "Model Resolution" table), so it is read
// verbatim like `auditShadowConfig`'s OpenRouter model id, not wrapped in
// `resolveModel()`. ──────────────────────────────────────────────────────────

export const tieredAuditConfig = Object.freeze({
  discoveryModel: process.env.AUDIT_DISCOVERY_MODEL || 'z-ai/glm-5.2',
  // Phase 7 (audit-orchestrator-hardening): rate/probability fields clamped
  // to [0, 1] via clampConfigNumber — a bare parseFloat previously accepted
  // any NaN/Infinity/out-of-range value with no positivity check.
  gptSentinelRate: clampConfigNumber(process.env.AUDIT_GPT_SENTINEL_RATE, {
    fallback: 0.2, min: 0, max: 1, parser: Number.parseFloat, envVar: 'AUDIT_GPT_SENTINEL_RATE',
  }),
  gptExplorationRate: clampConfigNumber(process.env.AUDIT_GPT_EXPLORATION_RATE, {
    fallback: 0.1, min: 0, max: 1, parser: Number.parseFloat, envVar: 'AUDIT_GPT_EXPLORATION_RATE',
  }),
  // A trigger threshold of 0 is degenerate-but-valid ("always trigger"), not
  // an error — no upper clamp beyond safe-integer range.
  gptDiffSizeTriggerChars: clampConfigNumber(process.env.AUDIT_GPT_DIFF_SIZE_TRIGGER_CHARS, {
    fallback: 150000, min: 0, max: Number.MAX_SAFE_INTEGER, parser: Number.parseInt, envVar: 'AUDIT_GPT_DIFF_SIZE_TRIGGER_CHARS',
  }),
  stage1Model: process.env.AUDIT_STAGE1_MODEL ? resolveModel(process.env.AUDIT_STAGE1_MODEL) : null,
  stage1MaxFalseDismissalHigh: clampConfigNumber(process.env.AUDIT_STAGE1_MAX_FALSE_DISMISSAL_HIGH, {
    fallback: 0.05, min: 0, max: 1, parser: Number.parseFloat, envVar: 'AUDIT_STAGE1_MAX_FALSE_DISMISSAL_HIGH',
  }),
  stage1MaxFalseDismissalOverall: clampConfigNumber(process.env.AUDIT_STAGE1_MAX_FALSE_DISMISSAL_OVERALL, {
    fallback: 0.10, min: 0, max: 1, parser: Number.parseFloat, envVar: 'AUDIT_STAGE1_MAX_FALSE_DISMISSAL_OVERALL',
  }),
  // Phase 11 chooser flag — explicit opt-in, never silently flipping default
  // behavior (§1.5 "every phase remains additive/env-var-gated"). Default
  // false: `runMultiPassCodeAudit` routes to the unchanged
  // `runLegacyProductionAudit` path until an operator explicitly opts in.
  pipelineEnabled: process.env.AUDIT_TIERED_PIPELINE_ENABLED === 'true',
  // Close-out shadow validation (tiered-shadow-compare.mjs) — runs the
  // tiered pipeline as an observation-only comparison alongside the real
  // legacy run. Independent of `pipelineEnabled` (can shadow-validate WHILE
  // still gating on legacy) and OFF by default. A temporary mechanism for
  // the plan's "10-15 real commits" validation window, not a permanent flag.
  shadowEnabled: process.env.AUDIT_TIERED_SHADOW_ENABLED === 'true',
  // Phase 9's FinalAdjudicationBudget.perCallTimeoutMs — actively enforced by
  // Phase 12's subprocess adapter via `execFile`'s own `timeout` option (sends
  // SIGTERM on expiry). Clamped strictly positive (a 0/negative timeout would
  // be degenerate — every call would time out instantly).
  adjudicationPerCallTimeoutMs: clampConfigNumber(process.env.AUDIT_ADJUDICATION_CALL_TIMEOUT_MS, {
    fallback: 120000, min: 1, max: Number.MAX_SAFE_INTEGER, parser: Number.parseInt, envVar: 'AUDIT_ADJUDICATION_CALL_TIMEOUT_MS',
  }),
});

// ── Audit Runtime Config (Phase 7 — audit-orchestrator-hardening) ──────────
// Bounds-validated runtime knobs for the legacy production audit
// orchestrator. `mapReduceConcurrency` was previously read via a bare
// inline `safeInt(process.env.MAP_REDUCE_CONCURRENCY, 5)` INSIDE
// legacy-production-audit.mjs — the one holdout env var outside this
// repo's own "all env var reads live in config.mjs" convention (AGENTS.md).
export const auditRuntimeConfig = Object.freeze({
  // Below 1 would deadlock the map-phase's slot-acquire loop; above 20 has
  // no precedent in this codebase's existing usage and risks provider
  // rate-limit storms.
  mapReduceConcurrency: clampConfigNumber(process.env.MAP_REDUCE_CONCURRENCY, {
    fallback: 5, min: 1, max: 20, parser: Number.parseInt, envVar: 'MAP_REDUCE_CONCURRENCY',
  }),
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
    // `(env.X || '').trim() || default` — NOT `(env.X || default).trim()`: the
    // latter mapped a whitespace-only value to '' (an empty deployment name → 400),
    // a third broken outcome distinct from absent/empty (audit M6). Now absent,
    // empty, and whitespace-only ALL collapse to the one default path, so the
    // check-setup predicate and runtime agree. Default kept (resilience over
    // fail-loud — the doctor handles a wrong/undeployed default by probing).
    embedDeployment: (env.AZURE_OPENAI_EMBED_DEPLOYMENT || '').trim() || 'text-embedding-3-small',
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
