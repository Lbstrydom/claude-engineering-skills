/**
 * @fileoverview Security-incidents domain module.
 * Plan: docs/plans/security-strategy-postgres-port.md §5 (Phase 2 — adapted).
 *
 * Adapted from the upstream `lib/store/security.mjs`. Uses audit-loop's db
 * query layer (../db/query.mjs) and repo resolver (./repo.mjs), matching the
 * sibling domain modules (repo.mjs, arch-memory.mjs, runs-findings.mjs).
 *
 * Embedding-column handling (plan Phase 2.3): the `embedding` column only
 * exists when pgvector is installed. Callers pass `includeEmbedding` — when
 * false the column is omitted from the statement entirely (never NULL-bound),
 * keeping a uniform column shape across the batch. `embedding_model` /
 * `embedding_dim` are always-present nullable columns.
 *
 * @module scripts/lib/store/security
 */

import crypto from 'node:crypto';
import { many, upsert, insertMany } from '../db/query.mjs';
import { getRepoIdByName, upsertRepo, isCloudEnabled } from './repo.mjs';

const UPSERT_CHUNK_SIZE = 500;

function chunk(arr, n) {
  const out = [];
  for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
  return out;
}

/** Format a JS number[] as a pgvector literal, or null. */
function vectorLiteral(embedding) {
  if (embedding == null) return null;
  if (!Array.isArray(embedding)) {
    throw new TypeError('security_incidents: embedding must be number[] or null');
  }
  return `[${embedding.join(',')}]`;
}

/**
 * Resolve a stable audit_repos.id for the security domain from a repo name.
 * Deterministic: fingerprint = sha256(name) so refresh and cross-skill agree.
 * @param {string} name
 * @returns {Promise<string|null>} repo UUID or null when cloud disabled.
 */
export async function resolveSecurityRepoId(name) {
  if (!await isCloudEnabled()) return null;
  // Reuse the existing audit_repos row for this repo when present, so security
  // incidents attach to the SAME repo_id the audit / arch-memory flows use
  // (avoids a duplicate bare repo row). Only when no row exists yet do we
  // create one under a deterministic security-scoped fingerprint — stable
  // across both refresh and cross-skill so retrieval always agrees.
  const existing = await getRepoIdByName(name);
  if (existing) return existing;
  const fingerprint = crypto.createHash('sha256').update(`security:${name}`).digest('hex').slice(0, 32);
  return upsertRepo({ repoFingerprint: fingerprint, stack: {}, fileBreakdown: {}, focusAreas: [] }, name);
}

/**
 * Compact existing rows for the refresh diff.
 * @param {string} repoId
 * @returns {Promise<object[]>}
 */
export async function getSecurityIncidentsByRepo(repoId) {
  if (!repoId || !await isCloudEnabled()) return [];
  return many(
    `SELECT id, incident_id, source_fingerprint, embedding_model, embedding_dim,
            status, commit_sha, mitigation_ref, mitigation_kind
       FROM security_incidents
      WHERE repo_id = $1`,
    [repoId]
  );
}

/**
 * UPSERT a batch of incidents. Chunked at 500 rows.
 *
 * @param {string} repoId
 * @param {Array<object>} incidents - each MUST carry a non-null commit_sha
 * @param {object} opts
 * @param {boolean} opts.includeEmbedding - include the `embedding` column
 * @returns {Promise<{upserted: number}>}
 */
export async function recordSecurityIncidents(repoId, incidents, { includeEmbedding = false } = {}) {
  if (!Array.isArray(incidents) || incidents.length === 0) return { upserted: 0 };
  if (!await isCloudEnabled()) return { upserted: 0 };

  let upserted = 0;
  for (const batch of chunk(incidents, UPSERT_CHUNK_SIZE)) {
    const payload = batch.map((i) => {
      if (!i.commit_sha) {
        throw new Error(`security_incidents: ${i.incident_id} is missing commit_sha (NOT NULL)`);
      }
      const row = {
        repo_id: repoId,
        incident_id: i.incident_id,
        description: i.description,
        affected_paths: i.affected_paths ?? [],
        mitigation_ref: i.mitigation_ref ?? null,
        mitigation_kind: i.mitigation_kind ?? 'manual',
        status: i.status ?? 'manual-verification-required',
        lessons_learned: i.lessons_learned ?? null,
        commit_sha: i.commit_sha,
        classification: i.classification ?? 'INTERNAL',
        compliance_tags: i.compliance_tags ?? [],
        embedding_model: i.embedding_model ?? null,
        embedding_dim: i.embedding_dim ?? null,
        source_fingerprint: i.source_fingerprint,
        status_check_at: i.status_check_at ?? null,
      };
      if (includeEmbedding) {
        row.embedding = vectorLiteral(i.embedding ?? null);
      }
      return row;
    });
    await upsert('security_incidents', payload, {
      onConflict: ['repo_id', 'incident_id'],
      update: 'all',
    });
    upserted += payload.length;
  }
  return { upserted };
}

/**
 * Mark incidents removed from the markdown as historical (sweep).
 * @param {string} repoId
 * @param {string[]} incidentIds
 * @returns {Promise<{marked: number}>}
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
 * Append audit-trail events. Plain multi-row insert (no conflict target).
 * `detail` is JSONB — pass plain objects (pre-redacted by the caller).
 * @param {string} repoId
 * @param {Array<{incident_id:string, event_kind:string, branch:string,
 *                who?:string, commit_sha?:string, detail?:object}>} events
 * @returns {Promise<{recorded: number}>}
 */
export async function recordStrategyEvents(repoId, events) {
  if (!Array.isArray(events) || events.length === 0) return { recorded: 0 };
  if (!await isCloudEnabled()) return { recorded: 0 };
  const rows = events.map((e) => ({
    repo_id: repoId,
    incident_id: e.incident_id,
    event_kind: e.event_kind,
    who: e.who ?? null,
    branch: e.branch,
    commit_sha: e.commit_sha ?? null,
    detail: e.detail ?? {},
  }));
  // Append-only audit trail — use insertMany (explicit plain INSERT) rather than
  // upsert with an empty conflict target, so the no-dedup intent is unambiguous
  // and independent of buildUpsert internals (R2 M1 / Opus O1).
  await insertMany('security_strategy_events', rows);
  return { recorded: rows.length };
}

/**
 * Neighbourhood retrieval. When pgvector is present, calls the
 * security_incident_neighbourhood() RPC (path-overlap-first, similarity tie-
 * break; NULL embedding → path-overlap only). When absent, runs an equivalent
 * path-overlap-only SQL fallback.
 *
 * @param {object} args
 * @param {string} args.repoId
 * @param {string[]} args.targetPaths
 * @param {number[]|null} args.intentEmbedding
 * @param {number} args.k
 * @param {boolean} args.hasVector
 * @returns {Promise<object[]>}
 */
export async function queryIncidentNeighbourhood({ repoId, targetPaths, intentEmbedding, k, hasVector }) {
  if (!repoId || !await isCloudEnabled()) return [];
  const kk = Number.isFinite(k) && k > 0 ? Math.floor(k) : 8;
  const paths = Array.isArray(targetPaths) ? targetPaths : [];

  let rows;
  if (hasVector) {
    rows = await many(
      // $3 is cast explicitly to vector: vectorLiteral() yields a text literal,
      // and under prepared-statement param typing an unknown/text bind can fail
      // function-overload resolution against the vector(768) parameter. NULL::vector
      // is still NULL, so the pgvector-OFF/no-intent case is unaffected. (R3 audit
      // finding d1793532; exercised live by the pgvector-azure-ci job.)
      `SELECT * FROM security_incident_neighbourhood($1, $2, $3::vector, $4)`,
      [repoId, paths, intentEmbedding ? vectorLiteral(intentEmbedding) : null, kk]
    );
  } else {
    rows = await many(
      `SELECT si.id, si.incident_id, si.description, si.affected_paths,
              si.status, si.classification, si.compliance_tags,
              NULL::numeric AS similarity,
              cardinality(ARRAY(
                SELECT unnest(si.affected_paths) INTERSECT SELECT unnest($2::text[])
              ))::int AS path_overlap
         FROM security_incidents si
        WHERE si.repo_id = $1 AND si.status <> 'historical'
        ORDER BY path_overlap DESC, si.updated_at DESC, si.incident_id ASC
        LIMIT $3`,
      [repoId, paths, kk]
    );
  }

  return rows.map((r) => ({
    id: r.id,
    incidentId: r.incident_id,
    description: r.description,
    affectedPaths: r.affected_paths,
    status: r.status,
    classification: r.classification,
    complianceTags: r.compliance_tags,
    similarity: r.similarity == null ? null : Number(r.similarity),
    pathOverlap: Number(r.path_overlap),
  }));
}

/**
 * Aggregate stats for the dashboard Security section.
 * Returns counts per classification + status, total non-historical, last
 * refresh timestamp, embedding coverage, and the most recent audit-trail
 * events. Returns null when cloud is disabled or the table is absent.
 *
 * @param {string} repoId
 * @returns {Promise<null | {
 *   total: number, historical: number,
 *   byClassification: Record<string, number>,
 *   byStatus: Record<string, number>,
 *   withEmbedding: number,
 *   lastRefreshAt: string|null,
 *   recentEvents: Array<{incident_id:string, event_kind:string, branch:string, created_at:string}>,
 * }>}
 */
export async function getSecurityStats(repoId) {
  if (!repoId || !await isCloudEnabled()) return null;
  try {
    const rows = await many(
      `SELECT classification, status, (embedding_model IS NOT NULL) AS has_embedding,
              EXTRACT(EPOCH FROM updated_at) AS updated_epoch
         FROM security_incidents
        WHERE repo_id = $1`,
      [repoId]
    );
    const byClassification = {};
    const byStatus = {};
    let total = 0, historical = 0, withEmbedding = 0, lastEpoch = 0;
    for (const r of rows) {
      if (r.status === 'historical') { historical += 1; } else { total += 1; }
      byClassification[r.classification] = (byClassification[r.classification] || 0) + 1;
      byStatus[r.status] = (byStatus[r.status] || 0) + 1;
      if (r.has_embedding) withEmbedding += 1;
      const e = Number(r.updated_epoch) || 0;
      if (e > lastEpoch) lastEpoch = e;
    }
    const recent = await many(
      `SELECT incident_id, event_kind, branch, created_at
         FROM security_strategy_events
        WHERE repo_id = $1
        ORDER BY created_at DESC
        LIMIT 10`,
      [repoId]
    );
    return {
      total,
      historical,
      byClassification,
      byStatus,
      withEmbedding,
      lastRefreshAt: lastEpoch ? new Date(lastEpoch * 1000).toISOString() : null,
      recentEvents: recent.map((e) => ({
        incident_id: e.incident_id,
        event_kind: e.event_kind,
        branch: e.branch,
        created_at: e.created_at,
      })),
    };
  } catch {
    // table absent (migration not applied) or transient — treat as no data
    return null;
  }
}

export const _securityInternals = Object.freeze({ vectorLiteral });
