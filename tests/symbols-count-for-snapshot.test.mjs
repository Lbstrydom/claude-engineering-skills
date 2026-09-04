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
// A SECOND repo, for the cross-repo isolation test at the bottom. Two repos in
// ONE store is the actual production shape — the store is single-tenant, so
// every consumer's snapshots share it — and it is the only configuration in
// which an unbound `refresh_id` read can be caught.
let foreignRepoId;
const REPO_UUID = `test-count-symbols-${crypto.randomUUID()}`;
const FOREIGN_REPO_UUID = `test-count-symbols-foreign-${crypto.randomUUID()}`;

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
    const foreign = await upsertRepoByUuid({ repoUuid: FOREIGN_REPO_UUID, name: 'count-symbols-foreign-repo', fingerprint: null });
    foreignRepoId = foreign.id;
  });

  after(async () => {
    const cleanupErrors = [];
    try {
      const pool = await getPool();
      if (pool) {
        // `= ANY` over BOTH repos: a teardown that cleans only the primary
        // one would leave the foreign repo's rows behind, and the next run's
        // counts would silently include them.
        const bothRepos = [[repoId, foreignRepoId]];
        const statements = [
          [`DELETE FROM symbol_index WHERE repo_id = ANY($1)`, bothRepos],
          [`DELETE FROM symbol_definitions WHERE repo_id = ANY($1)`, bothRepos],
          [`DELETE FROM refresh_runs WHERE repo_id = ANY($1)`, bothRepos],
        ];
        for (const [sql, params] of statements) {
          try {
            await pool.query(sql, params);
          } catch (err) {
            cleanupErrors.push(new Error(`${sql}: ${err?.message || err}`));
          }
        }
        try {
          const { rowCount } = await pool.query(`DELETE FROM audit_repos WHERE id = ANY($1)`, [[repoId, foreignRepoId]]);
          if (rowCount !== 2) {
            cleanupErrors.push(new Error(`DELETE FROM audit_repos WHERE id = ANY(${repoId}, ${foreignRepoId}): matched ${rowCount} rows — expected exactly 2`));
          }
        } catch (err) {
          cleanupErrors.push(new Error(`DELETE FROM audit_repos WHERE id = ANY($1): ${err?.message || err}`));
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

    const total = await countSymbolsForSnapshot({ repoId, refreshId });
    assert.equal(total, 7);

    const rows = await listSymbolsForSnapshot({ repoId, refreshId, limit: 200 });
    assert.equal(rows.length, 7, 'sanity: the row read agrees with the count at this size');
  });

  it('honours the same domainTag/kind/filePathPrefix filters as listSymbolsForSnapshot', async () => {
    const pool = await getPool();
    const refreshId = await insertRefreshRun(pool, repoId);
    await seedSymbols(refreshId, repoId, 3, { prefix: 'filtertest/a' });
    await seedSymbols(refreshId, repoId, 2, { prefix: 'filtertest/b' });

    const totalAll = await countSymbolsForSnapshot({ repoId, refreshId });
    assert.equal(totalAll, 5);

    const totalPrefixed = await countSymbolsForSnapshot({ repoId, refreshId, filePathPrefix: 'filtertest/a' });
    assert.equal(totalPrefixed, 3);

    const rowsPrefixed = await listSymbolsForSnapshot({ repoId, refreshId, filePathPrefix: 'filtertest/a', limit: 200 });
    assert.equal(rowsPrefixed.length, totalPrefixed, 'filtered count must agree with the filtered row read');
  });

  it('exactly 10,000 symbols → capped:false (the drift.mjs decision boundary)', async () => {
    const pool = await getPool();
    const refreshId = await insertRefreshRun(pool, repoId);
    await seedSymbols(refreshId, repoId, 10_000, { prefix: 'boundary-at-cap' });

    const total = await countSymbolsForSnapshot({ repoId, refreshId });
    assert.equal(total, 10_000);
    const capped = total > 10_000;
    assert.equal(capped, false, 'exactly 10,000 must NOT be reported as capped');
  });

  it('10,001 symbols → capped:true (one over the drift.mjs candidate-pool cap)', async () => {
    const pool = await getPool();
    const refreshId = await insertRefreshRun(pool, repoId);
    await seedSymbols(refreshId, repoId, 10_001, { prefix: 'boundary-over-cap' });

    const total = await countSymbolsForSnapshot({ repoId, refreshId });
    assert.equal(total, 10_001);
    const capped = total > 10_000;
    assert.equal(capped, true, '10,001 must be reported as capped');
  });

  it('returns a genuine JS number, not a bigint-derived string (the ::int cast this fix depends on)', async () => {
    const pool = await getPool();
    const refreshId = await insertRefreshRun(pool, repoId);
    await seedSymbols(refreshId, repoId, 4, { prefix: 'type-check' });

    const total = await countSymbolsForSnapshot({ repoId, refreshId });
    assert.equal(typeof total, 'number', 'a Postgres bigint COUNT(*) returns as a STRING without the ::int cast');
    assert.ok(Number.isInteger(total));
  });
  // ── Cross-repo isolation (2026-09-04) ─────────────────────────────────────
  //
  // The reads above all ask about a refresh THIS repo owns, so they pass
  // whether or not the query is repo-bound — which is exactly why the unbound
  // version survived. This is the case that separates them: a refresh id that
  // resolves to a real snapshot full of real symbols, owned by someone else.
  //
  // Before the binding landed, both assertions below returned the FOREIGN
  // repo's data (5 rows / 5). Read the failure that way round: the danger was
  // never an error, it was a plausible answer to the wrong question.
  it('refuses a refresh id owned by a DIFFERENT repo, rather than returning its rows', async () => {
    const pool = await getPool();
    const foreignRefreshId = await insertRefreshRun(pool, foreignRepoId);
    await seedSymbols(foreignRefreshId, foreignRepoId, 5, { prefix: 'foreign' });

    // Positive control FIRST: the foreign snapshot really does hold 5 symbols,
    // so an empty result below cannot be an empty snapshot wearing a fix's
    // clothes. Without this the test passes just as happily against a seeding
    // bug as against a working guard.
    assert.equal(
      await countSymbolsForSnapshot({ repoId: foreignRepoId, refreshId: foreignRefreshId }), 5,
      'positive control: the foreign snapshot must genuinely contain 5 symbols',
    );

    assert.deepEqual(
      await listSymbolsForSnapshot({ repoId, refreshId: foreignRefreshId, limit: 200 }), [],
      "asking as repo A for repo B's refresh must yield nothing, not B's symbols",
    );
    assert.equal(
      await countSymbolsForSnapshot({ repoId, refreshId: foreignRefreshId }), 0,
      'the count must agree with the list — a count bound differently from the '
      + 'list it bounds is how a truncation detector becomes a false all-clear',
    );
  });
});
