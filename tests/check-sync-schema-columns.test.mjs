/**
 * check-sync.mjs is the "is this repo syncing to the cloud store?" diagnostic.
 * Every column it names must exist, because a wrong one is not a wrong number —
 * it is a 42703 that the script's top-level catch turns into a bare
 * `[ERROR] column "…" does not exist` and `process.exit(3)`, aborting BEFORE
 * the verdict. That is exactly what happened: step 5 counted
 * `FROM bandit_arms WHERE repo_id = $1`, but bandit_arms is global — keyed
 * (pass_name, variant_id, context_bucket), no repo_id column at all — so the
 * checker crashed for every registered repo and never printed a verdict.
 *
 * The columns are extracted from the script's OWN SQL rather than re-listed
 * here: a hand-kept list would be the same drift class as the bug. Adding a
 * query to check-sync.mjs puts it under this guard with no edit.
 *
 * Oracle: tests/fixtures/expected-schema.json — the committed `--adopt` schema
 * contract. No DSN is touched (INC-002 forbids a live DSN in tests).
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const SRC = fs.readFileSync(
  fileURLToPath(new URL('../scripts/check-sync.mjs', import.meta.url)), 'utf-8');
const SCHEMA = JSON.parse(fs.readFileSync(
  fileURLToPath(new URL('./fixtures/expected-schema.json', import.meta.url)), 'utf-8'));

/** table_name → Set of column names, from the committed schema contract. */
const COLUMNS = new Map(
  SCHEMA.tables.map((t) => [t.table_name, new Set(t.columns.map((c) => c.column_name))]),
);

/**
 * Pull `{table, columns[]}` out of each backtick-delimited SELECT in the source.
 *
 * Deliberately narrow: it reads the FROM table, the WHERE predicate columns
 * (`col = $n` — the exact shape that broke), and a SELECT list only when that
 * list is plain bare identifiers. Anything with a call, a cast or an alias
 * (`COUNT(*)::int AS c`) is skipped rather than guessed at — a parser that
 * guesses produces false failures, and a check nobody trusts gets deleted.
 */
function extractQueries(src) {
  const out = [];
  for (const lit of src.match(/`[^`]*`/g) || []) {
    const body = lit.slice(1, -1).replace(/\s+/g, ' ').trim();
    if (!/^SELECT\b/i.test(body)) continue;
    const from = body.match(/\bFROM\s+([a-z_][a-z0-9_]*)/i);
    if (!from) continue;
    const table = from[1];

    const columns = new Set();
    for (const m of body.matchAll(/\b([a-z_][a-z0-9_]*)\s*=\s*\$\d+/gi)) columns.add(m[1]);

    const selectList = body.slice('SELECT'.length, from.index).trim();
    if (selectList && !/[(*:]|\bAS\b/i.test(selectList)) {
      for (const raw of selectList.split(',')) {
        const c = raw.trim();
        if (/^[a-z_][a-z0-9_]*$/i.test(c)) columns.add(c);
      }
    }
    out.push({ table, columns: [...columns], sql: body });
  }
  return out;
}

describe('check-sync.mjs SQL matches the committed schema contract', () => {
  const queries = extractQueries(SRC);

  it('the extractor actually found the queries (anti-vacuous)', () => {
    assert.ok(queries.length >= 4,
      `expected >=4 SELECTs in check-sync.mjs, extracted ${queries.length} — the extractor is broken, not the script`);
    assert.ok(queries.some((q) => q.table === 'bandit_arms'),
      'the bandit_arms query must be reachable by the extractor');
    assert.ok(queries.some((q) => q.columns.length > 0),
      'no columns extracted from any query — every assertion below would be vacuous');
  });

  it('every table it queries exists', () => {
    for (const q of queries) {
      assert.ok(COLUMNS.has(q.table), `unknown table "${q.table}" in: ${q.sql}`);
    }
  });

  it('every column it names exists on that table', () => {
    for (const q of queries) {
      const cols = COLUMNS.get(q.table);
      if (!cols) continue; // reported by the test above
      for (const c of q.columns) {
        assert.ok(cols.has(c),
          `column "${c}" does not exist on "${q.table}" — query: ${q.sql}`);
      }
    }
  });

  it('bandit_arms is not queried as if it were repo-scoped (the regression)', () => {
    // The oracle for the fix, stated directly: the table has no repo_id, so no
    // repo-scoped predicate against it can ever be correct.
    assert.ok(!COLUMNS.get('bandit_arms').has('repo_id'),
      'bandit_arms gained a repo_id column — this guard, and the query, both need revisiting');
    for (const q of queries.filter((x) => x.table === 'bandit_arms')) {
      assert.ok(!q.columns.includes('repo_id'), `bandit_arms query is repo-scoped: ${q.sql}`);
    }
  });
});

describe('extractQueries negative control', () => {
  it('flags a bad predicate column it is given', () => {
    // The guard above only means something if the extractor can SEE the defect.
    // This is the pre-fix source line, verbatim.
    const bad = extractQueries('const x = `SELECT COUNT(*)::int AS c FROM bandit_arms WHERE repo_id = $1`;');
    assert.deepEqual(bad, [{
      table: 'bandit_arms',
      columns: ['repo_id'],
      sql: 'SELECT COUNT(*)::int AS c FROM bandit_arms WHERE repo_id = $1',
    }]);
    assert.ok(!COLUMNS.get('bandit_arms').has('repo_id'),
      'and the schema oracle rejects it');
  });
});
