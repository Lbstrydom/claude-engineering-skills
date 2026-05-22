/**
 * @fileoverview symbol_file_imports — file-import graph edges + populated flag.
 *
 * Owns 6 exports:
 *   recordSymbolFileImports, copyForwardImports, listFileImportsForSnapshot,
 *   markImportGraphPopulated, getImportGraphPopulated, getImportersForFiles
 *
 * Plan: docs/plans/sustainability-cleanup-batch.md (WS1).
 *
 * @module scripts/lib/store/arch/imports
 */

import { many, one, updateWhere, upsert } from '../../db/query.mjs';
import { isCloudEnabled } from '../repo.mjs';
import { UPSERT_CHUNK_SIZE, IN_CHUNK, chunk } from './_shared.mjs';

export async function recordSymbolFileImports(refreshId, edges) {
  if (!Array.isArray(edges) || edges.length === 0) return { inserted: 0 };
  let inserted = 0;
  for (const batch of chunk(edges, UPSERT_CHUNK_SIZE)) {
    const payload = batch.map((e) => ({
      refresh_id: refreshId,
      importer_path: e.importer,
      imported_path: e.imported,
    }));
    try {
      await upsert('symbol_file_imports', payload, {
        onConflict: ['refresh_id', 'importer_path', 'imported_path'],
        update: 'all',
      });
      inserted += payload.length;
    } catch (err) {
      throw new Error(`recordSymbolFileImports failed: ${err.message}`);
    }
  }
  return { inserted };
}

export async function copyForwardImports({ fromRefreshId, toRefreshId, touchedFileSet }) {
  if (!fromRefreshId || !toRefreshId || !await isCloudEnabled()) return { copied: 0 };
  let copied = 0;
  const pageSize = 500;
  let offset = 0;
  while (true) {
    const rows = await many(
      `SELECT importer_path, imported_path FROM symbol_file_imports
        WHERE refresh_id = $1
        ORDER BY importer_path, imported_path
        OFFSET $2 LIMIT $3`,
      [fromRefreshId, offset, pageSize]
    );
    if (rows.length === 0) break;
    const keep = rows.filter((r) => !touchedFileSet.has(r.importer_path));
    if (keep.length > 0) {
      const payload = keep.map((r) => ({
        refresh_id: toRefreshId,
        importer_path: r.importer_path,
        imported_path: r.imported_path,
      }));
      await upsert('symbol_file_imports', payload, {
        onConflict: ['refresh_id', 'importer_path', 'imported_path'],
        update: 'all',
      });
      copied += payload.length;
    }
    if (rows.length < pageSize) break;
    offset += pageSize;
  }
  return { copied };
}

/**
 * List every file-import edge in a snapshot. Used by render-mermaid to
 * derive observed domain→domain deps. Plan: docs/plans/observed-domain-deps.md
 *
 * @param {string} refreshId
 * @returns {Promise<Array<{importer: string, imported: string}>>}
 */
export async function listFileImportsForSnapshot(refreshId) {
  if (!refreshId || !await isCloudEnabled()) return [];
  try {
    const rows = await many(
      `SELECT importer_path, imported_path FROM symbol_file_imports
        WHERE refresh_id = $1
        ORDER BY importer_path, imported_path`,
      [refreshId]
    );
    return rows.map((r) => ({ importer: r.importer_path, imported: r.imported_path }));
  } catch (err) {
    // R1-M9: preserve the underlying pg error as cause so callers can
    // inspect SQLSTATE / connection metadata without parsing the message.
    throw new Error(`listFileImportsForSnapshot failed: ${err.message}`, { cause: err });
  }
}

export async function markImportGraphPopulated(refreshId) {
  if (!await isCloudEnabled()) return;
  try {
    await updateWhere('refresh_runs', { import_graph_populated: true }, { id: refreshId });
  } catch (err) {
    throw new Error(`markImportGraphPopulated failed: ${err.message}`);
  }
}

export async function getImportGraphPopulated(refreshId) {
  if (!refreshId || !await isCloudEnabled()) return false;
  try {
    const row = await one(
      `SELECT import_graph_populated FROM refresh_runs WHERE id = $1 LIMIT 1`,
      [refreshId]
    );
    return row?.import_graph_populated === true;
  } catch {
    return false;
  }
}

/**
 * Look up file-level importers for a set of imported_path values within
 * a snapshot. Returns `Map<imported_path, sorted importer_paths[]>`.
 * Chunked at IN_CHUNK to avoid huge `= ANY($1)` parameter arrays.
 */
export async function getImportersForFiles({ refreshId, paths }) {
  const out = new Map();
  if (!refreshId || !Array.isArray(paths) || paths.length === 0) return out;
  if (!await isCloudEnabled()) return out;
  for (const batch of chunk(paths, IN_CHUNK)) {
    try {
      const rows = await many(
        `SELECT imported_path, importer_path FROM symbol_file_imports
          WHERE refresh_id = $1 AND imported_path = ANY($2)`,
        [refreshId, batch]
      );
      for (const row of rows) {
        if (!out.has(row.imported_path)) out.set(row.imported_path, []);
        out.get(row.imported_path).push(row.importer_path);
      }
    } catch (err) {
      throw new Error(`getImportersForFiles failed: ${err.message}`);
    }
  }
  for (const list of out.values()) list.sort();
  return out;
}
