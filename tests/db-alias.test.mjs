import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { resolveDbUrl, buildPoolConfig, _resetAliasWarnings } from '../scripts/lib/db/client.mjs';

const DB_ENV = ['AUDIT_DB_URL', 'AUDIT_POSTGRES_URL', 'AUDIT_STORE', 'AUDIT_DB_SSL_MODE', 'AUDIT_POSTGRES_SSL_MODE',
  'SUPABASE_AUDIT_URL', 'SUPABASE_AUDIT_ANON_KEY', 'SUPABASE_AUDIT_SERVICE_ROLE_KEY'];

function clearEnv() { for (const k of DB_ENV) delete process.env[k]; }

const fakePgTypes = { getTypeParser: () => (v) => v };

describe('resolveDbUrl — AUDIT_POSTGRES_URL back-compat alias', () => {
  beforeEach(() => { clearEnv(); _resetAliasWarnings(); });
  afterEach(clearEnv);

  it('canonical AUDIT_DB_URL resolves', () => {
    process.env.AUDIT_DB_URL = 'postgres://canonical';
    assert.equal(resolveDbUrl(), 'postgres://canonical');
  });

  it('alias AUDIT_POSTGRES_URL resolves when canonical absent', () => {
    process.env.AUDIT_POSTGRES_URL = 'postgres://alias';
    assert.equal(resolveDbUrl(), 'postgres://alias');
  });

  it('canonical wins when both are set', () => {
    process.env.AUDIT_DB_URL = 'postgres://canonical';
    process.env.AUDIT_POSTGRES_URL = 'postgres://alias';
    assert.equal(resolveDbUrl(), 'postgres://canonical');
  });

  it('warns at most once when the alias is used', () => {
    process.env.AUDIT_POSTGRES_URL = 'postgres://alias';
    const lines = [];
    const orig = process.stderr.write;
    process.stderr.write = (s) => { lines.push(String(s)); return true; };
    try { resolveDbUrl(); resolveDbUrl(); } finally { process.stderr.write = orig; }
    const warnings = lines.filter((l) => l.includes('AUDIT_POSTGRES_URL'));
    assert.equal(warnings.length, 1);
  });

  it('returns null when nothing configured', () => {
    assert.equal(resolveDbUrl(), null);
  });
});

describe('resolveDbUrl — AUDIT_STORE=postgres validation (M4)', () => {
  beforeEach(() => { clearEnv(); _resetAliasWarnings(); });
  afterEach(clearEnv);

  it('fails fast when AUDIT_STORE=postgres but no DSN', () => {
    process.env.AUDIT_STORE = 'postgres';
    assert.throws(() => resolveDbUrl(), /AUDIT_STORE=postgres/);
  });

  it('is satisfied when AUDIT_STORE=postgres + a DSN (canonical or alias)', () => {
    process.env.AUDIT_STORE = 'postgres';
    process.env.AUDIT_POSTGRES_URL = 'postgres://alias';
    assert.equal(resolveDbUrl(), 'postgres://alias');
  });
});

describe('buildPoolConfig — AUDIT_POSTGRES_SSL_MODE alias', () => {
  beforeEach(() => { clearEnv(); _resetAliasWarnings(); });
  afterEach(clearEnv);

  it('honours the SSL-mode alias when canonical absent', () => {
    process.env.AUDIT_POSTGRES_SSL_MODE = 'disable';
    const cfg = buildPoolConfig('postgres://x', fakePgTypes);
    assert.equal(cfg.ssl, false); // disable → ssl:false
  });

  it('canonical AUDIT_DB_SSL_MODE wins over the alias', () => {
    process.env.AUDIT_DB_SSL_MODE = 'no-verify';
    process.env.AUDIT_POSTGRES_SSL_MODE = 'disable';
    const cfg = buildPoolConfig('postgres://x', fakePgTypes);
    assert.deepEqual(cfg.ssl, { rejectUnauthorized: false }); // no-verify
  });
});
