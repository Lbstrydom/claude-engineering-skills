/**
 * @fileoverview symbol_definitions / symbol_index / symbol_embeddings /
 * symbol_layering_violations + the listSymbolsForSnapshot JOIN reader +
 * copyForwardUntouchedFiles incremental-refresh helper.
 *
 * Owns 8 exports:
 *   recordSymbolDefinitions, recordSymbolIndex, recordSymbolEmbedding,
 *   recordLayeringViolations, recordDuplicateJustifications,
 *   listSymbolsForSnapshot, listLayeringViolationsForSnapshot,
 *   copyForwardUntouchedFiles
 *
 * Plan: docs/plans/sustainability-cleanup-batch.md (WS1);
 * recordDuplicateJustifications added by
 * docs/plans/arch-drift-duplication-cleanup.md.
 *
 * @module scripts/lib/store/arch/symbols
 */

import { many, upsert, withTx } from '../../db/query.mjs';
import { getPool } from '../../db/client.mjs';
import { isCloudEnabled } from '../repo.mjs';
import { UPSERT_CHUNK_SIZE, chunk } from './_shared.mjs';

/**
 * Format a JS number[] as a pgvector literal `[0.1,0.2,...]`. The generic
 * `upsert()` helper serialises arrays as Postgres text-arrays `{"0.1",...}`
 * which pgvector rejects (`invalid input syntax for type vector`). Inline
 * formatter keeps recordSymbolEmbedding self-contained without leaking
 * pgvector knowledge into the generic db layer.
 */
function vectorLiteral(embedding, expectedDim) {
  if (!Array.isArray(embedding)) {
    throw new TypeError('recordSymbolEmbedding: vector must be number[]');
  }
  if (typeof expectedDim === 'number' && embedding.length !== expectedDim) {
    throw new RangeError(`recordSymbolEmbedding: vector has ${embedding.length} dims, expected ${expectedDim}`);
  }
  for (let i = 0; i < embedding.length; i++) {
    const v = embedding[i];
    if (typeof v !== 'number' || !Number.isFinite(v)) {
      throw new TypeError(`recordSymbolEmbedding: vector[${i}] is not finite (${v})`);
    }
  }
  return `[${embedding.join(',')}]`;
}

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
  // pgvector requires the `[0.1,0.2,...]::vector` literal form. The generic
  // upsert() helper would serialise as Postgres text-array `{"0.1",...}`
  // → SQLSTATE 22P02. Validate + format the vector here, then bypass upsert
  // with explicit ::vector cast in the SQL.
  const literal = vectorLiteral(vector, dimension);
  const pool = await getPool();
  if (!pool) return;
  try {
    await pool.query(
      `INSERT INTO symbol_embeddings
         (definition_id, embedding_model, dimension, embedding, signature_hash)
       VALUES ($1::uuid, $2, $3, $4::vector, $5)
       ON CONFLICT (definition_id, embedding_model, dimension, signature_hash)
       DO UPDATE SET embedding = EXCLUDED.embedding`,
      [definitionId, embeddingModel, dimension, literal, signatureHash]
    );
  } catch (err) {
    throw new Error(`recordSymbolEmbedding failed: ${err.message}`, { cause: err });
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
 * Persist which `symbol_index` rows (this `refreshId`) carry a resolved
 * `@duplicate-justification` pragma. Always a **full reset + reapply** —
 * mirrors `symbol_layering_violations`'s fully-recomputed-every-refresh
 * semantics (arch-drift-duplication-cleanup, round-1 H1 fix): an omitted
 * or empty `justifications` array still runs the reset, correctly
 * un-flagging any row whose pragma was removed since the last refresh.
 *
 * **Two statements, one transaction** (round-3 H2 fix) — NOT row-count
 * chunking (round-2 H1 fix, correcting an earlier contradictory draft):
 * `recordLayeringViolations`'s chunking exists because it bulk-INSERTS
 * many new rows and a single INSERT's parameter list has a practical
 * size limit; this function only ever issues two fixed statements
 * against rows that already exist, regardless of how many are justified.
 *
 * @param {string} refreshId
 * @param {string} repoId - bound explicitly in both statements' WHERE
 *   clauses as defense-in-depth (round-4 H3 fix) — refresh_id alone
 *   already scopes to one repo's snapshot via its FK, but every other
 *   record* function in this file binds repo_id explicitly too.
 * @param {{definitionId: string, reason: string, target: string, source: string}[]} justifications
 * @returns {Promise<number>} count of rows marked justified
 */
export async function recordDuplicateJustifications(refreshId, repoId, justifications) {
  const pool = await getPool();
  if (!pool) return 0;
  const rows = Array.isArray(justifications) ? justifications : [];
  try {
    return await withTx(async (client) => {
      // round-4 H3 fix: scope both statements on (refresh_id AND repo_id),
      // not refresh_id alone — defense-in-depth matching this file's other
      // record* functions' convention of always binding repo_id explicitly,
      // even though refresh_id already implies one repo via its FK.
      await client.query(
        `UPDATE symbol_index
           SET duplicate_justified = false,
               duplicate_justification_reason = NULL,
               duplicate_justification_target = NULL,
               duplicate_justification_source = NULL
         WHERE refresh_id = $1 AND repo_id = $2`,
        [refreshId, repoId],
      );
      if (rows.length === 0) return 0;
      const values = [];
      const params = [];
      rows.forEach((j, i) => {
        const base = i * 4;
        values.push(`($${base + 1}::uuid, $${base + 2}, $${base + 3}, $${base + 4})`);
        params.push(j.definitionId, j.reason ?? null, j.target ?? null, j.source ?? null);
      });
      params.push(refreshId, repoId);
      const applyResult = await client.query(
        `UPDATE symbol_index AS si
           SET duplicate_justified = true,
               duplicate_justification_reason = v.reason,
               duplicate_justification_target = v.target,
               duplicate_justification_source = v.source
           FROM (VALUES ${values.join(', ')}) AS v(definition_id, reason, target, source)
          WHERE si.definition_id = v.definition_id
            AND si.refresh_id = $${params.length - 1}
            AND si.repo_id = $${params.length}`,
        params,
      );
      // round-3 H2 fix: report the ACTUAL rows the UPDATE touched
      // (applyResult.rowCount), not rows.length — a definitionId that
      // doesn't exist in this refresh's symbol_index (a stale resolution,
      // a race with a concurrent refresh) previously reported success for
      // a write that never happened.
      return applyResult.rowCount;
    });
  } catch (err) {
    throw new Error(`recordDuplicateJustifications failed: ${err.message}`, { cause: err });
  }
}

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
