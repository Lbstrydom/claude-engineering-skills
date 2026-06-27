/**
 * @fileoverview Audit-runs + findings + pass-stats + adjudication domain.
 *
 * Part of the postgres-parity M3 split. The hottest part of the audit-loop
 * persistence surface — every audit run lands here, every finding is
 * recorded here, and every adjudication event mutates here.
 *
 * Functions by domain:
 *   audit_runs:      recordRunStart, recordRunComplete, updateRunMeta,
 *                    getAuditRunConvergence, getRunMeta (dashboard read)
 *   audit_findings:  recordFindings, getRunFindingOutcomeCounts,
 *                    getRunFindings (dashboard read)
 *                    (+ _resetClassificationColumnCache test seam)
 *   audit_pass_stats: recordPassStats, updatePassStatsPostDeliberation,
 *                    getPassTimings
 *   suppression_events: recordSuppressionEvents
 *   finding_adjudication_events: recordAdjudicationEvent
 *
 * The dashboard read queries (getRunFindings / getRunMeta) power the read-only
 * audit-run findings viewer (docs/plans/dashboard-audit-run-viewer.md).
 *
 * @module scripts/lib/store/runs-findings
 */

import { many, one, insertReturning, updateWhere, deleteWhere, withTx } from '../db/query.mjs';
import { getPool } from '../db/client.mjs';
import { isCloudEnabled, getRepoIdByName } from './repo.mjs';

/**
 * True only for PostgreSQL `undefined_column` (SQLSTATE 42703) — the one error
 * that genuinely means "this column is absent" (an un-migrated store). Every
 * other failure (connection refused, permission, pool exhaustion, statement
 * timeout) is transient/unexpected and must NOT be cached as "column missing":
 * a migration capability probe has to distinguish a real schema gap from a DB
 * blip, or one transient error poisons the columnless fallback for the whole
 * process (M3/M5).
 */
function isUndefinedColumnError(err) {
  // 42703 undefined_column AND 42P01 undefined_table both mean the probed
  // column is definitively unavailable (a missing table can't have the column)
  // — either is an authoritative "absent", distinct from a transient blip.
  return !!err && (
    err.code === '42703' || err.code === '42P01'
    || /column .* does not exist|relation .* does not exist/i.test(err.message || '')
  );
}

// Cached classification-column probe (column shape doesn't change mid-run).
let _hasClassificationColumns = null;

/** Test-only reset for the probe cache (mirrors legacy export). */
export function _resetClassificationColumnCache() {
  _hasClassificationColumns = null;
}

/**
 * Run a 0-row column probe with ONE retry on a transient error. Returns
 * `{ present, definitive }`: `definitive` is true only when the result is
 * authoritative — the column was confirmed present (probe succeeded) OR a
 * `42703` confirmed it absent. A transient/unexpected failure (after the
 * retry) yields `{ present:false, definitive:false }`, so the caller falls
 * back columnless for THIS call WITHOUT caching the negative — one DB blip can
 * never poison the cached column state for the process, and the retry absorbs
 * most blips before they degrade a single write (M3/M5/M6).
 */
async function probeColumn(sql) {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      await many(sql);
      return { present: true, definitive: true };
    } catch (err) {
      if (isUndefinedColumnError(err)) return { present: false, definitive: true };
      if (attempt === 0) continue; // transient — retry once before degrading
      process.stderr.write(`  [learning] column probe failed transiently (${err.code || err.message}); columnless for this call\n`);
      return { present: false, definitive: false };
    }
  }
  return { present: false, definitive: false };
}

async function detectClassificationColumns() {
  if (_hasClassificationColumns !== null) return _hasClassificationColumns;
  if (!await isCloudEnabled()) {
    _hasClassificationColumns = false;
    return false;
  }
  const { present, definitive } = await probeColumn(`SELECT sonar_type FROM audit_findings LIMIT 0`);
  if (definitive) {
    _hasClassificationColumns = present; // cache only an authoritative result
    if (!present) process.stderr.write('  [learning] classification columns not present — run migration to enable\n');
  }
  return present;
}

// Cached probe for the run-unification `audit_pass_stats.round` column
// (migration 20260605120000). Mirrors the classification probe so the round
// code degrades to the columnless path on an un-migrated store (WS1 §1.3a —
// defense-in-depth: the shared store has it applied, but air-gapped / fresh
// self-hosted stores may not).
let _hasPassStatsRoundColumn = null;

/** Test-only reset for the round-column probe cache. */
export function _resetPassStatsRoundColumnCache() {
  _hasPassStatsRoundColumn = null;
}

async function detectPassStatsRoundColumn() {
  if (_hasPassStatsRoundColumn !== null) return _hasPassStatsRoundColumn;
  if (!await isCloudEnabled()) {
    _hasPassStatsRoundColumn = false;
    return false;
  }
  const { present, definitive } = await probeColumn(`SELECT round FROM audit_pass_stats LIMIT 0`);
  if (definitive) {
    _hasPassStatsRoundColumn = present; // cache only an authoritative result
    if (!present) process.stderr.write('  [learning] audit_pass_stats.round not present — run migration 20260605120000 for per-round pass telemetry\n');
  }
  return present;
}

// ── audit_runs ─────────────────────────────────────────────────────────────

/**
 * Insert a new audit_runs row. Returns the new run's id, or null when
 * cloud is disabled / the insert fails.
 */
export async function recordRunStart(repoId, planFile, mode, { scopeMode, commitSha, branch, planId, runId } = {}) {
  if (!await isCloudEnabled()) return null;
  // Run-unification (WS1 §1.2/§1.3b): when the orchestrator threads an explicit
  // `runId`, REUSE the existing audit_runs row so all rounds of one audit share
  // a single run_id. Idempotent — a second call with the same runId returns it
  // without inserting a duplicate or clobbering round-1 metadata. When `runId`
  // is absent (manual single-shot /audit-code) behaviour is byte-identical to
  // before (mint a fresh row).
  if (runId) {
    try {
      const existing = await one(`SELECT id, repo_id FROM audit_runs WHERE id = $1`, [runId]);
      if (existing?.id) {
        // Repo-scoped reuse (Gemini H2): the store is single-TENANT but
        // multi-REPO — many consumer repos share it. A run_id must belong to
        // THIS audit's repo; reusing a row whose repo_id differs would attach
        // these findings to another repo's run. A randomUUID run_id never
        // legitimately collides across repos, so a mismatch means a
        // mis-threaded id — refuse to reuse (return null → the audit proceeds
        // cloud-degraded rather than corrupting another repo's run).
        if (existing.repo_id && repoId && existing.repo_id !== repoId) {
          process.stderr.write(`  [learning] recordRunStart: run_id ${runId} belongs to a different repo — refusing reuse\n`);
          return null;
        }
        return existing.id; // reuse — do not re-insert
      }
    } catch (err) {
      process.stderr.write(`  [learning] recordRunStart reuse-probe failed: ${err.message}\n`);
      // fall through to insert with the explicit id
    }
  }
  const row = {
    ...(runId ? { id: runId } : {}),
    repo_id: repoId,
    plan_file: planFile,
    mode,
    rounds: 0,
    total_findings: 0,
    accepted_count: 0,
    dismissed_count: 0,
    fixed_count: 0,
    ...(scopeMode ? { scope_mode: scopeMode } : {}),
    ...(commitSha ? { commit_sha: commitSha } : {}),
    ...(branch ? { branch } : {}),
    ...(planId ? { plan_id: planId } : {}),
  };
  try {
    const out = await insertReturning('audit_runs', row, { returning: ['id'] });
    return out?.id ?? null;
  } catch (err) {
    // Race-safe idempotency (WS1 §1.3b R1-H2): the SELECT-then-INSERT reuse
    // probe above has a TOCTOU window — two concurrent recordRunStart calls
    // with the same explicit runId can both miss the SELECT and race the
    // INSERT. The loser hits a PK unique-violation (SQLSTATE 23505); reuse the
    // existing row instead of failing, so reuse never creates a second row and
    // never returns null for a run that actually exists.
    if (runId && err?.code === '23505') {
      const existing = await one(`SELECT id, repo_id FROM audit_runs WHERE id = $1`, [runId]).catch(() => null);
      // Same repo-scoped guard as the primary reuse path (Gemini R2): never
      // reuse a row that raced in for a DIFFERENT repo — that would attach this
      // audit's findings to another repo's run.
      if (existing?.id && (!existing.repo_id || !repoId || existing.repo_id === repoId)) {
        return existing.id;
      }
    }
    process.stderr.write(`  [learning] recordRunStart failed: ${err.message}\n`);
    return null;
  }
}

/**
 * Update a completed run with final stats + cost / cache telemetry.
 * Best-effort.
 */
export async function recordRunComplete(runId, stats) {
  if (!runId || !await isCloudEnabled()) return;
  const update = {
    rounds: stats.rounds,
    total_findings: stats.totalFindings,
    accepted_count: stats.accepted,
    dismissed_count: stats.dismissed,
    fixed_count: stats.fixed,
    gemini_verdict: stats.geminiVerdict,
    total_cost_estimate: stats.costEstimate,
    total_duration_ms: stats.durationMs,
  };
  if (stats.diffLinesChanged != null) update.diff_lines_changed = stats.diffLinesChanged;
  if (stats.diffFilesChanged != null) update.diff_files_changed = stats.diffFilesChanged;
  if (stats.sessionCacheHit != null) update.session_cache_hit = stats.sessionCacheHit;
  if (stats.mapReducePasses != null) update.map_reduce_passes = stats.mapReducePasses;
  if (stats.r2SkipReason != null) update.r2_skip_reason = stats.r2SkipReason;
  if (stats.cacheInputTokens != null) update.cache_input_tokens = stats.cacheInputTokens;
  if (stats.cacheCachedTokens != null) update.cache_cached_tokens = stats.cacheCachedTokens;
  if (stats.cacheHitRate != null) update.cache_hit_rate = stats.cacheHitRate;
  if (stats.cacheEstimatedSavingsPct != null) update.cache_estimated_savings_pct = stats.cacheEstimatedSavingsPct;
  // cache_seed_enabled is a later-migration column — probe-guard it so a
  // pre-migration store skips ONLY this field instead of failing the whole
  // run-completion update (R1-H2: ADD COLUMN IF NOT EXISTS protects the
  // migration, not this UPDATE).
  if (stats.cacheSeedEnabled != null
      && await columnExists('audit_runs', 'cache_seed_enabled', many, isCloudEnabled)) {
    update.cache_seed_enabled = stats.cacheSeedEnabled;
  }
  try {
    await updateWhere('audit_runs', update, { id: runId });
  } catch (err) {
    process.stderr.write(`  [learning] recordRunComplete failed: ${err.message}\n`);
  }
}

/**
 * Non-destructive partial update of run metadata (only the supplied
 * fields are written). Best-effort.
 */
export async function updateRunMeta(runId, meta) {
  if (!runId) return;
  const update = {};
  if (meta.r2SkipReason != null)   update.r2_skip_reason   = meta.r2SkipReason;
  if (meta.geminiVerdict != null)  update.gemini_verdict   = meta.geminiVerdict;
  if (meta.labeled != null)        update.labeled          = meta.labeled;
  if (meta.acceptedCount != null)  update.accepted_count   = meta.acceptedCount;
  if (meta.dismissedCount != null) update.dismissed_count  = meta.dismissedCount;
  // Final-review model attribution + shadow cost telemetry (migration
  // 20260610120000). columnExists-guarded so the write degrades cleanly on an
  // un-migrated store (omit the absent column rather than fail the UPDATE).
  if (meta.finalReviewModel != null
      && await columnExists('audit_runs', 'final_review_model', many, isCloudEnabled)) {
    update.final_review_model = meta.finalReviewModel;
  }
  if (meta.finalReviewShadowModel != null
      && await columnExists('audit_runs', 'final_review_shadow_model', many, isCloudEnabled)) {
    update.final_review_shadow_model = meta.finalReviewShadowModel;
  }
  if (meta.finalReviewShadowInputTokens != null
      && await columnExists('audit_runs', 'final_review_shadow_input_tokens', many, isCloudEnabled)) {
    update.final_review_shadow_input_tokens = meta.finalReviewShadowInputTokens;
  }
  if (meta.finalReviewShadowOutputTokens != null
      && await columnExists('audit_runs', 'final_review_shadow_output_tokens', many, isCloudEnabled)) {
    update.final_review_shadow_output_tokens = meta.finalReviewShadowOutputTokens;
  }
  if (meta.finalReviewShadowLatencyMs != null
      && await columnExists('audit_runs', 'final_review_shadow_latency_ms', many, isCloudEnabled)) {
    update.final_review_shadow_latency_ms = meta.finalReviewShadowLatencyMs;
  }
  if (Object.keys(update).length === 0) return;
  if (!await isCloudEnabled()) return;
  try {
    await updateWhere('audit_runs', update, { id: runId });
  } catch (err) {
    process.stderr.write(`  [learning] updateRunMeta failed: ${err.message}\n`);
  }
}

// ── audit_findings ─────────────────────────────────────────────────────────

/** The closed domain of the final-review diff bucket (app-layer enforced). */
const VALID_BUCKETS = new Set(['both', 'primary-only', 'shadow-only']);

/** Coerce a bucket value to the valid domain or null (logs unexpected values). */
function normaliseBucket(b) {
  if (b == null) return null;
  if (VALID_BUCKETS.has(b)) return b;
  process.stderr.write(`  [learning] unexpected bucket value '${b}' coerced to null\n`);
  return null;
}

/**
 * Insert a batch of findings rows. Optionally includes the Phase B
 * classification columns when the schema supports them.
 *
 * @param {string} runId
 * @param {object[]} findings
 * @param {string} passName  Role: 'structure'|'wiring'|…|'final-review'|'final-review-shadow'.
 * @param {number} round
 * @param {{client?: import('pg').PoolClient}} [opts]  When `client` is supplied
 *   the multi-row INSERT runs on that pg client (e.g. inside a `withTx`
 *   transaction) instead of grabbing its own pool connection. This lets a
 *   caller make a delete+insert atomic (final-review replace-persistence). The
 *   default `{}` preserves every existing call site byte-for-byte.
 */
export async function recordFindings(runId, findings, passName, round, opts = {}) {
  if (!runId || !await isCloudEnabled()) return;
  const hasClassification = await detectClassificationColumns();
  // Final-review attribution columns (migration 20260610120000) — written
  // only when present so the path degrades cleanly on an un-migrated store.
  const hasSourceModel = await columnExists('audit_findings', 'source_model', many, isCloudEnabled);
  const hasBucket = await columnExists('audit_findings', 'bucket', many, isCloudEnabled);
  const rows = findings.map((f) => {
    const base = {
      run_id: runId,
      finding_fingerprint: f._hash || 'unknown',
      pass_name: passName,
      severity: f.severity,
      category: f.category,
      primary_file: f._primaryFile || f.section,
      detail_snapshot: f.detail?.slice(0, 600),
      round_raised: round,
    };
    if (hasClassification) {
      base.sonar_type = f.classification?.sonarType ?? null;
      base.effort = f.classification?.effort ?? null;
      base.source_kind = f.classification?.sourceKind ?? null;
      base.source_name = f.classification?.sourceName ?? null;
    }
    // f._sourceModel / f._bucket are stamped by the final-review diff; absent
    // (null) for normal audit-pass findings, which is the correct value.
    if (hasSourceModel) base.source_model = f._sourceModel ?? null;
    // App-layer validation of the bucket domain (plan R3 M5 / cluster-A M5,M7,M10:
    // the migration deliberately has no DB CHECK — Postgres lacks idempotent
    // ADD CONSTRAINT — so the write boundary enforces the literal domain here).
    // An unexpected value is coerced to null + logged rather than silently
    // persisting drift.
    if (hasBucket) base.bucket = normaliseBucket(f._bucket);
    return base;
  });
  if (rows.length === 0) return;
  // Bulk INSERT — homogeneous rows by construction. Use the caller's tx client
  // when provided (atomic delete+insert); otherwise grab a pool connection.
  try {
    const exec = opts.client ?? await getPool();
    if (!exec) return;
    const cols = Object.keys(rows[0]);
    const params = [];
    const valueGroups = rows.map((row) => {
      const placeholders = cols.map((c) => {
        params.push(row[c]);
        return `$${params.length}`;
      });
      return `(${placeholders.join(', ')})`;
    });
    const sql = `INSERT INTO audit_findings (${cols.map((c) => `"${c}"`).join(', ')})
                 VALUES ${valueGroups.join(', ')}`;
    await exec.query(sql, params);
  } catch (err) {
    process.stderr.write(`  [learning] recordFindings failed: ${err.message}\n`);
  }
}

/**
 * Idempotent replace-persistence for the final review's findings (plan
 * docs/completed/final-review-shadow-reviewer.md). A retry or manual rerun with
 * the same runId must NOT double-count, so this DELETEs the prior final-review
 * rows for the run and re-INSERTs — all inside ONE transaction so the
 * delete+insert is atomic (Gemini G1: recordFindings alone would grab its own
 * pool connection).
 *
 * Primary/shadow decoupling (Gemini G2): the CALLER decides what to pass —
 * `primary` is populated whenever the primary review ran; `shadow` is `[]`
 * (and `models.shadow*` null) unless the shadow actually ran. A skipped/failed
 * shadow therefore clears any stale shadow rows and leaves primary intact.
 *
 * @param {string} runId
 * @param {{
 *   primary?: object[],   // primary reviewer findings, each stamped _sourceModel/_bucket
 *   shadow?: object[],    // shadow reviewer findings (empty unless shadow ran)
 *   models?: {
 *     primaryModel?: string, shadowModel?: string|null,
 *     shadowInputTokens?: number|null, shadowOutputTokens?: number|null,
 *     shadowLatencyMs?: number|null,
 *   },
 * }} payload
 */
export async function recordFinalReviewFindings(runId, { primary = [], shadow = [], models = {} } = {}) {
  if (!runId || !await isCloudEnabled()) return;
  // (a) Run metadata — overwrite-idempotent, so it's fine outside the findings
  // tx. Null shadow fields are simply not written (updateRunMeta guards on
  // `!= null`), which is correct when the shadow didn't run.
  await updateRunMeta(runId, {
    finalReviewModel: models.primaryModel,
    finalReviewShadowModel: models.shadowModel,
    finalReviewShadowInputTokens: models.shadowInputTokens,
    finalReviewShadowOutputTokens: models.shadowOutputTokens,
    finalReviewShadowLatencyMs: models.shadowLatencyMs,
  });
  // (b) Replace the findings atomically.
  try {
    await withTx(async (client) => {
      // Scoped to final-review pass_names so the GPT audit's own rows are
      // untouched. Raw parameterized DELETE on the tx client (no dependency on
      // buildDelete IN-clause support).
      await client.query(
        `DELETE FROM audit_findings WHERE run_id = $1 AND pass_name IN ('final-review', 'final-review-shadow')`,
        [runId]
      );
      await recordFindings(runId, primary, 'final-review', 0, { client });
      if (shadow.length > 0) {
        await recordFindings(runId, shadow, 'final-review-shadow', 0, { client });
      }
    });
  } catch (err) {
    process.stderr.write(`  [learning] recordFinalReviewFindings failed: ${err.message}\n`);
  }
}

/**
 * Human-adjudication writeback for a shadow-only final-review finding (plan
 * D6). Sets `audit_findings.user_action`, mapping the user-facing verb to the
 * existing CHECK enum (20260508120000): accepted → 'accepted-permanent',
 * dismissed → 'dismissed'. Scoped to the shadow-only bucket so the fingerprint
 * disambiguates (R2 M2); returns the affected row count so the CLI can report
 * a multi-match.
 *
 * @param {string} runId
 * @param {string} fingerprint  finding_fingerprint of the shadow-only finding
 * @param {'accepted'|'dismissed'} action
 * @returns {Promise<{ok: boolean, updated: number, cloud: boolean}>}
 */
export async function adjudicateFinalReviewFinding(runId, fingerprint, action) {
  if (!await isCloudEnabled()) return { ok: false, updated: 0, cloud: false };
  const userAction = action === 'accepted' ? 'accepted-permanent'
    : action === 'dismissed' ? 'dismissed'
    : null;
  if (!userAction) throw new Error(`adjudicateFinalReviewFinding: action must be 'accepted' or 'dismissed', got '${action}'`);
  if (!await columnExists('audit_findings', 'bucket', many, isCloudEnabled)) {
    process.stderr.write('  [learning] adjudicate: bucket column absent — run migration 20260610120000\n');
    return { ok: false, updated: 0, cloud: true };
  }
  try {
    const res = await updateWhere(
      'audit_findings',
      { user_action: userAction },
      { run_id: runId, finding_fingerprint: fingerprint, bucket: 'shadow-only' }
    );
    return { ok: true, updated: res.rowCount ?? 0, cloud: true };
  } catch (err) {
    process.stderr.write(`  [learning] adjudicateFinalReviewFinding failed: ${err.message}\n`);
    return { ok: false, updated: 0, cloud: true };
  }
}

/**
 * Existence probe for one audit_runs row. Used by the deterministic
 * `finalize-outcomes` step (WS1 §1.3b R2-H2) to distinguish "cloud off"
 * (graceful no-op) from "cloud on but the run_id genuinely does not exist"
 * (a hard error — the orchestrator threaded a bad id).
 * @param {string} runId
 * @returns {Promise<boolean>}
 */
export async function auditRunExists(runId) {
  if (!runId || !await isCloudEnabled()) return false;
  try {
    const row = await one(`SELECT id FROM audit_runs WHERE id = $1`, [runId]);
    return !!row?.id;
  } catch {
    return false;
  }
}

/**
 * Reconciliation writeback (WS1 §1.3b R2-H3): flag findings the final ledger
 * never adjudicated as `needs_triage` rather than leaving them silently
 * `pending`/null, so a truncated ledger can't dark-drop a finding. Idempotent
 * and NON-destructive — only rows with no terminal `adjudication_outcome` and
 * no existing user_action (or already `needs_triage`) are touched, so a real
 * accepted/dismissed outcome is never clobbered on a re-run.
 * @param {string} runId
 * @param {string[]} fingerprints  finding_fingerprint values the ledger omitted
 * @returns {Promise<{updated: number}>}
 */
export async function markRunFindingsNeedsTriage(runId, fingerprints) {
  if (!runId || !await isCloudEnabled()
      || !Array.isArray(fingerprints) || fingerprints.length === 0) {
    return { updated: 0 };
  }
  try {
    const rows = await many(
      `UPDATE audit_findings
          SET user_action = 'needs_triage'
        WHERE run_id = $1
          AND finding_fingerprint = ANY($2::text[])
          AND adjudication_outcome IS NULL
          AND (user_action IS NULL OR user_action = 'needs_triage')
        RETURNING id`,
      [runId, fingerprints],
    );
    return { updated: Array.isArray(rows) ? rows.length : 0 };
  } catch (err) {
    process.stderr.write(`  [learning] markRunFindingsNeedsTriage failed: ${err.message}\n`);
    return { updated: 0 };
  }
}

/**
 * Read the shadow-A/B measurement surface for a repo by name (plan §6). Queries
 * BASE TABLES directly (no view — avoids the view/RLS-bypass question, R1 H5).
 * Returns {ok, cloud, repoId, buckets, shadowOnlyQueue, runs} where:
 *   - buckets: per (source_model, bucket, severity) DISTINCT-fingerprint counts
 *     (COUNT DISTINCT — R3 M2 dedup at the query layer too).
 *   - shadowOnlyQueue: the human spot-check list — shadow-only findings with
 *     their adjudication state (user_action), newest first.
 *   - runs: per (final_review_model, final_review_shadow_model) run count +
 *     aggregate shadow token/latency cost (the operator's cost overlay).
 *
 * @param {string} repoName
 * @param {{queueLimit?: number}} [opts]
 */
export async function getFinalReviewStats(repoName, { queueLimit = 50 } = {}) {
  if (!await isCloudEnabled()) return { ok: true, cloud: false, repoId: null, buckets: [], shadowOnlyQueue: [], runs: [] };
  const repoRow = await one(`SELECT id FROM audit_repos WHERE name = $1 ORDER BY created_at DESC LIMIT 1`, [repoName]);
  const repoId = repoRow?.id || null;
  if (!repoId) return { ok: true, cloud: true, repoId: null, buckets: [], shadowOnlyQueue: [], runs: [] };
  // Guard: bail cleanly on an un-migrated store (no source_model column).
  if (!await columnExists('audit_findings', 'source_model', many, isCloudEnabled)) {
    process.stderr.write('  [final-review-stats] source_model column absent — run migration 20260610120000\n');
    return { ok: false, cloud: true, repoId, buckets: [], shadowOnlyQueue: [], runs: [], error: 'NOT_MIGRATED' };
  }
  try {
    const buckets = await many(
      `SELECT f.source_model, f.bucket, f.severity,
              COUNT(DISTINCT f.finding_fingerprint) AS n
         FROM audit_findings f
         JOIN audit_runs r ON r.id = f.run_id
        WHERE r.repo_id = $1
          AND f.pass_name IN ('final-review', 'final-review-shadow')
        GROUP BY f.source_model, f.bucket, f.severity
        ORDER BY f.source_model, f.bucket, f.severity`,
      [repoId]
    );
    const shadowOnlyQueue = await many(
      `SELECT f.run_id, f.finding_fingerprint, f.severity, f.category,
              f.primary_file, f.detail_snapshot, f.source_model, f.user_action, f.created_at
         FROM audit_findings f
         JOIN audit_runs r ON r.id = f.run_id
        WHERE r.repo_id = $1 AND f.bucket = 'shadow-only'
        ORDER BY f.created_at DESC
        LIMIT $2`,
      [repoId, queueLimit]
    );
    const runs = await many(
      `SELECT r.final_review_model, r.final_review_shadow_model,
              COUNT(*) AS n,
              COALESCE(SUM(r.final_review_shadow_input_tokens), 0)  AS shadow_input_tokens,
              COALESCE(SUM(r.final_review_shadow_output_tokens), 0) AS shadow_output_tokens,
              COALESCE(SUM(r.final_review_shadow_latency_ms), 0)    AS shadow_latency_ms
         FROM audit_runs r
        WHERE r.repo_id = $1 AND r.final_review_model IS NOT NULL
        GROUP BY r.final_review_model, r.final_review_shadow_model
        ORDER BY n DESC`,
      [repoId]
    );
    return { ok: true, cloud: true, repoId, buckets, shadowOnlyQueue, runs };
  } catch (err) {
    process.stderr.write(`  [final-review-stats] query failed: ${err.message}\n`);
    return { ok: false, cloud: true, repoId, buckets: [], shadowOnlyQueue: [], runs: [], error: err.message };
  }
}

// ── audit_pass_stats ───────────────────────────────────────────────────────

/**
 * Insert a pass-level stats row.
 *
 * @param {number} [round] 1-based audit round. Written only when the `round`
 *   column exists (migration 20260605120000); on an un-migrated store it is
 *   omitted and the row defaults to round 1 server-side — preserving today's
 *   behaviour (WS1 §1.3a).
 */
export async function recordPassStats(runId, passName, stats, round) {
  if (!runId || !await isCloudEnabled()) return;
  const hasRound = await detectPassStatsRoundColumn();
  try {
    await insertReturning('audit_pass_stats', {
      run_id: runId,
      pass_name: passName,
      findings_raised: stats.raised || 0,
      findings_accepted: stats.accepted || 0,
      findings_dismissed: stats.dismissed || 0,
      findings_compromised: stats.compromised || 0,
      input_tokens: stats.inputTokens,
      output_tokens: stats.outputTokens,
      latency_ms: stats.latencyMs,
      reasoning_effort: stats.reasoning,
      prompt_variant_id: stats.promptVariantId,
      ...(hasRound && Number.isInteger(round) ? { round } : {}),
    });
  } catch (err) {
    process.stderr.write(`  [learning] recordPassStats failed: ${err.message}\n`);
  }
}

/**
 * After deliberation, update findings_accepted / findings_dismissed /
 * findings_compromised on each pass's stats row. Called by outcome-sync.
 */
export async function updatePassStatsPostDeliberation(runId, passCounts) {
  if (!runId || !await isCloudEnabled()) return;
  // Post-deliberation counts are run-FINAL (canonical adjudication truth lives in
  // audit_findings.adjudication_outcome; these are denormalized telemetry). Under
  // run-unification one run_id spans many per-round pass_stats rows, so matching
  // on (run_id, pass_name) alone overwrites EVERY round's row. Scope to the LATEST
  // round's row per pass so the final counts land unambiguously on the
  // convergence-round row (WS1 §1.3a / Gemini-R2-H1). On an un-migrated store
  // (no `round` column) fall back to the original match — today's behaviour.
  const hasRound = await detectPassStatsRoundColumn();
  for (const [passName, counts] of Object.entries(passCounts)) {
    try {
      const patch = {
        findings_accepted: counts.accepted,
        findings_dismissed: counts.dismissed,
        findings_compromised: counts.compromised || 0,
      };
      if (hasRound) {
        const maxRow = await one(
          `SELECT max(round) AS r FROM audit_pass_stats WHERE run_id = $1 AND pass_name = $2`,
          [runId, passName]
        );
        if (maxRow?.r == null) continue; // no row for this pass under the run
        await updateWhere('audit_pass_stats', patch, { run_id: runId, pass_name: passName, round: maxRow.r });
      } else {
        await updateWhere('audit_pass_stats', patch, { run_id: runId, pass_name: passName });
      }
    } catch (err) {
      process.stderr.write(`  [learning] updatePassStats(${passName}) failed: ${err.message}\n`);
    }
  }
}

/**
 * Read convergence/stop-round signals for one audit_runs row. Powers the
 * convergence_predict outcome detector in
 * scripts/learning/backfill-outcomes.mjs, which previously reached for a
 * raw supabase client (M3 P3 raw-client removal).
 *
 * @param {string} runId
 * @returns {Promise<{roundConvergedAfter: number|null, rigorPressureRound: number|null, rounds: number|null}|null>}
 */
/**
 * Per-run finding-outcome counts, used by the `pass_selection` resolver
 * (Cluster B / Phase 4). `acceptedOrFixed` counts findings the deliberation
 * sustained; `anyAdjudicated` tells the resolver whether outcome-sync has run
 * yet (if not, the decision stays pending rather than resolving to a false 0).
 *
 * @param {string} runId
 * @returns {Promise<{total:number, acceptedOrFixed:number, anyAdjudicated:boolean}|null>}
 */
export async function getRunFindingOutcomeCounts(runId) {
  if (!runId || !await isCloudEnabled()) return null;
  try {
    const row = await one(
      `SELECT count(*)::int AS total,
              count(*) FILTER (WHERE adjudication_outcome = 'accepted')::int AS accepted_or_fixed,
              count(*) FILTER (WHERE adjudication_outcome IS NOT NULL)::int AS adjudicated
         FROM audit_findings WHERE run_id = $1`,
      [runId],
    );
    if (!row) return null;
    return {
      total: Number(row.total),
      acceptedOrFixed: Number(row.accepted_or_fixed),
      anyAdjudicated: Number(row.adjudicated) > 0,
    };
  } catch {
    return null;
  }
}

export async function getAuditRunConvergence(runId) {
  if (!runId || !await isCloudEnabled()) return null;
  try {
    const row = await one(
      `SELECT round_converged_after, rigor_pressure_round, rounds
         FROM audit_runs WHERE id = $1 LIMIT 1`,
      [runId]
    );
    if (!row) return null;
    return {
      roundConvergedAfter: row.round_converged_after,
      rigorPressureRound:  row.rigor_pressure_round,
      rounds:              row.rounds,
    };
  } catch {
    return null;
  }
}

/**
 * Aggregate average pass timing/token data across all rows where
 * input_tokens > 0. In-memory aggregation matches the legacy approach.
 */
export async function getPassTimings() {
  if (!await isCloudEnabled()) return [];
  try {
    const rows = await many(
      `SELECT pass_name, input_tokens, output_tokens, latency_ms
         FROM audit_pass_stats
        WHERE input_tokens > 0`
    );
    const byPass = {};
    for (const row of rows) {
      if (!byPass[row.pass_name]) byPass[row.pass_name] = { totalIn: 0, totalOut: 0, totalLat: 0, count: 0 };
      const p = byPass[row.pass_name];
      p.totalIn += row.input_tokens || 0;
      p.totalOut += row.output_tokens || 0;
      p.totalLat += row.latency_ms || 0;
      p.count++;
    }
    return Object.entries(byPass).map(([passName, p]) => ({
      passName,
      avgInputTokens: Math.round(p.totalIn / p.count),
      avgOutputTokens: Math.round(p.totalOut / p.count),
      avgLatencyMs: Math.round(p.totalLat / p.count),
      runCount: p.count,
    }));
  } catch (err) {
    process.stderr.write(`  [learning] getPassTimings failed: ${err.message}\n`);
    return [];
  }
}

// ── audit-run read queries (dashboard findings viewer, plan §7.0) ───────────

// Generic cached optional-column probe for the read path. The two existing
// probes above (detectClassificationColumns / detectPassStatsRoundColumn) are
// column-specific booleans; the dashboard read-query needs to probe a DIFFERENT
// set of later-migration columns (adjudication_outcome / remediation_state on
// audit_findings; round_converged_after / commit_sha / branch / plan_id on
// audit_runs). This follows the SAME cached `SELECT col … LIMIT 0` pattern,
// generalised so an un-migrated store still returns rows (just without the
// optional columns). Keyed `<table>.<col>`.
const _runReadColumnCache = new Map();

/** Test-only reset for the read-path column probe cache. */
export function _resetRunReadColumnCache() {
  _runReadColumnCache.clear();
}

/**
 * @param {string} table  hardcoded table literal (never user input)
 * @param {string} col    hardcoded column literal (never user input)
 * @param {(sql:string, params?:unknown[]) => Promise<unknown[]>} manyFn
 * @param {() => Promise<boolean>} cloudFn
 * @returns {Promise<boolean>}
 */
async function columnExists(table, col, manyFn, cloudFn) {
  const key = `${table}.${col}`;
  if (_runReadColumnCache.has(key)) return _runReadColumnCache.get(key);
  if (!await cloudFn()) {
    _runReadColumnCache.set(key, false);
    return false;
  }
  try {
    await manyFn(`SELECT "${col}" FROM ${table} LIMIT 0`);
    _runReadColumnCache.set(key, true);
    return true;
  } catch (err) {
    // Only a genuine "absent" signal — undefined_column (42703) or
    // undefined_table (42P01) — is a STABLE capability fact worth caching.
    // A transient connectivity/auth/timeout error must NOT poison the cache:
    // caching `false` there would permanently omit a column that actually
    // exists, silently dropping adjudication/remediation data for the whole
    // process. On a transient error, omit the column for THIS call only and
    // leave the cache unset so the next call re-probes.
    if (err && (err.code === '42703' || err.code === '42P01')) {
      _runReadColumnCache.set(key, false);
    }
    return false;
  }
}

/**
 * Read all findings for one audit run as domain rows (plan §7.0). Pure
 * persistence + raw→domain mapping — NO presentation tokens (M7); the
 * presenter maps these to UI classes downstream.
 *
 * Returns:
 *   - `null` ONLY when cloud is disabled (`isCloudEnabled()` false).
 *   - `[]` when the run exists but has zero findings (a valid result, mapped
 *     differently from `null` by the collector — §5).
 *   - `AuditRunFinding[]` otherwise, in deterministic severity/round order.
 *
 * `deps` is an optional dependency-injection seam for unit tests (plan §9):
 * a fake `{ one, many, isCloudEnabled }` lets the store contract be asserted
 * without a live DB. Production callers omit it and get the real helpers.
 *
 * @param {string} runId
 * @param {{ one?: Function, many?: Function, isCloudEnabled?: Function }} [deps]
 * @returns {Promise<Array<object>|null>}
 */
export async function getRunFindings(runId, deps = {}) {
  const { many: manyFn = many, isCloudEnabled: cloudFn = isCloudEnabled } = deps;
  if (!runId) return null;
  if (!await cloudFn()) return null;

  const cols = [
    'id', 'finding_fingerprint', 'pass_name', 'severity', 'category',
    'primary_file', 'detail_snapshot', 'round_raised', 'created_at',
  ];
  if (await columnExists('audit_findings', 'adjudication_outcome', manyFn, cloudFn)) cols.push('adjudication_outcome');
  if (await columnExists('audit_findings', 'remediation_state', manyFn, cloudFn)) cols.push('remediation_state');

  const sql =
    `SELECT ${cols.map((c) => `"${c}"`).join(', ')}\n` +
    `  FROM audit_findings\n` +
    ` WHERE run_id = $1\n` +
    ` ORDER BY CASE severity WHEN 'HIGH' THEN 0 WHEN 'MEDIUM' THEN 1 ELSE 2 END,\n` +
    `          round_raised, pass_name, primary_file NULLS LAST, id`;

  const rows = await manyFn(sql, [runId]);
  return rows.map((r) => ({
    id: r.id,
    fingerprint: r.finding_fingerprint,
    pass: r.pass_name,
    severity: r.severity,
    category: r.category,
    file: r.primary_file ?? null,
    detail: r.detail_snapshot ?? '',
    round: r.round_raised,
    adjudication: r.adjudication_outcome ?? null,
    remediation: r.remediation_state ?? null,
  }));
}

/**
 * Recent findings for a repo across its audit runs — powers /persona-test
 * Phase 0d pre-test enrichment (replaces the dead PostgREST curl removed in
 * M4; the supabase-js/anon-read path no longer exists). Then joins
 * audit_findings → audit_runs for that repo.
 *
 * Pass a canonical `repoId` (audit_repos.id, resolved from the stable
 * repo_uuid) for an identity-correct lookup — this is the preferred path and
 * matches regardless of the bare-vs-owner/repo display name. `repoName` is a
 * fallback that resolves via the volatile `name` column (legacy / cross-repo
 * queries from a non-repo cwd).
 *
 * Returns `[]` when cloud is off, the repo is unknown, or there are no
 * findings — the persona skill treats an empty candidate set as "no audit
 * context", never an error. `deps` is the same DI seam as getRunFindings.
 *
 * @param {{ repoId?: string, repoName?: string, severities?: string[], limit?: number }} args
 * @param {{ many?: Function, isCloudEnabled?: Function, getRepoIdByName?: Function }} [deps]
 * @returns {Promise<Array<object>>}
 */
export async function getRecentFindingsByRepo(
  { repoId = null, repoName, severities = ['HIGH', 'MEDIUM'], limit = 20 } = {},
  deps = {},
) {
  const {
    many: manyFn = many,
    isCloudEnabled: cloudFn = isCloudEnabled,
    getRepoIdByName: repoIdFn = getRepoIdByName,
  } = deps;
  if (!await cloudFn()) return [];
  // Prefer the canonical repoId; fall back to name resolution only when absent.
  const id = repoId || (repoName ? await repoIdFn(repoName) : null);
  if (!id) return [];

  const sevs = (Array.isArray(severities) && severities.length > 0)
    ? severities : ['HIGH', 'MEDIUM'];
  const n = Math.max(1, Math.min(Number(limit) || 20, 100));

  const sql =
    `SELECT f.id, f.run_id, f.severity, f.category, f.primary_file,\n` +
    `       f.detail_snapshot, f.created_at\n` +
    `  FROM audit_findings f\n` +
    `  JOIN audit_runs r ON r.id = f.run_id\n` +
    ` WHERE r.repo_id = $1 AND f.severity = ANY($2)\n` +
    ` ORDER BY f.created_at DESC\n` +
    ` LIMIT $3`;

  const rows = await manyFn(sql, [id, sevs, n]);
  return rows.map((r) => ({
    id: r.id,
    runId: r.run_id,
    severity: r.severity,
    category: r.category,
    file: r.primary_file ?? null,
    detail: r.detail_snapshot ?? '',
    createdAt: r.created_at,
  }));
}

/**
 * Read one audit run's metadata as a domain row (plan §7.0). `null` when the
 * run is absent (collector → `run_not_found`) OR cloud is disabled (collector
 * distinguishes the two by checking `isCloudEnabled()` first — M1). Later-
 * migration columns are probe-guarded so an un-migrated store still returns a
 * row (just with those fields null).
 *
 * `round_converged_after` is frequently NULL even when the column exists (it is
 * resolved out-of-band by the learning pipeline), so the collector treats a
 * present-and-non-null value as authoritative and otherwise consults
 * `getAuditRunConvergence` for the §5 empty-state decision (G1).
 *
 * @param {string} runId
 * @param {{ one?: Function, many?: Function, isCloudEnabled?: Function }} [deps]
 * @returns {Promise<object|null>}
 */
export async function getRunMeta(runId, deps = {}) {
  const { one: oneFn = one, many: manyFn = many, isCloudEnabled: cloudFn = isCloudEnabled } = deps;
  if (!runId) return null;
  if (!await cloudFn()) return null;

  const cols = ['id', 'plan_file', 'mode', 'rounds', 'gemini_verdict', 'total_findings', 'created_at'];
  for (const c of ['round_converged_after', 'commit_sha', 'branch', 'plan_id']) {
    if (await columnExists('audit_runs', c, manyFn, cloudFn)) cols.push(c);
  }

  const sql = `SELECT ${cols.map((c) => `"${c}"`).join(', ')} FROM audit_runs WHERE id = $1`;
  const row = await oneFn(sql, [runId]);
  if (!row) return null;
  return {
    id: row.id,
    planFile: row.plan_file ?? null,
    mode: row.mode ?? null,
    rounds: row.rounds ?? null,
    geminiVerdict: row.gemini_verdict ?? null,
    totalFindings: row.total_findings ?? null,
    roundConvergedAfter: row.round_converged_after ?? null,
    commitSha: row.commit_sha ?? null,
    branch: row.branch ?? null,
    planId: row.plan_id ?? null,
    createdAt: row.created_at ?? null,
  };
}

// ── suppression_events ─────────────────────────────────────────────────────

/**
 * Record both suppressed-and-reopened events from an R2+ post-processing pass.
 */
export async function recordSuppressionEvents(runId, suppressionResult) {
  if (!runId || !await isCloudEnabled()) return;
  const rows = [
    ...suppressionResult.suppressed.map((s) => ({
      run_id: runId,
      finding_fingerprint: s.finding?._hash || 'unknown',
      matched_topic_id: s.matchedTopic,
      match_score: s.matchScore,
      action: 'suppressed',
      reason: s.reason,
    })),
    ...suppressionResult.reopened.map((f) => ({
      run_id: runId,
      finding_fingerprint: f._hash || 'unknown',
      matched_topic_id: f._matchedTopic,
      match_score: f._matchScore,
      action: 'reopened',
      reason: 'Scope changed',
    })),
  ];
  if (rows.length === 0) return;
  try {
    const pool = await getPool();
    if (!pool) return;
    const cols = Object.keys(rows[0]);
    const params = [];
    const valueGroups = rows.map((row) => {
      const placeholders = cols.map((c) => {
        params.push(row[c]);
        return `$${params.length}`;
      });
      return `(${placeholders.join(', ')})`;
    });
    const sql = `INSERT INTO suppression_events (${cols.map((c) => `"${c}"`).join(', ')})
                 VALUES ${valueGroups.join(', ')}`;
    await pool.query(sql, params);
  } catch (err) {
    process.stderr.write(`  [learning] recordSuppressionEvents failed: ${err.message}\n`);
  }
}

// ── finding_adjudication_events ────────────────────────────────────────────

/**
 * Record an adjudication event for a finding. Two-step:
 *   1. Resolve the audit_findings.id from the finding fingerprint
 *      (+ optional pass_name / round_raised disambiguation)
 *   2. Inside a transaction:
 *        - DELETE any prior adjudication events on this finding (idempotent re-record)
 *        - INSERT the new event
 *        - UPDATE audit_findings.adjudication_outcome (denormalised)
 */
export async function recordAdjudicationEvent(runId, findingFingerprint, event) {
  if (!runId || !await isCloudEnabled()) return;
  try {
    // Build the disambiguating WHERE clause for the finding lookup.
    const where = ['run_id = $1', 'finding_fingerprint = $2'];
    const params = [runId, findingFingerprint];
    if (event.passName) {
      where.push(`pass_name = $${params.length + 1}`);
      params.push(event.passName);
    }
    if (event.round) {
      where.push(`round_raised = $${params.length + 1}`);
      params.push(event.round);
    }
    const finding = await one(
      `SELECT id FROM audit_findings WHERE ${where.join(' AND ')} LIMIT 1`,
      params
    );
    if (!finding?.id) return;

    await withTx(async () => {
      await deleteWhere('finding_adjudication_events', { finding_id: finding.id });
      await insertReturning('finding_adjudication_events', {
        finding_id: finding.id,
        adjudication_outcome: event.adjudicationOutcome,
        remediation_state: event.remediationState,
        ruling: event.ruling,
        ruling_rationale: event.rulingRationale,
        round: event.round,
      });
      await updateWhere('audit_findings',
        { adjudication_outcome: event.adjudicationOutcome },
        { id: finding.id }
      );
    });
  } catch (err) {
    process.stderr.write(`  [learning] recordAdjudicationEvent failed: ${err.message}\n`);
  }
}
