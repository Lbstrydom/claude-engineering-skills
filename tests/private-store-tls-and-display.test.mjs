/**
 * @fileoverview Field-report fixes for a store reached through a localhost tunnel:
 *  - AUDIT_DB_SSL_SERVERNAME / AUDIT_DB_SSL_CA reach the TLS options the pool receives
 *  - the unreachable-store message prints the host exactly as configured
 *  - dbIdentity STILL folds loopback spellings together (negative control: the
 *    display fix must not have touched the equality key the fingerprint uses)
 */
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import pg from 'pg';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { buildPoolConfig, dbIdentity, dbDisplayTarget } from '../scripts/lib/db/client.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const fakePgTypes = { getTypeParser: () => (v) => v };
const KEYS = ['AUDIT_DB_SSL_MODE', 'AUDIT_POSTGRES_SSL_MODE', 'AUDIT_DB_SSL_SERVERNAME', 'AUDIT_DB_SSL_CA'];
let saved;
beforeEach(() => { saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]])); KEYS.forEach((k) => delete process.env[k]); });
afterEach(() => { for (const k of KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; } });

describe('buildPoolConfig — tunnel TLS options', () => {
  it('passes servername and the CA bundle contents to the pool ssl options', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ssl-ca-'));
    const caFile = path.join(dir, 'ca.pem');
    fs.writeFileSync(caFile, '-----BEGIN CERTIFICATE-----\nTEST\n-----END CERTIFICATE-----\n');
    process.env.AUDIT_DB_SSL_MODE = 'require';
    process.env.AUDIT_DB_SSL_SERVERNAME = 'db.internal.example';
    process.env.AUDIT_DB_SSL_CA = caFile;
    const { ssl } = buildPoolConfig('postgres://u:p@127.0.0.1:15499/audit_loop', fakePgTypes);
    assert.equal(ssl.rejectUnauthorized, true);       // verification stays ON
    assert.equal(ssl.servername, 'db.internal.example');
    assert.match(ssl.ca, /BEGIN CERTIFICATE/);
  });

  it('negative control: unset vars leave the options byte-identical to before', () => {
    process.env.AUDIT_DB_SSL_MODE = 'require';
    assert.deepEqual(buildPoolConfig('postgres://x', fakePgTypes).ssl, { rejectUnauthorized: true });
    process.env.AUDIT_DB_SSL_MODE = 'no-verify';
    assert.deepEqual(buildPoolConfig('postgres://x', fakePgTypes).ssl, { rejectUnauthorized: false });
  });

  it('disable stays ssl:false even when servername is set', () => {
    process.env.AUDIT_DB_SSL_MODE = 'disable';
    process.env.AUDIT_DB_SSL_SERVERNAME = 'x.example';
    assert.equal(buildPoolConfig('postgres://x', fakePgTypes).ssl, false);
  });

  it('an unreadable CA throws even when TLS is disabled (misconfiguration is reported, not ignored)', () => {
    process.env.AUDIT_DB_SSL_MODE = 'disable';
    process.env.AUDIT_DB_SSL_CA = path.join(os.tmpdir(), 'definitely-missing-ca.pem');
    assert.throws(() => buildPoolConfig('postgres://x', fakePgTypes), /AUDIT_DB_SSL_CA could not be read/);
  });

  it('an empty or non-PEM CA file throws instead of falling back to the default trust roots', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ssl-ca-empty-'));
    for (const body of ['', 'not a certificate']) {
      const f = path.join(dir, 'ca.pem');
      fs.writeFileSync(f, body);
      process.env.AUDIT_DB_SSL_CA = f;
      assert.throws(() => buildPoolConfig('postgres://x', fakePgTypes), /contains no PEM certificate/);
    }
  });

  it('an unreadable CA path throws loudly instead of falling back to system roots', () => {
    process.env.AUDIT_DB_SSL_CA = path.join(os.tmpdir(), 'definitely-missing-ca.pem');
    assert.throws(() => buildPoolConfig('postgres://x', fakePgTypes), /AUDIT_DB_SSL_CA could not be read/);
  });
});

describe('DSN ssl parameters must not replace the explicit TLS options (what pg actually consumes)', () => {
  const dsn = 'postgres://u:p@127.0.0.1:15499/audit_loop?sslmode=require&application_name=x';
  const consumed = (cfg) => new pg.Client(cfg).connectionParameters.ssl;

  it('servername + CA survive a DSN that carries sslmode (control: pg really replaces them otherwise)', () => {
    // Instrument check — proves the probe can see the replacement it guards against.
    assert.deepEqual(consumed({ connectionString: dsn, ssl: { rejectUnauthorized: true, servername: 'real.host' } }), {});
    process.env.AUDIT_DB_SSL_MODE = 'require';
    process.env.AUDIT_DB_SSL_SERVERNAME = 'real.host';
    const cfg = buildPoolConfig(dsn, fakePgTypes);
    const ssl = consumed(cfg);
    assert.equal(ssl.servername, 'real.host');
    assert.equal(ssl.rejectUnauthorized, true);
    assert.match(cfg.connectionString, /application_name=x/);   // only TLS params are dropped
  });

  it('a DSN carrying certificate params is refused, not silently stripped', () => {
    process.env.AUDIT_DB_SSL_SERVERNAME = 'real.host';
    for (const p of ['sslrootcert=/x/ca.pem', 'sslcert=/x/c.pem', 'sslkey=/x/k.pem']) {
      assert.throws(() => buildPoolConfig('postgres://u:p@h/d?' + p, fakePgTypes), /carries ssl/);
    }
  });

  it('negative control: without the new vars the DSN passes through untouched', () => {
    process.env.AUDIT_DB_SSL_MODE = 'require';
    assert.equal(buildPoolConfig(dsn, fakePgTypes).connectionString, dsn);
  });
});

describe('dbDisplayTarget vs dbIdentity', () => {
  it('keeps the host exactly as configured', () => {
    assert.equal(dbDisplayTarget('postgresql://u:secret@127.0.0.1:15499/audit_loop'), '127.0.0.1:15499/audit_loop');
    assert.equal(dbDisplayTarget('postgresql://u:secret@localhost:15499/audit_loop'), 'localhost:15499/audit_loop');
  });
  it('never carries credentials', () => {
    assert.doesNotMatch(dbDisplayTarget('postgresql://u:p%40ss@127.0.0.1:1/d'), /p%40ss|u:/);
  });
  it('NEGATIVE CONTROL: dbIdentity still folds loopback spellings (fingerprint equality key)', () => {
    assert.equal(dbIdentity('postgresql://u:p@127.0.0.1:15499/a'), dbIdentity('postgresql://u:p@localhost:15499/a'));
  });
});

describe('initLearningStore unreachable-store line', () => {
  it('prints 127.0.0.1 as configured, not localhost', async () => {
    // A port that was free a moment ago, and an environment with no ambient store config.
    const port = await new Promise((resolve) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); }); });
    const code = "import('./scripts/lib/store/repo.mjs').then(async m => { await m.initLearningStore(); process.exit(0); });";
    const res = spawnSync(process.execPath, ['-e', code], {
      cwd: ROOT, encoding: 'utf-8', timeout: 30000, windowsHide: true,
      env: { ...process.env, AUDIT_DB_URL: `postgresql://u:p@127.0.0.1:${port}/audit_loop`, AUDIT_DB_SSL_MODE: 'disable', AUDIT_DB_SSL_SERVERNAME: '', AUDIT_DB_SSL_CA: '', LEARNING_DISABLE: '' },
    });
    const out = `${res.stdout}\n${res.stderr}`;
    assert.ok(out.includes(`store unavailable at 127.0.0.1:${port}/audit_loop`), out);
    assert.doesNotMatch(out, /unavailable at localhost/);
  });
});
