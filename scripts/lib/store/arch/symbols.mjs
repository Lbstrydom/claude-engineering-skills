/**
 * @fileoverview symbol_definitions / symbol_index / symbol_embeddings /
 * symbol_layering_violations + the listSymbolsForSnapshot JOIN reader +
 * copyForwardUntouchedFiles incremental-refresh helper.
 *
 * Owns 10 exports:
 *   recordSymbolDefinitions, recordSymbolIndex, recordSymbolEmbedding,
 *   recordSymbolEmbeddings, recordLayeringViolations,
 *   recordDuplicateJustifications, listSymbolsForSnapshot,
 *   countSymbolsForSnapshot, listLayeringViolationsForSnapshot,
 *   copyForwardUntouchedFiles
 *
 * Plan: docs/plans/sustainability-cleanup-batch.md (WS1);
 * recordDuplicateJustifications added by
 * docs/plans/arch-drift-duplication-cleanup.md.
 *
 * @module scripts/lib/store/arch/symbols
 */

import { many, one, upsert, withTx } from '../../db/query.mjs';
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
      // @on-conflict-ok: repo_id is functionally determined by refresh_id — refresh_id is NOT NULL FK to refresh_runs, whose repo_id is NOT NULL, so adding repo_id cannot change which rows conflict. Measured 2026-07-19: 0 of 223,623 rows have symbol_index.repo_id <> refresh_runs.repo_id. Widening would rebuild a 223k-row unique index for zero semantic gain (WS-C2).
      const result = await upsert('symbol_index', slice, {
        onConflict: ['refresh_id', 'definition_id'],
        update: 'all',
      });
      // db707fba: report the DB's own rowCount, not the attempted slice
      // size — an attempted write is not a verified one. Under this
      // conflict target's ON CONFLICT DO UPDATE semantics rowCount should
      // always equal slice.length (every row either inserts or updates,
      // never no-ops), so a mismatch is unexpected and worth a visible
      // warning rather than silently trusting the attempted count.
      if (result.rowCount !== slice.length) {
        process.stderr.write(`  [symbol-index] recordSymbolIndex: chunk attempted ${slice.length} rows but DB reports rowCount=${result.rowCount} — investigate\n`);
      }
      total += result.rowCount;
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
    const result = await pool.query(
      `INSERT INTO symbol_embeddings
         (definition_id, embedding_model, dimension, embedding, signature_hash)
       VALUES ($1::uuid, $2, $3, $4::vector, $5)
       ON CONFLICT (definition_id, embedding_model, dimension, signature_hash)
       DO UPDATE SET embedding = EXCLUDED.embedding`,
      [definitionId, embeddingModel, dimension, literal, signatureHash]
    );
    // symbol-index-pipeline-reliability-hardening Theme 5 (D5), extended
    // to this single-record sibling for consistency with the batched
    // recordSymbolEmbeddings fix — an INSERT..ON CONFLICT DO UPDATE should
    // always affect exactly one row; a 0-row result is worth a visible
    // warning rather than a silently "succeeded" void return.
    if (result.rowCount !== 1) {
      process.stderr.write(`  [symbol-index] recordSymbolEmbedding: expected 1 row written but DB reports rowCount=${result.rowCount} (definitionId=${definitionId}) — investigate\n`);
    }
  } catch (err) {
    throw new Error(`recordSymbolEmbedding failed: ${err.message}`, { cause: err });
  }
}

/**
 * Batched sibling of recordSymbolEmbedding — same ON CONFLICT contract, one
 * multi-row statement per chunk instead of one round trip per symbol.
 *
 * A full refresh calls this once per touched symbol with an embedding
 * (tens of thousands per run on this repo's own symbol_index). Looping
 * recordSymbolEmbedding() per row turned into ~95k individual single-row
 * INSERT..ON CONFLICT statements per refresh — each its own round trip and
 * WAL-committing transaction — and was the dominant contributor to the
 * project's Disk IO budget (found via pg_stat_statements, 2026-07-24).
 * recordSymbolIndex/recordSymbolDefinitions/recordSymbolFileImports already
 * batch via chunk(); this brings embeddings in line with those siblings.
 *
 * Global (not per-chunk) de-dup on the conflict key mirrors
 * recordSymbolFileImports: a same-statement VALUES list can't legally repeat
 * a conflict key ("cannot affect row a second time"), and a repeat carries
 * no extra information since a re-embed of the same signature_hash writes
 * back the same vector — last-occurrence-wins is lossless here.
 *
 * @param {{definitionId: string, embeddingModel: string, dimension: number, vector: number[], signatureHash: string}[]} rows
 * @returns {Promise<number>} count of DISTINCT rows written
 */
export async function recordSymbolEmbeddings(rows, { query } = {}) {
  if (!Array.isArray(rows) || rows.length === 0) return 0;
  // The query function is injectable so the validate-before-commit ordering
  // below can be asserted without a database — the invariant is "no statement
  // is issued until every vector is known good", which is about ordering, not
  // about Postgres. Production path is unchanged: same pool, same cloud-off
  // short-circuit. (Deliberately a closure, not `pool.query.bind(pool)` in the
  // initialiser — `pool` is not in scope there, which is a ReferenceError on
  // exactly the non-injected path.)
  let run = query;
  if (!run) {
    const pool = await getPool();
    if (!pool) return 0;
    run = (text, params) => pool.query(text, params);
  }

  const byKey = new Map();
  for (const r of rows) {
    const key = `${r.definitionId} ${r.embeddingModel} ${r.dimension} ${r.signatureHash}`;
    byKey.set(key, r);
  }
  const distinct = [...byKey.values()];

  // VALIDATE EVERY ROW BEFORE COMMITTING ANY OF THEM. `vectorLiteral` throws on
  // a malformed vector; calling it here for the throw alone means a bad vector
  // in the LAST chunk cannot leave the earlier chunks already persisted, with
  // the embedding space partially written and no marker saying so.
  //
  // The result is deliberately DISCARDED rather than cached: retaining ~95k
  // formatted vector strings materialises a second copy of the largest data in
  // the run, which is exactly the Disk-IO/memory pressure the batching above
  // exists to avoid. Validation is O(n) time and O(1) retained; caching would
  // be O(n) in both. The duplicated call inside the loop is the cheap half.
  for (const r of distinct) vectorLiteral(r.vector, r.dimension);

  let total = 0;
  for (const batch of chunk(distinct, UPSERT_CHUNK_SIZE)) {
    const placeholders = [];
    const params = [];
    batch.forEach((r, i) => {
      const literal = vectorLiteral(r.vector, r.dimension);
      const base = i * 5;
      placeholders.push(`($${base + 1}::uuid, $${base + 2}, $${base + 3}, $${base + 4}::vector, $${base + 5})`);
      params.push(r.definitionId, r.embeddingModel, r.dimension, literal, r.signatureHash);
    });
    try {
      const result = await run(
        `INSERT INTO symbol_embeddings
           (definition_id, embedding_model, dimension, embedding, signature_hash)
         VALUES ${placeholders.join(', ')}
         ON CONFLICT (definition_id, embedding_model, dimension, signature_hash)
         DO UPDATE SET embedding = EXCLUDED.embedding`,
        params
      );
      // symbol-index-pipeline-reliability-hardening Theme 5 (D5): report the
      // DB's own rowCount, not the attempted batch length — same fix already
      // proven in this file's recordDuplicateJustifications/
      // recordLayeringViolations. An INSERT..ON CONFLICT DO UPDATE should
      // always match every attempted row, so a mismatch is worth a visible
      // warning rather than silently trusting the attempted count.
      if (result.rowCount !== batch.length) {
        process.stderr.write(`  [symbol-index] recordSymbolEmbeddings: chunk attempted ${batch.length} rows but DB reports rowCount=${result.rowCount} — investigate\n`);
      }
      total += result.rowCount;
    } catch (err) {
      throw new Error(`recordSymbolEmbeddings failed: ${err.message}`, { cause: err });
    }
  }
  return total;
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
      // @on-conflict-ok: repo_id is functionally determined by refresh_id — refresh_id is NOT NULL FK to refresh_runs, whose repo_id is NOT NULL, so adding repo_id cannot change which rows conflict. Measured 2026-07-19: 0 rows have symbol_layering_violations.repo_id <> refresh_runs.repo_id. Same FD as symbol_index above (WS-C2).
      const result = await upsert('symbol_layering_violations', slice, {
        onConflict: ['refresh_id', 'rule_name', 'from_path', 'to_path'],
        update: 'all',
      });
      // db707fba: same fix as recordSymbolIndex above — report the DB's
      // own rowCount, not the attempted slice size.
      if (result.rowCount !== slice.length) {
        process.stderr.write(`  [symbol-index] recordLayeringViolations: chunk attempted ${slice.length} rows but DB reports rowCount=${result.rowCount} — investigate\n`);
      }
      total += result.rowCount;
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
 * **One reset statement, N chunked apply statements, one transaction**
 * (0aa2b07f correction, 2026-07-27): round-2 H1's earlier "NOT row-count
 * chunking" reasoning conflated STATEMENT COUNT (always fixed at "one
 * reset") with PARAMETER COUNT PER STATEMENT (which scales linearly with
 * `justifications.length` regardless of how many statements there are) —
 * the apply statement binds 4 params/row with no cap, so a refresh with
 * 16,384+ justifications exceeded PostgreSQL's 65,535-parameter limit and
 * threw before doing any work. The apply is now chunked at
 * `UPSERT_CHUNK_SIZE` (this file's other record* functions' own constant),
 * same atomicity as before: still one reset + all applies inside the SAME
 * transaction, so a partial-chunk failure still rolls back the whole
 * reset-and-reapply as one unit.
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
      // 0aa2b07f: a single VALUES-list apply statement binds 4 params per
      // row with no cap — PostgreSQL's 65,535-parameter limit is exceeded
      // at 16,384+ justifications. Chunking the APPLY into UPSERT_CHUNK_SIZE
      // batches (same constant this file's other record* functions already
      // use) keeps every statement well under the limit while preserving
      // the round-3 H2 invariant this docstring documents: still exactly
      // one reset + N apply statements, all inside the SAME transaction, so
      // "reset, then reapply" stays atomic regardless of chunk count.
      let totalRowCount = 0;
      for (const slice of chunk(rows, UPSERT_CHUNK_SIZE)) {
        const values = [];
        const params = [];
        slice.forEach((j, i) => {
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
        totalRowCount += applyResult.rowCount;
      }
      return totalRowCount;
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

/**
 * Total count of symbols matching the same filters as
 * listSymbolsForSnapshot, ignoring limit/offset — lets a caller detect
 * when a paginated read is truncated (e.g. drift.mjs's pragma
 * reconciliation, which needs to know whether its 10000-row candidate
 * pool actually covers the whole snapshot). `count(*)` is Postgres
 * `bigint` by default, which node-postgres returns as a STRING — the
 * explicit `::int` cast is required so this returns a genuine number.
 */
export async function countSymbolsForSnapshot({ refreshId, kind, domainTag, filePathPrefix }) {
  if (!await isCloudEnabled()) return 0;
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
  const sql = `
    SELECT count(*)::int AS total
      FROM symbol_index si
      JOIN symbol_definitions sd ON sd.id = si.definition_id
     WHERE ${wheres.join(' AND ')}
  `;
  try {
    const row = await one(sql, params);
    return row ? row.total : 0;
  } catch (err) {
    const e = new Error(`countSymbolsForSnapshot failed: ${err.message}`);
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
/**
 * Copy a prior snapshot's rows for files NOT in `touchedFileSet` into the new
 * snapshot, carrying the duplicate_justification* columns (see the SELECT).
 *
 * @param {object} args
 * @param {Set<string>} args.touchedFileSet - files this run authoritatively
 *   covered; their rows are NOT copied (the run wrote them fresh).
 * @param {((filePath: string) => boolean)|null} [args.fileStillExists] -
 *   optional existence gate. When provided, a prior row is copied only if this
 *   returns true for its file_path. Incremental runs pass null: their
 *   touchedFileSet already contains git-detected deletions, so a deleted file
 *   is excluded that way. A timed-out FULL run has no git-diff of deletions —
 *   "un-reached" (copy me) and "deleted" (drop me) both present as "absent from
 *   this run's symbols", so it passes an on-disk check here to avoid
 *   resurrecting a file that was genuinely removed since the prior snapshot.
 */
export async function copyForwardUntouchedFiles({ repoId, fromRefreshId, toRefreshId, touchedFileSet, retagDomain = null, fileStillExists = null }) {
  if (!await isCloudEnabled()) return 0;
  let copied = 0;
  const pageSize = 500;
  let offset = 0;
  while (true) {
    const rows = await many(
      `SELECT definition_id, file_path, start_line, end_line,
              signature_hash, purpose_summary, domain_tag,
              duplicate_justified, duplicate_justification_reason,
              duplicate_justification_target, duplicate_justification_source
         FROM symbol_index
        WHERE refresh_id = $1
        ORDER BY definition_id
        OFFSET $2 LIMIT $3`,
      [fromRefreshId, offset, pageSize]
    );
    if (rows.length === 0) break;
    const keep = rows.filter((r) =>
      !touchedFileSet.has(r.file_path)
      && (!fileStillExists || fileStillExists(r.file_path)));
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
          // A copied-forward row belongs to a file this refresh did NOT
          // touch, so its @duplicate-justification pragma cannot have
          // changed (the pragma sits immediately above the declaration —
          // editing or removing it necessarily touches the file, which
          // would put it in touchedFileSet and exclude it from this copy).
          // Carrying these four columns is therefore the only way the flag
          // survives: step 12a's re-apply runs BEFORE this copy and only
          // covers touched files, so an omitted column here silently lands
          // on `duplicate_justified NOT NULL DEFAULT false` and the drift
          // score over-counts justified duplicates until the next full
          // refresh. Guarded by tests/symbol-index-drift-justification.test.mjs.
          duplicate_justified: r.duplicate_justified,
          duplicate_justification_reason: r.duplicate_justification_reason,
          duplicate_justification_target: r.duplicate_justification_target,
          duplicate_justification_source: r.duplicate_justification_source,
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
      const result = await pool.query(
        `INSERT INTO symbol_index (${cols.map((c) => `"${c}"`).join(', ')})
         VALUES ${valueGroups.join(', ')}`,
        ps
      );
      // symbol-index-pipeline-reliability-hardening Theme 5 (D5): report the
      // DB's own rowCount, not the attempted payload length — same fix as
      // recordSymbolEmbeddings/recordDuplicateJustifications/
      // recordLayeringViolations in this file. No ON CONFLICT here (a plain
      // INSERT), so every attempted row should insert; a mismatch is worth a
      // visible warning rather than silently trusting the attempted count.
      if (result.rowCount !== payload.length) {
        process.stderr.write(`  [symbol-index] copyForwardUntouchedFiles: page attempted ${payload.length} rows but DB reports rowCount=${result.rowCount} — investigate\n`);
      }
      copied += result.rowCount;
    }
    if (rows.length < pageSize) break;
    offset += pageSize;
  }
  return copied;
}

/** Cap on consecutive failed summarisation attempts before a symbol is terminal.
 *  Module-private: this is the store's own retry policy, and nothing outside
 *  needs it. Keeping it unexported preserves the barrel invariant that every
 *  public member is a function — a contract three separate tests pin. */
const SUMMARY_RETRY_CAP = 3;

/**
 * Files containing symbols whose summarisation has failed and is still
 * retryable (plan §2.1 C9).
 *
 * WHY FILES, NOT SYMBOLS: an incremental refresh scopes EXTRACTION to a file
 * list, and summarisation consumes extraction output. Re-queuing at file
 * granularity lets the failed symbols flow back through the normal
 * extract → summarise → embed pipeline instead of needing a second, divergent
 * path (which would be a near-duplicate of the pipeline and drift from it).
 *
 * Terminal rows (`summary_failed = TRUE`) are excluded: they fail permanently
 * — oversized body, safety-filter trip, malformed source — and retrying them
 * every refresh spends provider calls on work that cannot succeed.
 *
 * @param {string} repoId
 * @param {string} refreshId - the snapshot to inspect (usually the prior active one)
 * @returns {Promise<string[]>} repo-relative file paths, deduplicated
 */
export async function listFilesNeedingSummaryRetry(repoId, refreshId) {
  if (!await isCloudEnabled()) return [];
  if (!repoId || !refreshId) return [];
  const rows = await many(
    `SELECT DISTINCT si.file_path
       FROM symbol_index si
       JOIN symbol_definitions sd ON sd.id = si.definition_id
      WHERE si.repo_id = $1
        AND si.refresh_id = $2
        AND (si.purpose_summary IS NULL OR btrim(si.purpose_summary) = '')
        AND sd.summary_failed = FALSE
        AND sd.summary_attempts < $3
        AND sd.archived_at IS NULL`,
    [repoId, refreshId, SUMMARY_RETRY_CAP]
  );
  return (rows || []).map(r => r.file_path).filter(Boolean);
}

/**
 * Record the outcome of a summarisation pass (plan §2.1 C9).
 *
 * Success RESETS the counter — the contract is "consecutive failures", so a
 * symbol that recovers is not carrying scar tissue toward the cap. Failure
 * increments and flips `summary_failed` at the cap, in one statement so the
 * two can never disagree.
 *
 * @param {string} repoId
 * @param {{definitionId: string, ok: boolean}[]} outcomes
 * @returns {Promise<{reset: number, incremented: number, nowTerminal: number}>}
 */
export async function recordSummaryOutcomes(repoId, outcomes) {
  const out = { reset: 0, incremented: 0, nowTerminal: 0 };
  if (!await isCloudEnabled()) return out;
  const list = (outcomes || []).filter(o => o && o.definitionId);
  if (list.length === 0) return out;

  const okIds = list.filter(o => o.ok).map(o => o.definitionId);
  const badIds = list.filter(o => !o.ok).map(o => o.definitionId);

  await withTx(async (tx) => {
    if (okIds.length > 0) {
      const r = await tx.query(
        `UPDATE symbol_definitions
            SET summary_attempts = 0, summary_failed = FALSE
          WHERE repo_id = $1 AND id = ANY($2::uuid[])
            AND (summary_attempts > 0 OR summary_failed = TRUE)`,
        [repoId, okIds]
      );
      out.reset = r.rowCount || 0;
    }
    if (badIds.length > 0) {
      const r = await tx.query(
        `UPDATE symbol_definitions
            SET summary_attempts = summary_attempts + 1,
                summary_failed   = (summary_attempts + 1 >= $3)
          WHERE repo_id = $1 AND id = ANY($2::uuid[])
            AND summary_failed = FALSE
        RETURNING summary_failed`,
        [repoId, badIds, SUMMARY_RETRY_CAP]
      );
      out.incremented = r.rowCount || 0;
      out.nowTerminal = (r.rows || []).filter(x => x.summary_failed).length;
    }
  });
  return out;
}
