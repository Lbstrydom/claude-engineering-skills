/**
 * @fileoverview Repo-identity domain — audit_repos lookups + upserts.
 *
 * Part of the postgres-parity M3 domain-module split (plan §2
 * "Domain-module split", §7 P3). Translates the 6 repo-related
 * PostgREST calls in `scripts/learning-store.mjs` to raw SQL over the
 * new `db/` seam.
 *
 * The barrel in `scripts/learning-store.mjs` will re-export these
 * functions verbatim; signatures + return shapes match the legacy
 * supabase-js path byte-for-byte (audit-loop migration #18 — public
 * contract frozen).
 *
 * Graceful degradation (#16): every public function returns `null` (or
 * an equivalent neutral value) when `getPool()` returns null, mirroring
 * the legacy `if (!_supabase) return null` guard. NO_DB errors thrown
 * by the query helpers are caught and translated to the same neutral
 * return.
 *
 * @module scripts/lib/store/repo
 */

import { getPool } from '../db/client.mjs';
import { one, insertReturning, upsert, many } from '../db/query.mjs';

// ── Lifecycle helpers ──────────────────────────────────────────────────────

/**
 * Initialise the learning store. Under the old supabase-js path this
 * eagerly created the Supabase client; under the pg path this is just
 * a connectivity probe — the pool is lazy and getPool() builds it on
 * first use.
 *
 * Returns `true` if cloud mode is active (a pool was built + a SELECT 1
 * succeeded), `false` if cloud is disabled (no AUDIT_DB_URL) or the
 * probe failed.
 *
 * @returns {Promise<boolean>}
 */
export async function initLearningStore() {
  let pool;
  try {
    pool = await getPool();
  } catch (err) {
    process.stderr.write(`  [learning] Cloud store init failed: ${err.message}\n`);
    return false;
  }
  if (!pool) {
    process.stderr.write('  [learning] Cloud store not configured — using local mode\n');
    return false;
  }
  // Connectivity probe — single SELECT against audit_repos so we surface
  // table-missing / auth errors at init time rather than at first real query.
  try {
    await pool.query('SELECT 1 FROM audit_repos LIMIT 1');
  } catch (err) {
    process.stderr.write(`  [learning] Supabase connection failed: ${err.message}\n`);
    return false;
  }
  process.stderr.write('  [learning] Cloud store connected\n');
  return true;
}

/**
 * Synchronous-feeling cloud-enabled check. Inside the legacy code this
 * was `_supabase !== null` — a sync read of module state. Under the pg
 * path it's an async pool-presence check.
 *
 * @returns {Promise<boolean>}
 */
export async function isCloudEnabled() {
  try {
    const pool = await getPool();
    return pool !== null;
  } catch {
    return false;
  }
}

// ── audit_repos CRUD ───────────────────────────────────────────────────────

/**
 * Upsert a repo profile keyed on `fingerprint`. Returns the row id, or
 * null when the store is disabled / the upsert fails.
 *
 * Legacy contract:
 *   - input: profile = { repoFingerprint, stack, fileBreakdown, focusAreas }, repoName
 *   - return: string (uuid) | null
 *   - on-conflict: 'fingerprint' DO UPDATE
 *
 * @param {object} profile - From generateRepoProfile()
 * @param {string} repoName - Human-readable repo name
 * @returns {Promise<string|null>} row id
 */
export async function upsertRepo(profile, repoName) {
  if (!await isCloudEnabled()) return null;
  try {
    const rows = await upsert(
      'audit_repos',
      [{
        fingerprint:      profile.repoFingerprint,
        name:             repoName,
        stack:            profile.stack,
        file_breakdown:   profile.fileBreakdown,
        focus_areas:      profile.focusAreas,
        last_audited_at:  new Date().toISOString(),
      }],
      { onConflict: 'fingerprint', update: 'all', returning: ['id'] }
    );
    return rows[0]?.id ?? null;
  } catch (err) {
    process.stderr.write(`  [learning] upsertRepo failed: ${err.message}\n`);
    return null;
  }
}

/**
 * Read a repo's identity + active-snapshot pointers by `repo_uuid`.
 *
 * Legacy contract:
 *   - input: repoUuid (string)
 *   - return: { id, name, activeRefreshId, activeEmbeddingModel, activeEmbeddingDim } | null
 *
 * @param {string} repoUuid
 */
export async function getRepoIdByUuid(repoUuid) {
  if (!await isCloudEnabled()) return null;
  try {
    const row = await one(
      `SELECT id, name, repo_uuid, active_refresh_id,
              active_embedding_model, active_embedding_dim
         FROM audit_repos
        WHERE repo_uuid = $1
        LIMIT 1`,
      [repoUuid]
    );
    if (!row) return null;
    return {
      id: row.id,
      name: row.name,
      activeRefreshId: row.active_refresh_id,
      activeEmbeddingModel: row.active_embedding_model,
      activeEmbeddingDim: row.active_embedding_dim,
    };
  } catch {
    return null;
  }
}

/**
 * Upsert a repo row keyed on `repo_uuid`. Two-step: try update-existing
 * first, then insert when absent. Mirrors the legacy `upsertRepoByUuid`
 * behaviour exactly (it does the same select-then-upsert sequence).
 *
 * The fingerprint fallback to `repo_uuid:<uuid>` preserves backward
 * compat with the old fingerprint-only unique constraint.
 *
 * @param {{repoUuid: string, name: string, fingerprint?: string}} input
 * @returns {Promise<{id: string}|null>}
 */
export async function upsertRepoByUuid({ repoUuid, name, fingerprint }) {
  if (!await isCloudEnabled()) return null;
  try {
    // Step 1 — return early if a row with this repo_uuid already exists.
    const existing = await one(
      `SELECT id FROM audit_repos WHERE repo_uuid = $1 LIMIT 1`,
      [repoUuid]
    );
    if (existing?.id) return { id: existing.id };

    // Step 2 — upsert on fingerprint (the canonical unique constraint).
    const fp = fingerprint || `repo_uuid:${repoUuid}`;
    const rows = await upsert(
      'audit_repos',
      [{
        repo_uuid:        repoUuid,
        name,
        fingerprint:      fp,
        last_audited_at:  new Date().toISOString(),
      }],
      { onConflict: 'fingerprint', update: 'all', returning: ['id'] }
    );
    return rows[0] ? { id: rows[0].id } : null;
  } catch (err) {
    process.stderr.write(`  [arch] upsertRepoByUuid failed: ${err.message}\n`);
    return null;
  }
}

/**
 * Read the most recent repo id by human-readable name.
 *
 * Legacy contract:
 *   - input: repoName (string)
 *   - return: id (uuid) | null
 *   - ordering: created_at DESC LIMIT 1 (contract:created_at DESC LIMIT 1)
 *
 * @param {string} repoName
 * @returns {Promise<string|null>}
 */
export async function getRepoIdByName(repoName) {
  if (!repoName || !await isCloudEnabled()) return null;
  try {
    const row = await one(
      `SELECT id, created_at
         FROM audit_repos
        WHERE name = $1
        ORDER BY created_at DESC
        LIMIT 1`,
      [repoName]
    );
    return row?.id ?? null;
  } catch {
    return null;
  }
}

/**
 * List every audit_repos id — used by scripts/symbol-index/prune.mjs to
 * iterate per-repo for rollback-retention demotion.
 *
 * Plan §7 P3 — companion to the 6 raw-client-replacement exports.
 *
 * @returns {Promise<string[]>}
 */
export async function listRepoIds() {
  if (!await isCloudEnabled()) return [];
  try {
    const rows = await many(`SELECT id FROM audit_repos ORDER BY id`);
    return rows.map((r) => r.id);
  } catch (err) {
    process.stderr.write(`  [learning] listRepoIds failed: ${err.message}\n`);
    return [];
  }
}
