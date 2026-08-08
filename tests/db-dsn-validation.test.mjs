// DSN / SSL / pool-size validation in db/client.mjs (the two deferred findings
// from the shared-env-loading audit: reject the Supabase Transaction pooler,
// validate AUDIT_DB_SSL_MODE + AUDIT_DB_POOL_MAX). Pure — no connection opened.

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { assertSafeDsn, assertDisposableDbUrl, buildPoolConfig, isDisposableDbHost } from '../scripts/lib/db/client.mjs';

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

describe('assertDisposableDbUrl — 2026-07-14 incident guard', () => {
  it('rejects a Supabase direct-connection host (db.<ref>.supabase.co)', () => {
    assert.throws(
      () => assertDisposableDbUrl('postgresql://u:p@db.uahjjdelnnpfmaqjrwoz.supabase.co:5432/postgres'),
      /not a recognised disposable/,
    );
  });

  it('rejects a Supabase pooler host (*.pooler.supabase.com)', () => {
    assert.throws(
      () => assertDisposableDbUrl('postgresql://postgres.ref:p@aws-1-eu-west-2.pooler.supabase.com:5432/postgres'),
      /not a recognised disposable/,
    );
  });

  // The 2026-08-08 regression, as a test. The store moved off Supabase to a
  // self-hosted LAN Postgres; the old denylist matched only *.supabase.*, so
  // production became invisible to this guard on the day it moved. An
  // allowlist cannot rot that way — a new production host is refused by
  // default rather than admitted by default.
  it('rejects a self-hosted LAN production host with NO productionUrl to compare against', () => {
    assert.throws(
      () => assertDisposableDbUrl('postgresql://postgres:p@192.168.1.176:5433/audit_loop'),
      /not a recognised disposable/,
    );
  });

  it('rejects any non-loopback host, whatever brand of Postgres is behind it', () => {
    for (const host of ['db.internal', '10.0.0.5', 'nas.local', 'postgres.example.com']) {
      assert.throws(
        () => assertDisposableDbUrl(`postgresql://u:p@${host}:5432/postgres`),
        /not a recognised disposable/,
        `expected ${host} to be refused`,
      );
    }
  });

  it('rejects when it names the same database as AUDIT_DB_URL', () => {
    const url = 'postgresql://u:p@127.0.0.1:5432/postgres';
    assert.throws(
      () => assertDisposableDbUrl(url, { productionUrl: url }),
      /names the same database as AUDIT_DB_URL/,
    );
  });

  // Exact string equality — what this check used to be — passes every one of
  // these while all four address the identical database.
  it('rejects same-database aliases that are not the same STRING', () => {
    const prod = 'postgresql://u:p@127.0.0.1:5432/postgres';
    const aliases = [
      'postgresql://u:p@127.0.0.1:5432/postgres?sslmode=disable', // query param appended
      'postgresql://other:pw@127.0.0.1:5432/postgres',            // different credentials
      'postgresql://u:p@localhost:5432/postgres',                 // localhost vs 127.0.0.1
      'postgresql://u:p@127.0.0.1/postgres',                      // implicit default port
    ];
    for (const alias of aliases) {
      assert.throws(
        () => assertDisposableDbUrl(alias, { productionUrl: prod }),
        /names the same database as AUDIT_DB_URL/,
        `expected ${alias} to be recognised as production`,
      );
    }
  });

  it('still allows a DIFFERENT database on the same loopback server', () => {
    assert.doesNotThrow(() => assertDisposableDbUrl(
      'postgresql://u:p@127.0.0.1:5432/ces_test',
      { productionUrl: 'postgresql://u:p@127.0.0.1:5432/postgres' },
    ));
  });

  it('accepts a local/container Postgres host', () => {
    assert.doesNotThrow(() => assertDisposableDbUrl('postgresql://postgres:postgres@127.0.0.1:5432/postgres'));
    assert.doesNotThrow(() => assertDisposableDbUrl('postgresql://postgres:postgres@localhost:5432/postgres'));
  });

  it('accepts a local/container host even when a DIFFERENT productionUrl is set', () => {
    assert.doesNotThrow(() => assertDisposableDbUrl(
      'postgresql://postgres:postgres@127.0.0.1:5432/postgres',
      { productionUrl: 'postgresql://u:p@aws-1-eu-west-2.pooler.supabase.com:5432/postgres' },
    ));
  });

  it('rejects a non-URL string', () => {
    assert.throws(() => assertDisposableDbUrl('not a url'), /not a valid URL/);
  });
});

describe('isDisposableDbHost — shared predicate (client.mjs + generate-expected-schema.mjs)', () => {
  it('accepts loopback hosts — the only place a throwaway Postgres lives here', () => {
    for (const h of ['127.0.0.1', 'localhost', 'LOCALHOST', '::1', '[::1]', '127.0.0.2', '127.1.2.3']) {
      assert.equal(isDisposableDbHost(h), true, `expected ${h} to be disposable`);
    }
  });

  it('refuses everything else — including hosts that merely LOOK local', () => {
    for (const h of [
      'db.uahjjdelnnpfmaqjrwoz.supabase.co',
      'aws-1-eu-west-2.pooler.supabase.com',
      '192.168.1.176',      // the 2026-08-08 self-hosted store
      '10.0.0.5',
      'db.internal',
      'localhost.evil.com', // suffix trickery
      'not-localhost',
      '127.0.0.1.evil.com',
    ]) {
      assert.equal(isDisposableDbHost(h), false, `expected ${h} to be refused`);
    }
  });

  it('fails closed on junk input rather than defaulting to disposable', () => {
    for (const h of ['', '   ', null, undefined, 42, {}]) {
      assert.equal(isDisposableDbHost(h), false, `expected ${JSON.stringify(h)} to be refused`);
    }
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
