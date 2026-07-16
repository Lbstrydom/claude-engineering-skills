/**
 * @fileoverview symbol_file_imports — file-import graph edges + populated flag.
 *
 * Owns 7 exports:
 *   recordSymbolFileImports, copyForwardImports, listFileImportsForSnapshot,
 *   markImportGraphPopulated, getImportGraphPopulated, getImportersForFiles,
 *   getFreshImportersOrNull
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

/**
 * Freshness-validated, dirty-tree-guarded, BOUNDED TRANSITIVE reverse-
 * dependency query for the tiered-recall Stage 0 evidence-relevance split
 * (plan: docs/plans/stage0-evidence-relevance-split.md decisions #5/#7).
 * Answers `tagPreExisting`'s `impactAdapter` contract DIRECTLY — `true`
 * means INDEPENDENT (no changed file depends on `filePath`, within
 * `maxDepth`), matching `evidence-triage.mjs::tagPreExisting`'s existing
 * polarity, not this function's own internal "found a dependent?" framing
 * (Gemini final-review round-2 G1 — the earlier draft's opposite polarity
 * made `pre_existing_independent` structurally unreachable).
 *
 * @param {object} args
 * @param {string} args.repoUuid
 * @param {string} args.headSha - the commit under audit; compared against
 *   the active refresh's own generation commit for freshness
 * @param {boolean} args.workingTreeDirty - round-2 plan-audit H2: a graph
 *   fresh for a COMMITTED headSha cannot see imports introduced/removed by
 *   an uncommitted change: `true` here always short-circuits to `null`
 * @param {string} args.filePath - the cited file to check
 * @param {string[]} args.changedFiles - this audit run's changed-file set
 * @param {number} [args.maxDepth=6] - bounded BFS depth (repo-configurable
 *   by the caller)
 * @returns {Promise<boolean|null>} `false` if `filePath` is itself among
 *   `changedFiles` (round-1 code-audit H2 — the cross-file import graph
 *   structurally cannot see a same-file dependency between new hunks
 *   elsewhere in `filePath` and the cited pre-existing lines, so a directly
 *   changed file is always confidently dependent, never independent), OR if
 *   a changed file depends on `filePath` (directly or transitively) within
 *   `maxDepth` — confident, regardless of overall graph completeness, since
 *   a found edge (or the file's own changed-ness) is real; `true` if the
 *   bounded traversal exhausts with no such dependent found, on an already
 *   freshness- AND completeness-validated graph; `null` on cloud-
 *   unavailable, stale OR incompletely-populated graph (round-1 code-audit
 *   H1/H6 — commit-sha match alone is not sufficient; a refresh whose
 *   import-graph population crashed partway through must never be treated
 *   as authoritative), dirty working tree, missing snapshot, an invalid
 *   `maxDepth` (round-1 code-audit M4 — must be a finite, non-negative
 *   integer; `Infinity`/`NaN`/negative would defeat the bound), or a
 *   depth-limit / unresolved-edge outcome — never a guess.
 */
export async function getFreshImportersOrNull({ repoUuid, headSha, workingTreeDirty, filePath, changedFiles, maxDepth = 6 }) {
  if (workingTreeDirty) return null;
  if (!repoUuid || !headSha || !filePath) return null;
  if (!Number.isInteger(maxDepth) || maxDepth < 0) return null;

  const changedSet = new Set(Array.isArray(changedFiles) ? changedFiles : []);
  // A directly changed file is confidently DEPENDENT on itself for this
  // adapter's purposes — the import graph is cross-file only and has no
  // visibility into whether NEW code elsewhere in the same file calls the
  // cited pre-existing lines. Checked BEFORE isCloudEnabled()/any DB
  // round-trip — cheap, and correct regardless of cloud availability or
  // graph freshness/completeness.
  if (changedSet.has(filePath)) return false;

  if (!await isCloudEnabled()) return null;

  let repoRow;
  try {
    repoRow = await one(`SELECT id, active_refresh_id FROM audit_repos WHERE repo_uuid = $1 LIMIT 1`, [repoUuid]);
  } catch {
    return null;
  }
  if (!repoRow?.active_refresh_id) return null;

  let refreshRow;
  try {
    refreshRow = await one(
      `SELECT commit_sha, import_graph_populated FROM refresh_runs WHERE id = $1 LIMIT 1`,
      [repoRow.active_refresh_id]
    );
  } catch {
    return null;
  }
  // Freshness requires BOTH the commit sha match AND the graph-population
  // completion marker — a refresh row can exist for the right commit while
  // its import-graph population crashed partway through (round-1 code-audit
  // H1/H6); `import_graph_populated !== true` degrades to the same 'stale'
  // null result as a commit-sha mismatch, never treated as an empty-but-
  // authoritative importer set.
  if (!refreshRow?.commit_sha || refreshRow.commit_sha !== headSha || refreshRow.import_graph_populated !== true) {
    return null;
  }

  const refreshId = repoRow.active_refresh_id;
  const visited = new Set([filePath]);
  let frontier = [filePath];
  let depth = 0;

  while (frontier.length > 0) {
    if (depth >= maxDepth) return null; // depth-limit hit before resolution
    let importersMap;
    try {
      importersMap = await getImportersForFiles({ refreshId, paths: frontier });
    } catch {
      return null;
    }
    const nextFrontier = [];
    for (const node of frontier) {
      for (const importer of (importersMap.get(node) || [])) {
        if (changedSet.has(importer)) return false; // confidently dependent
        if (!visited.has(importer)) {
          visited.add(importer);
          nextFrontier.push(importer);
        }
      }
    }
    frontier = nextFrontier;
    depth += 1;
  }
  return true; // bounded traversal exhausted, no dependent found -> confidently independent
}
