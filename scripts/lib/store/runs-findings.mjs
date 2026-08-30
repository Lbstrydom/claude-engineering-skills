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

import { many, one, query, insertReturning, updateWhere, deleteWhere, withTx, pgArray } from '../db/query.mjs';
import { getPool } from '../db/client.mjs';
import { isCloudEnabled, getRepoIdByName } from './repo.mjs';
import crypto from 'node:crypto';
import { semanticSuppressConfig, symbolIndexConfig } from '../config.mjs';
import { partitionRecordTimeReRaises, toVectorLiteral } from '../semantic-suppression.mjs';
import { embedText } from '../embed-text.mjs';

/**
 * Prospective semantic re-raise suppression at the store-write boundary — the
 * promoted record-time hook (docs/research/pgvector-clustering-prototype.md).
 * Given the `merged` findings about to be recorded, drop the ones that are a
 * cosine re-raise of an existing OPEN finding in ANOTHER run of the same repo,
 * so the store never accumulates a reworded duplicate. Returns the findings to
 * record + the vectors to persist for the kept ones (future match targets).
 *
 * FAIL-OPEN end to end: disabled, cloud-off, no repo, or ANY error → returns
 * every finding unchanged. A suppressed finding loses only its learning-store
 * row, never its place in the audit's user-facing report (that is produced
 * elsewhere). So the worst a bug here can do is keep a duplicate row.
 */
async function applyRecordTimeSuppression(runId, findings, passName) {
  if (!semanticSuppressConfig.enabled || passName !== 'merged' || !Array.isArray(findings) || findings.length === 0) {
    return { kept: findings, vectorByFinding: null };
  }
  try {
    const pool = await getPool();
    if (!pool) return { kept: findings, vectorByFinding: null };
    const runRow = await one('SELECT repo_id FROM audit_runs WHERE id = $1', [runId]);
    const repoId = runRow?.repo_id;
    if (!repoId) return { kept: findings, vectorByFinding: null };
    const embed = async (text) => {
      const { result } = await embedText(text, { dim: symbolIndexConfig.embedDim, model: symbolIndexConfig.embedModel });
      return result;
    };
    const { kept, suppressed, vectorByFinding } = await partitionRecordTimeReRaises({
      pool, repoId, runId, findings, embed,
      threshold: semanticSuppressConfig.threshold,
      requireSameFile: semanticSuppressConfig.requireSameFile,
      log: (m) => process.stderr.write(m + '\n'),
    });
    if (suppressed.length) {
      process.stderr.write(`  [semantic-suppress] recorded ${kept.length}, suppressed ${suppressed.length} re-raise(s) of existing open findings\n`);
    }
    return { kept, vectorByFinding };
  } catch (err) {
    process.stderr.write(`  [semantic-suppress] disabled for this batch (keep-all): ${err.message?.slice(0, 100)}\n`);
    return { kept: findings, vectorByFinding: null };
  }
}

/**
 * Persist embeddings for just-recorded kept findings so they become future
 * match targets. Best-effort, keyed by fingerprint→id from the INSERT
 * RETURNING — a missing embedding only weakens future dedup, never breaks
 * recording. "Best-effort" no longer means "silent": every write is verified
 * via `rowCount` and every failure is logged + counted so the caller can
 * report it, matching the 0-row-update precedent already established in this
 * file (`markFindingsRemediation`) rather than trusting a resolved promise as
 * proof a row landed.
 *
 * Tenant/run scoping: `finding_embeddings` carries no repo_id of its own (see
 * supabase/migrations/20260721120000_finding_embeddings_prototype.sql) — the
 * write is scoped through the same unit every other write in this file trusts,
 * `run_id` (see `adjudicateFinalReviewFinding`, `markFindingsRemediation`), by
 * requiring the target finding_id to belong to THIS runId before the row is
 * written. A run belongs to exactly one repo (recordRunStart's repo-scoped
 * reuse guard), so this also closes the cross-repo case: a finding_id that
 * resolves to a different run — including one in a different repo — writes
 * zero rows instead of silently attaching an embedding to another tenant's
 * finding.
 *
 * Exported (undecorated, like `buildFindingAdjudicationPatch` /
 * `normalizeRemediationUpdates` below) so the write-verification and
 * run-scoping behaviour is directly unit-testable without a live DB.
 *
 * @returns {Promise<{persisted: number, failed: number}>}
 */
export async function persistKeptEmbeddings(exec, keptFindings, vectorByFinding, idByFingerprint, runId) {
  const result = { persisted: 0, failed: 0 };
  if (!vectorByFinding || vectorByFinding.size === 0) return result;
  for (const f of keptFindings) {
    const vec = vectorByFinding.get(f);
    if (!vec) continue;
    const id = idByFingerprint.get(fingerprintOf(f));
    if (!id) continue;
    try {
      const text = (typeof f.detail === 'string' ? f.detail : '').slice(0, 500);
      const hash = crypto.createHash('sha256').update(text).digest('hex').slice(0, 16);
      const res = await exec.query(
        `INSERT INTO finding_embeddings (finding_id, embedding, embedding_model, dimension, snapshot_hash)
         SELECT $1::uuid, $2::vector, $3, $4, $5
          WHERE EXISTS (SELECT 1 FROM audit_findings af WHERE af.id = $1::uuid AND af.run_id = $6::uuid)
         ON CONFLICT (finding_id) DO UPDATE SET embedding=EXCLUDED.embedding, embedding_model=EXCLUDED.embedding_model, dimension=EXCLUDED.dimension, snapshot_hash=EXCLUDED.snapshot_hash, created_at=now()`,
        [id, toVectorLiteral(vec), symbolIndexConfig.embedModel, symbolIndexConfig.embedDim, hash, runId]);
      if ((res?.rowCount ?? 0) === 0) {
        result.failed++;
        process.stderr.write(`  [semantic-suppress] embedding write affected 0 rows for finding ${id} (run ${runId}) — not persisted\n`);
        continue;
      }
      result.persisted++;
    } catch (err) {
      result.failed++;
      process.stderr.write(`  [semantic-suppress] embedding persistence failed for finding ${id}: ${err.message?.slice(0, 150)}\n`);
    }
  }
  return result;
}

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
export async function recordRunStart(repoId, planFile, mode, { scopeMode, commitSha, branch, planId, runId, experimentTag } = {}) {
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
    // Probed, not assumed: an un-migrated store would reject the whole INSERT on
    // an unknown column, turning a descriptive label into a run-registration
    // failure — the graceful-degradation invariant runs the other way.
    ...(experimentTag && await columnExists('audit_runs', 'experiment_tag', many, isCloudEnabled)
      ? { experiment_tag: experimentTag } : {}),
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
  if (!runId) return { applied: false, rows: 0, reason: 'no-run-id' };
  if (!await isCloudEnabled()) return { applied: false, rows: 0, reason: 'cloud-off' };
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
  if (stats.mapReducePasses != null) update.map_reduce_passes = pgArray(stats.mapReducePasses); // genuine text[]
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
  // Same probe-guard, same reason (migration 20260808190000). These two carry
  // the seed A/B's control arm: `cache_seed_eligible` says the run COULD have
  // seeded, `cache_seed_skip_reason` says why it did not. Without them a
  // seed-OFF row is ambiguous between "withheld" and "impossible", and the
  // cohorts are not comparable.
  if (stats.cacheSeedEligible != null
      && await columnExists('audit_runs', 'cache_seed_eligible', many, isCloudEnabled)) {
    update.cache_seed_eligible = stats.cacheSeedEligible;
  }
  if (stats.cacheSeedSkipReason != null
      && await columnExists('audit_runs', 'cache_seed_skip_reason', many, isCloudEnabled)) {
    update.cache_seed_skip_reason = stats.cacheSeedSkipReason;
  }
  // Write-durability outcomes (migration 20260812080000, durability plan
  // decision 3). Same probe-guard as the columns above so a pre-migration store
  // skips ONLY these fields instead of failing the whole completion update.
  //
  // `write_outcomes` is passed RAW — the jsonb write seam serialises it
  // (AGENTS.md: never hand-JSON.stringify a jsonb column).
  if (stats.writeOutcomes != null
      && await columnExists('audit_runs', 'write_outcomes', many, isCloudEnabled)) {
    update.write_outcomes = stats.writeOutcomes;
  }
  // Suppression provenance (migration 20260417120000 — the column predates this
  // writer by four months and was populated on 0 of 741 rows until 2026-08-13).
  // Carries the ruling-set denominator, so a round that had nothing to suppress
  // WITH stops reading like one that found nothing to suppress. Passed RAW —
  // the jsonb write seam serialises it. Same probe-guard as its siblings.
  if (stats.suppressionStats != null
      && await columnExists('audit_runs', 'suppression_stats', many, isCloudEnabled)) {
    update.suppression_stats = stats.suppressionStats;
  }
  // `run_status` carries the honest completion state. A run that produced
  // findings it could not record is `incomplete`, and that has to be a column
  // rather than a log line — the whole point of decision 3 is that a counter
  // nobody can query is not a completion contract.
  if (stats.runStatus != null
      && await columnExists('audit_runs', 'run_status', many, isCloudEnabled)) {
    update.run_status = stats.runStatus;
  }
  try {
    const res = await updateWhere('audit_runs', update, { id: runId });
    // An UPDATE that matched nothing is NOT a completed write. Postgres reports
    // success for a WHERE that selected zero rows, so a replayed completion
    // against a run row that never existed (or was deleted) would otherwise
    // return a receipt saying it applied — the unverified-write-success class
    // this plan exists to remove, reproduced inside its own reporting path.
    if ((res?.rowCount ?? 0) === 0) {
      // Carries an ERROR, not just a reason (final gate G2). Without it the
      // drain reads a non-throwing `{applied:false}` as a clean decline — not
      // the artifact's fault, so `attempts` is not incremented — and because
      // `audit.runComplete` is KEYED, the artifact stays queued and is retried
      // on every drain for ever. A plain Error classifies `retryable: false`
      // (measured), so it quarantines on the FIRST failure, which is right: a
      // run row that does not exist now will not exist later.
      return {
        applied: false,
        rows: 0,
        reason: 'run-row-absent',
        error: new Error(`recordRunComplete: no audit_runs row with id ${runId} — nothing to complete`),
      };
    }
    return { applied: true, rows: res.rowCount };
  } catch (err) {
    process.stderr.write(`  [learning] recordRunComplete failed: ${err.message}\n`);
    return { applied: false, rows: 0, reason: 'write-failed', error: err };
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
  // Model-A/B/C v2 assignment grain (migration 20260701140000). Set by the
  // generation shadow when the experiment runs; columnExists-guarded so a
  // pre-migration store degrades cleanly (omit the absent column).
  if (meta.assignmentId != null
      && await columnExists('audit_runs', 'assignment_id', many, isCloudEnabled)) {
    update.assignment_id = meta.assignmentId;
  }
  if (meta.stageType != null
      && await columnExists('audit_runs', 'stage_type', many, isCloudEnabled)) {
    update.stage_type = meta.stageType;
  }
  if (meta.phase != null
      && await columnExists('audit_runs', 'phase', many, isCloudEnabled)) {
    update.phase = meta.phase;
  }
  if (meta.promptVariant != null
      && await columnExists('audit_runs', 'prompt_variant', many, isCloudEnabled)) {
    update.prompt_variant = meta.promptVariant;
  }
  if (meta.attempt != null
      && await columnExists('audit_runs', 'attempt', many, isCloudEnabled)) {
    update.attempt = meta.attempt;
  }
  if (meta.armOrderSeed != null
      && await columnExists('audit_runs', 'arm_order_seed', many, isCloudEnabled)) {
    update.arm_order_seed = meta.armOrderSeed;
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

/**
 * Stand-in written to the NOT NULL `category` column when a producer omits it.
 * Deliberately self-describing rather than a neutral 'unknown': the value shows
 * up in dashboards and adjudication worksheets, so it should read as a producer
 * defect, not as a legitimate category.
 *
 * Deliberately NOT exported: `scripts/learning-store.mjs` re-exports this module
 * with `export *`, and that barrel's surface is pinned to callable functions only
 * (`tests/learning-store-exports.test.mjs`). Widening a pinned public contract to
 * let a test import a string is the wrong trade — the test asserts the value from
 * source instead.
 */
const MISSING_CATEGORY_MARKER = '(missing — producer omitted category)';

/**
 * The row identity for a finding — `_hash` when the producer supplied one, a
 * DERIVED digest when it did not.
 *
 * The fallback used to be the literal `'unknown'` for every hashless finding,
 * which the final gate caught (G5/G3): `(run_id, finding_fingerprint)` is
 * unique, so N hashless findings in one batch collapse onto ONE row — silent
 * loss of N-1 real findings. Writing NULL instead is not available: the column
 * is `NOT NULL` (verified against the live schema), so the gate's suggested
 * "skip the dedup for unknowns" would have raised 23505 on the second row, or
 * 21000 under the upsert.
 *
 * A content digest keeps every distinct finding distinct and keeps two IDENTICAL
 * ones collapsing, which is what the fingerprint means everywhere else. The
 * `missing-hash-` prefix keeps it visibly derived, so nobody reads it as a
 * producer-supplied semantic hash.
 */
function fingerprintOf(f) {
  if (f?._hash) return f._hash;
  const digest = crypto.createHash('sha256')
    .update(JSON.stringify([f?.severity ?? '', f?.category ?? '', f?.section ?? '', f?._primaryFile ?? '', f?.detail ?? '']))
    .digest('hex').slice(0, 24);
  return `missing-hash-${digest}`;
}

/**
 * Coerce a value to a closed column domain, or to null (logging the reject).
 *
 * Every CHECK-constrained nullable column on this table needs this, and for a
 * sharper reason than tidiness: a constraint violation inside a caller-supplied
 * transaction poisons the tx, so the COMMIT silently degrades to ROLLBACK and
 * the ENTIRE batch disappears with no error reaching the caller (the same
 * mechanism documented at the NOT-NULL write boundary below). One bad value must
 * cost one field, never the batch.
 */
function normaliseEnum(value, valid, label) {
  if (value == null) return null;
  if (valid.has(value)) return value;
  process.stderr.write(`  [learning] unexpected ${label} value '${value}' coerced to null\n`);
  return null;
}

/** Coerce a bucket value to the valid domain or null (logs unexpected values). */
function normaliseBucket(b) {
  return normaliseEnum(b, VALID_BUCKETS, 'bucket');
}

/** The closed domain `verifyExistenceFindings` emits, mirroring the DB CHECK in
 *  20260813120000. App-layer enforced for the same reason `bucket` is: an
 *  out-of-domain value would fail the CHECK, and a constraint violation inside a
 *  caller-supplied transaction poisons the tx — so the whole batch would vanish
 *  on one bad value, which is the failure this boundary exists to prevent. */
const VALID_VERIFICATIONS = new Set(['refuted', 'confirmed', 'requires_verification']);

/** The severity vocabulary — the same domain `severity` has always carried
 *  (`audit_findings_severity_check`) and the same one `schemas.mjs` declares for
 *  `verdictSeverity`. `verdict_severity` was the only one of the three new
 *  columns without a guard until the round-1 audit (M1) named the asymmetry. */
const VALID_SEVERITIES = new Set(['HIGH', 'MEDIUM', 'LOW']);

/**
 * Map ONE finding to its `audit_findings` row. Pure — every schema-dependent
 * choice arrives in `columns`, so no probe runs here.
 *
 * Exported undecorated (like `buildFindingAdjudicationPatch` /
 * `normalizeRemediationUpdates` below) so the column contract is directly
 * unit-testable without a live DB. It was inline in `recordFindings`, where the
 * one invariant most worth pinning — that `severity` keeps the MODEL's value
 * while the gate's verdict lands in its own column — was unreachable by any test.
 *
 * @param {object} f - the finding, optionally carrying the gate's `.verification`
 * @param {{runId:string, passName:string, round:number, columns:object}} ctx
 * @returns {object} the row, ready for the bulk INSERT
 */
export function buildFindingRow(f, { runId, passName, round, columns = {} }) {
  const base = {
    run_id: runId,
    // Same oracle as the dedup above and the embedding lookup — three
    // spellings of one identity is how a key silently stops matching itself.
    finding_fingerprint: fingerprintOf(f),
    pass_name: passName,
    // The MODEL's severity, never the gate-effective one. Same rule the
    // no-severity drop below states: this is the metric the A/B stopping rule
    // counts, so it is never fabricated — and audit M2 makes the model's claim
    // immutable. The gate's verdict goes to `verdict_severity` instead.
    severity: f.severity,
    category: f.category,
    primary_file: f._primaryFile || f.section,
    detail_snapshot: f.detail?.slice(0, 600),
    round_raised: round,
  };
  if (columns.hasClassification) {
    base.sonar_type = f.classification?.sonarType ?? null;
    base.effort = f.classification?.effort ?? null;
    base.source_kind = f.classification?.sourceKind ?? null;
    base.source_name = f.classification?.sourceName ?? null;
  }
  // f._sourceModel / f._bucket are stamped by the final-review diff; absent
  // (null) for normal audit-pass findings, which is the correct value.
  if (columns.hasSourceModel) base.source_model = f._sourceModel ?? null;
  // App-layer validation of the bucket domain (plan R3 M5 / cluster-A M5,M7,M10:
  // the migration deliberately has no DB CHECK — Postgres lacks idempotent
  // ADD CONSTRAINT — so the write boundary enforces the literal domain here).
  // An unexpected value is coerced to null + logged rather than silently
  // persisting drift.
  if (columns.hasBucket) base.bucket = normaliseBucket(f._bucket);
  if (columns.hasStage) base.stage = f._stage ?? null;
  // v2 hybrid attribution: `arm` is stamped by the shadow ONLY on arm-specific
  // stages (gemini/gpt-round); null for shared/production findings (the view
  // derives those). is_quick_fix comes straight off the finding object.
  if (columns.hasArm) base.arm = f._arm ?? null;
  if (columns.hasIsQuickFix) base.is_quick_fix = f.is_quick_fix ?? null;
  // Deterministic existence-gate verdict (migration 20260813120000). Read
  // straight off the sibling object the gate attaches — NOT re-derived, so this
  // module cannot become a second spelling of `effectiveSeverity`. A finding the
  // gate never looked at keeps NULL in all three, which is deliberately distinct
  // from `requires_verification` ("looked, could not decide").
  if (columns.hasVerification) {
    base.verification = normaliseEnum(f.verification?.verification, VALID_VERIFICATIONS, 'verification');
    base.verification_reason = f.verification?.verificationReason ?? null;
    base.verdict_severity = normaliseEnum(f.verification?.verdictSeverity, VALID_SEVERITIES, 'verdict_severity');
  }
  return base;
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
 *
 * **Returns a RECEIPT** (durability plan Phase 3). Every existing caller ignores
 * the return value, so this is additive — but `durableWrite`'s contract is that
 * a replay PROVES it applied, and `undefined` (what a cloud-off early return
 * produces) is read as *not* applied. Without a receipt the drain could not tell
 * "written" from "declined", which is the exact defect the plan's gate caught.
 * The `error` field carries the original error object, NOT a message: the drain
 * classifies on `err.code` (SQLSTATE / errno), and a string cannot be
 * classified.
 *
 * @returns {Promise<{applied: boolean, rows: number, reason?: string, error?: unknown}>}
 */
export async function recordFindings(runId, findings, passName, round, opts = {}) {
  if (!runId) return { applied: false, rows: 0, reason: 'no-run-id' };
  if (!await isCloudEnabled()) return { applied: false, rows: 0, reason: 'cloud-off' };
  const hasClassification = await detectClassificationColumns();
  // Final-review attribution columns (migration 20260610120000) — written
  // only when present so the path degrades cleanly on an un-migrated store.
  const hasSourceModel = await columnExists('audit_findings', 'source_model', many, isCloudEnabled);
  const hasBucket = await columnExists('audit_findings', 'bucket', many, isCloudEnabled);
  // Model-A/B/C generation-shadow attribution (migration 20260701120000): the
  // PRODUCING stage (oss-gen|gpt-round|gemini). Null for normal/baseline findings
  // — the correct value (baseline provenance = stage NULL in the scorer view).
  const hasStage = await columnExists('audit_findings', 'stage', many, isCloudEnabled);
  // Model-A/B/C v2 (migration 20260701140000): the explicit `arm` tag on
  // arm-specific stages (gemini|gpt-round) + the `is_quick_fix` quality input.
  // Both null/absent for normal findings — probe-guarded so an un-migrated store
  // is byte-identical.
  const hasArm = await columnExists('audit_findings', 'arm', many, isCloudEnabled);
  const hasIsQuickFix = await columnExists('audit_findings', 'is_quick_fix', many, isCloudEnabled);
  // Deterministic existence-gate verdict (migration 20260813120000). One probe
  // covers all three columns — they land in a single migration, so a store with
  // `verification` has the other two. Probe-guarded like every column above, so
  // an un-migrated store writes byte-identical rows rather than failing.
  const hasVerification = await columnExists('audit_findings', 'verification', many, isCloudEnabled);
  // Prospective semantic re-raise suppression (record-time hook). Fail-open:
  // returns every finding when disabled or on any error. Only `merged` findings
  // (the code-audit path that carries the measured churn) are considered.
  const { kept: suppressionKept, vectorByFinding } = await applyRecordTimeSuppression(runId, findings, passName);
  // ── Intra-batch fingerprint dedup (durability plan Phase 3) ───────────────
  // `audit_findings_run_fingerprint_uniq_full` (migration 20260812070000) makes
  // `(run_id, finding_fingerprint)` unique, and a multi-row INSERT carrying the
  // same fingerprint twice would now abort the WHOLE batch (23505) where it
  // previously wrote two rows. `ON CONFLICT DO UPDATE` does not rescue it
  // either — Postgres refuses to affect one row twice in a single command
  // (21000). So the collapse has to happen before the statement is built.
  //
  // Keep the FIRST occurrence: the batch is ordered, and a later duplicate of an
  // already-seen fingerprint carries no information the first does not. Never
  // silent — a dropped finding is exactly what this plan exists to make visible.
  const keptFindings = [];
  const seenFingerprints = new Set();
  let intraBatchDuplicates = 0;
  for (const f of suppressionKept) {
    const fp = fingerprintOf(f);
    if (seenFingerprints.has(fp)) { intraBatchDuplicates++; continue; }
    seenFingerprints.add(fp);
    keptFindings.push(f);
  }
  if (intraBatchDuplicates > 0) {
    process.stderr.write(
      `  [learning] ${intraBatchDuplicates} ${passName} finding(s) shared a fingerprint with an earlier one in the `
      + 'same batch and were collapsed — (run_id, finding_fingerprint) is unique, so they could not both be rows.\n'
    );
  }
  const columns = { hasClassification, hasSourceModel, hasBucket, hasStage, hasArm, hasIsQuickFix, hasVerification };
  const mappedRows = keptFindings.map((f) => buildFindingRow(f, { runId, passName, round, columns }));

  // ── NOT-NULL write-boundary guard (2026-07-26) ────────────────────────────
  // `finding_fingerprint` has always had a `|| 'unknown'` fallback; `severity`
  // and `category` had none, yet both are NOT NULL with no DB default. One
  // malformed finding therefore aborted the whole INSERT — and inside a
  // caller-supplied transaction that poisons the tx, so the subsequent COMMIT
  // silently degrades to ROLLBACK and the entire batch disappears with no error
  // reaching the caller. Found live: the Opus shadow reviewer returned a finding
  // with a null `category`, which discarded the PRIMARY reviewer's findings too.
  //
  // Coerce vs skip is deliberately asymmetric:
  //  - `category` is descriptive → coerce to a visible defect marker so the row
  //    survives. `detail_snapshot` is what a human grades; keeping the row keeps
  //    it gradeable, and the marker makes the provider bug visible IN THE DATA
  //    rather than only in a log line that scrolls away.
  //  - `severity` is the metric → NEVER fabricated. The shadow A/B's stopping
  //    rule counts HIGH/MEDIUM findings; inventing a severity would corrupt the
  //    exact number the row exists to feed. Drop it, loudly.
  const rows = [];
  let coercedCategories = 0;
  const droppedFingerprints = [];
  for (const row of mappedRows) {
    if (!row.severity) {
      droppedFingerprints.push(row.finding_fingerprint);
      continue;
    }
    if (row.category == null || row.category === '') {
      row.category = MISSING_CATEGORY_MARKER;
      coercedCategories++;
    }
    rows.push(row);
  }
  if (coercedCategories > 0) {
    process.stderr.write(
      `  [learning] WARNING: ${coercedCategories} ${passName} finding(s) had no category — `
      + `the producer omitted a REQUIRED field. Persisted as "${MISSING_CATEGORY_MARKER}" so the `
      + 'batch is not lost; fix the producer\'s structured-output contract.\n'
    );
  }
  if (droppedFingerprints.length > 0) {
    // Never a silent cap — name what was dropped and why (AGENTS.md).
    process.stderr.write(
      `  [learning] WARNING: dropped ${droppedFingerprints.length} ${passName} finding(s) with no severity `
      + `(${droppedFingerprints.join(', ')}) — severity is the metric the A/B stopping rule counts, so it is `
      + 'never fabricated. These findings are NOT persisted.\n'
    );
  }
  // Terminal, not pending: this payload will map to zero rows however often it
  // is replayed (the drops above are deterministic in the payload), so a spilled
  // artifact that lands here must be retired rather than retried forever.
  if (rows.length === 0) return { applied: true, rows: 0, reason: 'no-persistable-rows' };
  // Bulk INSERT — homogeneous rows by construction. Use the caller's tx client
  // when provided (atomic delete+insert); otherwise grab a pool connection.
  try {
    const exec = opts.client ?? await getPool();
    if (!exec) return { applied: false, rows: 0, reason: 'no-pool' };
    const cols = Object.keys(rows[0]);
    const params = [];
    const valueGroups = rows.map((row) => {
      const placeholders = cols.map((c) => {
        params.push(row[c]);
        return `$${params.length}`;
      });
      return `(${placeholders.join(', ')})`;
    });
    // UPSERT, not INSERT (durability plan Phase 3). A spilled batch is replayed
    // by a later drain, and a plain INSERT would abort on any row the first
    // attempt already committed — the partial-write case is precisely what the
    // spill exists to finish. `audit_findings_run_fingerprint_pass_bucket_uniq`
    // is the arbiter; it is a FULL (non-partial) unique index, so a bare
    // conflict target resolves it (the partial index in 20260812060000 could
    // not — measured 42P10).
    //
    // SCOPED BY pass_name AND bucket (20260812090000 then 20260812100000,
    // fixing two increasingly narrow versions of the same defect). The SAME
    // fingerprint legitimately recurs: across pass_names
    // (`recordFinalReviewFindings` writes primary under pass_name='final-review'
    // and shadow under pass_name='final-review-shadow'), AND within ONE
    // pass_name, distinguished only by `bucket` — `resolveFindingBucket`
    // (the function `adjudicateFinalReviewFinding`/`recordFinalReviewFix`
    // depend on) resolves purely on `(run_id, finding_fingerprint, bucket)`,
    // no pass_name in its WHERE clause, so pass_name alone was NOT sufficient:
    // measured live, a same-pass_name same-fingerprint pair differing only in
    // bucket still hit 23505 under the pass_name-only key. Only the 'merged'
    // pass_name (the durability plan's own replay target) ever needed strict
    // cross-batch fingerprint idempotency; scoping by pass_name AND bucket
    // gives it that without constraining every other writer of this table.
    //
    // `bucket` is COALESCE'd to '' in the index (and must be here, identically,
    // for the conflict target to resolve against an EXPRESSION index) because
    // it is nullable — NULL for every 'merged'-pass row — and Postgres treats
    // NULL as distinct within a unique index, so a raw (uncoalesced) bucket
    // column would not have deduplicated 'merged' findings at all, reopening
    // the exact defect 070000 fixed (706 duplicate rows, measured then).
    //
    // Conditional on `hasBucket` (an un-migrated store lacks the column
    // entirely — referencing it in SQL would be an undefined-column error, not
    // a graceful degrade) — matches every other `hasX`-guarded column in this
    // function.
    //
    // DO UPDATE rather than DO NOTHING for two reasons: `RETURNING` yields a row
    // for conflicting keys too, which the embedding persistence below needs to
    // map fingerprint→id; and a re-record of the same finding should refresh the
    // columns this statement owns. Adjudication columns are NOT in `cols`, so a
    // replay cannot overwrite a human ruling.
    const conflictTarget = hasBucket
      ? `run_id, finding_fingerprint, pass_name, (COALESCE(bucket, ''))`
      : `run_id, finding_fingerprint, pass_name`;
    const updatable = cols.filter((c) => c !== 'run_id' && c !== 'finding_fingerprint' && c !== 'pass_name' && c !== 'bucket');
    const conflict = updatable.length > 0
      ? `ON CONFLICT (${conflictTarget}) DO UPDATE SET ${updatable.map((c) => `"${c}" = EXCLUDED."${c}"`).join(', ')}`
      : `ON CONFLICT (${conflictTarget}) DO NOTHING`;
    const sql = `INSERT INTO audit_findings (${cols.map((c) => `"${c}"`).join(', ')})
                 VALUES ${valueGroups.join(', ')}
                 ${conflict}
                 RETURNING id, finding_fingerprint`;
    const inserted = await exec.query(sql, params);
    // Persist embeddings for the kept findings so they become future dedup
    // targets. Best-effort; keyed by fingerprint→id (unique within a batch).
    if (vectorByFinding && vectorByFinding.size > 0) {
      const idByFingerprint = new Map((inserted.rows || []).map((r) => [r.finding_fingerprint, r.id]));
      const embedResult = await persistKeptEmbeddings(exec, keptFindings, vectorByFinding, idByFingerprint, runId);
      if (embedResult.failed > 0) {
        process.stderr.write(`  [semantic-suppress] embedding persistence: ${embedResult.persisted} ok, ${embedResult.failed} failed this batch\n`);
      }
    }
    return { applied: true, rows: rows.length };
  } catch (err) {
    process.stderr.write(`  [learning] recordFindings failed: ${err.message}\n`);
    // RETHROW when running inside a caller-supplied transaction (2026-07-26).
    // Swallowing here is right for the standalone-pool callers — findings
    // telemetry is best-effort and must never break an audit. But inside a tx
    // the caller owns commit/rollback, and a failed statement has already put
    // Postgres in an aborted state: the caller's COMMIT then silently degrades
    // to a ROLLBACK, so it believes it persisted while everything vanished.
    // That is the unverified-write-success class this codebase treats as HIGH.
    // Surfacing it lets the caller decide (and, for the final review, keep the
    // primary's rows even when the shadow's are unwritable).
    if (opts.client) throw err;
    // The error object, not its message: `durableWrite`'s classifier reads
    // `err.code` to tell a store outage (abort the drain, charge nothing) from a
    // bad row (quarantine it). A stringified error is unclassifiable.
    return { applied: false, rows: 0, reason: 'write-failed', error: err };
  }
}

/**
 * Idempotent replace-persistence for the final review's findings (plan
 * docs/plans/final-review-shadow-reviewer.md). A retry or manual rerun with
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
 *   verdict?: string|null,  // the PRIMARY reviewer's Step-7 verdict. Must be
 *                           // one of the audit_runs.gemini_verdict CHECK
 *                           // values (migration 20260718160000). The shadow's
 *                           // verdict is deliberately NOT written here — it is
 *                           // observation-only and must never gate a build.
 * }} payload
 */
export async function recordFinalReviewFindings(runId, { primary = [], shadow = [], models = {}, verdict = null } = {}) {
  if (!runId || !await isCloudEnabled()) return;
  // (a) Run metadata — overwrite-idempotent, so it's fine outside the findings
  // tx. Null shadow fields are simply not written (updateRunMeta guards on
  // `!= null`), which is correct when the shadow didn't run.
  await updateRunMeta(runId, {
    // The Step-7 verdict. Written HERE, by the final reviewer that produced it
    // — `recordRunComplete` runs before Step 7 and has always hardcoded null
    // with a comment claiming this function would fill it in. Nothing did, so
    // `gemini_verdict` was NULL on every run ever recorded, which in turn made
    // "did the final gate approve this?" unanswerable from the store.
    // `updateRunMeta` skips null, so a reviewer that produced no verdict still
    // leaves the column honestly empty rather than writing a fake value.
    geminiVerdict: verdict ?? null,
    finalReviewModel: models.primaryModel,
    finalReviewShadowModel: models.shadowModel,
    finalReviewShadowInputTokens: models.shadowInputTokens,
    finalReviewShadowOutputTokens: models.shadowOutputTokens,
    finalReviewShadowLatencyMs: models.shadowLatencyMs,
  });
  // (b) Replace the findings. TWO transactions, deliberately — the shadow is
  // observation-only and must never be able to damage the primary's record.
  //
  // This function's own header promises "primary final-review rows persist
  // whenever cloud+runId, INDEPENDENT of the shadow". Until 2026-07-26 that was
  // only true of the *decision* to write, not of the write itself: both inserts
  // shared one tx, so a malformed shadow finding (null `category`, NOT NULL)
  // aborted the tx and the COMMIT silently degraded to ROLLBACK — taking the
  // DELETE and the primary's findings with it, with no error surfaced. The run
  // kept STALE findings from an earlier review and nobody could tell. Splitting
  // the transactions makes the documented invariant actually true.
  //
  // tx1 keeps the atomic delete+insert the idempotent-replace contract needs.
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
    });
  } catch (err) {
    process.stderr.write(`  [learning] recordFinalReviewFindings failed (primary): ${err.message}\n`);
    // The shadow rows belong to a review whose primary half is now unrecorded —
    // writing them alone would produce a run with shadow-only findings and no
    // baseline to diff against, which reads as "the primary found nothing".
    return;
  }
  // tx2 — shadow. Its own transaction so a provider-shaped defect here cannot
  // roll back tx1. A failure is loud but non-fatal: the A/B loses one
  // observation, the audit record stays intact.
  if (shadow.length > 0) {
    try {
      await withTx(async (client) => {
        await recordFindings(runId, shadow, 'final-review-shadow', 0, { client });
      });
    } catch (err) {
      process.stderr.write(
        `  [learning] recordFinalReviewFindings failed (shadow, non-fatal — primary rows are safe): ${err.message}\n`
      );
    }
  }
}

/**
 * Human-adjudication writeback for a final-review finding (plan D6).
 *
 * Maps the user-facing verb to the existing CHECK enum (20260508120000):
 * accepted → 'accepted-permanent', dismissed → 'dismissed'.
 *
 * **Bucket is RESOLVED, not hardcoded.** The original scoped every update to
 * `bucket = 'shadow-only'` so a fingerprint present in two buckets could not be
 * ambiguously matched (R2 M2 — a real hazard worth keeping). But the CLI is
 * named generically, so that hardcode silently made every PRIMARY final-review
 * finding unadjudicable: the update matched nothing and still reported success.
 * Found 2026-07-18 trying to label a refuted Gemini finding — `{ok: true,
 * updated: 0}`, the same unverified-write-success class this codebase treats as
 * HIGH elsewhere. So instead:
 *
 *   - explicit `bucket` (including `null` for primary) → scope to exactly that
 *   - omitted + exactly one bucket matches → adjudicate it (the common case;
 *     identical behaviour to before for the shadow queue)
 *   - omitted + several buckets match → REFUSE and name them, preserving the
 *     R2-M2 disambiguation intent without pretending to know which was meant
 *   - nothing matches → `ok: false` with a reason, never a silent success
 *
 * Also writes `adjudication_outcome` + `decided_at` alongside `user_action`,
 * mirroring the model-A/B sibling (`setFindingOutcome`). Writing only
 * `user_action` left an adjudicated finding invisible to every ground-truth
 * query that keys on those columns — labelled to a human, unlabelled to the
 * learner.
 *
 * @param {string} runId
 * @param {string} fingerprint  finding_fingerprint of the finding
 * @param {'accepted'|'dismissed'} action
 * @param {{bucket?: string|null}} [opts] - omit to auto-resolve; pass explicitly to disambiguate
 * @returns {Promise<{ok: boolean, updated: number, cloud: boolean, reason?: string, buckets?: Array<string|null>}>}
 */
export async function adjudicateFinalReviewFinding(runId, fingerprint, action, opts = {}) {
  if (!await isCloudEnabled()) return { ok: false, updated: 0, cloud: false, reason: 'cloud-disabled' };
  const userAction = action === 'accepted' ? 'accepted-permanent'
    : action === 'dismissed' ? 'dismissed'
    : null;
  if (!userAction) throw new Error(`adjudicateFinalReviewFinding: action must be 'accepted' or 'dismissed', got '${action}'`);
  const outcome = action === 'accepted' ? 'accepted' : 'dismissed';
  if (!await columnExists('audit_findings', 'bucket', many, isCloudEnabled)) {
    process.stderr.write('  [learning] adjudicate: bucket column absent — run migration 20260610120000\n');
    return { ok: false, updated: 0, cloud: true, reason: 'bucket-column-absent' };
  }
  try {
    const resolved = await resolveFindingBucket(runId, fingerprint, opts);
    if (!resolved.ok) return { ...resolved, updated: 0, cloud: true };
    const bucket = resolved.bucket;
    // `bucket` may legitimately be null (a primary finding), which updateWhere
    // renders as `IS NULL` — the reason this uses a raw predicate rather than
    // an equality object.
    const res = await query(
      `UPDATE audit_findings
          SET user_action = $3, adjudication_outcome = $4, decided_at = NOW()
        WHERE run_id = $1 AND finding_fingerprint = $2
          AND bucket IS NOT DISTINCT FROM $5`,
      [runId, fingerprint, userAction, outcome, bucket]
    );
    const updated = res.rowCount ?? 0;
    if (updated === 0) {
      // Reachable only on a concurrent delete between the probe and the write.
      return { ok: false, updated: 0, cloud: true, reason: 'no-rows-affected' };
    }
    return { ok: true, updated, cloud: true, bucket };
  } catch (err) {
    process.stderr.write(`  [learning] adjudicateFinalReviewFinding failed: ${err.message}\n`);
    return { ok: false, updated: 0, cloud: true, reason: `db-error: ${err.message}` };
  }
}

/**
 * Resolve which `bucket` a (runId, fingerprint) pair refers to.
 *
 * Extracted so `adjudicateFinalReviewFinding` and `recordFinalReviewFix` share
 * ONE disambiguation oracle — a second copy would be free to drift, and the
 * rule it encodes (never guess between primary and shadow) is exactly the one
 * whose violation would corrupt the A/B comparison.
 *
 * @param {string} runId
 * @param {string} fingerprint
 * @param {{bucket?: string|null}} [opts] - omit to auto-resolve; pass explicitly to disambiguate
 * @returns {Promise<{ok: true, bucket: string|null} | {ok: false, reason: string, buckets?: Array<string|null>}>}
 */
async function resolveFindingBucket(runId, fingerprint, opts = {}) {
  const candidates = await many(
    `SELECT DISTINCT bucket FROM audit_findings
      WHERE run_id = $1 AND finding_fingerprint = $2`,
    [runId, fingerprint]
  );
  if (candidates.length === 0) return { ok: false, reason: 'no-match' };
  if (Object.prototype.hasOwnProperty.call(opts, 'bucket')) {
    const bucket = opts.bucket;
    if (!candidates.some((c) => c.bucket === bucket)) {
      return { ok: false, reason: 'no-match-in-bucket', buckets: candidates.map((c) => c.bucket) };
    }
    return { ok: true, bucket };
  }
  if (candidates.length > 1) {
    // Do NOT guess. Two buckets sharing a fingerprint are two independent
    // observations (primary vs shadow) — collapsing them would corrupt the
    // A/B comparison the shadow experiment exists to make.
    return { ok: false, reason: 'ambiguous-bucket', buckets: candidates.map((c) => c.bucket) };
  }
  return { ok: true, bucket: candidates[0].bucket };
}

/**
 * Record that a final-review finding was actually FIXED, with the commit.
 *
 * **Why this exists — the shadow A/B could not measure its own headline claim.**
 * `adjudicateFinalReviewFinding` writes the *adjudication* axis (accepted /
 * dismissed). The *remediation* axis (`remediation_state`, `fix_commit_sha`)
 * had exactly one writer, `markFindingsRemediation`, whose sole caller projects
 * from the `/audit-code` LEDGER (legacy-production-audit.mjs). Final-review
 * shadow findings carry `pass_name='final-review-shadow'` and are adjudicated
 * through a different path, so they never enter that ledger — no code path
 * could ever set their remediation state. The only fix-related CLI was
 * `list-unlocked-fixes`, a read.
 *
 * So "14 accepted, 0 converted to fixes" — the single strongest argument that
 * the second gate produces observations rather than caught defects — was not a
 * measurement. It was an artifact of there being no way to record the other
 * outcome. Four wine-cellar-app findings had genuinely shipped fixes
 * (wine-cellar-app#193) and would still have read 0.
 *
 * Kept as a SEPARATE command rather than an `--action fixed` on the adjudication
 * CLI, because this repo's two-axis model (AGENTS.md: `adjudicationOutcome` +
 * `remediationState`) is load-bearing: "accepted" and "fixed" are orthogonal
 * facts, and collapsing them would make "accepted but not yet fixed" —
 * precisely the state worth counting — unrepresentable.
 *
 * Refuses a `dismissed` finding: recording a fix for something judged a
 * non-issue is incoherent. Allows a not-yet-adjudicated one, so a fix-first
 * workflow is not blocked.
 *
 * @param {string} runId
 * @param {string} fingerprint
 * @param {{bucket?: string|null, commitSha?: string|null, state?: 'fixed'|'verified'|'regressed'}} [opts]
 * @returns {Promise<{ok: boolean, updated: number, cloud: boolean, reason?: string, buckets?: Array<string|null>, bucket?: string|null}>}
 */
export async function recordFinalReviewFix(runId, fingerprint, opts = {}) {
  if (!await isCloudEnabled()) return { ok: false, updated: 0, cloud: false, reason: 'cloud-disabled' };
  const state = opts.state ?? 'fixed';
  if (!TERMINAL_REMEDIATION.has(state)) {
    return { ok: false, updated: 0, cloud: true, reason: `non-terminal state "${state}"` };
  }
  if (!await columnExists('audit_findings', 'bucket', many, isCloudEnabled)) {
    process.stderr.write('  [learning] record-fix: bucket column absent — run migration 20260610120000\n');
    return { ok: false, updated: 0, cloud: true, reason: 'bucket-column-absent' };
  }
  try {
    const resolved = await resolveFindingBucket(runId, fingerprint, opts);
    if (!resolved.ok) return { ...resolved, updated: 0, cloud: true };
    const bucket = resolved.bucket;

    const existing = await one(
      `SELECT user_action FROM audit_findings
        WHERE run_id = $1 AND finding_fingerprint = $2 AND bucket IS NOT DISTINCT FROM $3
        LIMIT 1`,
      [runId, fingerprint, bucket]
    );
    if (existing?.user_action === 'dismissed') {
      return { ok: false, updated: 0, cloud: true, reason: 'dismissed-cannot-be-fixed', bucket };
    }

    const patch = { remediation_state: state };
    if (opts.commitSha != null) patch.fix_commit_sha = opts.commitSha;
    const sets = Object.keys(patch).map((k, i) => `${k} = $${i + 4}`).join(', ');
    const res = await query(
      `UPDATE audit_findings SET ${sets}
        WHERE run_id = $1 AND finding_fingerprint = $2
          AND bucket IS NOT DISTINCT FROM $3`,
      [runId, fingerprint, bucket, ...Object.values(patch)]
    );
    const updated = res.rowCount ?? 0;
    // A 0-row write reported as success is the exact class this codebase treats
    // as HIGH elsewhere — and the class that hid the hardcoded-bucket bug.
    if (updated === 0) return { ok: false, updated: 0, cloud: true, reason: 'no-rows-affected', bucket };
    return { ok: true, updated, cloud: true, bucket, state };
  } catch (err) {
    process.stderr.write(`  [learning] recordFinalReviewFix failed: ${err.message}\n`);
    return { ok: false, updated: 0, cloud: true, reason: `db-error: ${err.message}` };
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
/**
 * Tri-state on purpose: `true` present, `false` genuinely absent, **`null` the
 * probe could not be performed**.
 *
 * It used to collapse a failed query into `false`, and its one caller renders
 * that as "run_id not found in audit_runs (cloud is configured) — was --run-id
 * threaded correctly?". With the store merely unreachable, that message blames
 * the operator's argument for a connectivity failure and sends them looking in
 * the wrong place. A boolean cannot carry three outcomes.
 *
 * An absent `runId` is still `false` — that is a real answer, not a failed probe.
 */
export async function auditRunExists(runId) {
  if (!runId) return false;
  if (!await isCloudEnabled()) return null;
  try {
    const row = await one(`SELECT id FROM audit_runs WHERE id = $1`, [runId]);
    return !!row?.id;
  } catch {
    return null;
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
 * Sibling of `markRunFindingsNeedsTriage` for CONTROL-STATE marker findings
 * (e.g. `ADJACENCY_INCOMPLETE` — see `scripts/lib/audit/control-markers.mjs`):
 * a ledger never adjudicates them because they are not real findings, so
 * without this they'd fall through to the same `needs_triage` reconciliation
 * as a genuinely un-ruled finding and clutter the human triage queue with
 * byte-identical machine noise. Routes them to their own terminal
 * `auto_dismissed` bucket instead — `pending_triage_findings` only selects
 * `needs_triage`, so this alone keeps them off the weekly digest. Same
 * guard shape as `markRunFindingsNeedsTriage`: idempotent, and never
 * clobbers a real adjudication or a differing prior user_action.
 * @param {string} runId
 * @param {string[]} fingerprints  finding_fingerprint values identified as control markers
 * @param {string} reason  human-readable dismiss_reason (which control-marker class matched)
 * @returns {Promise<{updated: number}>}
 */
export async function markRunFindingsAutoDismissed(runId, fingerprints, reason) {
  if (!runId || !await isCloudEnabled()
      || !Array.isArray(fingerprints) || fingerprints.length === 0) {
    return { updated: 0 };
  }
  try {
    const rows = await many(
      `UPDATE audit_findings
          SET user_action = 'auto_dismissed',
              dismiss_reason = $3
        WHERE run_id = $1
          AND finding_fingerprint = ANY($2::text[])
          AND adjudication_outcome IS NULL
          AND (user_action IS NULL OR user_action IN ('needs_triage', 'auto_dismissed'))
        RETURNING id`,
      [runId, fingerprints, reason || 'control-marker: auto-dismissed (not a real finding)'],
    );
    return { updated: Array.isArray(rows) ? rows.length : 0 };
  } catch (err) {
    process.stderr.write(`  [learning] markRunFindingsAutoDismissed failed: ${err.message}\n`);
    return { updated: 0 };
  }
}

/**
 * Read the shadow-A/B measurement surface for a repo by name (plan §6). Queries
 * BASE TABLES directly (no view — avoids the view/RLS-bypass question, R1 H5).
 * Returns {ok, cloud, repoId, buckets, shadowOnlyQueue, pendingQueue, runs} where:
 *   - buckets: per (source_model, bucket, severity) DISTINCT-fingerprint counts
 *     (COUNT DISTINCT — R3 M2 dedup at the query layer too).
 *   - shadowOnlyQueue: the human spot-check list — shadow-only findings with
 *     their adjudication state (user_action), newest first. Unchanged shape;
 *     `final-review-stats`'s worksheet is deliberately shadow-only and reads
 *     this field alone.
 *   - pendingQueue: `final-review-pending`'s read (docs/plans/skill-efficacy-census.md
 *     Phase 1) — shadow-only findings UNION ALL primary-bucket findings that are
 *     fixed/verified but never adjudicated (the label gap this plan closes),
 *     each row carrying its own `bucket` (never hardcoded downstream). Ordered
 *     by severity rank then recency at the SQL layer so the highest-leverage
 *     candidates survive `LIMIT queueLimit` when the true population exceeds
 *     it; `UNION ALL` is safe here only because the two branches' WHERE
 *     clauses partition mutually-exclusively on `bucket` — a row cannot match
 *     both, so no duplicate can occur by construction.
 *   - runs: per (final_review_model, final_review_shadow_model) run count +
 *     aggregate shadow token/latency cost (the operator's cost overlay).
 *
 * @param {string} repoName
 * @param {{queueLimit?: number}} [opts]
 */
export async function getFinalReviewStats(repoName, { queueLimit = 50 } = {}) {
  if (!await isCloudEnabled()) return { ok: true, cloud: false, repoId: null, buckets: [], shadowOnlyQueue: [], pendingQueue: [], actionablePairs: [], runs: [], experimentRuns: [] };
  const repoRow = await one(`SELECT id FROM audit_repos WHERE name = $1 ORDER BY created_at DESC LIMIT 1`, [repoName]);
  const repoId = repoRow?.id || null;
  if (!repoId) return { ok: true, cloud: true, repoId: null, buckets: [], shadowOnlyQueue: [], pendingQueue: [], actionablePairs: [], runs: [], experimentRuns: [] };
  // Guard: bail cleanly on an un-migrated store (no source_model column).
  if (!await columnExists('audit_findings', 'source_model', many, isCloudEnabled)) {
    process.stderr.write('  [final-review-stats] source_model column absent — run migration 20260610120000\n');
    return { ok: false, cloud: true, repoId, buckets: [], shadowOnlyQueue: [], pendingQueue: [], actionablePairs: [], runs: [], experimentRuns: [], error: 'NOT_MIGRATED' };
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
      // `f.remediation_state` (final-review-credit-and-cheap-shadow §2.1): the
      // outcome classification reads BOTH axes, and this projection carried only
      // `user_action`. Without it a fixed-but-unadjudicated finding is
      // indistinguishable from a never-touched one — so the `/ship` credit card
      // would either nag about a shipped fix forever or hide it by widening the
      // filter. One column; no new function.
      `SELECT f.run_id, f.finding_fingerprint, f.severity, f.category,
              f.primary_file, f.detail_snapshot, f.source_model,
              f.user_action, f.remediation_state, f.created_at
         FROM audit_findings f
         JOIN audit_runs r ON r.id = f.run_id
        WHERE r.repo_id = $1 AND f.bucket = 'shadow-only'
        ORDER BY f.created_at DESC
        LIMIT $2`,
      [repoId, queueLimit]
    );
    // The label-gap queue (docs/plans/skill-efficacy-census.md Phase 1): shadow-only
    // findings (unfiltered for actionability at the SQL level, same as
    // `shadowOnlyQueue` above — `finalReviewPendingCmd`'s JS-side `isActionable`
    // filter + `.slice(0, pageSize)` still owns that) UNION ALL primary-bucket
    // findings that are fixed/verified but never adjudicated. `bucket` is
    // selected explicitly (constant in the shadow branch, real in the primary
    // branch) so the CLI/renderer never has to hardcode it.
    // `severity_rank` is a projected OUTPUT COLUMN, not an inline ORDER BY
    // expression (manual-verification catch against the live store, round-3
    // M2 in docs/plans/skill-efficacy-census.md): Postgres rejects an
    // arbitrary expression in a UNION's trailing ORDER BY ("invalid
    // UNION/INTERSECT/EXCEPT ORDER BY clause") — only an output column name
    // or ordinal position is legal there, unlike a plain single SELECT.
    const pendingQueue = await many(
      `SELECT f.run_id, f.finding_fingerprint, f.severity, f.category,
              f.primary_file, f.detail_snapshot, f.source_model,
              f.user_action, f.remediation_state, f.created_at, f.bucket,
              (CASE f.severity WHEN 'HIGH' THEN 3 WHEN 'MEDIUM' THEN 2 WHEN 'LOW' THEN 1 ELSE 0 END) AS severity_rank
         FROM audit_findings f
         JOIN audit_runs r ON r.id = f.run_id
        WHERE r.repo_id = $1 AND f.bucket = 'shadow-only'
       UNION ALL
       SELECT f.run_id, f.finding_fingerprint, f.severity, f.category,
              f.primary_file, f.detail_snapshot, f.source_model,
              f.user_action, f.remediation_state, f.created_at, f.bucket,
              (CASE f.severity WHEN 'HIGH' THEN 3 WHEN 'MEDIUM' THEN 2 WHEN 'LOW' THEN 1 ELSE 0 END) AS severity_rank
         FROM audit_findings f
         JOIN audit_runs r ON r.id = f.run_id
        WHERE r.repo_id = $1 AND f.bucket IS NULL
          AND f.remediation_state IN ('fixed', 'verified')
          AND f.user_action IS NULL
        ORDER BY severity_rank DESC, created_at DESC
        LIMIT $2`,
      [repoId, queueLimit]
    );
    // Exact totals, INDEPENDENT of queueLimit. `shadowOnlyQueue` above is a
    // bounded page (default 50), so counting it would under-report the moment the
    // backlog exceeds the limit — and this repo already has ~63 unadjudicated
    // shadow findings, so that is the live case, not a hypothetical. Grouping by
    // the two axes keeps the result tiny (a handful of rows) and lets the pure
    // classifier own the semantics; SQL never encodes the rules.
    const actionablePairs = await many(
      `SELECT f.user_action, f.remediation_state, COUNT(*) AS n
         FROM audit_findings f
         JOIN audit_runs r ON r.id = f.run_id
        WHERE r.repo_id = $1 AND f.bucket = 'shadow-only'
        GROUP BY f.user_action, f.remediation_state`,
      [repoId]
    );
    // `n` here is the DENOMINATOR of every per-run rate the final-review
    // experiment quotes ("~1.1 accepted HIGH/MED per run"). Replay runs — a
    // saved transcript pushed back through a reviewer to compare models — are
    // not audits of anything, so counting them deflates the rate by however many
    // replays were collected. Excluded by tag, and the count of what was
    // excluded is returned rather than dropped: a silent filter is how a reader
    // ends up trusting a number whose population they cannot see.
    //
    // The adjudication queue above deliberately does NOT filter. Judging a
    // replay's findings is the entire point of running one, and each queue row
    // carries its run_id, so an operator can always tell which is which.
    const experimentFilter = await columnExists('audit_runs', 'experiment_tag', many, isCloudEnabled)
      ? 'AND r.experiment_tag IS NULL' : '';
    const runs = await many(
      `SELECT r.final_review_model, r.final_review_shadow_model,
              COUNT(*) AS n,
              COALESCE(SUM(r.final_review_shadow_input_tokens), 0)  AS shadow_input_tokens,
              COALESCE(SUM(r.final_review_shadow_output_tokens), 0) AS shadow_output_tokens,
              COALESCE(SUM(r.final_review_shadow_latency_ms), 0)    AS shadow_latency_ms
         FROM audit_runs r
        WHERE r.repo_id = $1 AND r.final_review_model IS NOT NULL ${experimentFilter}
        GROUP BY r.final_review_model, r.final_review_shadow_model
        ORDER BY n DESC`,
      [repoId]
    );
    const experimentRuns = experimentFilter
      ? (await many(
          `SELECT r.experiment_tag, COUNT(*) AS n
             FROM audit_runs r
            WHERE r.repo_id = $1 AND r.final_review_model IS NOT NULL
              AND r.experiment_tag IS NOT NULL
            GROUP BY r.experiment_tag ORDER BY n DESC`,
          [repoId]
        ))
      : [];
    return { ok: true, cloud: true, repoId, buckets, shadowOnlyQueue, pendingQueue, actionablePairs, runs, experimentRuns };
  } catch (err) {
    process.stderr.write(`  [final-review-stats] query failed: ${err.message}\n`);
    return { ok: false, cloud: true, repoId, buckets: [], shadowOnlyQueue: [], pendingQueue: [], actionablePairs: [], runs: [], experimentRuns: [], error: err.message };
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
  if (!runId) return { applied: false, rows: 0, reason: 'no-run-id' };
  if (!await isCloudEnabled()) return { applied: false, rows: 0, reason: 'cloud-off' };
  const hasRound = await detectPassStatsRoundColumn();
  // Model-A/B/C per-arm-execution columns (migration 20260701120000): written
  // only when present AND the caller supplied them, so the normal audit path is
  // byte-identical on an un-migrated store or when not shadowing.
  const armCols = {};
  if (stats.sourceModel !== undefined && await columnExists('audit_pass_stats', 'source_model', many, isCloudEnabled)) armCols.source_model = stats.sourceModel;
  if (stats.stage !== undefined && await columnExists('audit_pass_stats', 'stage', many, isCloudEnabled)) armCols.stage = stats.stage;
  if (stats.structuredOutputOk !== undefined && await columnExists('audit_pass_stats', 'structured_output_ok', many, isCloudEnabled)) armCols.structured_output_ok = stats.structuredOutputOk;
  if (stats.costUsd !== undefined && await columnExists('audit_pass_stats', 'cost_usd', many, isCloudEnabled)) armCols.cost_usd = stats.costUsd;
  if (stats.usageUnmeterable !== undefined && await columnExists('audit_pass_stats', 'usage_unmeterable', many, isCloudEnabled)) armCols.usage_unmeterable = stats.usageUnmeterable;
  // v2 (migration 20260701140000): the explicit arm for per-arm cost attribution
  // (B-gemini vs C-gemini share stage='gemini' + model, so cost splits by arm).
  if (stats.arm !== undefined && await columnExists('audit_pass_stats', 'arm', many, isCloudEnabled)) armCols.arm = stats.arm;
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
      ...armCols,
    });
    return { applied: true, rows: 1 };
  } catch (err) {
    process.stderr.write(`  [learning] recordPassStats failed: ${err.message}\n`);
    // Receipt, same contract as recordFindings: the caller cannot otherwise tell
    // a persisted stat row from a swallowed failure.
    return { applied: false, rows: 0, reason: 'write-failed', error: err };
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
 * The durable `reason` for a reopened finding. Keeps the historical
 * `Scope changed` prefix (so any existing query still matches) and appends the
 * distinction the column previously threw away: did the MODEL claim this
 * reopen, or did only the mechanical file-touch rule fire?
 *
 * `declared=no` on a `dismissed` entry is the churn shape — a false positive
 * the operator disproved, re-raised because an unrelated edit touched the same
 * file, with the model itself making no claim that anything invalidated the
 * ruling. Counting those over real rounds is what the deferred reopen-policy
 * decision needs (docs/plans/dismissed-fp-reopen-policy.md).
 *
 * @param {object} f - a reopened finding, post-`suppressReRaises`
 * @returns {string}
 */
export function reopenReason(f) {
  const declared = f?._reopenDeclared === true;
  // `_matchedOutcome` is absent on findings produced by an older bundle; report
  // it as `unknown` rather than implying `dismissed`, so a version skew cannot
  // silently inflate the churn count this string exists to measure.
  const outcome = f?._matchedOutcome ?? 'unknown';
  return `Scope changed; declared=${declared ? 'yes' : 'no'}; matched=${outcome}`;
}

/**
 * Record both suppressed-and-reopened events from an R2+ post-processing pass.
 */
export async function recordSuppressionEvents(runId, suppressionResult) {
  if (!runId) return { applied: false, rows: 0, reason: 'no-run-id' };
  if (!await isCloudEnabled()) return { applied: false, rows: 0, reason: 'cloud-off' };
  const rows = [
    ...suppressionResult.suppressed.map((s) => ({
      run_id: runId,
      finding_fingerprint: fingerprintOf(s.finding),
      matched_topic_id: s.matchedTopic,
      match_score: s.matchScore,
      action: 'suppressed',
      reason: s.reason,
    })),
    ...suppressionResult.reopened.map((f) => ({
      run_id: runId,
      finding_fingerprint: fingerprintOf(f),
      matched_topic_id: f._matchedTopic,
      match_score: f._matchScore,
      action: 'reopened',
      // `reason` was the hardcoded literal 'Scope changed' — identical for every
      // reopen, so the ONLY durable record of a reopen could not distinguish a
      // model-declared, line-citing reopen from a purely mechanical file-touch
      // reopen of a dismissal (the 2026-08-14 cluster-A shape). A constant in a
      // telemetry column reads as a measurement while carrying no information;
      // the per-run stderr/result-JSON counters do not survive the run, so
      // without this the signal the reopen-policy decision needs never
      // accumulated anywhere. Free-text column, so no migration — the prefix is
      // preserved for any existing query.
      reason: reopenReason(f),
    })),
  ];
  // Terminal for a replayed artifact: a suppression result with no suppressed
  // and no reopened findings maps to zero rows on every attempt.
  if (rows.length === 0) return { applied: true, rows: 0, reason: 'no-rows' };
  try {
    const pool = await getPool();
    if (!pool) return { applied: false, rows: 0, reason: 'no-pool' };
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
    return { applied: true, rows: rows.length };
  } catch (err) {
    process.stderr.write(`  [learning] recordSuppressionEvents failed: ${err.message}\n`);
    return { applied: false, rows: 0, reason: 'write-failed', error: err };
  }
}

// ── finding_adjudication_events ────────────────────────────────────────────

/**
 * Build the denormalised `audit_findings` patch for an adjudication event.
 * Pure + exported so the propagation contract is unit-testable without a DB.
 *
 * `remediation_state` (fix-lifecycle plan, gap #2): the `unlocked_fixes` view
 * reads `audit_findings.remediation_state`, but this UPDATE historically set
 * only `adjudication_outcome`, so the column was write-never and the view was
 * permanently empty. It is now propagated here — **only when the event carries a
 * value** (`!= null`), so an adjudication event lacking `remediationState` can
 * never null an existing state (monotonic-safe).
 *
 * @param {{adjudicationOutcome: string, remediationState?: string|null}} event
 * @param {Date} decidedAt
 * @returns {Record<string, unknown>}
 */
export function buildFindingAdjudicationPatch(event, decidedAt) {
  // decided_at (model-swap-eval-harness Phase 4 migration 20260713110000) — the
  // only column recording WHEN a finding was adjudicated; created_at is when it
  // was RAISED, not decided.
  const patch = { adjudication_outcome: event.adjudicationOutcome, decided_at: decidedAt };
  if (event.remediationState != null) patch.remediation_state = event.remediationState;
  return patch;
}

/**
 * Record an adjudication event for a finding. Two-step:
 *   1. Resolve the audit_findings.id from the finding fingerprint
 *      (+ optional pass_name / round_raised disambiguation)
 *   2. Inside a transaction:
 *        - DELETE any prior adjudication events on this finding (idempotent re-record)
 *        - INSERT the new event
 *        - UPDATE audit_findings.adjudication_outcome + remediation_state (denormalised)
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
      await updateWhere('audit_findings', buildFindingAdjudicationPatch(event, new Date()), { id: finding.id });
    });
  } catch (err) {
    process.stderr.write(`  [learning] recordAdjudicationEvent failed: ${err.message}\n`);
  }
}

// ── Fix-lifecycle projection (docs/plans/remediation-state-fix-lifecycle.md) ──

const TERMINAL_REMEDIATION = new Set(['fixed', 'verified', 'regressed']);

/**
 * PURE. Index a ledger's terminal-state entries by finding fingerprint →
 * remediationState, for O(1) reconciliation lookup. Non-terminal entries are
 * excluded (only fixed/verified/regressed are projected to the DB).
 * @param {object} ledger
 * @returns {Map<string,string>} fingerprint → terminal remediationState
 */
export function buildLedgerTerminalIndex(ledger) {
  const idx = new Map();
  for (const e of (ledger?.entries || [])) {
    if (!TERMINAL_REMEDIATION.has(e.remediationState)) continue;
    const fp = e.semanticHash;
    if (fp) idx.set(fp, e.remediationState);
  }
  return idx;
}

/**
 * PURE. Given recent DB rows `{finding_fingerprint, remediation_state}` and the
 * ledger terminal index, return the subset whose DB state DISAGREES with the
 * ledger's terminal state (a matching state is a no-op; a fingerprint absent
 * from the index is left alone). This is what makes the reconciliation both
 * bounded (caller supplies only recent rows) and COMPLETE — it heals
 * pending→terminal AND terminal→terminal divergence (Gemini-gate-3), unlike a
 * `remediation_state='pending'`-only filter.
 * @param {Array<{finding_fingerprint:string, remediation_state:string}>} dbRows
 * @param {Map<string,string>} index
 * @returns {Array<{fingerprint:string, state:string}>}
 */
export function selectReconcileTargets(dbRows, index) {
  const out = [];
  for (const row of dbRows || []) {
    const want = index.get(row.finding_fingerprint);
    if (want && want !== row.remediation_state) out.push({ fingerprint: row.finding_fingerprint, state: want });
  }
  return out;
}

/** Resolve a lifecycle update's target state from an explicit `state` or an action. */
function updateTargetState(u) {
  return u.state || (u.action === 'mark-regressed' ? 'regressed' : u.action === 'mark-fixed' ? 'fixed' : null);
}

/**
 * PURE. Partition raw lifecycle updates into `{valid, rejected}` — a valid
 * update has both a resolvable terminal `state` and a `findingFingerprint`.
 * Exported so validation is unit-testable directly (not masked behind a
 * cloud-off no-op — audit R1/M7). `rejected` carries a reason per input.
 * @param {Array<object>} updates
 * @returns {{valid: Array<{fingerprint:string, state:string, resolvedRound:number|null}>, rejected: Array<{update:object, reason:string}>}}
 */
export function normalizeRemediationUpdates(updates) {
  const valid = [], rejected = [];
  for (const u of (Array.isArray(updates) ? updates : [])) {
    const state = updateTargetState(u);
    const fingerprint = u.findingFingerprint || u.fingerprint;
    if (!state) { rejected.push({ update: u, reason: 'no resolvable remediation state' }); continue; }
    if (!TERMINAL_REMEDIATION.has(state)) { rejected.push({ update: u, reason: `non-terminal state "${state}"` }); continue; }
    if (!fingerprint) { rejected.push({ update: u, reason: 'missing findingFingerprint' }); continue; }
    valid.push({ fingerprint, state, resolvedRound: u.resolvedRound ?? null });
  }
  return { valid, rejected };
}

/**
 * Project fix-lifecycle updates onto `audit_findings.remediation_state` for a
 * repo, addressing rows by `(repo_id, finding_fingerprint)` within the
 * `unlocked_fixes` 14-day window (the exact population the view reads). Updates
 * the denormalised column AND upserts the parallel `finding_adjudication_events`
 * row. Fail-open (never throws to the audit). Idempotent — setting the same
 * state twice is a no-op. The `audit_findings` write asserts an affected row
 * (RETURNING id): a 0-row update is logged, never silently counted as success
 * (audit R1/H2 — gate honesty).
 *
 * @param {string} repoId - audit_repos.id
 * @param {Array<{findingFingerprint:string, state?:string, action?:string, resolvedRound?:number}>} updates
 * @returns {Promise<{updated:number}>}
 */
/**
 * The single write of a terminal `remediation_state` onto an ALREADY-RESOLVED
 * `audit_findings.id` — extracted from `markFindingsRemediation`'s loop body
 * (behaviour-preserving; locked by its existing test suite) so a second
 * caller that already knows the row id (no fingerprint/window resolution
 * needed) doesn't duplicate this transaction's careful rules. See the inline
 * comments below for what each of them protects against.
 *
 * @param {string} findingId - audit_findings.id, already resolved by the caller
 * @param {string} state - a member of TERMINAL_REMEDIATION
 * @param {{resolvedRound?: number|null}} [opts]
 * @returns {Promise<number>} rows affected in audit_findings (0 or 1)
 */
async function projectRemediationState(findingId, state, { resolvedRound = null } = {}) {
  return withTx(async () => {
    // `user_action` is filled here, and ONLY out of an undecided state.
    //
    // The two axes are independent (`remediation_state` = did a fix land;
    // `user_action` = what did we decide about the finding), and nothing
    // has ever written the second one at fix time — so a finding could be
    // fixed, have its fix recorded, and still read as never adjudicated.
    // Measured 2026-08-23 on the live store: **1,512 findings in this repo
    // alone (549 HIGH) carried remediation_state fixed/verified with
    // user_action NULL**, which is why the credit for a real catch lands in
    // a source comment and the audit's tail reads as noise. A shipped fix
    // is evidence the finding was real, which is exactly the inference
    // `/ship` Step 6.7's card already offers a human ("`accepted` only for a
    // fixed-but-unlabelled one").
    //
    // The NULL/`needs_triage` guard is the same one the `needs_triage` and
    // `auto_dismissed` writers above use, and it is what keeps this a
    // PROJECTION rather than a re-adjudication: a human `dismissed`,
    // `deferred` or `accepted-permanent` is never overwritten. A
    // `dismissed` row that later lands a fix stays contradictory ON PURPOSE
    // — `classifyFinalReviewOutcome` surfaces those for reconciliation, and
    // silently resolving one here is what the sibling comment below refuses
    // to do for `adjudication_outcome`.
    // `$1 IN ('fixed','verified')` is load-bearing: `TERMINAL_REMEDIATION`
    // also admits `regressed`, and a regressed finding is terminal but
    // emphatically NOT fixed — stamping `fix-now` on one would fabricate a
    // decision nobody made, out of the one signal that says the opposite.
    const rows = await many(
      `UPDATE audit_findings
          SET remediation_state = $1,
              user_action = CASE
                WHEN $1 IN ('fixed','verified')
                 AND (user_action IS NULL OR user_action = 'needs_triage')
                THEN 'fix-now'
                ELSE user_action END
        WHERE id = $2 RETURNING id`,
      [state, findingId]
    );
    if (rows.length === 0) return 0; // 0-row → do not write a phantom event
    // UPDATE, never delete+insert: `finding_adjudication_events.adjudication_outcome`
    // is NOT NULL with no default, and this projector never re-adjudicates a
    // finding (Gemini-gate-2 — that would desync the DB from a human
    // severity_adjusted ruling), so it must touch remediation_state (+round,
    // when known) only, leaving adjudication_outcome/ruling/ruling_rationale
    // untouched on the existing row.
    const eventRows = resolvedRound != null
      ? await many(
          `UPDATE finding_adjudication_events SET remediation_state = $1, round = $2 WHERE finding_id = $3 RETURNING id`,
          [state, resolvedRound, findingId]
        )
      : await many(
          `UPDATE finding_adjudication_events SET remediation_state = $1 WHERE finding_id = $2 RETURNING id`,
          [state, findingId]
        );
    if (eventRows.length === 0) {
      process.stderr.write(`  [lifecycle] projectRemediationState(${findingId}): audit_findings projected but no adjudication_events row exists to update\n`);
    }
    return rows.length;
  });
}

export async function markFindingsRemediation(repoId, updates) {
  if (!repoId || !await isCloudEnabled()) return { updated: 0, attempted: 0 };
  const { valid } = normalizeRemediationUpdates(updates);
  if (valid.length === 0) return { updated: 0, attempted: 0 };
  // `attempted` is returned alongside `updated` (audit 2026-08-13) so a caller
  // can see a SHORTFALL without re-deriving it. This is fail-open PER ROW: a
  // throw is caught, logged, and the loop continues — so `updated` alone cannot
  // distinguish "projected all 5" from "projected 2 of 5 and logged 3 failures",
  // and the on-disk ledger then diverges from the store with nobody counting.
  let updated = 0;
  for (const { fingerprint: fp, state, resolvedRound } of valid) {
    try {
      const finding = await one(
        `SELECT f.id FROM audit_findings f JOIN audit_runs r ON r.id = f.run_id
         WHERE r.repo_id = $1 AND f.finding_fingerprint = $2
           AND r.created_at > now() - interval '14 days'
         ORDER BY f.created_at DESC LIMIT 1`,
        [repoId, fp]
      );
      if (!finding?.id) continue;
      const affected = await projectRemediationState(finding.id, state, { resolvedRound });
      if (affected > 0) updated += 1;
      else process.stderr.write(`  [lifecycle] markFindingsRemediation(${fp}): 0-row update (finding vanished) — not counted\n`);
    } catch (err) {
      process.stderr.write(`  [lifecycle] markFindingsRemediation(${fp}) failed: ${err.message}\n`);
    }
  }
  return { updated, attempted: valid.length };
}

// ── Remediation-state verification reconciler writer ────────────────────────
// docs/plans/remediation-state-verification-reconciler.md. ID-addressed —
// unlike `markFindingsRemediation` above, the caller already knows
// `audit_finding_id` (it came straight off the row
// `getStaleAcceptedFindingsForVerification` selected), so there is no
// fingerprint+window resolution to do and no reason to inherit that
// function's 14-day bound, which would defeat this reconciler's entire
// purpose. `resolved` writes the terminal `remediation_state='verified'`
// (via the same `projectRemediationState` transaction `markFindingsRemediation`
// uses); `still-present`/`uncertain` only bump the two throttle columns —
// this is what stops an unresolved verdict from being re-asked on every
// subsequent run while the file sits unchanged (see the plan's Decision B).

const VALID_VERIFICATION_OUTCOMES = new Set(['resolved', 'still-present', 'uncertain']);

/**
 * Apply out-of-band verification results to `audit_findings`. Fail-open PER
 * ACTION, mirroring `markFindingsRemediation` — one bad row never aborts the
 * batch.
 *
 * @param {string} repoId
 * @param {Array<{findingId: string, outcome: 'resolved'|'still-present'|'uncertain',
 *                 checkedAtCommit: string, rationale?: string}>} actions
 * @returns {Promise<{updated: number, attempted: number}>}
 */
export async function applyRemediationVerificationResults(repoId, actions) {
  if (!repoId || !await isCloudEnabled()) return { updated: 0, attempted: 0 };
  const valid = (Array.isArray(actions) ? actions : []).filter(
    (a) => a && typeof a.findingId === 'string' && a.findingId
      && VALID_VERIFICATION_OUTCOMES.has(a.outcome) && typeof a.checkedAtCommit === 'string' && a.checkedAtCommit
  );
  if (valid.length === 0) return { updated: 0, attempted: 0 };
  // A store that hasn't yet run the `remediation_last_checked_*` migration
  // (a consumer on its own DSN, not-yet-migrated) degrades to "the throttle
  // columns are absent" — probed once (columnExists caches per-process), not
  // per action, and skipped rather than left to fail loudly on every row.
  // The terminal write below never touches these columns, so a `resolved`
  // verdict still lands correctly either way — only the re-check throttle is
  // unavailable until the store migrates, which fails toward MORE
  // verification (never toward silently skipping a real check).
  const hasThrottleColumns = await columnExists('audit_findings', 'remediation_last_checked_at', many, isCloudEnabled);
  let updated = 0;
  for (const { findingId, outcome, checkedAtCommit } of valid) {
    try {
      if (outcome === 'resolved') {
        const affected = await projectRemediationState(findingId, 'verified', { resolvedRound: null });
        if (affected === 0) {
          process.stderr.write(`  [lifecycle] applyRemediationVerificationResults(${findingId}): 0-row update on the terminal write (finding vanished) — not counted\n`);
          continue;
        }
        if (!hasThrottleColumns) { updated += 1; continue; }
      } else if (!hasThrottleColumns) {
        // Nothing to project (not resolved) and nowhere to stamp the throttle
        // — genuinely a no-op on this store, not a failure.
        continue;
      }
      // Tracking columns are bumped for EVERY outcome, including the terminal
      // one above — a single UPDATE covers both, since a resolved finding's
      // row still needs the "last checked" stamp like any other.
      const rows = await many(
        `UPDATE audit_findings SET remediation_last_checked_at = now(), remediation_last_checked_commit = $1
          WHERE id = $2 RETURNING id`,
        [checkedAtCommit, findingId]
      );
      if (rows.length > 0) updated += 1;
      else process.stderr.write(`  [lifecycle] applyRemediationVerificationResults(${findingId}): 0-row tracking-column update (finding vanished) — not counted\n`);
    } catch (err) {
      process.stderr.write(`  [lifecycle] applyRemediationVerificationResults(${findingId}) failed: ${err.message}\n`);
    }
  }
  return { updated, attempted: valid.length };
}

/**
 * Self-healing sweep (fail-open). DB-DRIVEN for O(recent): fetch the repo's
 * `audit_findings` rows within the 14-day `unlocked_fixes` window (regardless of
 * current remediation_state — Gemini-gate-3), then project any whose state
 * disagrees with the ledger's terminal index. Heals a projection that a prior
 * round's fail-open write dropped, including terminal→terminal (fixed→regressed)
 * divergence a pending-only filter would miss.
 *
 * @param {string} repoId
 * @param {object} ledger - parsed adjudication ledger
 * @returns {Promise<{reconciled:number}>}
 */
export async function reconcileRemediationProjection(repoId, ledger) {
  if (!repoId || !await isCloudEnabled()) return { reconciled: 0, attempted: 0, ok: true, reason: 'cloud-off' };
  const index = buildLedgerTerminalIndex(ledger);
  if (index.size === 0) return { reconciled: 0, attempted: 0, ok: true, reason: 'empty-ledger' };
  try {
    const rows = await many(
      `SELECT f.finding_fingerprint, f.remediation_state
       FROM audit_findings f JOIN audit_runs r ON r.id = f.run_id
       WHERE r.repo_id = $1 AND r.created_at > now() - interval '14 days'
         AND f.adjudication_outcome IN ('accepted','severity_adjusted')`,
      [repoId]
    );
    const targets = selectReconcileTargets(rows, index);
    if (targets.length === 0) return { reconciled: 0, attempted: 0, ok: true, reason: 'already-consistent' };
    const { updated, attempted } = await markFindingsRemediation(repoId, targets);
    return { reconciled: updated, attempted, ok: true, reason: null };
  } catch (err) {
    process.stderr.write(`  [lifecycle] reconcileRemediationProjection failed: ${err.message}\n`);
    // `ok:false` is the whole point of this return (audit 2026-08-13). This used
    // to be a bare `{reconciled: 0}` — byte-identical to the HEALTHY
    // "already-consistent" case above. A sweep that THREW and a projection that
    // needed no healing are opposite facts, and the caller could not tell them
    // apart: the self-heal silently not running looked exactly like the
    // self-heal having nothing to do. That is the believable-false-zero shape
    // the durability work exists to eliminate, in the very function whose job
    // is to repair divergence.
    return { reconciled: 0, attempted: 0, ok: false, reason: err.message };
  }
}

// ── Skill-efficacy census (docs/plans/skill-efficacy-census.md Phase 2) ────

/**
 * Window-scoped counts for `audit-code`/`audit-plan`, keyed by `audit_runs.mode`.
 *
 * Returns TWO numbers, never collapsed to one (§2 H2 fix): `roundCount` is
 * the raw row count — `audit_runs` rows are per-ROUND, not per-invocation, so
 * this over-counts a multi-round session. `commitsTouched` (distinct
 * `commit_sha`) is a LOWER BOUND on invocation count instead — a commit can
 * receive multiple separate sessions, and a session can re-run without a new
 * commit, so neither number alone is "invocations"; the census reports both,
 * labelled honestly.
 *
 * @param {string} repoId
 * @param {'code'|'plan'} mode
 * @param {{currentStart: string, priorStart: string, now: string}} bounds ISO timestamps
 * @returns {Promise<{roundCount: {current:number,prior:number,allTime:number}, commitsTouched: {current:number,prior:number,allTime:number}}|null>}
 */
export async function getAuditRunWindowCounts(repoId, mode, { currentStart, priorStart, now }) {
  if (!repoId || !await isCloudEnabled()) return null;
  try {
    const row = await many(
      `SELECT
         count(*) FILTER (WHERE created_at >= $3 AND created_at < $4) AS round_current,
         count(*) FILTER (WHERE created_at >= $5 AND created_at < $3) AS round_prior,
         count(*) AS round_all_time,
         count(DISTINCT commit_sha) FILTER (WHERE created_at >= $3 AND created_at < $4) AS commits_current,
         count(DISTINCT commit_sha) FILTER (WHERE created_at >= $5 AND created_at < $3) AS commits_prior,
         count(DISTINCT commit_sha) AS commits_all_time
         FROM audit_runs WHERE repo_id = $1 AND mode = $2`,
      [repoId, mode, currentStart, now, priorStart],
    );
    const r = row[0] || {};
    const n = (v) => Number(v) || 0;
    return {
      roundCount: { current: n(r.round_current), prior: n(r.round_prior), allTime: n(r.round_all_time) },
      commitsTouched: { current: n(r.commits_current), prior: n(r.commits_prior), allTime: n(r.commits_all_time) },
    };
  } catch (err) {
    process.stderr.write(`  [learning] getAuditRunWindowCounts failed: ${err.message}\n`);
    return null;
  }
}

/**
 * Conversion rate for `audit-code`/`audit-plan` (the only two skills with an
 * `audit_findings` finding lifecycle) — §2's precise definition.
 *
 * **Cohort = raise-time** (`audit_findings.created_at` in the window), never
 * fix-time — a finding raised late in the window may still show pending at
 * report time even though it is later fixed; that is expected. **Numerator
 * is a strict SUBSET of the denominator's WHERE clause** (round-3 H1 fix):
 * denominator = distinct accepted fingerprints in the cohort; numerator =
 * distinct fingerprints WITHIN that same accepted set that are also
 * fixed/verified. This guards against the numerator including a
 * fixed-but-never-accepted finding, which could push the rate above 100%.
 *
 * **Right-censoring**: evaluated at report time (current DB state), so a
 * `current`-window cohort has had systematically less time to accumulate a
 * fix than `prior`'s — the caller must render the maturity caveat and must
 * never use this to gate a verdict (§4's decision rubric deliberately does
 * not).
 *
 * @param {string} repoId
 * @param {'code'|'plan'} mode
 * @param {{currentStart: string, priorStart: string, now: string}} bounds ISO timestamps
 * @returns {Promise<{current: {numerator:number,denominator:number}, prior: {numerator:number,denominator:number}}|null>}
 */
export async function getAuditFindingConversionRate(repoId, mode, { currentStart, priorStart, now }) {
  if (!repoId || !await isCloudEnabled()) return null;
  try {
    const row = await many(
      `SELECT
         count(DISTINCT f.finding_fingerprint) FILTER (
           WHERE f.created_at >= $3 AND f.created_at < $4 AND f.adjudication_outcome = 'accepted'
         ) AS current_denominator,
         count(DISTINCT f.finding_fingerprint) FILTER (
           WHERE f.created_at >= $3 AND f.created_at < $4 AND f.adjudication_outcome = 'accepted'
             AND f.remediation_state IN ('fixed', 'verified')
         ) AS current_numerator,
         count(DISTINCT f.finding_fingerprint) FILTER (
           WHERE f.created_at >= $5 AND f.created_at < $3 AND f.adjudication_outcome = 'accepted'
         ) AS prior_denominator,
         count(DISTINCT f.finding_fingerprint) FILTER (
           WHERE f.created_at >= $5 AND f.created_at < $3 AND f.adjudication_outcome = 'accepted'
             AND f.remediation_state IN ('fixed', 'verified')
         ) AS prior_numerator
         FROM audit_findings f
         JOIN audit_runs r ON r.id = f.run_id
        WHERE r.repo_id = $1 AND r.mode = $2`,
      [repoId, mode, currentStart, now, priorStart],
    );
    const r = row[0] || {};
    const n = (v) => Number(v) || 0;
    return {
      current: { numerator: n(r.current_numerator), denominator: n(r.current_denominator) },
      prior: { numerator: n(r.prior_numerator), denominator: n(r.prior_denominator) },
    };
  } catch (err) {
    process.stderr.write(`  [learning] getAuditFindingConversionRate failed: ${err.message}\n`);
    return null;
  }
}
