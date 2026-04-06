import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeSqliteError, normalizePostgresError } from '../../scripts/lib/stores/sql/sql-errors.mjs';

describe('normalizeSqliteError', () => {
  it('maps SQLITE_BUSY to transient', () => {
    const err = new Error('database is locked');
    err.code = 'SQLITE_BUSY';
    const result = normalizeSqliteError(err);
    assert.equal(result.reason, 'transient');
    assert.equal(result.retryable, true);
    assert.equal(result.bufferToOutbox, true);
  });

  it('maps SQLITE_READONLY to misconfiguration', () => {
    const err = new Error('readonly database');
    err.code = 'SQLITE_READONLY';
    const result = normalizeSqliteError(err);
    assert.equal(result.reason, 'misconfiguration');
    assert.equal(result.retryable, false);
  });

  it('maps SQLITE_CONSTRAINT to integrity', () => {
    const err = new Error('UNIQUE constraint failed');
    err.code = 'SQLITE_CONSTRAINT';
    const result = normalizeSqliteError(err);
    assert.equal(result.reason, 'integrity');
  });

  it('maps unknown errors', () => {
    const err = new Error('something weird');
    const result = normalizeSqliteError(err);
    assert.equal(result.reason, 'unknown');
  });
});

describe('normalizePostgresError', () => {
  it('maps ECONNREFUSED to transient', () => {
    const err = new Error('connect ECONNREFUSED');
    const result = normalizePostgresError(err);
    assert.equal(result.reason, 'transient');
    assert.equal(result.bufferToOutbox, true);
  });

  it('maps 28P01 to misconfiguration', () => {
    const err = new Error('auth failed');
    err.code = '28P01';
    const result = normalizePostgresError(err);
    assert.equal(result.reason, 'misconfiguration');
  });

  it('maps 23505 to integrity', () => {
    const err = new Error('unique violation');
    err.code = '23505';
    const result = normalizePostgresError(err);
    assert.equal(result.reason, 'integrity');
  });

  it('maps 42P01 to misconfiguration', () => {
    const err = new Error('relation does not exist');
    err.code = '42P01';
    const result = normalizePostgresError(err);
    assert.equal(result.reason, 'misconfiguration');
    assert.ok(result.operatorHint.includes('setup-postgres'));
  });
});
