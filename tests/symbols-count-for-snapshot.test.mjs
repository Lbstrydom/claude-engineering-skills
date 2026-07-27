/**
 * @fileoverview DB-integration tests for `countSymbolsForSnapshot`
 * (symbol-index-pipeline-reliability-hardening plan, Theme 2). drift.mjs
 * uses this alongside `listSymbolsForSnapshot({limit: 10000})` to detect
 * when its pragma-reconciliation candidate pool is truncated — a genuine
 * count is required (not `rows.length` on a capped read, which can never
 * exceed the cap it's supposed to be measuring against).
 *
 * The boundary is asserted with real rows, not inferred from the `>`
 * operator alone (plan round-3 M2): exactly 10,000 symbols must read
 * capped:false, 10,001 must read capped:true.
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
  recordSymbolIndex,
  listSymbolsForSnapshot,
  countSymbolsForSnapshot,
} from '../scripts/lib/store/arch/symbols.mjs';
import { insertRefreshRun } from './helpers/db-fixtures.mjs';

const TEST_URL = process.env.AUDIT_DB_TEST_URL;
const skip = TEST_URL ? false : 'AUDIT_DB_TEST_URL not set';

let savedUrl, repoId;
const REPO_UUID = `test-count-symbols-${crypto.randomUUID()}`;

/** Bulk-write `count` distinct symbols under one refresh, batched (not one round trip per row). */
async function seedSymbols(refreshId, repoId, count, { prefix }) {
  const defs = Array.from({ length: count }, (_, i) => ({
    canonicalPath: `${prefix}/f${i}.mjs`, symbolName: `sym${i}`, kind: 'function',
  }));
  const defMap = await recordSymbolDefinitions(repoId, defs);
  const indexRows = defs.map((d) => ({
    definitionId: defMap[`${d.canonicalPath}|${d.symbolName}|${d.kind}`],
    filePath: d.canonicalPath,
    startLine: 1,
    endLine: 2,
    signatureHash: `sig-${prefix}-${d.symbolName}`,
    purposeSummary: null,
    domainTag: null,
  }));
  await recordSymbolIndex(refreshId, repoId, indexRows);
}

describe('countSymbolsForSnapshot — boundary + filter parity (disposable DB)', { skip }, () => {
  before(async () => {
    savedUrl = process.env.AUDIT_DB_URL;
    assertDisposableDbUrl(TEST_URL, { productionUrl: savedUrl });
    await _resetForTest();
    process.env.AUDIT_DB_URL = TEST_URL;
    const repo = await upsertRepoByUuid({ repoUuid: REPO_UUID, name: 'count-symbols-test-repo', fingerprint: null });
    repoId = repo.id;
  });

  after(async () => {
    const cleanupErrors = [];
    try {
      const pool = await getPool();
      if (pool) {
        const statements = [
          [`DELETE FROM symbol_index WHERE repo_id = $1`, [repoId]],
          [`DELETE FROM symbol_definitions WHERE repo_id = $1`, [repoId]],
          [`DELETE FROM refresh_runs WHERE repo_id = $1`, [repoId]],
        ];
        for (const [sql, params] of statements) {
          try {
            await pool.query(sql, params);
          } catch (err) {
            cleanupErrors.push(new Error(`${sql}: ${err?.message || err}`));
          }
        }
        try {
          const { rowCount } = await pool.query(`DELETE FROM audit_repos WHERE id = $1`, [repoId]);
          if (rowCount === 0) {
            cleanupErrors.push(new Error(`DELETE FROM audit_repos WHERE id = ${repoId}: matched 0 rows — expected exactly 1`));
          }
        } catch (err) {
          cleanupErrors.push(new Error(`DELETE FROM audit_repos WHERE id = $1: ${err?.message || err}`));
        }
      }
    } finally {
      if (savedUrl === undefined) delete process.env.AUDIT_DB_URL;
      else process.env.AUDIT_DB_URL = savedUrl;
      try { await closePool(); } catch { /* best-effort — env is already restored */ }
    }
    if (cleanupErrors.length > 0) {
      throw new AggregateError(cleanupErrors, `${cleanupErrors.length} teardown step(s) failed — disposable DB may have residual rows`);
    }
  });

  it('small snapshot: count matches the exact row count, not a capped read length', async () => {
    const pool = await getPool();
    const refreshId = await insertRefreshRun(pool, repoId);
    await seedSymbols(refreshId, repoId, 7, { prefix: 'small' });

    const total = await countSymbolsForSnapshot({ refreshId });
    assert.equal(total, 7);

    const rows = await listSymbolsForSnapshot({ refreshId, limit: 200 });
    assert.equal(rows.length, 7, 'sanity: the row read agrees with the count at this size');
  });

  it('honours the same domainTag/kind/filePathPrefix filters as listSymbolsForSnapshot', async () => {
    const pool = await getPool();
    const refreshId = await insertRefreshRun(pool, repoId);
    await seedSymbols(refreshId, repoId, 3, { prefix: 'filtertest/a' });
    await seedSymbols(refreshId, repoId, 2, { prefix: 'filtertest/b' });

    const totalAll = await countSymbolsForSnapshot({ refreshId });
    assert.equal(totalAll, 5);

    const totalPrefixed = await countSymbolsForSnapshot({ refreshId, filePathPrefix: 'filtertest/a' });
    assert.equal(totalPrefixed, 3);

    const rowsPrefixed = await listSymbolsForSnapshot({ refreshId, filePathPrefix: 'filtertest/a', limit: 200 });
    assert.equal(rowsPrefixed.length, totalPrefixed, 'filtered count must agree with the filtered row read');
  });

  it('exactly 10,000 symbols → capped:false (the drift.mjs decision boundary)', async () => {
    const pool = await getPool();
    const refreshId = await insertRefreshRun(pool, repoId);
    await seedSymbols(refreshId, repoId, 10_000, { prefix: 'boundary-at-cap' });

    const total = await countSymbolsForSnapshot({ refreshId });
    assert.equal(total, 10_000);
    const capped = total > 10_000;
    assert.equal(capped, false, 'exactly 10,000 must NOT be reported as capped');
  });

  it('10,001 symbols → capped:true (one over the drift.mjs candidate-pool cap)', async () => {
    const pool = await getPool();
    const refreshId = await insertRefreshRun(pool, repoId);
    await seedSymbols(refreshId, repoId, 10_001, { prefix: 'boundary-over-cap' });

    const total = await countSymbolsForSnapshot({ refreshId });
    assert.equal(total, 10_001);
    const capped = total > 10_000;
    assert.equal(capped, true, '10,001 must be reported as capped');
  });

  it('returns a genuine JS number, not a bigint-derived string (the ::int cast this fix depends on)', async () => {
    const pool = await getPool();
    const refreshId = await insertRefreshRun(pool, repoId);
    await seedSymbols(refreshId, repoId, 4, { prefix: 'type-check' });

    const total = await countSymbolsForSnapshot({ refreshId });
    assert.equal(typeof total, 'number', 'a Postgres bigint COUNT(*) returns as a STRING without the ::int cast');
    assert.ok(Number.isInteger(total));
  });
});
