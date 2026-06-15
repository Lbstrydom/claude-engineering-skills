// DSN / SSL / pool-size validation in db/client.mjs (the two deferred findings
// from the shared-env-loading audit: reject the Supabase Transaction pooler,
// validate AUDIT_DB_SSL_MODE + AUDIT_DB_POOL_MAX). Pure — no connection opened.

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { assertSafeDsn, buildPoolConfig } from '../scripts/lib/db/client.mjs';

const fakePgTypes = { getTypeParser: () => (v) => v };

describe('assertSafeDsn — forbidden / invalid DSNs', () => {
  it('rejects the Supabase Transaction pooler (port 6543)', () => {
    assert.throws(
      () => assertSafeDsn('postgresql://u:p@aws-1-eu-west-2.pooler.supabase.com:6543/postgres'),
      /Transaction pooler \(port 6543\)/,
    );
  });

  it('accepts the Supabase Session pooler (port 5432)', () => {
    assert.doesNotThrow(
      () => assertSafeDsn('postgresql://u:p@aws-1-eu-west-2.pooler.supabase.com:5432/postgres'),
    );
  });

  it('does NOT reject a self-hosted Postgres on 6543 (non-Supabase host)', () => {
    assert.doesNotThrow(() => assertSafeDsn('postgresql://u:p@db.internal:6543/postgres'));
  });

  it('rejects a non-postgres protocol', () => {
    assert.throws(() => assertSafeDsn('mysql://u:p@host:3306/db'), /postgresql:\/\/ connection string/);
  });

  it('rejects a non-URL string', () => {
    assert.throws(() => assertSafeDsn('not a url'), /not a valid URL/);
  });
});

describe('buildPoolConfig — SSL mode + pool size validation', () => {
  const KEYS = ['AUDIT_DB_SSL_MODE', 'AUDIT_POSTGRES_SSL_MODE', 'AUDIT_DB_POOL_MAX'];
  const snap = {};
  beforeEach(() => { for (const k of KEYS) { snap[k] = process.env[k]; delete process.env[k]; } });
  afterEach(() => { for (const k of KEYS) { if (snap[k] === undefined) delete process.env[k]; else process.env[k] = snap[k]; } });

  it('rejects an unknown AUDIT_DB_SSL_MODE', () => {
    process.env.AUDIT_DB_SSL_MODE = 'verify-full';
    assert.throws(() => buildPoolConfig('postgres://x', fakePgTypes), /AUDIT_DB_SSL_MODE="verify-full" is invalid/);
  });

  it('accepts the three valid SSL modes', () => {
    for (const [mode, expected] of [['require', { rejectUnauthorized: true }], ['no-verify', { rejectUnauthorized: false }], ['disable', false]]) {
      process.env.AUDIT_DB_SSL_MODE = mode;
      const cfg = buildPoolConfig('postgres://x', fakePgTypes);
      assert.deepEqual(cfg.ssl, expected, `ssl for ${mode}`);
    }
  });

  it('defaults to require (max 4) when unset', () => {
    const cfg = buildPoolConfig('postgres://x', fakePgTypes);
    assert.deepEqual(cfg.ssl, { rejectUnauthorized: true });
    assert.equal(cfg.max, 4);
  });

  it('accepts a valid integer pool size', () => {
    process.env.AUDIT_DB_POOL_MAX = '8';
    assert.equal(buildPoolConfig('postgres://x', fakePgTypes).max, 8);
  });

  it('rejects fractional / zero / over-bound pool sizes', () => {
    for (const bad of ['4.5', '0', '-1', '51', 'abc']) {
      process.env.AUDIT_DB_POOL_MAX = bad;
      assert.throws(() => buildPoolConfig('postgres://x', fakePgTypes), /AUDIT_DB_POOL_MAX=.* is invalid/, `pool max ${bad}`);
    }
  });
});
