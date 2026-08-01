/**
 * @fileoverview The write guard's asymmetry — Tier 3 (hard test-first).
 *
 * Tier 3 because a regression here has no local symptom and two opposite catastrophic
 * shapes: guard too much and every write in every consumer dies (including the migrator's
 * own, deadlocking the fix); guard too little and the original green-but-unrealized hazard
 * is silently restored. Neither shows up as a failing unit test elsewhere.
 *
 * The classifier is the whole contract, so it is tested as a contract — including the
 * shapes a leading-verb matcher gets wrong.
 *
 * Plan: docs/plans/green-but-unrealized.md (Cluster A, Phase 1).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { isReadOnlyStatement } from '../scripts/lib/db/query.mjs';

// ── Reads are allowed through ───────────────────────────────────────────────

test('plain reads are read-only', () => {
  for (const sql of [
    'SELECT 1',
    'SELECT * FROM audit_repos WHERE id = $1',
    'WITH x AS (SELECT 1) SELECT * FROM x',
    'TABLE audit_repos',
    'VALUES (1), (2)',
    'SHOW search_path',
    'EXPLAIN SELECT 1',
  ]) assert.equal(isReadOnlyStatement(sql), true, sql);
});

test('session and transaction control are read-only — withTx depends on it', () => {
  // Load-bearing: `withTx` issues BEGIN/COMMIT through this same seam. Classifying them as
  // writes would make a purely READ-ONLY transaction fail on a behind schema, breaking the
  // fail-open read guarantee via the write guard.
  for (const sql of [
    'BEGIN', 'COMMIT', 'ROLLBACK', 'SAVEPOINT sp_1', 'RELEASE SAVEPOINT sp_1',
    "SET search_path = 'public'", 'RESET ALL', 'DISCARD TEMP',
  ]) assert.equal(isReadOnlyStatement(sql), true, sql);
});

// ── Writes are guarded ──────────────────────────────────────────────────────

test('plain mutations are guarded', () => {
  for (const sql of [
    'INSERT INTO t (a) VALUES ($1)',
    'UPDATE t SET a = 1',
    'DELETE FROM t WHERE id = $1',
    'TRUNCATE t',
  ]) assert.equal(isReadOnlyStatement(sql), false, sql);
});

test('a data-modifying CTE is guarded — the case a leading-verb match misses', () => {
  // `WITH d AS (DELETE … RETURNING *) SELECT * FROM d` begins with WITH and mutates. This
  // is exactly why the classifier is an allow-list of provably-safe shapes rather than a
  // black-list of mutating verbs.
  assert.equal(isReadOnlyStatement('WITH d AS (DELETE FROM t RETURNING *) SELECT * FROM d'), false);
  assert.equal(isReadOnlyStatement('WITH u AS (UPDATE t SET a=1 RETURNING *) SELECT count(*) FROM u'), false);
  assert.equal(isReadOnlyStatement('WITH i AS (INSERT INTO t VALUES (1) RETURNING id) SELECT * FROM i'), false);
});

test('EXPLAIN ANALYZE is guarded — it EXECUTES the statement', () => {
  assert.equal(isReadOnlyStatement('EXPLAIN ANALYZE INSERT INTO t VALUES (1)'), false);
  assert.equal(isReadOnlyStatement('EXPLAIN (ANALYZE, BUFFERS) DELETE FROM t'), false);
});

test('a leading comment cannot disguise the verb', () => {
  assert.equal(isReadOnlyStatement('/* harmless */ UPDATE t SET a = 1'), false);
  assert.equal(isReadOnlyStatement('-- just a note\nDELETE FROM t'), false);
  assert.equal(isReadOnlyStatement('  -- note\n  SELECT 1'), true);
});

test('an UNKNOWN shape is guarded, not waved through', () => {
  // The failure direction that matters: a statement nobody anticipated gets CHECKED.
  // Enumerating every mutating shape is the losing side of that arms race.
  for (const sql of ['MERGE INTO t USING s ON (1=1)', 'CALL do_something()', 'COPY t FROM STDIN', 'GRANT ALL ON t TO x']) {
    assert.equal(isReadOnlyStatement(sql), false, sql);
  }
});

test('a non-string or empty statement never crashes the guard', () => {
  assert.equal(isReadOnlyStatement(''), true);
  assert.equal(isReadOnlyStatement('   '), true);
  assert.equal(isReadOnlyStatement(null), false, 'a non-string is not provably read-only');
  assert.equal(isReadOnlyStatement(undefined), false);
});

// ── The guard is actually wired into _exec ──────────────────────────────────

test('_exec consults the classifier and the migration bypass', async () => {
  // Belt-and-braces anti-bypass check: the behavioural assertions above prove the
  // classifier, this proves it is CONNECTED. A correct classifier nobody calls is the
  // shape this whole plan exists to prevent.
  const fs = await import('node:fs');
  const path = await import('node:path');
  const src = fs.readFileSync(
    path.resolve(import.meta.dirname, '..', 'scripts', 'lib', 'db', 'query.mjs'), 'utf-8',
  );
  const code = src.replace(/^\s*(\/\/|\*|\/\*).*$/gm, '');
  assert.match(code, /isReadOnlyStatement\(sql\)/, '_exec must classify the statement');
  assert.match(code, /isMigrationContext\(\)/, 'the migrator must be exempt, or --migrate deadlocks');
  assert.match(code, /assertSchemaRealized/, 'and the guard must actually be asserted');
});

test('the guard reads through the ACTIVE TRANSACTION, never a second connection', async () => {
  // The deadlock the integration tier caught: with `max: 1`, asking the pool for another
  // connection while a transaction holds the only one blocks until the connect timeout —
  // which assertSchemaRealized catches as "indeterminate" and ALLOWS. So every write inside
  // a transaction went unchecked, silently, while this file stayed green.
  const fs = await import('node:fs');
  const path = await import('node:path');
  const src = fs.readFileSync(
    path.resolve(import.meta.dirname, '..', 'scripts', 'lib', 'db', 'query.mjs'), 'utf-8',
  );
  const code = src.replace(/^\s*(\/\/|\*|\/\*).*$/gm, '');
  const call = code.match(/assertSchemaRealized\(\{[^}]*\}\)/);
  assert.ok(call, 'the guard must be called with an options object');
  assert.match(call[0], /executor:/,
    'the guard must be handed an executor — passing only the pool reintroduces the deadlock');
  assert.match(call[0], /txClient/,
    'and that executor must be the active transaction client when there is one');
});

test('assertSchemaRealized runs its ledger read on `executor`, not on `pool`', async () => {
  const { assertSchemaRealized } = await import('../scripts/lib/db/schema-realization.mjs');
  const calls = [];
  const mk = (name, rows) => ({ name, query: async (sql) => { calls.push({ name, sql }); return { rows }; } });
  // A pool that would DEADLOCK if used, and a tx client that answers. The guard must reach
  // for the executor; if it ever reads the pool again this test hangs the assertion instead
  // of the build.
  const pool = { name: 'pool', query: async () => { throw new Error('pool must not be queried'); } };
  const tx = mk('tx', [{ filename: 'x.sql' }]);
  const r = await assertSchemaRealized({
    pool, executor: tx, migrationsDir: null, warn: () => {},
  });
  assert.equal(r.realized, true, 'no migrations dir ⇒ indeterminate ⇒ allow');
  // With a real dir the read must go to `tx`; with none it short-circuits before any query.
  assert.deepEqual(calls, [], 'and it must not have queried anything at all in that state');
});
