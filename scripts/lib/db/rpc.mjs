/**
 * @fileoverview Explicit per-RPC wrappers for the 8 stored functions the
 * audit-loop store calls. One wrapper per RPC, ordered positional
 * arguments, type casts pinned on the SQL side. NOT a generic
 * `callFn(name, argMap)` — that would make JS object key-order a DB API
 * contract (postgres-parity plan §2 "RPC handling", R1/H1).
 *
 * RPC signatures verified against `supabase/migrations/*.sql`:
 *  - defer_finding              — adaptive_learning_v1 §103
 *  - mark_finding_needs_triage  — adaptive_learning_v1 §190
 *  - drift_score                — drift_score_signature §42 (4-arg form is live)
 *  - memory_health_metrics      — memory_health_perf §17
 *  - top_duplicate_clusters     — top_duplicate_clusters §17
 *  - symbol_neighbourhood       — symbol_index §231
 *  - incident_neighbourhood     — security_incidents §82
 *  - publish_refresh_run        — symbol_index §166
 *
 * Vector params: `pg` does NOT auto-serialise JS number arrays to `vector`.
 * We hand-build the `[1,2,3,…]` literal and cast via `::vector` so the
 * pgvector extension parses it correctly. `text[]` params pass natively
 * via the `pg` driver's array codec; explicit `::text[]` casts kept anyway
 * to make signatures stable when an empty / null array would otherwise
 * resolve to `unknown[]`.
 *
 * @module scripts/lib/db/rpc
 */

import { many, one, query, withTx } from './query.mjs';

// ── vector helpers ─────────────────────────────────────────────────────────

/**
 * Width of the pgvector columns the audit-loop migrations declare —
 * `symbol_index.embedding` and `security_incidents.embedding` are both
 * `VECTOR(768)` (see `supabase/migrations/20260501120000_symbol_index.sql`
 * and `…/20260504120000_security_incidents.sql`). Exported so the symbol
 * index + neighbourhood callers can share one constant and the RPC layer
 * can validate at the boundary instead of waiting for a server-side
 * dimension-mismatch error (audit M6 / M14).
 */
export const PG_VECTOR_DIM = 768;

/**
 * Format a JS number array into a pgvector literal, e.g. `[1,2.5,3]`.
 * Returns `null` for null/undefined so the caller can pass an optional
 * embedding through unchanged. Throws on non-finite values — silently
 * shipping NaN/Infinity into the DB has burned us before; the cast would
 * fail server-side with a useless error message.
 *
 * If `expectedDim` is supplied the array length is validated against it.
 * The neighbourhood RPCs pass `PG_VECTOR_DIM` so a wrong-width embedding
 * is rejected at the client boundary with a useful error message instead
 * of producing a generic SQLSTATE 22P02 from pgvector (audit M6 / M14).
 *
 * @param {number[] | null | undefined} embedding
 * @param {{expectedDim?: number}} [opts]
 * @returns {string | null}
 */
function vectorLiteral(embedding, { expectedDim } = {}) {
  if (embedding == null) return null;
  if (!Array.isArray(embedding)) {
    throw new TypeError('vectorLiteral: embedding must be a number[]');
  }
  if (expectedDim != null && embedding.length !== expectedDim) {
    throw new RangeError(
      `vectorLiteral: embedding has ${embedding.length} dims, DB expects ${expectedDim}`
    );
  }
  for (let i = 0; i < embedding.length; i++) {
    const v = embedding[i];
    if (typeof v !== 'number' || !Number.isFinite(v)) {
      throw new TypeError(`vectorLiteral: embedding[${i}] is not a finite number (${v})`);
    }
  }
  return `[${embedding.join(',')}]`;
}

// ── 1. defer_finding (void) ───────────────────────────────────────────────

/**
 * Idempotent dismissal of a finding plus the side-effect bundle
 * (recurring-cluster upsert + learning_decisions insert). Returns void.
 *
 * @param {{
 *   findingId: string,
 *   dismissReason: string,
 *   evidence: object | null,
 *   clusterHash: string,
 *   severity: string,
 *   auditRunId: string,
 *   round: number,
 *   sequence: number,
 * }} args
 * @returns {Promise<void>}
 */
export async function deferFinding({
  findingId, dismissReason, evidence, clusterHash, severity,
  auditRunId, round, sequence,
}) {
  await query(
    'SELECT defer_finding($1::uuid, $2::text, $3::jsonb, $4::text, $5::text, $6::uuid, $7::integer, $8::integer)',
    [findingId, dismissReason, evidence ?? null, clusterHash, severity, auditRunId, round, sequence]
  );
}

// ── 2. mark_finding_needs_triage (void) ───────────────────────────────────

/**
 * Mark a finding `needs_triage` plus the supporting learning_decisions row.
 * Idempotent via decision_key.
 *
 * @param {{
 *   findingId: string,
 *   reason: string,
 *   auditRunId: string,
 *   round: number,
 *   sequence: number,
 *   evidence: object | null,
 * }} args
 * @returns {Promise<void>}
 */
export async function markFindingNeedsTriage({
  findingId, reason, auditRunId, round, sequence, evidence,
}) {
  await query(
    'SELECT mark_finding_needs_triage($1::uuid, $2::text, $3::uuid, $4::integer, $5::integer, $6::jsonb)',
    [findingId, reason, auditRunId, round, sequence, evidence ?? null]
  );
}

// ── 3. drift_score (scalar jsonb) ─────────────────────────────────────────

/**
 * Snapshot drift score (4-arg signature; `p_sim_dup`/`p_sim_name` are
 * kept for backwards-compat but ignored by v3 of the function).
 *
 * @param {{repoId: string, refreshId: string, simDup?: number, simName?: number}} args
 * @returns {Promise<object | null>} the JSONB payload
 */
export async function driftScore({ repoId, refreshId, simDup, simName }) {
  const row = await one(
    'SELECT drift_score($1::uuid, $2::uuid, $3::numeric, $4::numeric) AS result',
    [repoId, refreshId, simDup ?? 0.85, simName ?? 0.90]
  );
  return row?.result ?? null;
}

// ── 4. memory_health_metrics (scalar jsonb) ───────────────────────────────

/**
 * Cluster-density / re-raise / recurrence metrics across all repos in the
 * audit store.
 *
 * The DB function declares its own DEFAULTs; with Postgres's positional-arg
 * model the only way to "inherit" them is to omit the trailing positional
 * slot in the SQL — which would mean a different SELECT string per
 * caller-supplied subset. To keep the wrapper one SQL string we instead
 * pass each value explicitly, mirroring the DB defaults in JS. The two
 * sources stay in lock-step intentionally (audit M9 / M11); when the
 * migration moves a default, update both at once. The defaults must match
 * `supabase/migrations/20260421163657_memory_health_perf.sql` §17 —
 * `window_days=30, similarity_reraise=0.6, similarity_cluster=0.5, max_pairs_per_repo=1000`.
 *
 * TIMEOUT LIVES HERE, NOT ON THE FUNCTION (2026-08-08). All three
 * memory-health migrations declare `SET statement_timeout = '120s'` on the
 * function; that clause is DECORATIVE. Postgres arms the statement timer when
 * the top-level statement starts, and a `SET` taking effect inside the
 * function body does not re-arm it. Verified with a negative control: a
 * function declaring `SET statement_timeout='2s'` slept 5s and returned
 * normally, while the identical sleep under a session-level 2s timeout was
 * cancelled. So the RPC was effectively unbounded — against the self-hosted
 * NAS store it ran past 15 minutes and the weekly gate's 5-minute per-check
 * spawn budget killed it with a bare `spawn ETIMEDOUT`, which reads as a
 * broken runner rather than a slow query. A `SET LOCAL` inside `withTx` binds
 * for real (it is the same connection, released at COMMIT), so a runaway now
 * surfaces as a loud `57014 statement_timeout` that memory-health.mjs reports
 * as an infra error (exit 2) instead of a silent kill.
 *
 * @param {{
 *   windowDays?: number,
 *   similarityReraise?: number,
 *   similarityCluster?: number,
 *   maxPairsPerRepo?: number,
 *   statementTimeoutMs?: number,
 * }} [args]
 * @returns {Promise<object | null>}
 */
export async function memoryHealthMetrics({
  windowDays, similarityReraise, similarityCluster, maxPairsPerRepo,
  statementTimeoutMs,
} = {}) {
  const timeoutMs = Number.isFinite(statementTimeoutMs) && statementTimeoutMs > 0
    ? Math.floor(statementTimeoutMs)
    : 120_000;
  const row = await withTx(async (client) => {
    // Integer-only interpolation (validated above) — statement_timeout is a
    // GUC name, not a value slot, so it cannot be a bound parameter.
    await client.query(`SET LOCAL statement_timeout = ${timeoutMs}`);
    const res = await client.query(
      'SELECT memory_health_metrics($1::integer, $2::numeric, $3::numeric, $4::integer) AS result',
      [
        windowDays ?? 30,
        similarityReraise ?? 0.6,
        similarityCluster ?? 0.5,
        maxPairsPerRepo ?? 1000,
      ]
    );
    return res.rows[0] ?? null;
  });
  return row?.result ?? null;
}

/**
 * Semantic cluster density (migration 20260721140000) — the trigram cluster
 * metric's replacement. Counts SAME-FILE, CROSS-RUN, cross-fingerprint pairs
 * with cosine > threshold over finding_embeddings, per repo, and reports
 * embedding COVERAGE so a caller never treats a low-coverage reading as
 * authoritative. Returns null if the RPC is absent (pre-migration store).
 *
 * @param {{windowDays?: number, cosineThreshold?: number, perRepoCap?: number}} [args]
 * @returns {Promise<object|null>}
 */
export async function memoryHealthSemanticCluster({
  windowDays, cosineThreshold, perRepoCap,
} = {}) {
  try {
    const row = await one(
      'SELECT memory_health_semantic_cluster($1::integer, $2::numeric, $3::integer) AS result',
      [windowDays ?? 30, cosineThreshold ?? 0.85, perRepoCap ?? 200],
    );
    return row?.result ?? null;
  } catch (err) {
    // Undefined-function (42883) = pre-migration store → null (caller degrades).
    if (err?.code === '42883') return null;
    throw err;
  }
}

// ── 5. top_duplicate_clusters (set) ───────────────────────────────────────

/**
 * Top-N exact-duplicate clusters in a snapshot. Companion to driftScore.
 *
 * @param {{repoId: string, refreshId: string, limit?: number}} args
 * @returns {Promise<Array<{
 *   signature_hash: string,
 *   kind: string,
 *   file_count: number,
 *   symbol_names: string[],
 *   file_paths: string[],
 *   example_purpose: string | null,
 * }>>}
 */
export async function topDuplicateClusters({ repoId, refreshId, limit }) {
  return many(
    'SELECT * FROM top_duplicate_clusters($1::uuid, $2::uuid, $3::integer)',
    [repoId, refreshId, limit ?? 20]
  );
}

// ── 6. symbol_neighbourhood (set, takes vector + text[]) ──────────────────

/**
 * ANN-and-overlap symbol neighbourhood query. `intentEmbedding` must match
 * the DB's `VECTOR(768)` width; we pass it as a `'[…]'::vector` literal so
 * pgvector parses it correctly. `kindFilter` may be `null` to disable.
 *
 * @param {{
 *   repoId: string,
 *   refreshId: string,
 *   targetPaths: string[],
 *   intentEmbedding: number[],
 *   kindFilter?: string[] | null,
 *   k?: number,
 * }} args
 */
export async function symbolNeighbourhood({
  repoId, refreshId, targetPaths, intentEmbedding, kindFilter, k,
}) {
  const vec = vectorLiteral(intentEmbedding, { expectedDim: PG_VECTOR_DIM });
  if (vec === null) {
    throw new TypeError('symbolNeighbourhood: intentEmbedding is required');
  }
  const kf = (kindFilter && kindFilter.length) ? kindFilter : null;
  return many(
    `SELECT * FROM symbol_neighbourhood(
       $1::uuid, $2::uuid, $3::text[], $4::vector, $5::text[], $6::integer
     )`,
    [repoId, refreshId, targetPaths, vec, kf, k ?? 50]
  );
}

// ── 7. incident_neighbourhood (set, takes vector + text[]) ────────────────

/**
 * Composite security-incident neighbourhood query. Returns raw signals so
 * the JS caller can weight + re-sort.
 *
 * @param {{
 *   repoId: string,
 *   targetPaths: string[],
 *   intentEmbedding: number[],
 *   k?: number,
 * }} args
 */
export async function incidentNeighbourhood({
  repoId, targetPaths, intentEmbedding, k,
}) {
  const vec = vectorLiteral(intentEmbedding, { expectedDim: PG_VECTOR_DIM });
  if (vec === null) {
    throw new TypeError('incidentNeighbourhood: intentEmbedding is required');
  }
  return many(
    `SELECT * FROM incident_neighbourhood(
       $1::uuid, $2::text[], $3::vector, $4::integer
     )`,
    [repoId, targetPaths, vec, k ?? 3]
  );
}

// ── 8. publish_refresh_run (scalar jsonb) ─────────────────────────────────

/**
 * Atomic publish — flips refresh_runs.status + audit_repos.active_refresh_id
 * + active embedding model/dim in one transaction (Gemini-R2 G1; R1 audit H4).
 *
 * @param {{
 *   repoId: string,
 *   refreshId: string,
 *   activeEmbeddingModel?: string | null,
 *   activeEmbeddingDim?: number | null,
 * }} args
 * @returns {Promise<object | null>}
 */
export async function publishRefreshRun({
  repoId, refreshId, activeEmbeddingModel, activeEmbeddingDim,
}) {
  const row = await one(
    `SELECT publish_refresh_run(
       $1::uuid, $2::uuid, $3::text, $4::integer
     ) AS result`,
    [
      repoId,
      refreshId,
      activeEmbeddingModel ?? null,
      activeEmbeddingDim ?? null,
    ]
  );
  return row?.result ?? null;
}

// ── friction_recurrence + friction_neighbourhood (memory_friction) ──────────

/**
 * Cross-repo (repoIdFilter null) or per-repo recurrence clusters among OPEN friction.
 * @param {{repoIdFilter?: string|null, windowDays?: number, minSimilarity?: number, maxAnchors?: number}} args
 * @returns {Promise<{generated_at, window_days, repo_scoped, clusters: Array}|null>}
 */
export async function frictionRecurrence({ repoIdFilter = null, windowDays, minSimilarity, maxAnchors } = {}) {
  const row = await one(
    'SELECT friction_recurrence($1::uuid, $2::integer, $3::numeric, $4::integer) AS result',
    [repoIdFilter, windowDays ?? 30, minSimilarity ?? 0.5, maxAnchors ?? 500],
  );
  return row?.result ?? null;
}

/**
 * Hook injection: top-k OPEN friction whose short signature matches the prompt (word_similarity).
 * @param {{repoId: string, prompt: string, k?: number, minWordSim?: number}} args
 * @returns {Promise<Array<{memory_name, title, cost, scope_tags, score}>>}
 */
export async function frictionNeighbourhood({ repoId, prompt, k, minWordSim } = {}) {
  if (!repoId) throw new TypeError('frictionNeighbourhood: repoId is required');
  const row = await one(
    'SELECT friction_neighbourhood($1::uuid, $2::text, $3::integer, $4::numeric) AS result',
    // Default 0.3 (not 0.6) — empirically, real titles top out ~0.38 for a
    // relevant prompt vs ~0.03 unrelated; 0.6 never fires. Callers override via
    // frictionConfig.injectionWordSim (commands.frictionNeighbourhood).
    [repoId, prompt ?? '', k ?? 2, minWordSim ?? 0.3],
  );
  return Array.isArray(row?.result) ? row.result : [];
}

// ── Test seam ──────────────────────────────────────────────────────────────

export const _internals = Object.freeze({
  vectorLiteral,
});
