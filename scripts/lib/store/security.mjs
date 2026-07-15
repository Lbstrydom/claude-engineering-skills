/**
 * @fileoverview Security-incidents domain (plan: docs/plans/security-memory-v1.md).
 *
 * Part of the postgres-parity M3 split. Translates 5 security_incidents
 * functions. The composite incident_neighbourhood RPC is bridged through
 * the M1 wrapper.
 *
 * @module scripts/lib/store/security
 */

import { many, one, updateWhere, upsert, pgArray } from '../db/query.mjs';
import { incidentNeighbourhood as rpcIncidentNeighbourhood } from '../db/rpc.mjs';
import { isCloudEnabled } from './repo.mjs';

// Same chunk size the legacy path uses for chunked upserts (the Supabase
// REST body cap is gone now, but keeping the chunk size preserves the
// same network shape + makes incremental progress visible in logs).
const UPSERT_CHUNK_SIZE = 500;

function chunk(arr, n) {
  const out = [];
  for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
  return out;
}

/**
 * UPSERT a batch of parsed incidents from docs/security-strategy.md.
 * Chunked at 500 rows per request — matches the legacy chunking.
 *
 * Note: `embedding` is a JS number[] (the legacy supabase-js path serialised
 * it as a Postgres array literal). For pgvector columns, the column type is
 * VECTOR(N); the `pg` driver's array codec produces `{1,2,3}` which pgvector
 * accepts via implicit cast. If pgvector rejects this, the upsert will
 * surface a 22P02 with the column name and we'll need to format the literal
 * as `[1,2,3]::vector` explicitly (mirrors rpc.mjs::vectorLiteral).
 *
 * @param {string} repoId
 * @param {Array<object>} incidents
 * @returns {Promise<{upserted: number}>}
 */
export async function recordSecurityIncidents(repoId, incidents) {
  if (!Array.isArray(incidents) || incidents.length === 0) return { upserted: 0 };
  if (!await isCloudEnabled()) return { upserted: 0 };
  let upserted = 0;
  for (const batch of chunk(incidents, UPSERT_CHUNK_SIZE)) {
    const payload = batch.map((i) => ({
      repo_id: repoId,
      incident_id: i.incident_id,
      description: i.description,
      affected_paths: pgArray(i.affected_paths),   // genuine text[] — not jsonb
      mitigation_ref: i.mitigation_ref,
      mitigation_kind: i.mitigation_kind,
      lessons_learned: i.lessons_learned,
      embedding: formatVectorOrNull(i.embedding),
      embedding_model: i.embedding_model,
      embedding_dim: i.embedding_dim,
      source_fingerprint: i.source_fingerprint,
      status: i.status,
      status_check_at: i.status_check_at,
    }));
    await upsert('security_incidents', payload, {
      onConflict: ['repo_id', 'incident_id'],
      update: 'all',
    });
    upserted += payload.length;
  }
  return { upserted };
}

/**
 * Parse a raw pgvector text literal ("[0.1,0.2,...]") back into a number[].
 * `pg` has no built-in type parser for `vector` (a custom extension type),
 * so a plain SELECT returns it as this text form, not an array. Found while
 * root-causing a bug where `getSecurityIncidentsByRepo`'s missing `embedding`
 * column made the refresh loop's "reuse the prior embedding on unchanged
 * content" fast path always report a failure instead — `prior.embedding` was
 * always `undefined`, so unchanged incidents could never actually be reused,
 * only ever re-embedded or (if that path was skipped) marked failed.
 * Null-safe: a NULL embedding column already comes back as `null` from `pg`,
 * never a string.
 */
function parseVectorLiteral(raw) {
  if (raw == null) return null;
  if (Array.isArray(raw)) return raw;
  const trimmed = String(raw).trim().replace(/^\[|\]$/g, '');
  if (!trimmed) return [];
  return trimmed.split(',').map(Number);
}

/**
 * Cache-hit comparison reader during refresh. Returns the rows in their
 * compact shape used by the refresh loop.
 */
export async function getSecurityIncidentsByRepo(repoId) {
  if (!repoId || !await isCloudEnabled()) return [];
  const rows = await many(
    `SELECT id, incident_id, source_fingerprint, embedding, embedding_model, embedding_dim,
            status, mitigation_ref, mitigation_kind
       FROM security_incidents
      WHERE repo_id = $1`,
    [repoId]
  );
  return rows.map((r) => ({ ...r, embedding: parseVectorLiteral(r.embedding) }));
}

/**
 * Mark a set of incidents as historical (sweep — R-Gemini-r2-G2).
 * `IN` clause translation: we expand to a `= ANY($2)` so the JS array
 * binds natively as a `text[]`.
 */
export async function markIncidentsHistorical(repoId, incidentIds) {
  if (!Array.isArray(incidentIds) || incidentIds.length === 0) return { marked: 0 };
  if (!await isCloudEnabled()) return { marked: 0 };
  await many(
    `UPDATE security_incidents
        SET status = 'historical', status_check_at = $2
      WHERE repo_id = $1 AND incident_id = ANY($3)`,
    [repoId, new Date().toISOString(), incidentIds]
  );
  return { marked: incidentIds.length };
}

/**
 * Freshness check — most recent updated_at on this repo's incidents.
 * R2-H2.
 *
 * @returns {Promise<string|null>}
 */
export async function getMaxIncidentRefreshAt(repoId) {
  if (!repoId || !await isCloudEnabled()) return null;
  try {
    const row = await one(
      `SELECT updated_at
         FROM security_incidents
        WHERE repo_id = $1
        ORDER BY updated_at DESC
        LIMIT 1`,
      [repoId]
    );
    return row?.updated_at ?? null;
  } catch {
    return null;
  }
}

/**
 * Composite incident-neighbourhood RPC. Bridges through the M1 wrapper
 * and re-shapes the rows (camelCase + Number-cast) to match the legacy
 * return contract.
 */
export async function callIncidentNeighbourhoodRpc({ repoId, targetPaths, intentEmbedding, k }) {
  if (!await isCloudEnabled()) return [];
  let rows;
  try {
    rows = await rpcIncidentNeighbourhood({ repoId, targetPaths, intentEmbedding, k });
  } catch (err) {
    const e = new Error(`incident_neighbourhood RPC failed: ${err.message}`);
    e.code = 'RPC_ERROR';
    throw e;
  }
  return rows.map((r) => ({
    incidentId: r.incident_id,
    description: r.description,
    affectedPaths: r.affected_paths,
    mitigationRef: r.mitigation_ref,
    status: r.status,
    lessonsLearned: r.lessons_learned,
    cosineScore: Number(r.cosine_score),
    pathOverlap: r.path_overlap === true,
    mitigationBonus: Number(r.mitigation_bonus),
    recencyDecay: Number(r.recency_decay),
  }));
}

// ── audit trail (security_strategy_events) ──────────────────────────────────

/**
 * Append a batch of audit-trail events (security_strategy_events). Append-only:
 * uses a plain multi-row INSERT (no ON CONFLICT) since each event is a distinct
 * historical fact — inserted/updated/marked_historical/refused_secret/
 * redacted_secret. Back-port: docs/plans/security/PLAN.md §4.2.
 *
 * `detail` is JSON-encoded for the jsonb column (only masked samples reach it).
 *
 * @param {string} repoId
 * @param {Array<{incident_id:string, event_kind:string, branch:string,
 *                commit_sha?:string|null, who?:string|null, detail?:object}>} events
 * @returns {Promise<{recorded: number}>}
 */
export async function recordSecurityEvents(repoId, events) {
  if (!repoId || !Array.isArray(events) || events.length === 0) return { recorded: 0 };
  if (!await isCloudEnabled()) return { recorded: 0 };
  const rows = events.map((e) => ({
    repo_id: repoId,
    incident_id: e.incident_id,
    event_kind: e.event_kind,
    who: e.who ?? null,
    branch: e.branch,
    commit_sha: e.commit_sha ?? null,
    detail: JSON.stringify(e.detail ?? {}),
  }));
  // Append-only by construction: upsert() with no onConflict emits a plain
  // multi-row INSERT (buildUpsert contract). Even if that contract changed, the
  // append semantics are STRUCTURALLY guaranteed — security_strategy_events has
  // no UNIQUE/PK conflict target other than the gen_random_uuid() id, so an
  // ON CONFLICT clause has nothing to match and every row is a fresh insert.
  // Chunked (Gemini gate LOW): a pathological markdown with thousands of PII
  // redactions could otherwise exceed Postgres's 65535 bind-param ceiling.
  for (const batch of chunk(rows, UPSERT_CHUNK_SIZE)) {
    await upsert('security_strategy_events', batch, {});
  }
  return { recorded: rows.length };
}

/**
 * Recent audit-trail events, newest first. Used by the dashboard Security
 * section + any "what did the last refresh do?" reader.
 */
export async function getSecurityEvents(repoId, limit = 10) {
  if (!repoId || !await isCloudEnabled()) return [];
  return many(
    `SELECT incident_id, event_kind, branch, commit_sha, detail, created_at
       FROM security_strategy_events
      WHERE repo_id = $1
      ORDER BY created_at DESC
      LIMIT $2`,
    [repoId, limit]
  );
}

/**
 * Governance roll-up for the dashboard Security section: per-status incident
 * counts, embedding coverage, last-refresh timestamp, event-kind tallies, and
 * the 10 most recent audit-trail events. Resilient — any query failure degrades
 * to `cloud:false` rather than throwing into the collector.
 *
 * @param {string} repoId
 * @returns {Promise<{cloud:boolean, totalIncidents:number,
 *   byStatus:Record<string,number>, embedded:number, lastRefreshAt:string|null,
 *   eventCounts:Record<string,number>, recentEvents:Array<object>}>}
 */
export async function getSecurityStats(repoId) {
  const empty = {
    cloud: false, totalIncidents: 0, byStatus: {}, embedded: 0,
    lastRefreshAt: null, eventCounts: {}, recentEvents: [],
  };
  if (!repoId || !await isCloudEnabled()) return empty;
  try {
    const statusRows = await many(
      `SELECT status, count(*)::int AS n
         FROM security_incidents WHERE repo_id = $1 GROUP BY status`,
      [repoId]
    );
    const cover = await one(
      `SELECT count(*)::int AS total, count(embedding)::int AS embedded
         FROM security_incidents WHERE repo_id = $1`,
      [repoId]
    );
    const lastRow = await one(
      `SELECT max(updated_at) AS last FROM security_incidents WHERE repo_id = $1`,
      [repoId]
    );
    const eventRows = await many(
      `SELECT event_kind, count(*)::int AS n
         FROM security_strategy_events WHERE repo_id = $1 GROUP BY event_kind`,
      [repoId]
    );
    const recentEvents = await getSecurityEvents(repoId, 10);

    const byStatus = {};
    for (const r of statusRows) byStatus[r.status] = r.n;
    const eventCounts = {};
    for (const r of eventRows) eventCounts[r.event_kind] = r.n;

    return {
      cloud: true,
      totalIncidents: cover?.total ?? 0,
      byStatus,
      embedded: cover?.embedded ?? 0,
      lastRefreshAt: lastRow?.last ?? null,
      eventCounts,
      recentEvents,
    };
  } catch (err) {
    // Degrade to empty so the dashboard collector still renders — but surface
    // the cause: a swallowed error here would make a failing/permission-denied
    // store look identical to "no incidents yet" (false-health reporting).
    process.stderr.write(`  [security-store] getSecurityStats failed (rendering empty): ${err.message}\n`);
    return empty;
  }
}

// ── helpers ────────────────────────────────────────────────────────────────

/**
 * Format a JS number[] embedding as a pgvector literal string the same
 * way rpc.mjs::vectorLiteral does, so the upsert can write directly into
 * a VECTOR(N) column. Returns null for null/undefined embeddings.
 */
function formatVectorOrNull(embedding) {
  if (embedding == null) return null;
  if (!Array.isArray(embedding)) {
    throw new TypeError(`security_incidents: embedding must be number[] or null`);
  }
  return `[${embedding.join(',')}]`;
}

// Test-only access to pure helpers (mirrors anthropic-client.mjs's pattern).
export const _internals = { parseVectorLiteral, formatVectorOrNull };
