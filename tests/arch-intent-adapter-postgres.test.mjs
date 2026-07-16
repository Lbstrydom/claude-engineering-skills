/**
 * Tests for the architecture-intent Postgres adapter
 * (scripts/lib/arch-intent/adapters/postgres.mjs).
 */
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import analyseImports, { _internals } from '../scripts/lib/arch-intent/adapters/postgres.mjs';

const { stripSqlCommentsAndStrings, parseFile, buildSqlCatalog, resolveSqlRef } = _internals;

let tmpDir;
beforeEach(() => { tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'arch-pg-')); });
afterEach(() => { fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }); });

function writeTree(files) {
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(tmpDir, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
  }
  return tmpDir;
}

/** Convenience — parse a single SQL string into a FileParse. */
function parse(sql, file = 'm.sql') {
  return parseFile(stripSqlCommentsAndStrings(sql), sql, file);
}

// ── stripSqlCommentsAndStrings ──────────────────────────────────────────────

describe('stripSqlCommentsAndStrings', () => {
  it('blanks -- line comments', () => {
    const out = stripSqlCommentsAndStrings('select 1; -- create table evil ()');
    assert.ok(!out.includes('evil'));
    assert.ok(out.includes('select 1;'));
  });
  it('blanks nested /* */ block comments', () => {
    const out = stripSqlCommentsAndStrings('/* outer /* inner create table evil */ still */ select 1;');
    assert.ok(!out.includes('evil'));
    assert.ok(out.includes('select 1;'));
  });
  it('blanks single-quoted strings incl. the doubled-quote escape', () => {
    const out = stripSqlCommentsAndStrings("insert into t values ('O''Reilly; create table evil ()');");
    assert.ok(!out.includes('evil'));
    assert.ok(out.includes('insert into t values'));
  });
  it('handles E-prefixed escape strings with backslash-escaped quote (G1)', () => {
    const out = stripSqlCommentsAndStrings("select E'O\\'Reilly; drop table x'; select 2;");
    // The \\' must NOT terminate the string — `select 2;` must survive intact.
    assert.ok(out.includes('select 2;'), `got: ${JSON.stringify(out)}`);
    assert.ok(!out.includes('drop table'));
  });
  it('blanks dollar-quoted bodies incl. tagged tags', () => {
    const out = stripSqlCommentsAndStrings('create function f() returns int as $func$ begin create table evil(); end $func$ language plpgsql; select 1;');
    assert.ok(!out.includes('evil'));
    assert.ok(out.includes('select 1;'));
  });
  it('a ; inside a dollar-quoted body does not split a statement', () => {
    const p = parse('create function f() returns void as $$ begin perform 1; perform 2; end $$ language plpgsql;');
    // one function def, not three statements
    assert.equal(p.objectDefs.filter(d => d.kind === 'function').length, 1);
  });
  it('preserves quoted identifiers (text kept)', () => {
    const out = stripSqlCommentsAndStrings('create table "Mixed;Case" (id int);');
    assert.ok(out.includes('"Mixed;Case"'));
  });
  it('preserves line count', () => {
    const src = '/*\na\nb\n*/\nselect 1;';
    assert.equal(stripSqlCommentsAndStrings(src).split('\n').length, src.split('\n').length);
  });
});

// ── parseFile ───────────────────────────────────────────────────────────────

describe('parseFile', () => {
  it('extracts a table with an inline FK', () => {
    const p = parse('create table app.orders (id int, user_id int references core.users(id));');
    const def = p.objectDefs.find(d => d.name === 'app.orders');
    assert.ok(def);
    assert.ok(def.refs.some(r => r.kind === 'foreign-key' && r.toName === 'core.users'));
  });
  it('extracts a table-level named FK constraint', () => {
    const p = parse('create table app.o (id int, constraint fk_u foreign key (uid) references core.u(id));');
    const fk = p.objectDefs[0].refs.find(r => r.kind === 'foreign-key');
    assert.equal(fk.toName, 'core.u');
    assert.equal(fk.constraintName, 'fk_u');
  });
  it('extracts a column-type ref to a custom type (G4)', () => {
    const p = parse('create table t (id int, status order_status);');
    assert.ok(p.objectDefs[0].refs.some(r => r.kind === 'column-type' && r.toName === 'order_status'));
  });
  it('does NOT emit a column-type ref for a builtin type', () => {
    const p = parse('create table t (id int, name text, payload jsonb);');
    assert.equal(p.objectDefs[0].refs.filter(r => r.kind === 'column-type').length, 0);
  });
  it('extracts PARTITION OF (G1)', () => {
    const p = parse('create table events_2026 partition of events for values from (1) to (2);');
    assert.ok(p.objectDefs[0].refs.some(r => r.kind === 'partition-of' && r.toName === 'events'));
  });
  it('extracts a view with FROM refs, excluding CTEs (M2)', () => {
    const p = parse('create view v as with c as (select 1) select * from c join real_table on true;');
    const refs = p.objectDefs[0].refs.filter(r => r.kind === 'view-select');
    assert.ok(refs.some(r => r.toName === 'real_table'));
    assert.ok(!refs.some(r => r.toName === 'c'), 'CTE name must be excluded');
  });
  it('extracts a function and a call from its body', () => {
    const p = parse('create function caller() returns void as $$ begin perform helper_fn(); end $$ language plpgsql;');
    const def = p.objectDefs.find(d => d.kind === 'function');
    assert.ok(def);
    assert.ok(def.refs.some(r => r.kind === 'function-call' && r.toName === 'helper_fn'));
  });
  it('recovers a function body from the AS \'...\' form (M3)', () => {
    const p = parse("create function f() returns int as 'select other_fn()' language sql;");
    assert.ok(p.objectDefs[0].refs.some(r => r.toName === 'other_fn'));
  });
  it('extracts CREATE TYPE / CREATE DOMAIN as kind type', () => {
    const p = parse("create type order_status as enum ('a','b'); create domain pos as int;");
    assert.deepEqual(
      p.objectDefs.filter(d => d.kind === 'type').map(d => d.name).sort(),
      ['order_status', 'pos']);
  });
  it('extracts ALTER TABLE ADD FOREIGN KEY as an alterRef', () => {
    const p = parse('alter table app.o add constraint fk foreign key (u) references core.u(id);');
    assert.equal(p.alterRefs[0].kind, 'foreign-key');
    assert.equal(p.alterRefs[0].toName, 'core.u');
  });
  it('extracts CREATE TRIGGER (incl. OR REPLACE, G3) and CREATE POLICY', () => {
    const p = parse('create or replace trigger t1 after insert on app.o execute function audit_fn();'
      + ' create policy p1 on app.o using (tenant_id in (select id from core.tenants));');
    assert.ok(p.alterRefs.some(r => r.kind === 'trigger-binding' && r.toName === 'audit_fn'));
    assert.ok(p.alterRefs.some(r => r.kind === 'policy-reference' && r.toName === 'core.tenants'));
  });
  it('extracts a multi-object DROP list (G2)', () => {
    const p = parse('drop table if exists t1, t2, t3 cascade;');
    assert.deepEqual(p.drops.filter(d => d.what === 'object').map(d => d.name).sort(),
      ['t1', 't2', 't3']);
  });
  it('extracts DROP TRIGGER / DROP POLICY (G2)', () => {
    const p = parse('drop trigger t1 on app.o; drop policy p1 on app.o;');
    assert.ok(p.drops.some(d => d.what === 'trigger' && d.name === 't1'));
    assert.ok(p.drops.some(d => d.what === 'policy' && d.name === 'p1'));
  });
  it('does not split a statement on a ; inside a quoted identifier (H3)', () => {
    const p = parse('create table "weird;name" (id int); create table after_it (id int);');
    const names = p.objectDefs.map(d => d.name).sort();
    assert.deepEqual(names, ['after_it', 'weird;name'],
      `expected both tables, got ${JSON.stringify(names)}`);
  });
  it('parses a fully-qualified name with quoted schema AND name (M2)', () => {
    const p = parse('create table "app"."Orders" (id int);');
    assert.equal(p.objectDefs[0].name, 'app.Orders',
      `expected app.Orders (quoted segments case-preserved), got ${p.objectDefs[0].name}`);
  });
  it('a dot inside a quoted identifier does NOT collide with schema.name (G1)', () => {
    // "my.table" (one identifier containing a dot) and my.table (schema my,
    // table table) must NOT normalise to the same catalog key.
    const quoted = parse('create table "my.table" (id int);').objectDefs[0].name;
    const qualified = parse('create table my.table (id int);').objectDefs[0].name;
    assert.notEqual(quoted, qualified,
      `"my.table" and my.table must have distinct keys, both were ${JSON.stringify(quoted)}`);
  });
});

// ── buildSqlCatalog ─────────────────────────────────────────────────────────

describe('buildSqlCatalog', () => {
  it('CREATE OR REPLACE — last definition wins', () => {
    const parses = [
      { file: '001.sql', parse: parse('create function f() returns int as $$ select old_fn() $$ language sql;', '001.sql') },
      { file: '002.sql', parse: parse('create or replace function f() returns int as $$ select new_fn() $$ language sql;', '002.sql') },
    ];
    const cat = buildSqlCatalog(parses);
    assert.equal(cat.functionToDef.get('f').definingFile, '002.sql');
  });
  it('DROP removes an object from the catalog', () => {
    const parses = [
      { file: '001.sql', parse: parse('create table t (id int);', '001.sql') },
      { file: '002.sql', parse: parse('drop table t;', '002.sql') },
    ];
    const cat = buildSqlCatalog(parses);
    assert.equal(cat.relationToDef.has('t'), false);
  });
  it('epoch model — drop-then-recreate discards a stale alterRef (H1)', () => {
    const parses = [
      { file: '001.sql', parse: parse('create table t (id int);', '001.sql') },
      { file: '002.sql', parse: parse('alter table t add constraint fk foreign key (u) references other(id);', '002.sql') },
      { file: '003.sql', parse: parse('drop table t;', '003.sql') },
      { file: '004.sql', parse: parse('create table t (id int);', '004.sql') },
    ];
    const cat = buildSqlCatalog(parses);
    // the FK alterRef belonged to the dropped epoch — must not survive.
    assert.equal(cat.survivingRefs.some(r => r.kind === 'foreign-key' && r.fromObjectName === 't'), false);
  });
  it('ALTER TABLE DROP CONSTRAINT removes the matching FK alterRef (G3)', () => {
    const parses = [
      { file: '001.sql', parse: parse('create table t (id int);', '001.sql') },
      { file: '002.sql', parse: parse('alter table t add constraint fk_x foreign key (u) references other(id);', '002.sql') },
      { file: '003.sql', parse: parse('alter table t drop constraint fk_x;', '003.sql') },
    ];
    const cat = buildSqlCatalog(parses);
    assert.equal(cat.survivingRefs.some(r => r.kind === 'foreign-key'), false);
  });
  it('DROP TRIGGER removes the matching trigger alterRef (G2)', () => {
    const parses = [
      { file: '001.sql', parse: parse('create table t (id int);', '001.sql') },
      { file: '002.sql', parse: parse('create trigger tr after insert on t execute function f();', '002.sql') },
      { file: '003.sql', parse: parse('drop trigger tr on t;', '003.sql') },
    ];
    const cat = buildSqlCatalog(parses);
    assert.equal(cat.survivingRefs.some(r => r.kind === 'trigger-binding'), false);
  });
});

// ── resolveSqlRef ───────────────────────────────────────────────────────────

describe('resolveSqlRef', () => {
  const cat = buildSqlCatalog([
    { file: 'a.sql', parse: parse('create table public.users (id int); create table app.orders (id int);', 'a.sql') },
  ]);
  it('resolves a local relation', () => {
    assert.equal(resolveSqlRef('public.users', 'relation', cat).state, 'resolved-local');
  });
  it('resolves an unqualified name via unique bare match', () => {
    assert.equal(resolveSqlRef('orders', 'relation', cat).state, 'resolved-local');
  });
  it('classifies pg_catalog / builtins as proven-external', () => {
    assert.equal(resolveSqlRef('pg_catalog.pg_class', 'relation', cat).state, 'proven-external');
    assert.equal(resolveSqlRef('gen_random_uuid', 'function', cat).state, 'proven-external');
  });
  it('classifies an unknown reference as unresolved', () => {
    assert.equal(resolveSqlRef('app.nonexistent', 'relation', cat).state, 'unresolved');
  });
});

// ── Integration — analyseImports against a fixture repo ─────────────────────

describe('postgres analyseImports (integration)', () => {
  function buildFixture() {
    return writeTree({
      'db/core/0001.sql':
        'create table core.users (id uuid);\n' +
        'create function core.touch() returns trigger as $$ begin new.updated = now(); return new; end $$ language plpgsql;\n',
      'db/app/0002.sql':
        'create table app.orders (id int, uid uuid references core.users(id));\n' +
        'create table app.bad (id int, tid int references tests.fixtures(id));\n',
      'db/tests/0003.sql': 'create table tests.fixtures (id int);\n',
    });
  }
  const mapped = new Map([
    ['db/core/0001.sql', 'core'],
    ['db/app/0002.sql', 'app'],
    ['db/tests/0003.sql', 'tests'],
  ]);
  const domainMap = {
    rules: [
      { pattern: 'db/core/**', domain: 'core' },
      { pattern: 'db/app/**', domain: 'app' },
      { pattern: 'db/tests/**', domain: 'tests' },
    ],
    allowedDeps: { app: ['core'], tests: ['core', 'app'] },
  };

  it('catches the deliberate app -> tests FK violation', async () => {
    const repoPath = buildFixture();
    const { violations } = await analyseImports({ mapped, domainMap, repoPath });
    const v = violations.find(x => x.fromFile === 'db/app/0002.sql' && x.toFile === 'db/tests/0003.sql');
    assert.ok(v, `expected app->tests violation, got ${JSON.stringify(violations)}`);
    assert.equal(v.fromDomain, 'app');
    assert.equal(v.toDomain, 'tests');
  });
  it('does NOT flag the allowed app -> core FK', async () => {
    const repoPath = buildFixture();
    const { violations } = await analyseImports({ mapped, domainMap, repoPath });
    assert.ok(!violations.some(x => x.toFile === 'db/core/0001.sql'));
  });
  it('classifies gen_random_uuid as a vendor ref (not a violation)', async () => {
    const repoPath = buildFixture();
    const { violations, _meta } = await analyseImports({ mapped, domainMap, repoPath });
    assert.ok(_meta.vendorRefs >= 1);
    assert.ok(!violations.some(x => x.toFile === undefined));
  });
  it('_meta has all fixed keys', async () => {
    const repoPath = buildFixture();
    const { _meta, analyzerVersion } = await analyseImports({ mapped, domainMap, repoPath });
    for (const k of ['statementCount', 'tableCount', 'viewCount', 'functionCount',
      'typeCount', 'edgeCount', 'fkEdges', 'viewEdges', 'functionCallEdges',
      'triggerEdges', 'policyEdges', 'partitionEdges', 'columnTypeEdges',
      'vendorRefs', 'unresolvedRefs', 'objectRedefinitions', 'unreadableFiles',
      'parseErrors', 'skippedLargeFiles', 'edges', 'allFiles']) {
      assert.ok(k in _meta, `_meta missing key ${k}`);
    }
    assert.equal(analyzerVersion, 'postgres-1.0.0');
  });
  it('returns empty for a repo with no .sql files', async () => {
    const repoPath = writeTree({ 'readme.md': 'hi' });
    const { violations } = await analyseImports({ mapped: new Map(), domainMap, repoPath });
    assert.deepEqual(violations, []);
  });
});
