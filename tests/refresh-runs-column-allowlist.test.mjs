/**
 * @fileoverview refresh_runs schema-contract tests.
 *
 * Three defects, one shape: a query naming a column `refresh_runs` does not
 * have, wrapped in a `catch` that renders the resulting SQLSTATE 42703 as an
 * empty result. `getActiveSnapshot` had it, `getFreshImportersOrNull` had it
 * (its freshness cache never hit once), and `GET_REFRESH_RUN_COLUMNS`
 * ALLOWLISTED eight phantom columns, so the gate meant to reject an unknown
 * column instead waved it through into the same silent failure.
 *
 * Every unit test that existed stopped at the pre-cloud guards, so the parts
 * that were wrong were the parts no test could reach. These tests target
 * exactly those: the column list (against the committed schema fixture, so it
 * cannot rot), the pure freshness decision (both directions), and the
 * "a schema fault is not an empty result" predicate.
 */

import { describe, it, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const REFRESH_RUNS_SRC = path.join(REPO_ROOT, 'scripts/lib/store/arch/refresh-runs.mjs');

/**
 * The GET_REFRESH_RUN_COLUMNS literal, read from source text.
 *
 * Deliberately NOT imported. The arch-memory barrel re-exports this module
 * with `export *`, so any test seam here would widen the public store surface,
 * and tests/arch-memory-split.test.mjs asserts this name is NOT reachable
 * through the barrel — the SQL identifier guard stays file-private. Reading the
 * literal keeps one spelling of the list without breaking that.
 */
function allowlistedColumns() {
  const src = fs.readFileSync(REFRESH_RUNS_SRC, 'utf8');
  const m = src.match(/const GET_REFRESH_RUN_COLUMNS = new Set\(\[([\s\S]*?)\]\);/);
  assert.ok(m, 'GET_REFRESH_RUN_COLUMNS literal not found — did it stop being a Set literal?');
  const names = [...m[1].matchAll(/'([^']+)'/g)].map((x) => x[1]);
  assert.ok(names.length > 0, 'parsed an EMPTY allowlist — the regex is broken, not the code');
  return new Set(names);
}

/** Live `refresh_runs` columns, from the committed real-Postgres schema fixture. */
function liveRefreshRunColumns() {
  const fixture = JSON.parse(
    fs.readFileSync(path.join(REPO_ROOT, 'tests/fixtures/expected-schema.json'), 'utf8'),
  );
  const table = fixture.tables.find((t) => t.table_name === 'refresh_runs');
  assert.ok(table, 'expected-schema.json must describe refresh_runs');
  return new Set(table.columns.map((c) => c.column_name));
}

describe('GET_REFRESH_RUN_COLUMNS names only columns that exist', () => {
  it('has no phantom entries', () => {
    const live = liveRefreshRunColumns();
    const phantom = [...allowlistedColumns()].filter((c) => !live.has(c));
    assert.deepEqual(
      phantom, [],
      'allowlisted column(s) do not exist on refresh_runs — a `select` naming one '
      + 'produces SQLSTATE 42703 (silently rendered as "no such run") instead of the '
      + 'clear "unknown column" throw this allowlist exists to give',
    );
  });

  it('does not name the specific eight that were wrong', () => {
    // Regression pin, not a duplicate of the test above: the generic check
    // would also pass if someone deleted the whole set.
    for (const gone of [
      'commit_sha', 'branch', 'plan_id', 'created_at',
      'updated_at', 'parent_run_id', 'rigor_pressure_round', 'round_converged_after',
    ]) {
      assert.equal(
        allowlistedColumns().has(gone), false,
        `${gone} is not a refresh_runs column and must not be allowlisted`,
      );
    }
  });

  it('still admits the columns real callers select', () => {
    // The direction the gate must NOT break: refresh-mode.mjs selects
    // walk_start_commit, and a too-aggressive prune would throw on it.
    for (const kept of ['id', 'repo_id', 'mode', 'status', 'walk_start_commit', 'import_graph_populated']) {
      assert.equal(allowlistedColumns().has(kept), true, `${kept} must stay allowlisted`);
    }
  });

  it('the default projection selects only live columns', async () => {
    // The `select`-less path interpolates a hardcoded column string that the
    // allowlist does not gate — its own chance to name a phantom.
    const src = fs.readFileSync(
      path.join(REPO_ROOT, 'scripts/lib/store/arch/refresh-runs.mjs'), 'utf8',
    );
    const m = src.match(/cols = '([^']+)';/);
    assert.ok(m, 'expected a hardcoded default projection in getRefreshRun');
    const live = liveRefreshRunColumns();
    const bad = m[1].split(',').map((c) => c.trim()).filter((c) => !live.has(c));
    assert.deepEqual(bad, [], 'default projection names column(s) refresh_runs does not have');
  });
});

describe('resolveImportGraphFreshness — the decision that never once ran', () => {
  const SHA = 'a4ec98da1111111111111111111111111111aaaa';

  test('fresh when the snapshot opened at this exact commit and the graph completed', async () => {
    const { resolveImportGraphFreshness } = await import('../scripts/lib/store/arch/imports.mjs');
    assert.deepEqual(
      resolveImportGraphFreshness({ walk_start_commit: SHA, import_graph_populated: true }, SHA),
      { fresh: true, reason: 'ok' },
    );
  });

  // Each of the following is a direction the cache must NOT fire in. A false
  // `fresh` vouches for a graph that does not describe this commit, and
  // downstream that can route a real finding to `pre_existing_independent` —
  // suppression, and silent suppression at that.
  test('not fresh on commit mismatch', async () => {
    const { resolveImportGraphFreshness } = await import('../scripts/lib/store/arch/imports.mjs');
    const r = resolveImportGraphFreshness({ walk_start_commit: 'b'.repeat(40), import_graph_populated: true }, SHA);
    assert.equal(r.fresh, false);
    assert.equal(r.reason, 'commit-mismatch');
  });

  test('not fresh when the import graph did not finish populating, even at the right commit', async () => {
    const { resolveImportGraphFreshness } = await import('../scripts/lib/store/arch/imports.mjs');
    const r = resolveImportGraphFreshness({ walk_start_commit: SHA, import_graph_populated: false }, SHA);
    assert.equal(r.fresh, false);
    assert.equal(r.reason, 'graph-incomplete');
  });

  test('a missing populated flag is not a truthy pass', async () => {
    const { resolveImportGraphFreshness } = await import('../scripts/lib/store/arch/imports.mjs');
    assert.equal(resolveImportGraphFreshness({ walk_start_commit: SHA }, SHA).fresh, false);
  });

  test('not fresh on a null run row or an unrecorded walk commit', async () => {
    const { resolveImportGraphFreshness } = await import('../scripts/lib/store/arch/imports.mjs');
    assert.equal(resolveImportGraphFreshness(null, SHA).reason, 'no-run-row');
    assert.equal(resolveImportGraphFreshness(undefined, SHA).reason, 'no-run-row');
    assert.equal(
      resolveImportGraphFreshness({ walk_start_commit: null, import_graph_populated: true }, SHA).reason,
      'no-walk-commit',
    );
  });

  test('a null/absent walk commit never matches a null headSha', async () => {
    // Guards the nastiest false-positive: two absent values comparing equal.
    const { resolveImportGraphFreshness } = await import('../scripts/lib/store/arch/imports.mjs');
    assert.equal(resolveImportGraphFreshness({ walk_start_commit: null, import_graph_populated: true }, null).fresh, false);
    assert.equal(resolveImportGraphFreshness({ walk_start_commit: undefined, import_graph_populated: true }, undefined).fresh, false);
  });

  test('reads walk_start_commit, never a commit_sha property', async () => {
    // The phantom column by another name: a row shaped like the OLD query's
    // output must not be accepted as fresh.
    const { resolveImportGraphFreshness } = await import('../scripts/lib/store/arch/imports.mjs');
    assert.equal(
      resolveImportGraphFreshness({ commit_sha: SHA, import_graph_populated: true }, SHA).fresh,
      false,
    );
  });
});

describe('isSchemaFaultSqlstate / describeSchemaFault', () => {
  test('SQLSTATE class 42 is a schema fault', async () => {
    const { isSchemaFaultSqlstate } = await import('../scripts/lib/db/errors.mjs');
    for (const c of ['42703', '42P01', '42P10', '42601', '42501']) {
      assert.equal(isSchemaFaultSqlstate(c), true, `${c} must classify as a schema fault`);
    }
  });

  test('connection, integrity and absent codes are NOT schema faults', async () => {
    // The direction that must not fire: classifying a transient blip as a
    // schema fault would spam operators on every network hiccup.
    const { isSchemaFaultSqlstate } = await import('../scripts/lib/db/errors.mjs');
    for (const c of ['08006', '23505', '40001', '57014', '', undefined, null, 42703]) {
      assert.equal(isSchemaFaultSqlstate(c), false, `${String(c)} must not classify as a schema fault`);
    }
  });

  test('describeSchemaFault names the SQLSTATE and stays silent otherwise', async () => {
    const { describeSchemaFault } = await import('../scripts/lib/db/errors.mjs');
    const note = describeSchemaFault(
      Object.assign(new Error('column "commit_sha" does not exist'), { code: '42703' }),
      'getFreshImportersOrNull',
    );
    assert.match(note, /42703/);
    assert.match(note, /getFreshImportersOrNull/);
    assert.match(note, /SCHEMA fault, not an empty result/);
    // Named by path, not an npm alias — this module syncs into consumer repos.
    assert.match(note, /node scripts\/setup-postgres\.mjs/);
    assert.doesNotMatch(note, /npm run/);

    assert.equal(describeSchemaFault(Object.assign(new Error('boom'), { code: '08006' }), 'x'), null);
    assert.equal(describeSchemaFault(new Error('no code'), 'x'), null);
  });

  test('reads a normalized nativeCode when err.code is absent', async () => {
    const { describeSchemaFault } = await import('../scripts/lib/db/errors.mjs');
    const err = Object.assign(new Error('nope'), { _normalized: { nativeCode: '42703' } });
    assert.match(describeSchemaFault(err, 'y'), /42703/);
  });

  test('sees through a wrapper that rethrows with { cause }', async () => {
    // getImportersForFiles rethrows as `new Error('... failed: msg', {cause})`,
    // so a top-level-only read would be blind at exactly the seam that wraps.
    const { describeSchemaFault } = await import('../scripts/lib/db/errors.mjs');
    const inner = Object.assign(new Error('column "commit_sha" does not exist'), { code: '42703' });
    const wrapped = new Error(`getImportersForFiles failed: ${inner.message}`, { cause: inner });
    assert.match(describeSchemaFault(wrapped, 'z'), /42703/);
    // ...and a wrapped TRANSIENT error still stays silent.
    const t = new Error('wrapped', { cause: Object.assign(new Error('conn'), { code: '08006' }) });
    assert.equal(describeSchemaFault(t, 'z'), null);
  });

  test('a self-referential cause chain terminates instead of spinning', async () => {
    const { describeSchemaFault } = await import('../scripts/lib/db/errors.mjs');
    const a = new Error('a');
    a.cause = a;
    assert.equal(describeSchemaFault(a, 'z'), null);
  });
});

// ── Live proof that the freshness cache actually HITS ───────────────────────
//
// The pure tests above cannot prove this fix. The defect was in the QUERY, and
// a pure test of the decision passed throughout the entire period the cache
// was dead — that is precisely how it survived. Only a real Postgres can show
// `getFreshImportersOrNull` returning something other than `null`.
//
// This is also the verification the behaviour change earns: the cache has
// never once run, so its BFS and its `true`/`false` polarity have never been
// exercised against real rows. `true` routes a finding to
// `pre_existing_independent` in evidence-triage, i.e. OUT of Stage 1 — a
// suppression path. It is asserted here in both directions before being
// trusted.
//
// Enrolled in BOTH db-test-container.mjs ISOLATED_SUITE_FILES and
// .github/workflows/postgres-parity.yml — two edits, always (AGENTS.md).

const TEST_URL = process.env.AUDIT_DB_TEST_URL;
const dbSkip = TEST_URL ? false : 'AUDIT_DB_TEST_URL not set';

describe('getFreshImportersOrNull against a REAL Postgres', { skip: dbSkip }, () => {
  let savedUrl, getPool, closePool, _resetForTest, assertDisposableDbUrl;
  let upsertRepoByUuid, openRefreshRun, publishRefreshRun;
  let recordSymbolFileImports, markImportGraphPopulated, getFreshImportersOrNull;
  let repoId;
  const REPO_UUID = `test-fresh-importers-${crypto.randomUUID()}`;
  const HEAD = 'deadbeef00000000000000000000000000000001';

  before(async () => {
    ({ getPool, closePool, _resetForTest, assertDisposableDbUrl } = await import('../scripts/lib/db/client.mjs'));
    ({ upsertRepoByUuid } = await import('../scripts/lib/store/repo.mjs'));
    ({ openRefreshRun, publishRefreshRun } = await import('../scripts/lib/store/arch/refresh-runs.mjs'));
    ({ recordSymbolFileImports, markImportGraphPopulated, getFreshImportersOrNull } =
      await import('../scripts/lib/store/arch/imports.mjs'));

    savedUrl = process.env.AUDIT_DB_URL;
    assertDisposableDbUrl(TEST_URL, { productionUrl: savedUrl });
    await _resetForTest();
    process.env.AUDIT_DB_URL = TEST_URL;
    if (/@(127\.0\.0\.1|localhost|\[::1\])[:/]/.test(TEST_URL)) {
      process.env.AUDIT_DB_SSL_MODE = 'disable';
    }
    const repo = await upsertRepoByUuid({ repoUuid: REPO_UUID, name: 'fresh-importers-test-repo', fingerprint: null });
    repoId = repo.id;

    // src/c.mjs -> src/b.mjs -> src/a.mjs, so a's dependents are reachable
    // only transitively. markImportGraphPopulated requires status='running',
    // so it runs BEFORE publish.
    const opened = await openRefreshRun({ repoId, mode: 'full', walkStartCommit: HEAD });
    await recordSymbolFileImports(opened.refreshId, [
      { importer: 'src/b.mjs', imported: 'src/a.mjs' },
      { importer: 'src/c.mjs', imported: 'src/b.mjs' },
    ]);
    const marked = await markImportGraphPopulated(opened.refreshId, repoId);
    assert.equal(marked.populated, true, 'setup: import_graph_populated must land');
    await publishRefreshRun({ repoId, refreshId: opened.refreshId, activeEmbeddingModel: 'stable-model', activeEmbeddingDim: 768 });
  });

  after(async () => {
    const errors = [];
    try {
      const pool = await getPool();
      if (pool) {
        for (const [sql, params] of [
          [`DELETE FROM symbol_file_imports WHERE refresh_id IN (SELECT id FROM refresh_runs WHERE repo_id = $1)`, [repoId]],
          [`UPDATE audit_repos SET active_refresh_id = NULL WHERE id = $1`, [repoId]],
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

  test('THE FIX: a fresh snapshot yields a real verdict, not the null it always returned', async () => {
    // Before the fix this asserted-against value was `null` for every input,
    // because the SELECT named a column refresh_runs does not have.
    const r = await getFreshImportersOrNull({
      repoUuid: REPO_UUID, headSha: HEAD, workingTreeDirty: false,
      filePath: 'src/a.mjs', changedFiles: ['src/unrelated.mjs'],
    });
    assert.notEqual(r, null, 'the freshness cache must HIT — a null here means the query is broken again');
    assert.equal(r, true, 'nothing that changed depends on src/a.mjs, so it is confidently independent');
  });

  test('a TRANSITIVE dependent is found: c -> b -> a returns false', async () => {
    // The suppression-relevant direction. `false` = do not treat as
    // pre-existing-independent. Two hops, so it also proves the BFS advances.
    const r = await getFreshImportersOrNull({
      repoUuid: REPO_UUID, headSha: HEAD, workingTreeDirty: false,
      filePath: 'src/a.mjs', changedFiles: ['src/c.mjs'],
    });
    assert.equal(r, false);
  });

  test('a direct dependent returns false', async () => {
    const r = await getFreshImportersOrNull({
      repoUuid: REPO_UUID, headSha: HEAD, workingTreeDirty: false,
      filePath: 'src/a.mjs', changedFiles: ['src/b.mjs'],
    });
    assert.equal(r, false);
  });

  test('a depth bound below the dependent distance degrades to null, never to true', async () => {
    // The dangerous failure: an exhausted-by-bound traversal reported as
    // "confidently independent". c is 2 hops from a; maxDepth 1 must NOT
    // answer true.
    const r = await getFreshImportersOrNull({
      repoUuid: REPO_UUID, headSha: HEAD, workingTreeDirty: false,
      filePath: 'src/a.mjs', changedFiles: ['src/c.mjs'], maxDepth: 1,
    });
    assert.equal(r, null);
  });

  test('a DIFFERENT head sha is stale and returns null', async () => {
    // Proves the comparison is live against walk_start_commit rather than
    // vacuously true — the positive control for the freshness gate.
    const r = await getFreshImportersOrNull({
      repoUuid: REPO_UUID, headSha: 'f'.repeat(40), workingTreeDirty: false,
      filePath: 'src/a.mjs', changedFiles: ['src/unrelated.mjs'],
    });
    assert.equal(r, null);
  });

  test('an unknown repo uuid returns null without throwing', async () => {
    const r = await getFreshImportersOrNull({
      repoUuid: `absent-${crypto.randomUUID()}`, headSha: HEAD, workingTreeDirty: false,
      filePath: 'src/a.mjs', changedFiles: [],
    });
    assert.equal(r, null);
  });
});
