/**
 * Tests for the symbol_file_imports persistence pipeline.
 * Plan v6 §2.6 + §2.6.1.
 *
 * The full extract→refresh→persist→copy-forward pipeline requires Supabase,
 * so these tests cover the deterministic logic at the boundaries:
 *   - extract.mjs's isInternalEdge filter (covered in import-edge-filter.test.mjs)
 *   - The chain-of-trust rule for import_graph_populated (R2-H1)
 *   - The renderer's "0 importers + populated=false" handling
 *   - The renderer's "0 importers + populated=true" handling
 *   - importer_path-keyed copy-forward semantics (R1-H1)
 *
 * Live integration smoke (npm run arch:refresh:full → arch:render) is the
 * end-to-end gate.
 *
 * The same-batch duplicate-edge suite at the bottom is DB-gated on
 * AUDIT_DB_TEST_URL (the DISPOSABLE container, never AUDIT_DB_URL) — the
 * failure it pins is Postgres behaviour, not JS logic, so a mock could not
 * have caught it.
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { renderSymbolTable } from '../scripts/lib/arch-render.mjs';
import { getPool, closePool, _resetForTest, assertDisposableDbUrl } from '../scripts/lib/db/client.mjs';
import { upsertRepoByUuid } from '../scripts/lib/store/repo.mjs';
import { recordSymbolFileImports, copyForwardImports } from '../scripts/lib/store/arch/imports.mjs';

// Mirror the chain-of-trust logic from refresh.mjs
function computeImportGraphPopulated(mode, priorPopulated) {
  return (mode === 'full') || (mode === 'incremental' && priorPopulated === true);
}

// Mirror the importer-keyed copy-forward filter from learning-store.mjs
function shouldCopyForward(row, touchedFileSet) {
  return !touchedFileSet.has(row.importer_path);
}

describe('chain-of-trust for import_graph_populated (Plan v6 §2.6.1, R2-H1)', () => {
  it('full refresh → always populated', () => {
    assert.equal(computeImportGraphPopulated('full', null), true);
    assert.equal(computeImportGraphPopulated('full', false), true);
    assert.equal(computeImportGraphPopulated('full', true), true);
  });

  it('incremental from populated → populated (carry-forward + new = full)', () => {
    assert.equal(computeImportGraphPopulated('incremental', true), true);
  });

  it('incremental from un-populated → NOT populated (would have gaps)', () => {
    assert.equal(computeImportGraphPopulated('incremental', false), false);
  });

  it('incremental from null prior → NOT populated', () => {
    assert.equal(computeImportGraphPopulated('incremental', null), false);
  });
});

describe('importer-keyed copy-forward (Plan v6 §2.6, R1-H1)', () => {
  // Edges in prior snapshot
  const priorEdges = [
    { importer_path: 'a.js', imported_path: 'b.js' },
    { importer_path: 'a.js', imported_path: 'c.js' },
    { importer_path: 'd.js', imported_path: 'b.js' },
    { importer_path: 'd.js', imported_path: 'c.js' },
  ];

  it('untouched importer files → all their edges carry forward', () => {
    const touched = new Set();  // nothing touched
    const carried = priorEdges.filter(e => shouldCopyForward(e, touched));
    assert.equal(carried.length, 4);
  });

  it('touched importer file → its edges DROPPED (importer re-emits current edges)', () => {
    // a.js was touched and modified — its current edges will be re-extracted.
    // The OLD edges (a→b, a→c) must NOT be carried forward, even though
    // b.js and c.js are untouched. (R1-H1: edges owned by importer side.)
    const touched = new Set(['a.js']);
    const carried = priorEdges.filter(e => shouldCopyForward(e, touched));
    assert.equal(carried.length, 2, 'only d.js edges carry');
    assert.deepEqual(
      carried.map(e => e.importer_path).sort(),
      ['d.js', 'd.js'],
    );
  });

  it('the bug scenario: a.js (touched) DROPS its import of b.js (untouched)', () => {
    // After this refresh: a.js no longer imports b.js. Its current edges
    // are just a→c. The dropped (a,b) edge must NOT linger.
    const touched = new Set(['a.js']);
    const carriedFromPrior = priorEdges.filter(e => shouldCopyForward(e, touched));
    const newlyExtracted = [{ importer_path: 'a.js', imported_path: 'c.js' }];  // a.js's new edges (b dropped)
    const finalSnapshot = [...carriedFromPrior, ...newlyExtracted];

    // (a, b) must be ABSENT
    assert.equal(
      finalSnapshot.some(e => e.importer_path === 'a.js' && e.imported_path === 'b.js'),
      false,
      'naive imported-keyed copy-forward would have kept this stale edge — must not',
    );
    // (a, c) is present from new extraction
    assert.equal(
      finalSnapshot.some(e => e.importer_path === 'a.js' && e.imported_path === 'c.js'),
      true,
    );
    // d.js's edges (untouched importer) carry forward
    assert.equal(finalSnapshot.filter(e => e.importer_path === 'd.js').length, 2);
  });
});

describe('renderer respects importGraphPopulated (Plan v6 §2.6.1, R1-H2)', () => {
  const sampleSymbols = [
    { id: 's1', symbolName: 'foo', kind: 'function', filePath: 'src/leaf.js',
      startLine: 10, endLine: 20, purposeSummary: 'A leaf function', domainTag: 'core' },
  ];

  it('populated=true + no importers → "(internal)" (true leaf)', () => {
    const out = renderSymbolTable(sampleSymbols, new Set(), {
      importerMap: new Map(), importGraphPopulated: true,
    });
    assert.match(out, /_\(internal\)_/);
    assert.doesNotMatch(out, /unknown/);
  });

  it('populated=false + no importers → "(unknown)" (pre-feature snapshot)', () => {
    const out = renderSymbolTable(sampleSymbols, new Set(), {
      importerMap: new Map(), importGraphPopulated: false,
    });
    assert.match(out, /_\(unknown — run `npm run arch:refresh:full`\)_/);
    assert.doesNotMatch(out, /\(internal\)/);
  });

  it('populated=true + 1 importer → renders importer path', () => {
    const out = renderSymbolTable(sampleSymbols, new Set(), {
      importerMap: new Map([['src/leaf.js', ['src/caller.js']]]),
      importGraphPopulated: true,
    });
    assert.match(out, /`src\/caller\.js`/);
  });
});

// ── Same-batch duplicate edges (disposable DB) ──────────────────────────────
//
// Field failure (2026-07-20, downstream consumer, 8,431 symbols / 6,077 edges):
//   recordSymbolFileImports failed: ON CONFLICT DO UPDATE command cannot
//   affect row a second time
//
// Postgres raises this when ONE INSERT ... ON CONFLICT statement carries the
// same conflict key twice — a second UPDATE to a row this statement already
// touched is ambiguous, so it aborts. The whole refresh died at step 12b,
// AFTER the (expensive) summarise + embed passes had completed.

const TEST_URL = process.env.AUDIT_DB_TEST_URL;
const dbSkip = TEST_URL ? false : 'AUDIT_DB_TEST_URL not set';

describe('recordSymbolFileImports — duplicate edges in one batch', { skip: dbSkip }, () => {
  let savedUrl, repoId, refreshId;
  const REPO_UUID = `test-import-dedup-${crypto.randomUUID()}`;

  before(async () => {
    savedUrl = process.env.AUDIT_DB_URL;
    assertDisposableDbUrl(TEST_URL, { productionUrl: savedUrl });
    await _resetForTest();
    process.env.AUDIT_DB_URL = TEST_URL;
    if (/@(127\.0\.0\.1|localhost|\[::1\])[:/]/.test(TEST_URL)) {
      process.env.AUDIT_DB_SSL_MODE = 'disable';
    }
    const repo = await upsertRepoByUuid({ repoUuid: REPO_UUID, name: 'import-dedup-test-repo', fingerprint: null });
    repoId = repo.id;
    const pool = await getPool();
    refreshId = (await pool.query(
      // Seeded 'published', not 'running': idx_refresh_runs_repo_running is a
      // UNIQUE partial index allowing at most ONE running refresh per repo, so
      // two seeded 'running' rows for one repo collide before any assertion
      // runs. Nothing here reads refresh_runs.status — these rows exist only to
      // satisfy the refresh_id FK — so a terminal status is both collision-free
      // and the more truthful shape (you copy coverage FORWARD from a finished
      // refresh). The suites were enrolled in no runner, so this never surfaced.
      `INSERT INTO refresh_runs (repo_id, mode, status) VALUES ($1, 'full', 'published') RETURNING id`,
      [repoId],
    )).rows[0].id;
  });

  after(async () => {
    const errors = [];
    try {
      const pool = await getPool();
      if (pool) {
        for (const [sql, params] of [
          [`DELETE FROM symbol_file_imports WHERE refresh_id = $1`, [refreshId]],
          [`DELETE FROM refresh_runs WHERE repo_id = $1`, [repoId]],
          [`DELETE FROM audit_repos WHERE id = $1`, [repoId]],
        ]) {
          try { await pool.query(sql, params); } catch (err) { errors.push(new Error(`${sql}: ${err?.message || err}`)); }
        }
      }
    } finally {
      if (savedUrl === undefined) delete process.env.AUDIT_DB_URL;
      else process.env.AUDIT_DB_URL = savedUrl;
      try { await closePool(); } catch { /* env already restored */ }
    }
    if (errors.length > 0) throw new AggregateError(errors, 'teardown failed — disposable DB may have residual rows');
  });

  it('does not abort when the same (importer, imported) pair appears twice in one batch', async () => {
    // The exact field shape: a duplicate pair well inside a single 500-row chunk.
    const edges = [
      { importer: 'src/a.js', imported: 'src/lib.js' },
      { importer: 'src/b.js', imported: 'src/lib.js' },
      { importer: 'src/a.js', imported: 'src/lib.js' },   // <- duplicate of [0]
    ];
    const res = await recordSymbolFileImports(refreshId, edges);
    assert.equal(res.inserted, 2, 'reports DISTINCT edges persisted, not raw input length');

    const pool = await getPool();
    const { rows } = await pool.query(
      `SELECT importer_path, imported_path FROM symbol_file_imports
        WHERE refresh_id = $1 ORDER BY importer_path`, [refreshId]);
    assert.deepEqual(
      rows.map((r) => `${r.importer_path}->${r.imported_path}`),
      ['src/a.js->src/lib.js', 'src/b.js->src/lib.js'],
      'the duplicate collapses to one row; the distinct edge is unaffected',
    );
  });

  it('survives duplicates that span a chunk boundary AND repeat within a chunk', async () => {
    // > UPSERT_CHUNK_SIZE (500) so the batch is split: cross-chunk repeats are
    // harmless (the 2nd chunk just UPDATEs), but same-chunk repeats are the
    // aborting case. Both must pass, and the row count must stay distinct.
    const edges = [];
    for (let i = 0; i < 600; i++) edges.push({ importer: `src/f${i}.js`, imported: 'src/shared.js' });
    edges.push({ importer: 'src/f0.js', imported: 'src/shared.js' });     // repeats chunk 1
    edges.push({ importer: 'src/f550.js', imported: 'src/shared.js' });   // repeats chunk 2

    const res = await recordSymbolFileImports(refreshId, edges);
    assert.equal(res.inserted, 600, '602 inputs collapse to 600 distinct edges');

    const pool = await getPool();
    const { rows } = await pool.query(
      `SELECT count(*)::int AS n FROM symbol_file_imports
        WHERE refresh_id = $1 AND imported_path = 'src/shared.js'`, [refreshId]);
    assert.equal(rows[0].n, 600, 'no duplicate rows persisted');
  });

  // symbol-index-pipeline-reliability-hardening Theme 5 (D5): copyForwardImports
  // must report a rowCount backed by the DB's own result, not payload.length.
  it('copyForwardImports reports a count matching a real post-write SELECT, not the attempted payload length', async () => {
    const pool = await getPool();
    // Its own SOURCE refresh, not the suite-wide `refreshId`. The cases above
    // load that one with 602 edges, so copy-forward legitimately carried 604
    // rows here and the assertion of 2 could never hold — the case measures
    // what copyForwardImports does with THREE edges, so it has to own those
    // three. (Never observed until 2026-08-11: enrolled in no runner.)
    const fromRefreshId = (await pool.query(
      `INSERT INTO refresh_runs (repo_id, mode, status) VALUES ($1, 'incremental', 'published') RETURNING id`,
      [repoId],
    )).rows[0].id;
    await recordSymbolFileImports(fromRefreshId, [
      { importer: 'kept-a.js', imported: 'lib.js' },
      { importer: 'kept-b.js', imported: 'lib.js' },
      { importer: 'touched.js', imported: 'lib.js' },
    ]);
    const toRefreshId = (await pool.query(
      `INSERT INTO refresh_runs (repo_id, mode, status) VALUES ($1, 'incremental', 'published') RETURNING id`,
      [repoId],
    )).rows[0].id;

    const { copied } = await copyForwardImports({
      fromRefreshId, toRefreshId, touchedFileSet: new Set(['touched.js']),
    });
    assert.equal(copied, 2, 'only the two untouched importers copy forward');

    const { rows } = await pool.query(
      `SELECT count(*)::int AS n FROM symbol_file_imports WHERE refresh_id = $1`, [toRefreshId],
    );
    assert.equal(rows[0].n, 2, 'the reported count matches the real row count in the DB');

    await pool.query(`DELETE FROM symbol_file_imports WHERE refresh_id = ANY($1)`, [[fromRefreshId, toRefreshId]]);
    await pool.query(`DELETE FROM refresh_runs WHERE id = ANY($1)`, [[fromRefreshId, toRefreshId]]);
  });
});
