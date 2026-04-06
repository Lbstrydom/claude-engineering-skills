import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { quoteIdent, placeholder, buildUpsert, expandTemplate } from '../../scripts/lib/stores/sql/sql-dialect.mjs';

describe('quoteIdent', () => {
  it('wraps valid identifiers in double quotes', () => {
    assert.equal(quoteIdent('my_table'), '"my_table"');
    assert.equal(quoteIdent('Column1'), '"Column1"');
  });

  it('rejects invalid identifiers', () => {
    assert.throws(() => quoteIdent(''), /Invalid SQL identifier/);
    assert.throws(() => quoteIdent('1table'), /Invalid SQL identifier/);
    assert.throws(() => quoteIdent('table; DROP'), /Invalid SQL identifier/);
    assert.throws(() => quoteIdent('a'.repeat(64)), /Invalid SQL identifier/);
  });
});

describe('placeholder', () => {
  it('returns ? for sqlite', () => {
    assert.equal(placeholder('sqlite', 1), '?');
    assert.equal(placeholder('sqlite', 5), '?');
  });

  it('returns $n for postgres', () => {
    assert.equal(placeholder('postgres', 1), '$1');
    assert.equal(placeholder('postgres', 3), '$3');
  });
});

describe('buildUpsert', () => {
  it('builds INSERT ON CONFLICT DO UPDATE', () => {
    const { sql } = buildUpsert({
      table: 'repos',
      columns: ['repo_id', 'fingerprint', 'name'],
      conflictTarget: ['fingerprint'],
      updateColumns: ['name'],
      dialect: 'sqlite',
    });
    assert.ok(sql.includes('INSERT INTO'));
    assert.ok(sql.includes('ON CONFLICT'));
    assert.ok(sql.includes('DO UPDATE SET'));
    assert.ok(sql.includes('"name" = EXCLUDED."name"'));
  });

  it('builds INSERT ON CONFLICT DO NOTHING when no update columns', () => {
    const { sql } = buildUpsert({
      table: 'debt_events',
      columns: ['id', 'key'],
      conflictTarget: ['key'],
      updateColumns: [],
      dialect: 'postgres',
    });
    assert.ok(sql.includes('DO NOTHING'));
  });
});

describe('expandTemplate', () => {
  it('expands sqlite tokens', () => {
    const result = expandTemplate('col {{JSONB}} NOT NULL, ts {{TIMESTAMPTZ}}', 'sqlite');
    assert.ok(result.includes('TEXT NOT NULL'));
    assert.ok(result.includes('ts TEXT'));
  });

  it('expands postgres tokens', () => {
    const result = expandTemplate('col {{JSONB}}, ts {{TIMESTAMPTZ}}', 'postgres', 'audit_loop');
    assert.ok(result.includes('jsonb'));
    assert.ok(result.includes('TIMESTAMPTZ'));
  });

  it('expands schema prefix for postgres', () => {
    const result = expandTemplate('CREATE TABLE {{SCHEMA}}repos', 'postgres', 'my_schema');
    assert.ok(result.includes('"my_schema".repos'));
  });

  it('leaves schema empty for sqlite', () => {
    const result = expandTemplate('CREATE TABLE {{SCHEMA}}repos', 'sqlite');
    assert.equal(result, 'CREATE TABLE repos');
  });
});
