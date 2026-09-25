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
import { findingKeyString, selectFindingRow } from './finding-identity.mjs';
import { applyFindingWrite } from './finding-write.mjs';
// Imported, never re-exported (learning-store.mjs does `export *` from here).
import { CREDIT_BRANCH_SHADOW_WHERE, CREDIT_BRANCH_PRIMARY_LABEL_GAP_WHERE, pendingQueueSql, UNRULED_WHERE } from './final-review-credit-population.mjs';
import crypto from 'node:crypto';
import { semanticSuppressConfig } from '../config.mjs';
import { partitionRecordTimeReRaises, toVectorLiteral } from '../semantic-suppression.mjs';
import { embedText, findingEmbeddingSpace } from '../embed-text.mjs';

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
    // ONE space for the whole batch: `requestModel` goes on the wire (a bare
    // Azure deployment; the endpoint-qualified id 404s), `provenanceId` is what
    // gets persisted and compared. Both were `symbolIndexConfig.embedModel` —
    // the GEMINI default — even when embedText routed to Azure, so the stored
    // provenance did not describe the vectors that were made.
    const space = findingEmbeddingSpace();
    const embed = async (text) => {
      const { result } = await embedText(text, { dim: space.dim, model: space.requestModel });
      return result;
    };
    const { kept, suppressed, vectorByFinding } = await partitionRecordTimeReRaises({
      pool, repoId, runId, findings, embed,
      threshold: semanticSuppressConfig.threshold,
      requireSameFile: semanticSuppressConfig.requireSameFile,
      embeddingSpace: space,
      log: (m) => process.stderr.write(m + '\n'),
    });
    if (suppressed.length) {
      process.stderr.write(`  [semantic-suppress] recorded ${kept.length}, suppressed ${suppressed.length} re-raise(s) of existing open findings\n`);
    }
    return { kept, vectorByFinding, embeddingSpace: space };
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
 * `isCallerTx` (write-boundary-hardening plan Phase 7, debt 3c3f95142582):
 * routed through `finding-write.mjs`'s `applyFindingWrite` with
 * `expectAffected: null` — this function does not know in advance whether a
 * `WHERE EXISTS(...)`-guarded row will match (0 or 1 is both legitimate), so
 * it skips the count check entirely rather than asserting a specific number.
 * A 0-row result is NOT a Postgres error, and NOT itself a sign the
 * transaction is poisoned, so it stays a per-row `failed` count exactly as
 * before. A genuinely THROWN error (constraint violation, bad vector
 * literal, connection issue) is what poisons a caller-supplied transaction —
 * previously swallowed unconditionally by this function's own `try`/`catch`
 * even when `exec` was the caller's open transaction client, so the caller's
 * later `COMMIT` silently degraded to `ROLLBACK` with no signal. `isCallerTx`
 * makes that propagate instead, mirroring `recordFindings`' own
 * `if (opts.client) throw err` for its own statement — set from the SAME
 * `!!opts.client` `recordFindings` already computes, not re-derived.
 *
 * `idByKey` (round-2 audit H4 — renamed from `idByFingerprint`): keyed by
 * `findingKeyString({fingerprint, bucket})`, not fingerprint alone. Write-
 * boundary-hardening plan Phase 3 made it possible for TWO findings sharing a
 * fingerprint but differing in bucket to both persist in one batch — a
 * fingerprint-only map could then only hold ONE of their ids (`Map` silently
 * overwrites on a duplicate key), so the other's embedding would be attached
 * to the WRONG finding_id. `hasBucket` must be the SAME value the caller used
 * to build `idByKey`, so the lookup key agrees with how it was built.
 *
 * @param {boolean} [isCallerTx] - true when `exec` is inside an open transaction
 * @param {boolean} [hasBucket] - whether this store has the `bucket` column;
 *   must match what the caller used when building `idByKey`
 * @returns {Promise<{persisted: number, failed: number}>}
 */
export async function persistKeptEmbeddings(exec, keptFindings, vectorByFinding, idByKey, runId, embeddingSpace, isCallerTx = false, hasBucket = false) {
  const result = { persisted: 0, failed: 0 };
  if (!vectorByFinding || vectorByFinding.size === 0) return result;
  // The space these vectors were ACTUALLY made in, passed down from the call
  // that made them. Re-resolving it here would look identical today and
  // mislabel the batch the moment the two resolutions can disagree — the exact
  // shape of the bug being fixed. The fallback covers only direct unit-test
  // callers; production always threads it.
  const space = embeddingSpace || findingEmbeddingSpace();
  for (const f of keptFindings) {
    const vec = vectorByFinding.get(f);
    if (!vec) continue;
    const key = findingKeyString({ fingerprint: fingerprintOf(f), bucket: hasBucket ? normaliseBucket(f._bucket) : undefined });
    const id = idByKey.get(key);
    if (!id) continue;
    const text = (typeof f.detail === 'string' ? f.detail : '').slice(0, 500);
    const hash = crypto.createHash('sha256').update(text).digest('hex').slice(0, 16);
    // expectAffected:null — a 0-row EXISTS-guard miss must NOT be treated the
    // same as a thrown error by applyFindingWrite; only a real exception
    // should propagate under isCallerTx:true. This function decides what a
    // 0-row result means (below), applyFindingWrite decides only whether an
    // EXCEPTION propagates.
    //
    // round-5 audit M1: embeddings are explicitly BEST-EFFORT (this whole
    // function's contract — one failed write must cost one embedding, never
    // the batch), but under isCallerTx:true a thrown error does not merely
    // fail JS-side: Postgres itself aborts the OUTER transaction at the
    // statement level, poisoning the primary findings that were ALREADY
    // inserted earlier in that same transaction — the exact "one bad
    // optional write costs the whole batch" failure this file's guards exist
    // to prevent, now happening one level up. `withTx`'s own re-entrant
    // SAVEPOINT nesting (it auto-detects the active transaction via
    // AsyncLocalStorage — no client threading needed) isolates each write:
    // a failure rolls back only its savepoint, so it costs exactly this one
    // embedding, and the outer transaction (the findings that matter) stays
    // valid. Caught HERE, not left to propagate — the savepoint rollback
    // already cleanly undid the damage, so this is now genuinely safe to
    // treat as a per-item failure, same as the isCallerTx:false path always
    // has.
    let write;
    try {
      // round-6 audit H3: `toVectorLiteral(vec)` throws synchronously (a
      // malformed/non-finite vector) and MUST be inside this try — building
      // it before the try block let that one exception bypass everything
      // below, including the round-5 savepoint isolation, and propagate
      // straight out to poison the outer transaction: the exact failure this
      // whole fix exists to prevent, just reached through a different door.
      const statement = {
        text: `INSERT INTO finding_embeddings (finding_id, embedding, embedding_model, dimension, snapshot_hash)
               SELECT $1::uuid, $2::vector, $3, $4, $5
                WHERE EXISTS (SELECT 1 FROM audit_findings af WHERE af.id = $1::uuid AND af.run_id = $6::uuid)
               ON CONFLICT (finding_id) DO UPDATE SET embedding=EXCLUDED.embedding, embedding_model=EXCLUDED.embedding_model, dimension=EXCLUDED.dimension, snapshot_hash=EXCLUDED.snapshot_hash, created_at=now()`,
        values: [id, toVectorLiteral(vec), space.provenanceId, space.dim, hash, runId],
      };
      // round-6 audit H1: the nested `withTx` callback must write through
      // the CLIENT `withTx` ITSELF HANDS BACK, never through the outer
      // closured `exec` — they only happen to be the same reference today
      // because every current caller threads `exec` in from an
      // AsyncLocalStorage-tracked client. Using the callback's own parameter
      // instead makes this correct BY CONSTRUCTION (the write always targets
      // whatever connection `withTx` is actually managing — a re-entrant
      // SAVEPOINT on the parent when one is active, or a fresh top-level
      // transaction otherwise) rather than by that coincidence holding.
      write = isCallerTx
        ? await withTx((spClient) => applyFindingWrite(spClient, statement, { expectAffected: null, isCallerTx: true }))
        : await applyFindingWrite(exec, statement, { expectAffected: null, isCallerTx: false });
    } catch (err) {
      result.failed++;
      process.stderr.write(`  [semantic-suppress] embedding persistence failed for finding ${id} (savepoint rolled back, outer transaction intact): ${err.message?.slice(0, 150)}\n`);
      continue;
    }
    if (write.outcome === 'failed') {
      result.failed++;
      process.stderr.write(`  [semantic-suppress] embedding persistence failed for finding ${id}: ${write.error?.message?.slice(0, 150)}\n`);
      continue;
    }
    if (write.affected === 0) {
      result.failed++;
      process.stderr.write(`  [semantic-suppress] embedding write affected 0 rows for finding ${id} (run ${runId}) — not persisted\n`);
      continue;
    }
    result.persisted++;
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
/**
 * Symmetric repo-identity match for `recordRunStart`'s reuse paths
 * (write-boundary-hardening plan Phase 6, debt 68dc4939db8b/6706b21a3335).
 * The prior guard only refused reuse when BOTH `existing.repo_id` and
 * `repoId` were present and differed — a mixed case (one side null, the
 * other set) silently allowed reuse in either direction: a legacy row with
 * a null `repo_id`, or a caller that forgot to thread `repoId`. Reuse is now
 * allowed only when both are non-null and equal, or both are null/absent
 * (the genuine single-tenant/local-only case) — any mixed case refuses.
 * @param {string|null|undefined} a
 * @param {string|null|undefined} b
 * @returns {boolean}
 */
function repoIdentityMatches(a, b) {
  if (a == null && b == null) return true;
  if (a == null || b == null) return false;
  return a === b;
}

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
        if (!repoIdentityMatches(existing.repo_id, repoId)) {
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
      if (existing?.id && repoIdentityMatches(existing.repo_id, repoId)) {
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
/**
 * @returns {Promise<{ok: boolean}|undefined>} `{ok:false}` on a caught write
 *   failure (write-boundary-hardening plan Phase 10) — mechanical, not new
 *   error-handling: the existing `try`/`catch` below already caught this
 *   outcome and only logged it; this makes it ALSO a return value so
 *   `recordFinalReviewFindings` can tell. Every pre-existing caller ignores
 *   the return value, so this is additive. `undefined` (the early returns
 *   above) means "nothing to write" — a different case from a write that was
 *   attempted and failed.
 */
export async function updateRunMeta(runId, meta, deps = {}) {
  // `deps` (round-3 audit H2 test seam): mirrors the injectable `deps = {}`
  // pattern `getRunFindings`/`getRunMeta` already use in this same file.
  // Defaults are the real store — production behavior is unchanged; a test
  // can inject `many`/`isCloudEnabled`/`updateWhereFn` to exercise the new
  // transient-vs-confirmed-absent branch without a live DB.
  const { many: manyFn = many, isCloudEnabled: cloudFn = isCloudEnabled, updateWhere: updateWhereFn = updateWhere } = deps;
  if (!runId) return;
  const update = {};
  if (meta.geminiVerdict != null)  update.gemini_verdict   = meta.geminiVerdict;
  if (meta.labeled != null)        update.labeled          = meta.labeled;
  if (meta.acceptedCount != null)  update.accepted_count   = meta.acceptedCount;
  if (meta.dismissedCount != null) update.dismissed_count  = meta.dismissedCount;
  // round-3 audit H2 (GPT deliberation: compromise, MEDIUM): this function
  // backs verdict persistence (`geminiVerdict` above), so a caller-supplied
  // optional field silently vanishing on an EXHAUSTED TRANSIENT probe — not a
  // confirmed-absent column — while the write still reports `{ok:true}` is
  // misleading in exactly the way GPT's ruling singled out. `probeColumnExistence`
  // exposes `definitive` so this one write site can tell the two apart and
  // surface a `partial` outcome; every other `columnExists` boolean-context
  // caller in this file is deliberately untouched (GPT explicitly rejected
  // widening all ~25 of them — that risks aborting a whole batch for one
  // optional field, the exact failure this file's guards exist to prevent).
  const skippedFields = [];
  async function tryColumn(value, table, col, updateKey) {
    if (value == null) return;
    const { present, definitive } = await probeColumnExistence(table, col, manyFn, cloudFn);
    if (present) { update[updateKey] = value; return; }
    if (!definitive) skippedFields.push(col);
  }
  // Final-review model attribution + shadow cost telemetry (migration
  // 20260610120000). columnExists-guarded so the write degrades cleanly on an
  // un-migrated store (omit the absent column rather than fail the UPDATE).
  await tryColumn(meta.finalReviewModel, 'audit_runs', 'final_review_model', 'final_review_model');
  await tryColumn(meta.finalReviewShadowModel, 'audit_runs', 'final_review_shadow_model', 'final_review_shadow_model');
  await tryColumn(meta.finalReviewShadowInputTokens, 'audit_runs', 'final_review_shadow_input_tokens', 'final_review_shadow_input_tokens');
  await tryColumn(meta.finalReviewShadowOutputTokens, 'audit_runs', 'final_review_shadow_output_tokens', 'final_review_shadow_output_tokens');
  await tryColumn(meta.finalReviewShadowLatencyMs, 'audit_runs', 'final_review_shadow_latency_ms', 'final_review_shadow_latency_ms');
  // Model-A/B/C v2 assignment grain (migration 20260701140000). Set by the
  // generation shadow when the experiment runs; columnExists-guarded so a
  // pre-migration store degrades cleanly (omit the absent column).
  await tryColumn(meta.assignmentId, 'audit_runs', 'assignment_id', 'assignment_id');
  await tryColumn(meta.stageType, 'audit_runs', 'stage_type', 'stage_type');
  await tryColumn(meta.phase, 'audit_runs', 'phase', 'phase');
  await tryColumn(meta.promptVariant, 'audit_runs', 'prompt_variant', 'prompt_variant');
  await tryColumn(meta.attempt, 'audit_runs', 'attempt', 'attempt');
  await tryColumn(meta.armOrderSeed, 'audit_runs', 'arm_order_seed', 'arm_order_seed');
  if (Object.keys(update).length === 0) {
    // round-4 audit M1: a bare early-return-to-`undefined` here previously
    // discarded `skippedFields` whenever EVERY field the caller supplied was
    // an optional one that hit the transient-probe-skip path (round-3 H2) —
    // `undefined` reads as "nothing was supplied", which is a different fact
    // from "something real was supplied but couldn't be verified writable".
    // Report the latter honestly: nothing was written (`ok:false`, there is
    // no update to run), but `skippedFields` is still surfaced.
    if (skippedFields.length > 0) {
      process.stderr.write(`  [learning] updateRunMeta: run ${runId} — every supplied field was skipped on an unresolved schema probe (${skippedFields.join(', ')}); nothing written\n`);
      return { ok: false, partial: true, skippedFields };
    }
    return;
  }
  if (!await cloudFn()) return;
  try {
    // round-2 audit H1: previously returned `{ok:true}` whenever the query
    // did not THROW, never checking whether it actually matched a row — so a
    // stale/invalid `runId` (the row already deleted, or never existed)
    // reported success identically to a real write.
    const { rowCount } = await updateWhereFn('audit_runs', update, { id: runId });
    if (rowCount === 0) {
      process.stderr.write(`  [learning] updateRunMeta: 0 rows matched for run ${runId} — not written\n`);
      return { ok: false };
    }
    if (skippedFields.length > 0) {
      process.stderr.write(`  [learning] updateRunMeta: run ${runId} — wrote but SKIPPED ${skippedFields.length} supplied field(s) on an unresolved schema probe (${skippedFields.join(', ')}); this write is PARTIAL, not a confirmed column-absence degrade\n`);
      return { ok: true, partial: true, skippedFields };
    }
    return { ok: true };
  } catch (err) {
    process.stderr.write(`  [learning] updateRunMeta failed: ${err.message}\n`);
    return { ok: false };
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
  // Deliberately RAW here, not coerced — bucket participates in finding
  // IDENTITY (round-3 audit H1: coercing an invalid value to null here would
  // silently reassign it onto the DIFFERENT, real identity null legitimately
  // carries). `filterPersistableRows` below validates and drops on an
  // out-of-domain value instead; this field is only ever coerced-to-null
  // for a genuinely absent/null source value, which is already correct.
  if (columns.hasBucket) base.bucket = f._bucket ?? null;
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
 * The NOT-NULL write-boundary guard (2026-07-26), extracted to a pure
 * function — same reason `buildFindingRow` was pulled out of `recordFindings`
 * above: the decision needs to be directly unit-testable without a live DB.
 *
 * `finding_fingerprint` has always had a `|| 'unknown'` fallback; `severity`
 * and `category` had none, yet both are NOT NULL with no DB default. One
 * malformed row therefore aborted the whole INSERT — and inside a
 * caller-supplied transaction that poisons the tx, so the subsequent COMMIT
 * silently degrades to ROLLBACK and the entire batch disappears with no error
 * reaching the caller. Found live: the Opus shadow reviewer returned a finding
 * with a null `category`, which discarded the PRIMARY reviewer's findings too.
 *
 * Coerce vs skip is deliberately asymmetric:
 *  - `category` is descriptive → coerce to a visible defect marker so the row
 *    survives. `detail_snapshot` is what a human grades; keeping the row keeps
 *    it gradeable, and the marker makes the provider bug visible IN THE DATA
 *    rather than only in a log line that scrolls away.
 *  - `severity` is the metric → NEVER fabricated. The shadow A/B's stopping
 *    rule counts HIGH/MEDIUM findings; inventing a severity would corrupt the
 *    exact number the row exists to feed. Drop it, loudly — keyed on
 *    `VALID_SEVERITIES.has(row.severity)`, not mere truthiness: a truthy but
 *    out-of-domain value (e.g. a producer emitting `"CRITICAL"`) previously
 *    survived this guard and hit the DB's `severity` CHECK constraint instead,
 *    triggering the exact same whole-batch-lost failure this guard exists to
 *    prevent — just one step later, and with no application-level warning.
 *
 * `bucket` (round-3 audit H1) gets the SAME drop-not-coerce treatment as
 * `severity`, for the same structural reason: it participates in finding
 * IDENTITY (the dedup key below, the DB's ON CONFLICT target,
 * `pruneUnrecordedUnruled`'s comparison) rather than being purely
 * descriptive like `category`. `buildFindingRow` deliberately does NOT
 * coerce an out-of-domain bucket to null before this point — null is a
 * REAL, DIFFERENT identity value (the one primary/no-bucket findings
 * legitimately carry), so coercing here would silently reassign an
 * invalid-bucket finding onto an unrelated finding's identity slot instead
 * of dropping it. Checked via `'bucket' in row` rather than a separate
 * `hasBucket` flag — `buildFindingRow` only ever sets the property at all
 * when the store has the column, so property presence already carries
 * that signal without this pure function needing `columns` threaded in.
 *
 * @param {object[]} mappedRows - rows already produced by `buildFindingRow`
 * @returns {{rows: object[], droppedFingerprints: string[], droppedBucketFingerprints: string[], coercedCategories: number}}
 */
export function filterPersistableRows(mappedRows) {
  const rows = [];
  let coercedCategories = 0;
  const droppedFingerprints = [];
  const droppedBucketFingerprints = [];
  for (const row of mappedRows) {
    if (!VALID_SEVERITIES.has(row.severity)) {
      droppedFingerprints.push(row.finding_fingerprint);
      continue;
    }
    if (Object.prototype.hasOwnProperty.call(row, 'bucket') && row.bucket != null && !VALID_BUCKETS.has(row.bucket)) {
      droppedBucketFingerprints.push(row.finding_fingerprint);
      continue;
    }
    if (row.category == null || row.category === '') {
      row.category = MISSING_CATEGORY_MARKER;
      coercedCategories++;
    }
    rows.push(row);
  }
  return { rows, droppedFingerprints, droppedBucketFingerprints, coercedCategories };
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
 *   **Invariant (write-boundary-hardening plan Phase 7)**: `opts.client`,
 *   when supplied, MUST be a client from an OPEN transaction — passing a bare
 *   pool connection here is a caller bug, not a supported mode. This function's
 *   own `if (opts.client) throw err` below already relied on that equivalence
 *   silently; `persistKeptEmbeddings`' `isCallerTx` parameter now inherits the
 *   same, now-documented, invariant instead of re-deriving it.
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
 * @returns {Promise<{applied: boolean, rows: number, keptKeys?: {fingerprint:string, bucket:string|null}[], droppedCount?: number, reason?: string, error?: unknown}>}
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
  const { kept: suppressionKept, vectorByFinding, embeddingSpace } = await applyRecordTimeSuppression(runId, findings, passName);
  const columns = { hasClassification, hasSourceModel, hasBucket, hasStage, hasArm, hasIsQuickFix, hasVerification };
  // A side Map from row -> its originating raw finding (never a property ON
  // the row — `cols = Object.keys(rows[0])` below builds the INSERT column
  // list directly from row keys, so any extra property would try to become a
  // column). Needed downstream to recover `keptFindings` for
  // `persistKeptEmbeddings`, which keys `vectorByFinding` by raw-finding
  // object identity — lost once rows go through filter+dedup by value.
  const rowToFinding = new Map();
  const mappedRows = suppressionKept.map((f) => {
    const row = buildFindingRow(f, { runId, passName, round, columns });
    rowToFinding.set(row, f);
    return row;
  });

  // NOT-NULL + domain write-boundary guard (2026-07-26; severity-domain check
  // added round-1 audit H18, bucket-domain check added round-3 audit H1) runs
  // BEFORE dedup (round-2 code-audit H4/H5) — the pure decision lives in
  // `filterPersistableRows` above; this call site only owns the I/O (logging).
  // Order is load-bearing: dedup below keeps only the FIRST occurrence of a
  // key, on the assumption that "a later duplicate carries no information the
  // first does not." An invalid/missing-severity or out-of-domain-bucket
  // occurrence breaks that assumption — if it happened to be the first of its
  // key, dedup would consume the key's one slot and a later, VALID occurrence
  // of the same key would never be reached. Filtering for persistability
  // first means dedup only ever chooses among rows that were already going
  // to survive.
  const { rows: persistableRows, droppedFingerprints, droppedBucketFingerprints, coercedCategories } = filterPersistableRows(mappedRows);
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
      `  [learning] WARNING: dropped ${droppedFingerprints.length} ${passName} finding(s) with a missing or `
      + `invalid severity (${droppedFingerprints.join(', ')}) — severity is the metric the A/B stopping rule `
      + 'counts, so it is never fabricated or coerced. These findings are NOT persisted.\n'
    );
  }
  if (droppedBucketFingerprints.length > 0) {
    process.stderr.write(
      `  [learning] WARNING: dropped ${droppedBucketFingerprints.length} ${passName} finding(s) with an out-of-domain bucket `
      + `(${droppedBucketFingerprints.join(', ')}) — an invalid bucket cannot be coerced to null without colliding with a `
      + 'DIFFERENT, legitimate null-bucket identity. These findings are NOT persisted.\n'
    );
  }
  // Single count covering EVERY drop reason (severity + bucket) — every
  // `droppedCount` consumer below (the terminal early-return, the bulk-insert
  // return, and recordFinalReviewFindings' own all-dropped guard) needs "how
  // many rows failed to land", not "why", so a caller checking completeness
  // can't miss a whole drop CLASS just because it only summed one list.
  const droppedTotalCount = droppedFingerprints.length + droppedBucketFingerprints.length;

  // ── Intra-batch fingerprint dedup (durability plan Phase 3) ───────────────
  // `audit_findings_run_fingerprint_uniq_full` (migration 20260812070000) makes
  // `(run_id, finding_fingerprint)` unique, and a multi-row INSERT carrying the
  // same fingerprint twice would now abort the WHOLE batch (23505) where it
  // previously wrote two rows. `ON CONFLICT DO UPDATE` does not rescue it
  // either — Postgres refuses to affect one row twice in a single command
  // (21000). So the collapse has to happen before the statement is built, and
  // (see above) after severity/bucket validation — never before it.
  //
  // Keep the FIRST occurrence: the batch is ordered, and a later duplicate of an
  // already-VALID-and-seen key carries no information the first does not. Never
  // silent — a dropped finding is exactly what this plan exists to make visible.
  //
  // Keyed on (fingerprint, bucket) via findingKeyString, not fingerprint alone
  // (write-boundary-hardening plan Phase 3, fixing debt 1b5bce68d2ce/883d3001f45f):
  // the DB-level ON CONFLICT target a few lines below is already scoped by
  // pass_name+bucket, so an intra-batch dedup on fingerprint alone silently
  // collapsed a same-fingerprint-different-bucket pair BEFORE that correctly-
  // scoped statement ever ran. Read straight off the already-built row's own
  // `finding_fingerprint`/`bucket` fields — never recomputed a second time —
  // so the dedup key can never drift from what actually lands in the row.
  // Only scoped by bucket when this store has the column at all (`hasBucket`);
  // an un-migrated store has no column to disambiguate on, matching the DB
  // conflict target's own `hasBucket` condition.
  const rows = [];
  const seenKeys = new Set();
  let intraBatchDuplicates = 0;
  for (const row of persistableRows) {
    const key = findingKeyString({ fingerprint: row.finding_fingerprint, bucket: hasBucket ? row.bucket : undefined });
    if (seenKeys.has(key)) { intraBatchDuplicates++; continue; }
    seenKeys.add(key);
    rows.push(row);
  }
  if (intraBatchDuplicates > 0) {
    process.stderr.write(
      `  [learning] ${intraBatchDuplicates} ${passName} finding(s) shared a fingerprint with an earlier one in the `
      + 'same batch and were collapsed — (run_id, finding_fingerprint) is unique, so they could not both be rows.\n'
    );
  }
  // Terminal, not pending: this payload will map to zero rows however often it
  // is replayed (the drops above are deterministic in the payload), so a spilled
  // artifact that lands here must be retired rather than retried forever.
  // `droppedCount` is deliberately reported even on the terminal early-return
  // below (final-review-credit-projection.md Seam 3 / audit-code cluster A R1
  // H17): a caller doing replace-by-snapshot (recordFinalReviewFindings) must
  // be able to tell "the round genuinely raised nothing" from "a producer
  // defect silently rejected part of the batch" — pruning on the latter would
  // treat rows the round never actually re-examined as absent and erase them.
  if (rows.length === 0) return { applied: true, rows: 0, reason: 'no-persistable-rows', keptKeys: [], droppedCount: droppedTotalCount };
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
                 RETURNING id, finding_fingerprint${hasBucket ? ', bucket' : ''}`;
    const inserted = await exec.query(sql, params);
    // Persist embeddings for the kept findings so they become future dedup
    // targets. Best-effort; keyed by (fingerprint,bucket) via findingKeyString,
    // NOT fingerprint alone (round-2 audit H4) — a bare Map keyed by
    // finding_fingerprint silently collapses two rows this batch legitimately
    // persisted at different buckets (Phase 3 made that possible), attaching
    // an embedding to the wrong finding_id. `bucket` is only in the RETURNING
    // list — and only read here — when `hasBucket`, matching every other
    // `hasBucket`-guarded reference in this function.
    if (vectorByFinding && vectorByFinding.size > 0) {
      const idByKey = new Map((inserted.rows || []).map((r) =>
        [findingKeyString({ fingerprint: r.finding_fingerprint, bucket: hasBucket ? r.bucket : undefined }), r.id]));
      // Recover the raw findings behind the rows that actually made it through
      // filter + dedup, in the same order — see `rowToFinding` above.
      const keptFindings = rows.map((row) => rowToFinding.get(row));
      const embedResult = await persistKeptEmbeddings(exec, keptFindings, vectorByFinding, idByKey, runId, embeddingSpace, !!opts.client, hasBucket);
      if (embedResult.failed > 0) {
        process.stderr.write(`  [semantic-suppress] embedding persistence: ${embedResult.persisted} ok, ${embedResult.failed} failed this batch\n`);
      }
    }
    // The complete identity of every row this batch wrote (final-review-credit-
    // projection.md Seam 3 / R1 H2) — (finding_fingerprint, bucket), bucket
    // preserved as NULL, not coalesced. A caller doing a replace-by-snapshot
    // (recordFinalReviewFindings) needs this to prune exactly what left the
    // snapshot, scoped to the SAME pass_name/bucket space the upsert wrote —
    // deriving it from the upserted rows themselves, never re-guessed.
    const keptKeys = rows.map((row) => ({ fingerprint: row.finding_fingerprint, bucket: row.bucket ?? null }));
    return { applied: true, rows: rows.length, keptKeys, droppedCount: droppedTotalCount };
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
 * docs/plans/final-review-shadow-reviewer.md; the replace mechanics rewritten
 * by docs/plans/final-review-credit-projection.md Seam 3 — see below). A
 * retry or manual rerun with the same runId must NOT double-count, so this
 * UPSERTs the snapshot and prunes only the rows the new snapshot dropped that
 * carry no ruling and no recorded remediation — never a blanket DELETE.
 *
 * REQUIRES a migrated store (the `bucket` column, migration 20260610120000).
 * `pruneUnrecordedUnruled` references `bucket` unconditionally, and so does
 * every other final-review-credit query in this codebase (the two
 * `CREDIT_BRANCH_*_WHERE` predicates, `pendingQueueSql`) — the credit queue
 * this function's callers exist to serve is DEFINED in terms of that column,
 * so an un-migrated store cannot meaningfully run any part of this feature.
 * `recordFindings`' own `hasBucket` capability degrade is for ITS OTHER
 * callers (the primary GPT-audit pass has no bucket concept), not this one
 * (audit-code cluster A R5 H1, dismissed by GPT deliberation — this is a
 * pre-existing precondition, not a regression).
 *
 * Primary/shadow decoupling (Gemini G2): the CALLER decides what to pass —
 * `primary` is populated whenever the primary review ran; `shadow` is `[]`
 * unless the shadow actually ran, gated by `shadowRan` (see below).
 *
 * @param {string} runId
 * @param {{
 *   primary?: object[],   // primary reviewer findings, each stamped _sourceModel/_bucket
 *   shadow?: object[],    // shadow reviewer findings (empty unless shadowRan)
 *   shadowRan?: boolean,  // did the shadow reviewer actually run this round?
 *                         // (final-review-credit-projection.md Seam 3 / R1 H3)
 *                         // Absent/false is treated as false — NEVER prune what
 *                         // was not measured. `shadow.length > 0` with
 *                         // `shadowRan` not exactly `true` is a caller
 *                         // contradiction: logged, shadow treated as not-run.
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
 * @returns {Promise<{findingsRecorded: boolean, verdictPersisted: boolean,
 *   primaryDroppedCount?: number, shadowDroppedCount?: number, shadowWriteFailed?: boolean}|undefined>}
 *   `undefined` only for the cloud-off/no-runId early return (nothing was
 *   attempted). Once findings recording is attempted, always a definite
 *   shape — see the write-boundary-hardening plan Phase 10 note below.
 *   `primaryDroppedCount`/`shadowDroppedCount` (round-3 audit H4) name a
 *   MIXED-batch drop explicitly: `findingsRecorded: true` only means "a
 *   verdict-backing snapshot was written", not "every supplied finding
 *   landed" — a producer defect on part of the batch (invalid severity or
 *   bucket) still drops just those rows (by design, see the tx1-block
 *   comment below) while the verdict and the surviving findings persist. A
 *   caller that needs to know whether the batch was COMPLETE must check
 *   these counts, not infer completeness from `findingsRecorded` alone.
 *   `shadowWriteFailed` (round-5 audit H1): `true` when the shadow's own
 *   transaction threw and was caught (still non-fatal to the primary) —
 *   distinguishes "the shadow write was LOST" from "the shadow ran cleanly
 *   with `shadowDroppedCount: 0`", which previously read identically.
 */
export async function recordFinalReviewFindings(runId, { primary = [], shadow = [], shadowRan = false, models = {}, verdict = null } = {}) {
  if (!runId || !await isCloudEnabled()) return;
  // (a) Replace the findings — UPSERT + prune-unruled-absentees, never DELETE
  // (final-review-credit-projection.md Seam 3). Until 2026-09-14 this function
  // unconditionally DELETEd every 'final-review'/'final-review-shadow' row for
  // the run before re-inserting, so a re-run (round 2 of a Gemini gate, or a
  // consolidated union-diff pass over the same --run-id) erased every
  // `user_action`/`adjudication_outcome` a human or agent had written on that
  // run's rows. `recordFindings` already upserts on the finding's complete
  // identity and never writes the adjudication columns (`DO UPDATE` therefore
  // preserves them); the only thing that lost state was the DELETE.
  //
  // TWO transactions, deliberately — the shadow is observation-only and must
  // never be able to damage the primary's record (Gemini G1/G2, unchanged).
  // Each transaction OWNS exactly one pass_name (Gemini plan-gate R1 H3):
  // tx1 = 'final-review', tx2 = 'final-review-shadow', so a prune scoped by
  // pass_name can never touch the other's rows. Each starts with an advisory
  // transaction lock on `(runId, passName)` (Gemini plan-gate R1 M1): two
  // concurrent replacements of the SAME population would otherwise each upsert
  // and prune against a view of the table that does not yet see the other's
  // rows, leaving the union of both snapshots rather than the latest one — no
  // existing lock covers this (`withTx` is a bare BEGIN/COMMIT).
  //
  // tx1 keeps the atomic upsert+prune the idempotent-replace contract needs.
  let primaryResult;
  try {
    await withTx(async (client) => {
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`${runId}:final-review`]);
      const res = await recordFindings(runId, primary, 'final-review', 0, { client });
      primaryResult = res;
      // Prune ONLY on a complete batch (audit-code cluster A R1 H17): a
      // producer defect (e.g. every finding missing `severity`) silently
      // drops rows via `recordFindings`' own defensive filter, and a dropped
      // finding is not the same fact as "this round genuinely did not raise
      // it" — pruning on a degraded batch would erase history for findings
      // the round never actually re-examined.
      if (res.droppedCount > 0) {
        process.stderr.write(`  [learning] recordFinalReviewFindings: skipping prune for final-review — ${res.droppedCount} finding(s) were dropped from this batch (producer defect), so it is not a complete replacement snapshot\n`);
      } else {
        await pruneUnrecordedUnruled(client, { runId, passName: 'final-review', keptKeys: res.keptKeys || [] });
      }
    });
  } catch (err) {
    process.stderr.write(`  [learning] recordFinalReviewFindings failed (primary): ${err.message}\n`);
    // The shadow rows belong to a review whose primary half is now unrecorded —
    // writing them alone would produce a run with shadow-only findings and no
    // baseline to diff against, which reads as "the primary found nothing".
    // Nothing landed at all (write-boundary-hardening plan Phase 10) — the
    // reorder below means run metadata was never attempted either, so both
    // flags read false, not the mixed "verdict recorded, findings not" state
    // this reorder exists to prevent.
    return { findingsRecorded: false, verdictPersisted: false };
  }
  // A batch that raised findings but had EVERY one dropped by recordFindings'
  // own guard (a producer defect, e.g. every finding missing severity) is the
  // SAME orphan-verdict risk the tx1-failure early return above already closes
  // — `applied:true, rows:0` did not throw, so control would otherwise fall
  // through to the metadata write below and persist a verdict backed by zero
  // recorded findings (round-1 audit H16). `primary.length === 0` (a
  // genuinely empty round — nothing was ever claimed) is NOT this case: that
  // is a legitimate clean result, and writing its verdict is correct.
  if (primary.length > 0 && primaryResult.rows === 0 && primaryResult.droppedCount === primary.length) {
    process.stderr.write(`  [learning] recordFinalReviewFindings: all ${primary.length} primary finding(s) were dropped by a producer defect — skipping the verdict write to avoid persisting one with no backing findings\n`);
    return { findingsRecorded: false, verdictPersisted: false, primaryDroppedCount: primaryResult.droppedCount, shadowDroppedCount: 0, shadowWriteFailed: false };
  }
  // (b) Run metadata — moved to run AFTER tx1 succeeds (write-boundary-
  // hardening plan Phase 10, debt 3d77eba7cae1). Previously ran BEFORE tx1:
  // the columns here are overwrite-idempotent on RETRY, but that argument
  // never covered a *first-ever* call whose findings tx then failed — the
  // early return above already correctly skipped recording anything further
  // in that case, yet the metadata write had already landed, leaving a
  // `gemini_verdict` persisted with no findings behind it and no guarantee a
  // retry would ever happen. Conditioning this write on tx1's success closes
  // that. The mirror-image case (findings commit, this write then fails) is a
  // real, distinct, and DELIBERATELY accepted gap — not chased into full
  // cross-write-path atomicity, since `updateRunMeta` is shared,
  // non-transactional infrastructure used by unrelated callers (model-A/B/C
  // shadow assignment) with no atomicity relationship to `audit_findings`
  // writes; retrofitting it, or duplicating its column-probed UPDATE inline
  // inside this transaction, would both be larger, riskier changes than this
  // fix's scope for a less consequential defect (a stale/missing verdict, not
  // a misleading one). Instead: `verdictPersisted` below reports it, and the
  // one real production caller (`runShadowAndPersist` in
  // scripts/lib/final-review/shadow.mjs) is wired to surface it loudly.
  const metaResult = await updateRunMeta(runId, {
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
  // `metaResult` is `undefined` when updateRunMeta had nothing to write (every
  // meta field null) — that is not a failure, so it counts as persisted here;
  // only an explicit `{ok:false}` (a caught write error) is a real failure.
  const verdictPersisted = metaResult?.ok !== false;
  // tx2 — shadow. Its own transaction so a provider-shaped defect here cannot
  // roll back tx1. A failure is loud but non-fatal: the A/B loses one
  // observation, the audit record stays intact.
  //
  // Runs ONLY when `shadowRan === true` — a shadow that did not run must leave
  // PRIOR shadow rows untouched (no upsert, no prune); a shadow that ran and
  // found nothing (`shadow: []`) prunes the unruled ones, same as any other
  // empty replacement snapshot. `shadow.length > 0` with `shadowRan` anything
  // but `true` is a caller contradiction — no permissive default here, the
  // shadow is treated as not-run and the contradiction is logged naming the
  // caller, so a producer bug reads as a message, not a silent stale set.
  if (shadow.length > 0 && shadowRan !== true) {
    process.stderr.write(
      `  [learning] recordFinalReviewFindings: ${shadow.length} shadow finding(s) supplied but shadowRan is not true — ` +
      'treating the shadow as not-run (no write, no prune). This is a producer contract violation in the caller.\n'
    );
  }
  let shadowDroppedCount = 0;
  // round-5 audit H1: a shadow write that THREW left `shadowDroppedCount` at
  // its initialised 0 — byte-identical to a shadow that ran cleanly and
  // dropped nothing, so a caller could not tell "the shadow observation was
  // lost" from "the shadow observation succeeded with zero drops". The log
  // line below was already loud, but the RETURN VALUE — what a caller
  // actually branches on — carried no such signal. `shadowWriteFailed` names
  // it explicitly; still non-fatal (the try/catch shape, and the "primary
  // rows are safe" guarantee, are unchanged).
  let shadowWriteFailed = false;
  if (shadowRan === true) {
    try {
      await withTx(async (client) => {
        await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`${runId}:final-review-shadow`]);
        const res = await recordFindings(runId, shadow, 'final-review-shadow', 0, { client });
        shadowDroppedCount = res.droppedCount || 0;
        // Same "complete batch only" gate as the primary tx above (H17).
        if (res.droppedCount > 0) {
          process.stderr.write(`  [learning] recordFinalReviewFindings: skipping prune for final-review-shadow — ${res.droppedCount} finding(s) were dropped from this batch (producer defect), so it is not a complete replacement snapshot\n`);
        } else {
          await pruneUnrecordedUnruled(client, { runId, passName: 'final-review-shadow', keptKeys: res.keptKeys || [] });
        }
      });
    } catch (err) {
      shadowWriteFailed = true;
      process.stderr.write(
        `  [learning] recordFinalReviewFindings failed (shadow, non-fatal — primary rows are safe): ${err.message}\n`
      );
    }
  }
  return {
    findingsRecorded: true, verdictPersisted,
    primaryDroppedCount: primaryResult.droppedCount || 0, shadowDroppedCount, shadowWriteFailed,
  };
}

/**
 * Delete the rows of ONE (run, pass_name) population that the new snapshot no
 * longer raises AND that carry no completed ruling on either axis and no
 * recorded remediation (`UNRULED_WHERE`) — the prune half of Seam 3. Compares
 * the COMPLETE identity `(finding_fingerprint, bucket)`, bucket compared
 * null-safely (`IS NOT DISTINCT FROM`), against `keptKeys` — the exact rows
 * `recordFindings` just wrote for this pass, never re-derived (Gemini
 * plan-gate R1 H2): the same fingerprint legitimately recurs across buckets
 * within one pass_name, so a fingerprint-only comparison could prune a row in
 * one bucket while a same-fingerprint row survives in another, or vice versa.
 *
 * A labelled or remediated absentee is evidence and is kept — its
 * `finding_fingerprint` no longer appearing in the new snapshot is itself
 * information, not grounds to erase what a human or agent recorded about it.
 *
 * @param {import('../db/query.mjs').TxClient} client
 * @param {{runId: string, passName: string, keptKeys: {fingerprint:string, bucket:string|null}[]}} args
 * @returns {Promise<number>} rows pruned
 */
async function pruneUnrecordedUnruled(client, { runId, passName, keptKeys }) {
  const fingerprints = keptKeys.map((k) => k.fingerprint);
  const buckets = keptKeys.map((k) => k.bucket ?? null);
  const res = await client.query(
    `DELETE FROM audit_findings AS f
      WHERE f.run_id = $1 AND f.pass_name = $2
        AND ${UNRULED_WHERE}
        AND NOT EXISTS (
          SELECT 1 FROM unnest($3::text[], $4::text[]) AS k(fp, b)
          WHERE k.fp = f.finding_fingerprint AND k.b IS NOT DISTINCT FROM f.bucket
        )`,
    [runId, passName, fingerprints, buckets]
  );
  const pruned = res.rowCount ?? 0;
  if (pruned > 0) {
    process.stderr.write(`  [learning] recordFinalReviewFindings: pruned ${pruned} unruled absentee(s) from ${passName}\n`);
  }
  return pruned;
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
  // Validate the CALL SHAPE before touching the environment. `isCloudEnabled()`
  // used to run first, so a caller bug (a typo'd action literal) on a
  // cloud-disabled machine silently returned `{ok:false, reason:'cloud-disabled'}`
  // instead of the clear "must be 'accepted' or 'dismissed'" throw — a
  // programming error misreported as an environment condition, and only
  // reachable in an environment where cloud happens to be off (found via CI:
  // main's own postgres-parity `db-suite` job runs this suite with
  // AUDIT_DB_URL deliberately unset for the drift-justification step's
  // destructive-guard isolation, so the test — which asserts the rejection
  // unconditionally — never saw it on a developer machine where a personal
  // ~/.audit-loop.env silently re-populates AUDIT_DB_URL on every import of
  // config.mjs/db/client.mjs, masking the ordering bug there).
  const userAction = action === 'accepted' ? 'accepted-permanent'
    : action === 'dismissed' ? 'dismissed'
    : null;
  if (!userAction) throw new Error(`adjudicateFinalReviewFinding: action must be 'accepted' or 'dismissed', got '${action}'`);
  if (!await isCloudEnabled()) return { ok: false, updated: 0, cloud: false, reason: 'cloud-disabled' };
  const outcome = action === 'accepted' ? 'accepted' : 'dismissed';
  if (!await columnExists('audit_findings', 'bucket', many, isCloudEnabled)) {
    process.stderr.write('  [learning] adjudicate: bucket column absent — run migration 20260610120000\n');
    return { ok: false, updated: 0, cloud: true, reason: 'bucket-column-absent' };
  }
  try {
    const resolved = await resolveFindingBucket(runId, fingerprint, opts);
    if (!resolved.ok) return { ...resolved, updated: 0, cloud: true };
    // Write by the resolved row's `id` (write-boundary-hardening plan Phase
    // 4) — never by re-deriving a `(run_id, fingerprint, bucket)` predicate a
    // second time, which leaves a TOCTOU window between "which row did we
    // mean" and "which row did we actually update".
    const res = await query(
      `UPDATE audit_findings
          SET user_action = $2, adjudication_outcome = $3, decided_at = NOW()
        WHERE id = $1`,
      [resolved.id, userAction, outcome]
    );
    const updated = res.rowCount ?? 0;
    if (updated === 0) {
      // Reachable only on a concurrent delete between the probe and the write.
      return { ok: false, updated: 0, cloud: true, reason: 'no-rows-affected' };
    }
    return { ok: true, updated, cloud: true, bucket: resolved.bucket };
  } catch (err) {
    process.stderr.write(`  [learning] adjudicateFinalReviewFinding failed: ${err.message}\n`);
    return { ok: false, updated: 0, cloud: true, reason: `db-error: ${err.message}` };
  }
}

/**
 * Resolve which `bucket` (and, critically, which ROW `id`) a (runId,
 * fingerprint) pair refers to.
 *
 * Extracted so `adjudicateFinalReviewFinding` and `recordFinalReviewFix` share
 * ONE disambiguation oracle — a second copy would be free to drift, and the
 * rule it encodes (never guess between primary and shadow) is exactly the one
 * whose violation would corrupt the A/B comparison.
 *
 * write-boundary-hardening plan Phase 4 (debt 49e4b2b29f9f/c4a5540210a8): the
 * previous `SELECT DISTINCT bucket` query silently collapsed two rows that
 * share a fingerprint AND a bucket value but differ in `pass_name` (e.g. a
 * `'merged'`-pass finding and a `'final-review'`-pass finding, both
 * `bucket=NULL`) into a single DISTINCT bucket — so the "ambiguous, refuse"
 * branch never fired even though the identity was genuinely ambiguous, and a
 * caller's subsequent `bucket`-only `WHERE` would match BOTH rows. This
 * queries every matching ROW (not `DISTINCT bucket`) and refuses whenever
 * more than one row remains after applying whatever the caller supplied —
 * whether that ambiguity is across buckets or, now, across pass_names within
 * one bucket. Reason vocabulary (`no-match` / `no-match-in-bucket` /
 * `ambiguous-bucket`) is unchanged so existing callers/tests keep working;
 * `ok:true` now also carries the resolved row's `id`, so a caller can write
 * back `WHERE id = $resolvedId` instead of re-deriving a `(run_id,
 * fingerprint, bucket)` predicate a second time.
 *
 * Scoped to `pass_name IN ('final-review', 'final-review-shadow')`
 * (round-1 audit M1): both callers (`adjudicateFinalReviewFinding`,
 * `recordFinalReviewFix`) are final-review-specific commands, but the
 * un-scoped query previously let an UNAMBIGUOUS single match from a
 * different pass_name population (e.g. a `'merged'`-pass row with no
 * final-review counterpart) resolve silently — the multi-row ambiguity
 * check above only catches the case where MULTIPLE rows collide; a lone
 * wrong-population match never triggered it.
 *
 * @param {string} runId
 * @param {string} fingerprint
 * @param {{bucket?: string|null}} [opts] - omit to auto-resolve; pass explicitly to disambiguate
 * @returns {Promise<{ok: true, id: string, bucket: string|null} | {ok: false, reason: string, buckets?: Array<string|null>}>}
 */
async function resolveFindingBucket(runId, fingerprint, opts = {}) {
  const rows = await many(
    `SELECT id, bucket FROM audit_findings
      WHERE run_id = $1 AND finding_fingerprint = $2
        AND pass_name IN ('final-review', 'final-review-shadow')`,
    [runId, fingerprint]
  );
  if (rows.length === 0) return { ok: false, reason: 'no-match' };
  if (Object.prototype.hasOwnProperty.call(opts, 'bucket')) {
    const bucket = opts.bucket;
    const matching = rows.filter((r) => r.bucket === bucket);
    if (matching.length === 0) {
      return { ok: false, reason: 'no-match-in-bucket', buckets: [...new Set(rows.map((r) => r.bucket))] };
    }
    if (matching.length > 1) {
      // Same fingerprint AND same (caller-supplied) bucket, but more than one
      // row — differing only by pass_name. Still ambiguous; the caller's
      // explicit bucket did not fully pin down a single row.
      return { ok: false, reason: 'ambiguous-bucket', buckets: [bucket] };
    }
    return { ok: true, id: matching[0].id, bucket };
  }
  const distinctBuckets = [...new Set(rows.map((r) => r.bucket))];
  if (distinctBuckets.length > 1 || rows.length > 1) {
    // Do NOT guess. Either two DIFFERENT bucket values share this fingerprint
    // (primary vs shadow — the original check), OR one bucket value is shared
    // by more than one row (the pass_name-blind-spot this fix closes).
    // Collapsing either would corrupt the A/B comparison the shadow
    // experiment exists to make, or silently target the wrong row.
    return { ok: false, reason: 'ambiguous-bucket', buckets: distinctBuckets };
  }
  return { ok: true, id: rows[0].id, bucket: rows[0].bucket };
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

    // write-boundary-hardening plan Phase 4 (debt fb6936368272/14b6898621c4):
    // the dismissal check used to be a separate SELECT followed by an
    // unconditional UPDATE — another writer could dismiss the finding in the
    // window between them. Folded into one atomic conditional UPDATE, by
    // `id` (never a re-derived predicate), via `finding-write.mjs` with
    // `isCallerTx:false` — this is a standalone action, not part of a larger
    // caller-owned transaction, so a 0-row result comes back as a typed
    // outcome rather than a thrown exception. A completed dismissal on
    // EITHER axis (final-review-credit-projection.md Seam 1) still closes
    // this off, checked in the WHERE clause instead of a preceding read.
    const patch = { remediation_state: state };
    if (opts.commitSha != null) patch.fix_commit_sha = opts.commitSha;
    const setCols = Object.keys(patch);
    const sets = setCols.map((k, i) => `${k} = $${i + 2}`).join(', ');
    const result = await applyFindingWrite(
      { query },
      {
        text: `UPDATE audit_findings SET ${sets}
                WHERE id = $1
                  AND user_action IS DISTINCT FROM 'dismissed'
                  AND adjudication_outcome IS DISTINCT FROM 'dismissed'`,
        values: [resolved.id, ...setCols.map((k) => patch[k])],
      },
      { isCallerTx: false }
    );
    if (result.outcome === 'failed') {
      // round-2 audit H1: a genuine write ERROR (the query threw) must not
      // fall into the 0-row investigation below — that branch's conclusion
      // ("no-rows-affected" / "dismissed-cannot-be-fixed") asserts the
      // predicate ran and simply matched nothing, which is false here: the
      // statement never completed. Conflating the two told a caller "the
      // finding was already dismissed" when the real story was a DB error.
      process.stderr.write(`  [learning] recordFinalReviewFix write error for ${fingerprint}: ${result.error?.message}\n`);
      return { ok: false, updated: 0, cloud: true, reason: `db-error: ${result.error?.message}`, bucket };
    }
    if (result.outcome !== 'written') {
      // Zero rows is ambiguous between "the row is gone" and "it's now
      // dismissed" — resolving that does not change what was WRITTEN (the
      // atomic UPDATE above already correctly refused in both cases), only
      // what the caller is TOLD. This read is not part of the atomicity
      // guarantee; its own staleness is harmless.
      const still = await one(
        `SELECT user_action, adjudication_outcome FROM audit_findings WHERE id = $1`,
        [resolved.id]
      );
      if (still?.user_action === 'dismissed' || still?.adjudication_outcome === 'dismissed') {
        return { ok: false, updated: 0, cloud: true, reason: 'dismissed-cannot-be-fixed', bucket };
      }
      return { ok: false, updated: 0, cloud: true, reason: 'no-rows-affected', bucket };
    }
    return { ok: true, updated: result.affected, cloud: true, bucket, state };
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
 * @param {{queueLimit?: number, after?: {severityRank:number, createdAt:string, fingerprint:string, runId:string, findingId:string}|null}} [opts]
 *   `after` is the keyset cursor for `pendingQueue` — the LAST raw row of the
 *   previous page, in the queue's own total order. `createdAt` is the row's
 *   `created_at_cursor` (`created_at::text`, microsecond-exact), never a JS Date.
 */
export async function getFinalReviewStats(repoName, { queueLimit = 50, after = null } = {}) {
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
    //
    // Keyset-paged since 2026-09-13; the SQL lives beside its predicates in
    // final-review-credit-population.mjs (`pendingQueueSql`) — see there for
    // the total order, the cursor predicate and the bind positions.
    const cursorParams = after ? [after.severityRank, after.createdAt, after.fingerprint, after.runId, after.findingId] : [];
    const pendingQueue = await many(pendingQueueSql({ cursor: !!after }), [repoId, queueLimit, ...cursorParams]);
    // Exact totals, INDEPENDENT of queueLimit. `shadowOnlyQueue` above is a
    // bounded page (default 50), so counting it would under-report the moment the
    // backlog exceeds the limit — and this repo already has ~63 unadjudicated
    // shadow findings, so that is the live case, not a hypothetical. Grouping by
    // the two axes keeps the result tiny (a handful of rows) and lets the pure
    // classifier own the semantics; SQL never encodes the rules.
    // Same two predicates `pendingQueue` uses, by construction. Counting only
    // the shadow branch (as this did until 2026-09-04) makes the card's header
    // describe a strict subset of its own list.
    // Grouped by BOTH axes since 2026-09-14: the classifier reads
    // `adjudication_outcome` too (final-review-credit-projection.md Seam 1), so a
    // group that omitted it would sum rows the classifier would place in
    // different classes.
    const actionablePairs = await many(
      `SELECT user_action, adjudication_outcome, remediation_state, COUNT(*) AS n FROM (
         SELECT f.user_action, f.adjudication_outcome, f.remediation_state FROM audit_findings f
           JOIN audit_runs r ON r.id = f.run_id WHERE ${CREDIT_BRANCH_SHADOW_WHERE}
         UNION ALL
         SELECT f.user_action, f.adjudication_outcome, f.remediation_state FROM audit_findings f
           JOIN audit_runs r ON r.id = f.run_id WHERE ${CREDIT_BRANCH_PRIMARY_LABEL_GAP_WHERE}
       ) credit_population
       GROUP BY user_action, adjudication_outcome, remediation_state`,
      [repoId]
    );
    // The two axes disagreeing in DIRECTION — a ship-time disposition that
    // closes against a triage ruling that accepts, or the reverse. Counted over
    // ALL of the repo's findings with both axes set (the credit population
    // filters `user_action` open and so could never contain one), independent
    // of the page, so the card can say it. `user_action` is the durable
    // override (the classifier reads it first); this makes the override visible
    // rather than silent. Measured 0 on 2026-09-14.
    const axisConflicts = Number((await one(
      `SELECT COUNT(*) AS n FROM audit_findings f JOIN audit_runs r ON r.id = f.run_id
        WHERE r.repo_id = $1
          AND ((f.user_action IN ('dismissed', 'auto_dismissed') AND f.adjudication_outcome IN ('accepted', 'severity_adjusted'))
            OR (f.user_action IN ('accepted-permanent', 'fix-now') AND f.adjudication_outcome = 'dismissed'))`,
      [repoId]
    ))?.n ?? 0);
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
    return { ok: true, cloud: true, repoId, buckets, shadowOnlyQueue, pendingQueue, actionablePairs, axisConflicts, runs, experimentRuns };
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
/**
 * round-3 audit H2 (GPT deliberation: compromise, MEDIUM): the boolean
 * `columnExists` below cannot distinguish "confirmed absent" from "an
 * exhausted transient probe" — both read `false` to every one of its ~25
 * boolean-context call sites, and GPT's own ruling was explicit that widening
 * ALL of them to a tri-state contract is disproportionate (it would risk
 * aborting whole batches for the sake of one optional field, the exact
 * failure mode this file's NOT-NULL/domain guards exist to prevent). This
 * helper is the one exception: it exposes the `definitive` bit for the ONE
 * write site that persists a REPORTED OUTCOME a caller trusts — `updateRunMeta`,
 * which backs verdict persistence — so a transient probe there can produce an
 * honest `partial` result instead of silently dropping a supplied value while
 * reporting `{ok:true}`. `columnExists` itself is now a thin wrapper that
 * discards `definitive` and keeps its existing boolean contract byte-for-byte
 * for every other caller.
 * @returns {Promise<{present: boolean, definitive: boolean}>}
 */
async function probeColumnExistence(table, col, manyFn, cloudFn) {
  const key = `${table}.${col}`;
  if (_runReadColumnCache.has(key)) return { present: _runReadColumnCache.get(key), definitive: true };
  if (!await cloudFn()) {
    _runReadColumnCache.set(key, false);
    return { present: false, definitive: true };
  }
  // Retry once before degrading (round-1 audit H8/H17, mirroring `probeColumn`'s
  // established pattern — and its own `isUndefinedColumnError` oracle instead of
  // a second, drifting inline `42703`/`42P01` check): the cache was already
  // correctly never poisoned by a transient failure, but a single blip still
  // silently omitted the probed column from THIS one call with no retry —
  // load-bearing for Phase 3, whose intra-batch dedup key depends on `hasBucket`
  // being accurate for the batch it is actually probed for.
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      await manyFn(`SELECT "${col}" FROM ${table} LIMIT 0`);
      _runReadColumnCache.set(key, true);
      return { present: true, definitive: true };
    } catch (err) {
      // Only a genuine "absent" signal is a STABLE capability fact worth
      // caching. A transient connectivity/auth/timeout error must NOT poison
      // the cache: caching `false` there would permanently omit a column that
      // actually exists, silently dropping adjudication/remediation data for
      // the whole process. On a transient error, retry once; if it persists,
      // omit the column for THIS call only and leave the cache unset so the
      // next call re-probes.
      if (isUndefinedColumnError(err)) {
        _runReadColumnCache.set(key, false);
        return { present: false, definitive: true };
      }
      if (attempt === 0) continue;
      // round-2 audit H5: both retries failed on a NON-definitive error (not
      // `isUndefinedColumnError` — a real schema gap would have returned
      // above). This is an exhausted transient probe, not a confirmed-absent
      // column, and previously returned bare `false` with no signal — making
      // it silently indistinguishable from genuine absence. Mirrors
      // `probeColumn`'s own log line for the same case. The cache is
      // deliberately left unset (see the comment above the loop) so the next
      // call re-probes instead of being poisoned by this one blip.
      process.stderr.write(`  [learning] columnExists(${key}) probe failed transiently (${err.code || err.message}); treating as absent for this call only\n`);
    }
  }
  return { present: false, definitive: false };
}

async function columnExists(table, col, manyFn, cloudFn) {
  const { present } = await probeColumnExistence(table, col, manyFn, cloudFn);
  return present;
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
  for (const c of ['round_converged_after', 'commit_sha', 'branch', 'plan_id', 'audited_sha', 'audited_tree']) {
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
    // `commitSha` is HEAD at audit-capture time — the PARENT of a dirty-tree
    // audit, not the commit containing the audited diff (see AGENTS.md's
    // Postgres-Parity-Store section). `auditedSha`/`auditedTree` are the real
    // target identity; both null on pre-2026-07-19 rows.
    commitSha: row.commit_sha ?? null,
    auditedSha: row.audited_sha ?? null,
    auditedTree: row.audited_tree ?? null,
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

/** One round's `suppression_events` rows — pure, so the shape is testable without a DB. */
export function buildSuppressionEventRows(runId, suppressionResult) {
  return [
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
    // A missed re-raise (concern-identity.mjs); `kept` was in the CHECK, never written.
    ...(suppressionResult.nearMisses ?? []).map((m) => ({
      run_id: runId, finding_fingerprint: fingerprintOf(m.finding),
      matched_topic_id: m.matchedTopic, match_score: m.matchScore, action: 'kept', reason: m.reason,
    })),
  ];
}

/** Record suppressed, reopened and near-miss events from an R2+ post-processing pass. */
export async function recordSuppressionEvents(runId, suppressionResult) {
  if (!runId) return { applied: false, rows: 0, reason: 'no-run-id' };
  if (!await isCloudEnabled()) return { applied: false, rows: 0, reason: 'cloud-off' };
  const rows = buildSuppressionEventRows(runId, suppressionResult);
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
 *      (+ optional pass_name / round_raised disambiguation), via the shared
 *      `selectFindingRow` oracle (write-boundary-hardening plan Phase 4,
 *      debt 28d5f3d2fde7/8dbc3a738ff8) — never a bare `LIMIT 1` with no
 *      `ORDER BY`, and a missing/ambiguous/db-error outcome is now
 *      distinguishable to the caller instead of a uniform `undefined`.
 *   2. Inside a transaction:
 *        - DELETE any prior adjudication events on this finding (idempotent re-record)
 *        - INSERT the new event
 *        - UPDATE audit_findings.adjudication_outcome + remediation_state (denormalised)
 *
 * @returns {Promise<{ok: true} | {ok: false, reason: 'no-match'|'ambiguous'|'db-error', detail?: string}>}
 */
export async function recordAdjudicationEvent(runId, findingFingerprint, event) {
  if (!runId || !await isCloudEnabled()) return { ok: false, reason: 'no-match' };
  try {
    const resolved = await selectFindingRow({
      runId,
      fingerprint: findingFingerprint,
      passName: event.passName || undefined,
      roundRaised: event.round || undefined,
    });
    if (!resolved.ok) {
      return { ok: false, reason: resolved.reason === 'ambiguous' ? 'ambiguous' : 'no-match' };
    }
    const finding = { id: resolved.id };

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
    return { ok: true };
  } catch (err) {
    process.stderr.write(`  [learning] recordAdjudicationEvent failed: ${err.message}\n`);
    return { ok: false, reason: 'db-error', detail: err.message };
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
 * write-boundary-hardening plan Phase 5 (debt 61809b947026/08cf3203f120):
 * carries the row's `id` through when the input row has one (real DB rows
 * from `reconcileRemediationProjection` do; hand-built test fixtures without
 * one are unaffected). This is what lets `markFindingsRemediation` address
 * the SPECIFIC divergent row it found instead of re-resolving "the newest
 * row for this fingerprint" — which silently reconciles the wrong row when
 * two runs in the window both raised the same fingerprint and only one
 * actually diverges.
 *
 * @param {Array<{finding_fingerprint:string, remediation_state:string, id?:string}>} dbRows
 * @param {Map<string,string>} index
 * @returns {Array<{fingerprint:string, state:string, id?:string}>}
 */
export function selectReconcileTargets(dbRows, index) {
  const out = [];
  for (const row of dbRows || []) {
    const want = index.get(row.finding_fingerprint);
    if (want && want !== row.remediation_state) {
      out.push({
        fingerprint: row.finding_fingerprint,
        state: want,
        ...(row.id !== undefined ? { id: row.id } : {}),
      });
    }
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
 * `id` (an `audit_findings.id`, e.g. from `selectReconcileTargets`) is
 * carried through when present on the input, so `markFindingsRemediation`
 * can address that specific row directly (write-boundary-hardening plan
 * Phase 5) — omitted from `valid`'s shape entirely when absent, so this
 * stays behaviour-identical for every existing caller/fixture that never
 * supplies one.
 *
 * @param {Array<object>} updates
 * @returns {{valid: Array<{fingerprint:string, state:string, resolvedRound:number|null, id?:string}>, rejected: Array<{update:object, reason:string}>}}
 */
export function normalizeRemediationUpdates(updates) {
  const valid = [], rejected = [];
  for (const u of (Array.isArray(updates) ? updates : [])) {
    // write-boundary-hardening plan Phase 9 (debt a6b21fc5011f): a null/
    // non-object array entry passes the top-level array check, but
    // `updateTargetState(u)` reads `u.state` — on `null` that throws
    // TypeError OUTSIDE this function entirely, past markFindingsRemediation's
    // per-row try/catch, defeating its fail-open-per-row contract. Reject it
    // as an invalid input instead of letting it throw.
    if (u == null || typeof u !== 'object') { rejected.push({ update: u, reason: 'update is not an object' }); continue; }
    const state = updateTargetState(u);
    const fingerprint = u.findingFingerprint || u.fingerprint;
    if (!state) { rejected.push({ update: u, reason: 'no resolvable remediation state' }); continue; }
    if (!TERMINAL_REMEDIATION.has(state)) { rejected.push({ update: u, reason: `non-terminal state "${state}"` }); continue; }
    if (!fingerprint) { rejected.push({ update: u, reason: 'missing findingFingerprint' }); continue; }
    valid.push({
      fingerprint, state, resolvedRound: u.resolvedRound ?? null,
      ...(u.id !== undefined ? { id: u.id } : {}),
    });
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
 * `repoId` is REQUIRED (positional, thrown on absence — main's PR #117):
 * folded into the terminal UPDATE's own WHERE clause via an atomic `EXISTS`,
 * never checked via a separate prior SELECT. The row-id caller and
 * `applyRemediationVerificationResults` used to verify repo ownership with a
 * SELECT and only then issue the write — a real TOCTOU window (the finding's
 * repo association could change between the two statements) this closes.
 *
 * `fingerprint` (round-2 audit H3, optional): the same atomic-predicate
 * treatment for identity, not just ownership — the ownership SELECT this
 * replaces never checked that a caller-supplied `findingId` actually carried
 * the caller-supplied fingerprint, so a mismatched (id, fingerprint) pair
 * could still target the wrong finding. `null` by default (no predicate
 * added) for callers that already resolved the exact row by fingerprint and
 * need no re-check.
 *
 * `throttleStamp` (write-boundary-hardening plan Phase 8, debt a2999cbf144f,
 * optional): when supplied, the `remediation_last_checked_*` throttle
 * columns are stamped as a THIRD statement inside this function's own
 * `withTx`, instead of `applyRemediationVerificationResults` running a
 * second, separately-transactional UPDATE after this one returns. A failure
 * anywhere in the transaction now rolls back the terminal state too, so
 * "verified but not counted" (the confirmed bug: the terminal write landing
 * while a later, independent throttle-stamp failure discounted it) is
 * structurally impossible rather than merely less likely.
 *
 * @param {string} repoId - audit_repos.id; the finding must belong to it
 * @param {string} findingId - audit_findings.id, already resolved by the caller
 * @param {string} state - a member of TERMINAL_REMEDIATION
 * @param {{resolvedRound?: number|null, throttleStamp?: {checkedAtCommit: string}|null, fingerprint?: string|null}} [opts]
 * @returns {Promise<{affected: number, throttleStamped: boolean|null}>} `throttleStamped`
 *   is `null` when no `throttleStamp` was requested.
 */
async function projectRemediationState(repoId, findingId, state, { resolvedRound = null, throttleStamp = null, fingerprint = null } = {}) {
  if (!repoId) throw new Error('projectRemediationState requires repoId');
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
        WHERE id = $2
          AND EXISTS (SELECT 1 FROM audit_runs r WHERE r.id = audit_findings.run_id AND r.repo_id = $3)
          AND ($4::text IS NULL OR finding_fingerprint = $4)
        RETURNING id`,
      [state, findingId, repoId, fingerprint]
    );
    // 0-row → do not write a phantom event. Indistinguishable here between
    // "no such row" and "row exists but failed the repoId/fingerprint
    // predicate" — both mean the same thing to a caller: this write did not
    // happen, for a reason that must not be silently retried against a
    // different row.
    if (rows.length === 0) return { affected: 0, throttleStamped: null };
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
    let throttleStamped = null;
    if (throttleStamp) {
      const throttleRows = await many(
        `UPDATE audit_findings SET remediation_last_checked_at = now(), remediation_last_checked_commit = $1
          WHERE id = $2 RETURNING id`,
        [throttleStamp.checkedAtCommit, findingId]
      );
      throttleStamped = throttleRows.length > 0;
      // round-3 audit M1: checking this invariant AFTER projectRemediationState
      // returns (round-2 audit H1's fix, in applyRemediationVerificationResults)
      // only detects a violation post-commit — this transaction has already
      // committed the terminal write by the time the caller sees it. Provably
      // unreachable in practice (same transaction, same row id the terminal
      // UPDATE just matched — Postgres holds that row's lock across both
      // statements), but "provably unreachable" is exactly why this must throw
      // HERE, inside the transaction: if it is ever violated, the whole write
      // should roll back rather than commit a terminal state whose throttle
      // stamp silently failed to land alongside it.
      if (!throttleStamped) {
        throw new Error(`projectRemediationState(${findingId}): throttle-stamp UPDATE affected 0 rows in the same transaction as the terminal write it must accompany — invariant violated`);
      }
    }
    return { affected: rows.length, throttleStamped };
  });
}

export async function markFindingsRemediation(repoId, updates) {
  if (!repoId || !await isCloudEnabled()) return { updated: 0, attempted: 0 };
  const { valid, rejected } = normalizeRemediationUpdates(updates);
  // `rejected` (round-1 audit M2): previously computed by `normalizeRemediationUpdates`
  // and then silently discarded — a caller could not distinguish "5 sent, 5
  // processed" from "5 sent, 2 rejected as malformed input, 3 processed",
  // which matters most for exactly the case Phase 9's null-safety fix added
  // (a non-object array entry): catching bad input only to make it invisible
  // in the receipt defeats part of the point of catching it.
  if (valid.length === 0) return { updated: 0, attempted: 0, rejected: rejected.length };
  // `attempted` is returned alongside `updated` (audit 2026-08-13) so a caller
  // can see a SHORTFALL without re-deriving it. This is fail-open PER ROW: a
  // throw is caught, logged, and the loop continues — so `updated` alone cannot
  // distinguish "projected all 5" from "projected 2 of 5 and logged 3 failures",
  // and the on-disk ledger then diverges from the store with nobody counting.
  let updated = 0;
  for (const { fingerprint: fp, state, resolvedRound, id } of valid) {
    try {
      let findingId;
      if (id !== undefined) {
        // Row-id path (write-boundary-hardening plan Phase 5, debt
        // 61809b947026/08cf3203f120): the caller (reconcileRemediationProjection,
        // via selectReconcileTargets) already identified this SPECIFIC divergent
        // row — address it directly instead of re-resolving "newest row for this
        // fingerprint", which can silently reconcile the wrong row when two runs
        // in the window both raised the same fingerprint.
        //
        // repo ownership AND fingerprint (round-2 audit H2/H3) are enforced in
        // `projectRemediationState`'s own UPDATE predicate below, not via a
        // prior SELECT here — a SELECT-then-write leaves a TOCTOU window where
        // the finding's repo association (or fingerprint) could change between
        // the two statements, and a separate ownership-only SELECT never
        // checked that `id` actually carries the fingerprint the caller
        // supplied, so a mismatched (id, fingerprint) pair could silently
        // target the wrong finding.
        findingId = id;
      } else {
        // Fingerprint-only path — kept for the ledger-driven /audit-code
        // projection caller, which has no row id (the on-disk ledger indexes
        // by fingerprint alone; see docs/plans/runs-findings-write-boundary-hardening.md
        // Phase 5 for why that is the correct fallback, not a second unfixed gap).
        const finding = await one(
          `SELECT f.id FROM audit_findings f JOIN audit_runs r ON r.id = f.run_id
           WHERE r.repo_id = $1 AND f.finding_fingerprint = $2
             AND r.created_at > now() - interval '14 days'
           ORDER BY f.created_at DESC LIMIT 1`,
          [repoId, fp]
        );
        if (!finding?.id) continue;
        findingId = finding.id;
      }
      // repoId + fingerprint always threaded through: for the row-id path
      // this IS the ownership/identity check (see above); for the
      // fingerprint-only path it's a same-transaction re-assertion of what
      // the resolving SELECT just found, closing that path's own smaller
      // TOCTOU window between resolve and write.
      const { affected } = await projectRemediationState(repoId, findingId, state, { resolvedRound, fingerprint: fp });
      if (affected > 0) updated += 1;
      else process.stderr.write(`  [lifecycle] markFindingsRemediation(${fp}): 0-row update (not found, not owned by repo ${repoId}, or fingerprint mismatch) — not counted\n`);
    } catch (err) {
      process.stderr.write(`  [lifecycle] markFindingsRemediation(${fp}) failed: ${err.message}\n`);
    }
  }
  return { updated, attempted: valid.length, rejected: rejected.length };
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
 * batch. `repoId` scopes BOTH writes here (the terminal `projectRemediationState`
 * call and this function's own throttle-column `UPDATE`) via an atomic `EXISTS`
 * clause — a `findingId` from another repo affects nothing.
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
  //
  // round-4 audit H1: `columnExists`'s bare boolean can't tell "confirmed
  // absent" from "an exhausted transient probe" — both used to read as
  // "throttle columns absent" here, so a rare blip could silently skip
  // EVERY action's throttle stamp for the whole batch, not just log-and-omit
  // one field the way `updateRunMeta`'s targeted fix (round-3 H2) does.
  // `probeColumnExistence` exposes `definitive` so this can distinguish them:
  // a genuinely un-migrated store still degrades exactly as before, but an
  // unresolved probe now logs loudly and is NOT silently treated the same as
  // confirmed absence.
  const { present: hasThrottleColumns, definitive: throttleColumnsDefinitive } =
    await probeColumnExistence('audit_findings', 'remediation_last_checked_at', many, isCloudEnabled);
  if (!hasThrottleColumns && !throttleColumnsDefinitive) {
    process.stderr.write(`  [lifecycle] applyRemediationVerificationResults: remediation_last_checked_at probe failed transiently — treating throttle columns as unavailable for THIS batch only (not a confirmed un-migrated store); re-verification may fire sooner than intended for these ${valid.length} action(s)\n`);
  }
  let updated = 0;
  for (const { findingId, outcome, checkedAtCommit } of valid) {
    try {
      // Repo-scope verification (write-boundary-hardening plan round-1 audit
      // H1/H10, hardened round-2 H2): `repoId` is enforced in EACH write's own
      // WHERE clause below (via `projectRemediationState`'s `repoId` option,
      // or inline here for the throttle-only path) — not via a prior SELECT.
      // A SELECT-then-write here left a TOCTOU window where the finding's
      // repo association could change between the ownership check and the
      // write; folding the check into the write predicate closes it.
      if (outcome === 'resolved') {
        // write-boundary-hardening plan Phase 8: the terminal write and the
        // throttle stamp are now ONE atomic call — see projectRemediationState's
        // `throttleStamp` option. Previously these were two independent
        // statements/transactions; a failure of the second discounted a
        // `verified` state that had already landed. Now either both land or
        // neither does.
        const { affected } = await projectRemediationState(repoId, findingId, 'verified', {
          resolvedRound: null,
          throttleStamp: hasThrottleColumns ? { checkedAtCommit } : null,
        });
        if (affected === 0) {
          process.stderr.write(`  [lifecycle] applyRemediationVerificationResults(${findingId}): 0-row update on the terminal write (not found, or not owned by repo ${repoId}) — not counted\n`);
          continue;
        }
        // round-3 audit M1: the throttle-stamp/terminal-write invariant is now
        // enforced INSIDE projectRemediationState's own transaction (it throws
        // and rolls back there, rather than this caller detecting it after the
        // fact once the write has already committed) — see its throttleStamp
        // block. `affected > 0` here is therefore already a guarantee that
        // either both landed or the whole write rolled back and this call
        // rejected with an error.
        updated += 1;
        continue;
      }
      if (!hasThrottleColumns) {
        // Nothing to project (not resolved) and nowhere to stamp the throttle
        // — genuinely a no-op on this store, not a failure.
        continue;
      }
      // Not 'resolved': a single, already-atomic UPDATE — no terminal write
      // to compose with here, but STILL repo-scoped in the predicate itself
      // (round-2 audit H2), not via a separate prior SELECT.
      const rows = await many(
        `UPDATE audit_findings SET remediation_last_checked_at = now(), remediation_last_checked_commit = $1
          WHERE id = $2
            AND EXISTS (SELECT 1 FROM audit_runs r WHERE r.id = audit_findings.run_id AND r.repo_id = $3)
          RETURNING id`,
        [checkedAtCommit, findingId, repoId]
      );
      if (rows.length > 0) updated += 1;
      else process.stderr.write(`  [lifecycle] applyRemediationVerificationResults(${findingId}): 0-row tracking-column update (not found, or not owned by repo ${repoId}) — not counted\n`);
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
      `SELECT f.id, f.finding_fingerprint, f.remediation_state
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
