/**
 * @fileoverview Architectural-memory + symbol-index + refresh-runs domain.
 *
 * The largest M3 domain — 18 functions covering the entire symbol-index
 * + refresh-runs + domain-summaries + import-graph + neighbourhood-query
 * surface (per docs/plans/architectural-memory.md).
 *
 * Notable translation choices:
 *   - The legacy `withRetry` network-blip wrapper is gone: under the `pg`
 *     driver the connection-failure path is handled by normalizePostgresError
 *     (errors.mjs) classifying SQLSTATE 08* / ECONNRESET as transient. Pool-
 *     level reconnect handles single-connection blips; the explicit retry
 *     loop was a supabase-js-fetch workaround.
 *   - `listSymbolsForSnapshot` has a non-trivial JOIN against
 *     symbol_definitions — hand-written SQL.
 *
 * @module scripts/lib/store/arch-memory
 */

import crypto from 'node:crypto';
import { many, one, insertReturning, updateWhere, upsert } from '../db/query.mjs';
import { getPool } from '../db/client.mjs';
import {
  publishRefreshRun as rpcPublishRefreshRun,
  driftScore as rpcDriftScore,
  topDuplicateClusters as rpcTopDuplicateClusters,
  symbolNeighbourhood as rpcSymbolNeighbourhood,
} from '../db/rpc.mjs';
import { isCloudEnabled } from './repo.mjs';

const UPSERT_CHUNK_SIZE = 500;
const IN_CHUNK = 200;

function chunk(arr, n) {
  const out = [];
  for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
  return out;
}

// ── refresh_runs lifecycle ─────────────────────────────────────────────────

/**
 * Open a new refresh_run row. Holds the (repo_id, status='running')
 * unique lock until publishRefreshRun or abortRefreshRun resolves.
 *
 * Throws REFRESH_IN_FLIGHT on unique-constraint conflict (existing lock).
 */
export async function openRefreshRun({ repoId, mode, walkStartCommit }) {
  const cancellationToken = crypto.randomUUID();
  try {
    const data = await insertReturning('refresh_runs', {
      repo_id: repoId,
      mode,
      walk_start_commit: walkStartCommit || null,
      cancellation_token: cancellationToken,
      last_heartbeat_at: new Date().toISOString(),
    }, { returning: ['id'] });
    return { refreshId: data.id, cancellationToken };
  } catch (err) {
    if (err._normalized?.nativeCode === '23505' || err.code === '23505') {
      const e = new Error('A refresh is already in flight for this repo. Pass --force to abort.');
      e.code = 'REFRESH_IN_FLIGHT';
      throw e;
    }
    throw err;
  }
}

/**
 * Atomic publish via the publish_refresh_run RPC (Gemini-R2 G1):
 * flips refresh_runs.status + audit_repos.active_refresh_id + active
 * embedding model/dim in one server-side transaction.
 */
export async function publishRefreshRun({ repoId, refreshId, activeEmbeddingModel, activeEmbeddingDim }) {
  try {
    return await rpcPublishRefreshRun({ repoId, refreshId, activeEmbeddingModel, activeEmbeddingDim });
  } catch (err) {
    throw new Error(`publish_refresh_run RPC failed: ${err.message}`);
  }
}

/** Mark a refresh_run aborted — workers polling status see this and exit. */
export async function abortRefreshRun({ refreshId, reason }) {
  try {
    await updateWhere('refresh_runs',
      {
        status: 'aborted',
        error: reason || null,
        completed_at: new Date().toISOString(),
        retention_class: 'aborted',
      },
      { id: refreshId }
    );
  } catch (err) {
    throw new Error(`abortRefreshRun failed: ${err.message}`);
  }
}

/** Touch heartbeat so --force can detect a live worker. */
export async function heartbeatRefreshRun({ refreshId }) {
  await updateWhere('refresh_runs', { last_heartbeat_at: new Date().toISOString() }, { id: refreshId });
}

// ── refresh_runs prune / inspect (replaces the raw-client callers) ─────────

/**
 * Read a single refresh_run by id. `select` is an optional column allowlist
 * (defaults to a useful set). Replaces a raw-client SELECT in
 * scripts/symbol-index/refresh.mjs.
 *
 * Plan §7 P3 — one of the 6 named exports the caller migrations consume.
 *
 * @param {string} refreshId
 * @param {object} [opts]
 * @param {string[]} [opts.select] - column allowlist
 * @returns {Promise<object|null>}
 */
export async function getRefreshRun(refreshId, { select } = {}) {
  if (!refreshId || !await isCloudEnabled()) return null;
  const cols = (Array.isArray(select) && select.length > 0)
    ? select.map((c) => `"${c}"`).join(', ')
    : 'id, repo_id, mode, status, walk_start_commit, walk_end_commit, started_at, completed_at, retention_class, last_heartbeat_at, import_graph_populated';
  try {
    return await one(
      `SELECT ${cols} FROM refresh_runs WHERE id = $1 LIMIT 1`,
      [refreshId]
    );
  } catch {
    return null;
  }
}

/**
 * Find the most-recent stuck-on-running refresh for a repo. Used by
 * `arch:refresh --force` to know which refresh to abort. Replaces a
 * raw-client query in scripts/symbol-index/refresh.mjs.
 *
 * @param {string} repoId
 * @returns {Promise<{id: string, last_heartbeat_at: string, started_at: string}|null>}
 */
export async function findStaleRunningRefresh(repoId) {
  if (!repoId || !await isCloudEnabled()) return null;
  try {
    return await one(
      `SELECT id, last_heartbeat_at, started_at
         FROM refresh_runs
        WHERE repo_id = $1 AND status = 'running'
        ORDER BY started_at DESC
        LIMIT 1`,
      [repoId]
    );
  } catch {
    return null;
  }
}

/**
 * Return refresh_run ids eligible for pruning, given a filter
 * (`status` or `retention_class`) and a retention cutoff in days. Picks
 * up BOTH cleanly-finished runs (completed_at < cutoff) AND crashed runs
 * (completed_at IS NULL AND started_at < cutoff) — closing the
 * Gemini-G3 leak where crashed refreshes lived forever.
 *
 * Plan §7 P3 — one of the 6 named exports.
 *
 * @param {{filterCol: 'status'|'retention_class', filterVal: string, retainDays: number}} args
 * @returns {Promise<string[]>}
 */
export async function listPrunableRefreshRuns({ filterCol, filterVal, retainDays }) {
  if (!await isCloudEnabled()) return [];
  // Whitelist the column so the SQL is safe even though it's interpolated.
  if (filterCol !== 'status' && filterCol !== 'retention_class') {
    throw new Error(`listPrunableRefreshRuns: filterCol must be 'status' or 'retention_class' — got ${filterCol}`);
  }
  const cutoffIso = new Date(Date.now() - retainDays * 86400_000).toISOString();
  try {
    const rows = await many(
      `SELECT id FROM refresh_runs
        WHERE "${filterCol}" = $1
          AND (
            completed_at < $2
            OR (completed_at IS NULL AND started_at < $2)
          )`,
      [filterVal, cutoffIso]
    );
    return rows.map((r) => r.id);
  } catch (err) {
    process.stderr.write(`  [arch] listPrunableRefreshRuns failed: ${err.message}\n`);
    return [];
  }
}

/**
 * Bulk delete refresh_runs by id list. Returns count actually deleted.
 *
 * Plan §7 P3 — one of the 6 named exports.
 */
export async function deleteRefreshRuns(ids) {
  if (!Array.isArray(ids) || ids.length === 0) return 0;
  if (!await isCloudEnabled()) return 0;
  try {
    const pool = await getPool();
    if (!pool) return 0;
    const res = await pool.query(
      `DELETE FROM refresh_runs WHERE id = ANY($1)`,
      [ids]
    );
    return res.rowCount ?? 0;
  } catch (err) {
    process.stderr.write(`  [arch] deleteRefreshRuns failed: ${err.message}\n`);
    return 0;
  }
}

/**
 * Bulk set retention_class for refresh_runs by id list. Used by the
 * rollback-keep-N demotion in scripts/symbol-index/prune.mjs.
 *
 * Plan §7 P3 — one of the 6 named exports.
 *
 * @param {string[]} ids
 * @param {'transient'|'weekly_checkpoint'|'rollback'|'aborted'} retentionClass
 * @returns {Promise<number>} rows affected
 */
export async function demoteRefreshRuns(ids, retentionClass) {
  if (!Array.isArray(ids) || ids.length === 0) return 0;
  if (!await isCloudEnabled()) return 0;
  try {
    const pool = await getPool();
    if (!pool) return 0;
    const res = await pool.query(
      `UPDATE refresh_runs SET retention_class = $1 WHERE id = ANY($2)`,
      [retentionClass, ids]
    );
    return res.rowCount ?? 0;
  } catch (err) {
    process.stderr.write(`  [arch] demoteRefreshRuns failed: ${err.message}\n`);
    return 0;
  }
}

/**
 * List rollback-class refresh_runs for a repo, ordered newest-first.
 * Powers the keep-last-N rollback retention in
 * scripts/symbol-index/prune.mjs.
 *
 * @param {string} repoId
 * @returns {Promise<Array<{id: string, completed_at: string|null}>>}
 */
export async function listRollbacksForRepo(repoId) {
  if (!repoId || !await isCloudEnabled()) return [];
  try {
    return await many(
      `SELECT id, completed_at FROM refresh_runs
        WHERE repo_id = $1 AND retention_class = 'rollback'
        ORDER BY completed_at DESC NULLS LAST`,
      [repoId]
    );
  } catch (err) {
    process.stderr.write(`  [arch] listRollbacksForRepo failed: ${err.message}\n`);
    return [];
  }
}


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

// ── symbol_definitions / symbol_index / symbol_embeddings ─────────────────

/**
 * Bulk upsert symbol_definitions. Returns `{[canonical_path|name|kind]: id}`
 * — the lookup map subsequent symbol_index writes need.
 */
export async function recordSymbolDefinitions(repoId, defs) {
  if (!Array.isArray(defs) || defs.length === 0) return {};
  const rows = defs.map((d) => ({
    repo_id: repoId,
    canonical_path: d.canonicalPath,
    symbol_name: d.symbolName,
    kind: d.kind,
    last_seen_at: new Date().toISOString(),
  }));
  const map = {};
  for (const slice of chunk(rows, UPSERT_CHUNK_SIZE)) {
    try {
      const out = await upsert('symbol_definitions', slice, {
        onConflict: ['repo_id', 'canonical_path', 'symbol_name', 'kind'],
        update: 'all',
        returning: ['id', 'canonical_path', 'symbol_name', 'kind'],
      });
      for (const r of out) map[`${r.canonical_path}|${r.symbol_name}|${r.kind}`] = r.id;
    } catch (err) {
      throw new Error(`recordSymbolDefinitions failed: ${err.message}`);
    }
  }
  return map;
}

export async function recordSymbolIndex(refreshId, repoId, rows) {
  if (!Array.isArray(rows) || rows.length === 0) return 0;
  const payload = rows.map((r) => ({
    refresh_id: refreshId,
    repo_id: repoId,
    definition_id: r.definitionId,
    file_path: r.filePath,
    start_line: r.startLine,
    end_line: r.endLine,
    signature_hash: r.signatureHash,
    purpose_summary: r.purposeSummary || null,
    domain_tag: r.domainTag || null,
  }));
  let total = 0;
  for (const slice of chunk(payload, UPSERT_CHUNK_SIZE)) {
    try {
      await upsert('symbol_index', slice, {
        onConflict: ['refresh_id', 'definition_id'],
        update: 'all',
      });
      total += slice.length;
    } catch (err) {
      throw new Error(`recordSymbolIndex failed: ${err.message}`);
    }
  }
  return total;
}

export async function recordSymbolEmbedding({ definitionId, embeddingModel, dimension, vector, signatureHash }) {
  try {
    await upsert('symbol_embeddings', [{
      definition_id: definitionId,
      embedding_model: embeddingModel,
      dimension,
      embedding: vector,
      signature_hash: signatureHash,
    }], {
      onConflict: ['definition_id', 'embedding_model', 'dimension', 'signature_hash'],
      update: 'all',
    });
  } catch (err) {
    throw new Error(`recordSymbolEmbedding failed: ${err.message}`);
  }
}

export async function recordLayeringViolations(refreshId, repoId, violations) {
  if (!Array.isArray(violations) || violations.length === 0) return 0;
  const payload = violations.map((v) => ({
    refresh_id: refreshId,
    repo_id: repoId,
    rule_name: v.ruleName,
    from_path: v.fromPath,
    to_path: v.toPath,
    severity: v.severity,
    comment: v.comment || null,
  }));
  let total = 0;
  for (const slice of chunk(payload, UPSERT_CHUNK_SIZE)) {
    try {
      await upsert('symbol_layering_violations', slice, {
        onConflict: ['refresh_id', 'rule_name', 'from_path', 'to_path'],
        update: 'all',
      });
      total += slice.length;
    } catch (err) {
      throw new Error(`recordLayeringViolations failed: ${err.message}`);
    }
  }
  return total;
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

// ── RPC bridges ────────────────────────────────────────────────────────────

export async function callNeighbourhoodRpc({ repoId, refreshId, targetPaths, intentEmbedding, kindFilter, k }) {
  if (!await isCloudEnabled()) return [];
  try {
    const rows = await rpcSymbolNeighbourhood({
      repoId, refreshId, targetPaths, intentEmbedding, kindFilter, k,
    });
    return Array.isArray(rows) ? rows : [];
  } catch (err) {
    const e = new Error(`symbol_neighbourhood RPC failed: ${err.message}`);
    e.code = 'RPC_ERROR';
    throw e;
  }
}

export async function computeDriftScore({ repoId, refreshId, simDup, simName }) {
  if (!await isCloudEnabled()) return null;
  try {
    return await rpcDriftScore({ repoId, refreshId, simDup, simName });
  } catch (err) {
    const e = new Error(`drift_score RPC failed: ${err.message}`);
    e.code = 'RPC_ERROR';
    throw e;
  }
}

export async function getTopDuplicateClusters({ repoId, refreshId, limit = 20 }) {
  if (!await isCloudEnabled()) return [];
  try {
    const rows = await rpcTopDuplicateClusters({ repoId, refreshId, limit });
    return rows.map((r) => ({
      signatureHash: r.signature_hash,
      kind: r.kind,
      fileCount: r.file_count,
      symbolNames: r.symbol_names,
      filePaths: r.file_paths,
      examplePurpose: r.example_purpose,
    }));
  } catch (err) {
    const e = new Error(`top_duplicate_clusters RPC failed: ${err.message}`);
    e.code = 'RPC_ERROR';
    throw e;
  }
}

// ── symbol_file_imports ────────────────────────────────────────────────────

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

// ── domain_summaries ───────────────────────────────────────────────────────

export async function upsertDomainSummary({ repoId, domainTag, summary, compositionHash, symbolCount, promptTemplateVersion, generatedModel }) {
  if (!await isCloudEnabled()) return;
  try {
    await upsert('domain_summaries', [{
      repo_id: repoId,
      domain_tag: domainTag,
      summary,
      composition_hash: compositionHash,
      symbol_count: symbolCount,
      prompt_template_version: promptTemplateVersion,
      generated_model: generatedModel,
      generated_at: new Date().toISOString(),
    }], { onConflict: ['repo_id', 'domain_tag'], update: 'all' });
  } catch (err) {
    throw new Error(`upsertDomainSummary failed: ${err.message}`);
  }
}

export async function getDomainSummaries(repoId) {
  const out = new Map();
  if (!repoId || !await isCloudEnabled()) return out;
  try {
    const rows = await many(
      `SELECT domain_tag, summary, composition_hash, symbol_count,
              prompt_template_version, generated_model
         FROM domain_summaries WHERE repo_id = $1`,
      [repoId]
    );
    for (const r of rows) {
      out.set(r.domain_tag, {
        summary: r.summary,
        compositionHash: r.composition_hash,
        symbolCount: r.symbol_count,
        promptTemplateVersion: r.prompt_template_version,
        generatedModel: r.generated_model,
      });
    }
  } catch (err) {
    throw new Error(`getDomainSummaries failed: ${err.message}`);
  }
  return out;
}

// ── symbol_index reads with non-trivial JOIN ───────────────────────────────

/**
 * Read symbols for a snapshot with paginated filters. Joins through
 * symbol_definitions for the symbol_name + kind fields — hand-written
 * SQL because this is the only JOIN in the audit-loop API surface.
 */
export async function listSymbolsForSnapshot({ refreshId, kind, domainTag, filePathPrefix, limit = 200, offset = 0 }) {
  if (!await isCloudEnabled()) return [];
  const params = [refreshId];
  const wheres = ['si.refresh_id = $1'];
  if (Array.isArray(kind) && kind.length > 0) {
    params.push(kind);
    wheres.push(`sd.kind = ANY($${params.length})`);
  }
  if (domainTag) {
    params.push(domainTag);
    wheres.push(`si.domain_tag = $${params.length}`);
  }
  if (filePathPrefix) {
    params.push(`${filePathPrefix}%`);
    wheres.push(`si.file_path LIKE $${params.length}`);
  }
  params.push(limit);
  params.push(offset);
  const sql = `
    SELECT si.id, si.definition_id, si.repo_id, si.file_path,
           si.start_line, si.end_line, si.signature_hash,
           si.purpose_summary, si.domain_tag,
           sd.symbol_name, sd.kind
      FROM symbol_index si
      JOIN symbol_definitions sd ON sd.id = si.definition_id
     WHERE ${wheres.join(' AND ')}
     ORDER BY si.file_path ASC, si.start_line ASC
     LIMIT $${params.length - 1} OFFSET $${params.length}
  `;
  try {
    const rows = await many(sql, params);
    return rows.map((r) => ({
      id: r.id,
      definitionId: r.definition_id,
      refreshId,
      repoId: r.repo_id,
      filePath: r.file_path,
      startLine: r.start_line,
      endLine: r.end_line,
      signatureHash: r.signature_hash,
      purposeSummary: r.purpose_summary,
      domainTag: r.domain_tag,
      symbolName: r.symbol_name,
      kind: r.kind,
    }));
  } catch (err) {
    const e = new Error(`listSymbolsForSnapshot failed: ${err.message}`);
    e.code = 'RPC_ERROR';
    throw e;
  }
}

export async function listLayeringViolationsForSnapshot(refreshId) {
  if (!await isCloudEnabled()) return [];
  try {
    const rows = await many(
      `SELECT rule_name, from_path, to_path, severity, comment
         FROM symbol_layering_violations
        WHERE refresh_id = $1
        ORDER BY rule_name`,
      [refreshId]
    );
    return rows.map((r) => ({
      ruleName: r.rule_name,
      fromPath: r.from_path,
      toPath: r.to_path,
      severity: r.severity,
      comment: r.comment,
    }));
  } catch (err) {
    throw new Error(`listLayeringViolations failed: ${err.message}`);
  }
}

/**
 * Bulk-copy untouched-file symbols from prior snapshot into a new
 * refresh_id. Paginated read + bulk insert. Optional `retagDomain`
 * callback re-derives domain_tag per row (preserves prior tag on null).
 */
export async function copyForwardUntouchedFiles({ repoId, fromRefreshId, toRefreshId, touchedFileSet, retagDomain = null }) {
  if (!await isCloudEnabled()) return 0;
  let copied = 0;
  const pageSize = 500;
  let offset = 0;
  while (true) {
    const rows = await many(
      `SELECT definition_id, file_path, start_line, end_line,
              signature_hash, purpose_summary, domain_tag
         FROM symbol_index
        WHERE refresh_id = $1
        ORDER BY definition_id
        OFFSET $2 LIMIT $3`,
      [fromRefreshId, offset, pageSize]
    );
    if (rows.length === 0) break;
    const keep = rows.filter((r) => !touchedFileSet.has(r.file_path));
    if (keep.length > 0) {
      const payload = keep.map((r) => {
        let domainTag = r.domain_tag;
        if (typeof retagDomain === 'function') {
          const fresh = retagDomain(r.file_path);
          if (fresh) domainTag = fresh;
        }
        return {
          refresh_id: toRefreshId,
          repo_id: repoId,
          definition_id: r.definition_id,
          file_path: r.file_path,
          start_line: r.start_line,
          end_line: r.end_line,
          signature_hash: r.signature_hash,
          purpose_summary: r.purpose_summary,
          domain_tag: domainTag,
        };
      });
      // Bulk insert without ON CONFLICT — legacy used a plain insert here.
      const pool = await getPool();
      if (!pool) break;
      const cols = Object.keys(payload[0]);
      const ps = [];
      const valueGroups = payload.map((row) => {
        const placeholders = cols.map((c) => {
          ps.push(row[c]);
          return `$${ps.length}`;
        });
        return `(${placeholders.join(', ')})`;
      });
      await pool.query(
        `INSERT INTO symbol_index (${cols.map((c) => `"${c}"`).join(', ')})
         VALUES ${valueGroups.join(', ')}`,
        ps
      );
      copied += payload.length;
    }
    if (rows.length < pageSize) break;
    offset += pageSize;
  }
  return copied;
}
