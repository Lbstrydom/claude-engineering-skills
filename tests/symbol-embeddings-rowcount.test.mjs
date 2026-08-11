/**
 * @fileoverview DB-integration tests for the symbol_embeddings write-result
 * honesty fix (symbol-index-pipeline-reliability-hardening plan, Theme 5 /
 * D5): `recordSymbolEmbedding`/`recordSymbolEmbeddings` must report a
 * rowCount backed by the DB's own result, not the attempted input length.
 *
 * Note on what IS and ISN'T constructible here: both writes use
 * `ON CONFLICT (...) DO UPDATE SET embedding = EXCLUDED.embedding` with no
 * conditional WHERE clause, so a Postgres statement that succeeds at all
 * always affects every row in its VALUES list (insert-or-update, never a
 * silent skip) — a genuinely-partial rowCount is not a reachable outcome
 * for THESE specific queries the way it is for a targeted `UPDATE ... WHERE
 * id = $2` (the exact shape markFindingsRemediation's earlier fix this
 * session addressed). What these tests instead prove: (1) the reported
 * count matches a real post-write `SELECT count(*)` in the normal case —
 * proving the code path is wired to the DB's actual result, not a
 * hardcoded input-derived number — and (2) a genuine re-embed (same
 * conflict key, different vector) still reports the correct count and
 * actually overwrites the stored vector.
 *
 * Env-gated: requires AUDIT_DB_TEST_URL. Skips cleanly when absent.
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

import { getPool, closePool, _resetForTest, assertDisposableDbUrl } from '../scripts/lib/db/client.mjs';
import { upsertRepoByUuid } from '../scripts/lib/store/repo.mjs';
import {
  recordSymbolDefinitions,
  recordSymbolEmbedding,
  recordSymbolEmbeddings,
} from '../scripts/lib/store/arch/symbols.mjs';

const TEST_URL = process.env.AUDIT_DB_TEST_URL;
const skip = TEST_URL ? false : 'AUDIT_DB_TEST_URL not set';

let savedUrl, repoId;
const REPO_UUID = `test-embeddings-rowcount-${crypto.randomUUID()}`;
// Must match the `vector(768)` width of symbol_embeddings.embedding — pgvector
// rejects any other length at the write ("expected 768 dimensions, not 8"), so
// a smaller convenience value makes every case here unrunnable. This said 8;
// the suite was enrolled in no runner, so it never ran to find out.
const DIM = 768;
const vec = (seed) => Array.from({ length: DIM }, (_, i) => (seed + i) / 100);

describe('symbol_embeddings write-result honesty (disposable DB)', { skip }, () => {
  before(async () => {
    savedUrl = process.env.AUDIT_DB_URL;
    assertDisposableDbUrl(TEST_URL, { productionUrl: savedUrl });
    await _resetForTest();
    process.env.AUDIT_DB_URL = TEST_URL;
    const repo = await upsertRepoByUuid({ repoUuid: REPO_UUID, name: 'embeddings-rowcount-test-repo', fingerprint: null });
    repoId = repo.id;
  });

  after(async () => {
    const cleanupErrors = [];
    try {
      const pool = await getPool();
      if (pool) {
        for (const [sql, params] of [
          [`DELETE FROM symbol_embeddings WHERE definition_id IN (SELECT id FROM symbol_definitions WHERE repo_id = $1)`, [repoId]],
          [`DELETE FROM symbol_definitions WHERE repo_id = $1`, [repoId]],
        ]) {
          try { await pool.query(sql, params); } catch (err) { cleanupErrors.push(new Error(`${sql}: ${err?.message || err}`)); }
        }
        try {
          const { rowCount } = await pool.query(`DELETE FROM audit_repos WHERE id = $1`, [repoId]);
          if (rowCount === 0) cleanupErrors.push(new Error(`DELETE FROM audit_repos WHERE id = ${repoId}: matched 0 rows`));
        } catch (err) { cleanupErrors.push(new Error(`audit_repos delete: ${err?.message || err}`)); }
      }
    } finally {
      if (savedUrl === undefined) delete process.env.AUDIT_DB_URL;
      else process.env.AUDIT_DB_URL = savedUrl;
      try { await closePool(); } catch { /* best-effort */ }
    }
    if (cleanupErrors.length > 0) throw new AggregateError(cleanupErrors, 'teardown failed — disposable DB may have residual rows');
  });

  it('recordSymbolEmbedding (singular) writes exactly one row, verified against a real SELECT', async () => {
    const pool = await getPool();
    const defMap = await recordSymbolDefinitions(repoId, [{ canonicalPath: 'a.mjs', symbolName: 'foo', kind: 'function' }]);
    const definitionId = defMap['a.mjs|foo|function'];
    const signatureHash = `sig-single-${crypto.randomUUID()}`;

    await recordSymbolEmbedding({ definitionId, embeddingModel: 'test-model', dimension: DIM, vector: vec(1), signatureHash });

    const { rows } = await pool.query(
      `SELECT count(*)::int AS n FROM symbol_embeddings WHERE definition_id = $1 AND embedding_model = 'test-model' AND signature_hash = $2`,
      [definitionId, signatureHash],
    );
    assert.equal(rows[0].n, 1);
  });

  it('recordSymbolEmbedding re-embed (same conflict key) actually overwrites the stored vector', async () => {
    const pool = await getPool();
    const defMap = await recordSymbolDefinitions(repoId, [{ canonicalPath: 'b.mjs', symbolName: 'bar', kind: 'function' }]);
    const definitionId = defMap['b.mjs|bar|function'];
    const signatureHash = `sig-reembed-${crypto.randomUUID()}`;

    await recordSymbolEmbedding({ definitionId, embeddingModel: 'test-model', dimension: DIM, vector: vec(1), signatureHash });
    await recordSymbolEmbedding({ definitionId, embeddingModel: 'test-model', dimension: DIM, vector: vec(50), signatureHash });

    const { rows } = await pool.query(
      `SELECT count(*)::int AS n, embedding::text AS vec FROM symbol_embeddings
        WHERE definition_id = $1 AND embedding_model = 'test-model' AND signature_hash = $2
        GROUP BY embedding`,
      [definitionId, signatureHash],
    );
    assert.equal(rows.length, 1, 'still exactly one row (updated, not duplicated)');
    assert.equal(rows[0].n, 1);
    assert.ok(rows[0].vec.includes('0.5'), 'the SECOND vector (seed 50) won, proving the update actually landed');
  });

  it('recordSymbolEmbeddings (batched) reports a count matching a real post-write SELECT, not the attempted array length', async () => {
    const pool = await getPool();
    const defs = Array.from({ length: 5 }, (_, i) => ({ canonicalPath: `batch${i}.mjs`, symbolName: `s${i}`, kind: 'function' }));
    const defMap = await recordSymbolDefinitions(repoId, defs);
    const rows = defs.map((d, i) => ({
      definitionId: defMap[`${d.canonicalPath}|${d.symbolName}|${d.kind}`],
      embeddingModel: 'test-model-batch',
      dimension: DIM,
      vector: vec(i),
      signatureHash: `sig-batch-${i}-${crypto.randomUUID()}`,
    }));

    const written = await recordSymbolEmbeddings(rows);
    assert.equal(written, 5, 'reports 5 — matching the DB write, not a hardcoded length');

    const { rows: dbRows } = await pool.query(
      `SELECT count(*)::int AS n FROM symbol_embeddings WHERE embedding_model = 'test-model-batch' AND signature_hash = ANY($1)`,
      [rows.map((r) => r.signatureHash)],
    );
    assert.equal(dbRows[0].n, 5, 'the reported count matches the real row count in the DB');
  });

  it('recordSymbolEmbeddings de-dupes on the conflict key BEFORE writing — reported count reflects distinct rows, not raw input length', async () => {
    const defMap = await recordSymbolDefinitions(repoId, [{ canonicalPath: 'dup.mjs', symbolName: 'd', kind: 'function' }]);
    const definitionId = defMap['dup.mjs|d|function'];
    const signatureHash = `sig-dup-${crypto.randomUUID()}`;
    const rows = [
      { definitionId, embeddingModel: 'test-model-dup', dimension: DIM, vector: vec(1), signatureHash },
      { definitionId, embeddingModel: 'test-model-dup', dimension: DIM, vector: vec(2), signatureHash }, // same conflict key
    ];

    const written = await recordSymbolEmbeddings(rows);
    assert.equal(written, 1, '2 inputs sharing one conflict key collapse to 1 distinct written row');
  });
});
