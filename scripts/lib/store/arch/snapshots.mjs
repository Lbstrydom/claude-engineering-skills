/**
 * @fileoverview Active-snapshot pointer + embedding-model config.
 *
 * Owns 3 exports:
 *   getActiveSnapshot, setActiveEmbeddingModel, getActiveEmbeddingModel
 *
 * `getActiveSnapshot` reads from BOTH `audit_repos` (active_refresh_id +
 * embedding metadata) AND `refresh_runs` (import_graph_populated flag)
 * — kept together because the join target is the conceptual "snapshot
 * pointer" the repo currently exposes.
 *
 * Plan: docs/plans/sustainability-cleanup-batch.md (WS1).
 *
 * @module scripts/lib/store/arch/snapshots
 */

import { one, many, updateWhere } from '../../db/query.mjs';
import { isCloudEnabled } from '../repo.mjs';

/**
 * Read active snapshot pointers + the import-graph provenance flag.
 * Two-step: read repo pointers, then look up the active refresh's
 * import_graph_populated flag.
 */
export async function getActiveSnapshot(repoId) {
  if (!await isCloudEnabled()) return null;
  try {
    const data = await one(
      `SELECT active_refresh_id, active_embedding_model, active_embedding_dim
         FROM audit_repos WHERE id = $1 LIMIT 1`,
      [repoId]
    );
    if (!data) return null;
    let importGraphPopulated = false;
    if (data.active_refresh_id) {
      const rr = await one(
        `SELECT import_graph_populated FROM refresh_runs WHERE id = $1 LIMIT 1`,
        [data.active_refresh_id]
      );
      if (rr && rr.import_graph_populated === true) importGraphPopulated = true;
    }
    return {
      refreshId: data.active_refresh_id,
      activeEmbeddingModel: data.active_embedding_model,
      activeEmbeddingDim: data.active_embedding_dim,
      importGraphPopulated,
    };
  } catch {
    return null;
  }
}

/**
 * Set the repo's active embedding model + dim. Per R3 H7 / Gemini G2,
 * `model` MUST be a concrete provider id (never a sentinel string).
 */
export async function setActiveEmbeddingModel({ repoId, model, dim }) {
  if (!model || !dim) throw new Error('model and dim are both required');
  try {
    await updateWhere('audit_repos',
      { active_embedding_model: model, active_embedding_dim: dim },
      { id: repoId }
    );
  } catch (err) {
    throw new Error(`setActiveEmbeddingModel failed: ${err.message}`);
  }
}

export async function getActiveEmbeddingModel(repoId) {
  if (!await isCloudEnabled()) return null;
  try {
    const data = await one(
      `SELECT active_embedding_model, active_embedding_dim
         FROM audit_repos WHERE id = $1 LIMIT 1`,
      [repoId]
    );
    if (!data) return null;
    return { model: data.active_embedding_model, dim: data.active_embedding_dim };
  } catch {
    return null;
  }
}

/**
 * Persist a per-repo band calibration (plan §2.1 C4-REVISED).
 *
 * The floor is a MEASUREMENT of this repo's own embedding background, not a
 * setting — which is why it lives in the store rather than in synced config.
 * See the migration comment for why the whole record is one jsonb value.
 *
 * jsonb-safe write seam (AGENTS.md): the value is passed RAW. The db layer's
 * `serializeWriteParam` JSON-serialises plain objects/arrays bound to write
 * params; hand-stringifying here would double-encode.
 *
 * @param {string} repoId
 * @param {object|null} calibration - null clears it (back to uncalibrated)
 */
export async function recordBandCalibration(repoId, calibration) {
  if (!await isCloudEnabled()) return { ok: false, cloud: false };
  if (!repoId) return { ok: false, reason: 'no-repo-id' };
  await updateWhere('audit_repos', { band_calibration: calibration }, { id: repoId });
  return { ok: true, cloud: true };
}

/**
 * Read a repo's band calibration.
 *
 * Returns `null` for uncalibrated, and the caller MUST treat that as "band
 * `review` only" rather than substituting a default. A borrowed threshold is
 * precisely the defect this design removes.
 *
 * @returns {Promise<object|null>}
 */
export async function getBandCalibration(repoId) {
  if (!await isCloudEnabled()) return null;
  if (!repoId) return null;
  const row = await one(`SELECT band_calibration FROM audit_repos WHERE id = $1 LIMIT 1`, [repoId]);
  return row?.band_calibration ?? null;
}

/**
 * Random sample of embedding vectors from a published snapshot, for computing
 * the repo's background similarity distribution (plan §2.1 C4-REVISED).
 *
 * Samples from the DB rather than from the in-flight embed output on purpose:
 * an INCREMENTAL refresh only embeds touched files, so sampling the run's own
 * output would measure the background of whatever the developer happened to be
 * editing. The floor must describe the corpus, not the changeset.
 *
 * @param {string} refreshId
 * @param {number} limit
 * @returns {Promise<number[][]>}
 */
export async function sampleSnapshotEmbeddings(refreshId, limit = 120) {
  if (!await isCloudEnabled()) return [];
  if (!refreshId) return [];
  const rows = await many(
    `SELECT se.embedding::text AS emb
       FROM symbol_index si
       JOIN symbol_definitions sd ON sd.id = si.definition_id
       JOIN symbol_embeddings se ON se.definition_id = sd.id
                                AND se.signature_hash = si.signature_hash
      WHERE si.refresh_id = $1
      ORDER BY random()
      LIMIT $2`,
    [refreshId, limit],
  );
  const out = [];
  for (const r of rows || []) {
    try {
      const v = JSON.parse(r.emb);
      if (Array.isArray(v) && v.length > 0) out.push(v);
    } catch { /* skip an unparseable vector rather than abort calibration */ }
  }
  return out;
}
