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

import { one, updateWhere } from '../../db/query.mjs';
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
