/**
 * @fileoverview `doctor`'s store-reachability verdict and the org setup pointer.
 *
 * The failure this exists for: a store that is configured but unreachable makes
 * the whole tooling run local-only SILENTLY, and the first sign is missing
 * cross-session history weeks later. Three verdicts, never collapsed, and the
 * pointer a team commits is printed — never executed.
 */
import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import net from 'node:net';
import path from 'node:path';
import {
  STORE_VERDICT, STORE_SETUP_POINTER_PATH, classifyStoreReachability, readStoreSetupPointer,
  renderStoreDetail, probeStoreReachability,
} from '../scripts/lib/doctor/store-reachability.mjs';
import { REGISTRY, probeIds } from '../scripts/lib/doctor/registry.mjs';
import { runProbe } from '../scripts/lib/doctor/registry.mjs';
import { classifyDbConnectionError } from '../scripts/lib/db/client.mjs';

const roots = [];
afterEach(() => { for (const r of roots.splice(0)) fs.rmSync(r, { recursive: true, force: true }); });

function repoWithPointer(body) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'store-setup-'));
  roots.push(root);
  if (body !== undefined) {
    fs.mkdirSync(path.join(root, '.audit-loop'), { recursive: true });
    fs.writeFileSync(path.join(root, STORE_SETUP_POINTER_PATH), body);
  }
  return root;
}

describe('classifyStoreReachability', () => {
  it('maps the three states', () => {
    assert.equal(classifyStoreReachability({ configured: false }), STORE_VERDICT.UNCONFIGURED);
    assert.equal(classifyStoreReachability({ configured: true, ok: true }), STORE_VERDICT.REACHABLE);
    assert.equal(classifyStoreReachability({ configured: true, ok: false }), STORE_VERDICT.UNREACHABLE);
  });
  it('configured with no positive answer is NOT reachable (never a pass by omission)', () => {
    assert.equal(classifyStoreReachability({ configured: true }), STORE_VERDICT.UNREACHABLE);
    assert.equal(classifyStoreReachability(undefined), STORE_VERDICT.UNCONFIGURED);
  });
});

describe('readStoreSetupPointer', () => {
  it('absent file is present:false', () => {
    assert.deepEqual(readStoreSetupPointer(repoWithPointer(undefined)), { present: false });
  });
  it('reads check and docs', () => {
    const p = readStoreSetupPointer(repoWithPointer('{"check":"pwsh setup.ps1 -DryRun","docs":"tools/README.md"}'));
    assert.deepEqual(p, { present: true, check: 'pwsh setup.ps1 -DryRun', docs: 'tools/README.md', problems: [] });
  });
  it('malformed is reported as malformed, never as absent', () => {
    for (const body of ['{not json', '[]', '"x"', '{}', '{"check": 5}']) {
      const p = readStoreSetupPointer(repoWithPointer(body));
      assert.equal(p.present, true, body);
      assert.ok(p.problems.length > 0, body);
    }
  });
  it('rejects control characters (a terminal-injection / forged-line vector) and over-long values', () => {
    const esc = readStoreSetupPointer(repoWithPointer(JSON.stringify({ check: 'ok\u001b[31mred', docs: 'docs.md' })));
    assert.equal(esc.check, null);
    assert.equal(esc.docs, 'docs.md');
    assert.match(esc.problems.join(' '), /control characters/);
    const nl = readStoreSetupPointer(repoWithPointer(JSON.stringify({ check: 'a\nstore: reachable' })));
    assert.equal(nl.check, null);
    // Control characters at the EDGES must not be laundered by trimming.
    for (const edge of ['setup\n', '\tsetup', 'setup\r\n']) {
      assert.equal(readStoreSetupPointer(repoWithPointer(JSON.stringify({ check: edge }))).check, null, JSON.stringify(edge));
    }
    // ...nor an over-cap value padded with whitespace.
    assert.equal(readStoreSetupPointer(repoWithPointer(JSON.stringify({ docs: 'x' + ' '.repeat(305) }))).docs, null);
    const long = readStoreSetupPointer(repoWithPointer(JSON.stringify({ docs: 'x'.repeat(301) })));
    assert.equal(long.docs, null);
  });
  it('an unreadable (non-ENOENT) file is reported, not treated as absent', () => {
    const p = readStoreSetupPointer('.', { readFileSync: () => { throw Object.assign(new Error('x'), { code: 'EACCES' }); } });
    assert.equal(p.present, true);
    assert.match(p.problems[0], /could not be read/);
  });
});

describe('renderStoreDetail', () => {
  const ptr = { present: true, check: 'pwsh setup.ps1 -DryRun', docs: 'tools/README.md', problems: [] };
  it('not reachable: prints the verdict, the cause and the pointer', () => {
    const d = renderStoreDetail(STORE_VERDICT.UNREACHABLE, ptr, { cause: 'unreachable' });
    assert.match(d, /store: configured-but-unreachable/);
    assert.match(d, /cause: unreachable/);
    assert.match(d, /setup check \(run it yourself\): pwsh setup\.ps1 -DryRun/);
    assert.match(d, /setup docs: tools\/README\.md/);
  });
  it('unconfigured: says local-only and prints the pointer', () => {
    const d = renderStoreDetail(STORE_VERDICT.UNCONFIGURED, ptr);
    assert.match(d, /unconfigured \(local-only\)/);
    assert.match(d, /setup docs/);
  });
  it('CONTROL — reachable prints no pointer even when one exists', () => {
    const d = renderStoreDetail(STORE_VERDICT.REACHABLE, ptr);
    assert.equal(d, 'store: reachable');
  });
  it('no pointer file: says a team can commit one', () => {
    assert.match(renderStoreDetail(STORE_VERDICT.UNREACHABLE, { present: false }), /can commit one/);
  });
});

describe('probeStoreReachability', () => {
  const noEnv = { loadEnv: () => ({}), injectResolvedDbEnv: () => {} };
  it('no pool (no DSN) is unconfigured', async () => {
    const r = await probeStoreReachability({ subjectRoot: '.', ...noEnv, importClient: async () => ({ getPool: async () => null, classifyDbConnectionError }) });
    assert.deepEqual(r, { configured: false });
  });
  it('a pool whose query answers is reachable', async () => {
    const r = await probeStoreReachability({ subjectRoot: '.', ...noEnv, importClient: async () => ({ getPool: async () => ({ query: async () => ({}) }), classifyDbConnectionError }) });
    assert.deepEqual(r, { configured: true, ok: true });
  });
  it('a refused connection is configured + not ok, with the real classified cause (no host, no DSN)', async () => {
    const err = Object.assign(new Error(''), { code: 'ECONNREFUSED' });
    const r = await probeStoreReachability({ subjectRoot: '.', ...noEnv, importClient: async () => ({ getPool: async () => ({ query: async () => { throw err; } }), classifyDbConnectionError }) });
    assert.equal(r.configured, true);
    assert.equal(r.ok, false);
    assert.equal(r.cause, 'unreachable');
  });
  it('a wedged connection attempt is bounded by the timeout', async () => {
    let closed = 0;
    const t0 = Date.now();
    const r = await probeStoreReachability({ subjectRoot: '.', ...noEnv, timeoutMs: 30, importClient: async () => ({ getPool: async () => ({ query: () => new Promise(() => {}) }), classifyDbConnectionError, closePool: async () => { closed++; } }) });
    assert.equal(r.ok, false);
    assert.equal(r.cause, 'unreachable');
    assert.ok(Date.now() - t0 < 2000, 'the verdict must arrive at the deadline, not at the stalled attempt');
    assert.equal(closed, 1, 'the abandoned attempt is torn down');
  });
  it('a teardown that itself never finishes cannot hold up the verdict', async () => {
    const t0 = Date.now();
    const r = await probeStoreReachability({
      subjectRoot: '.', ...noEnv, timeoutMs: 30, teardownTimeoutMs: 50,
      importClient: async () => ({
        getPool: async () => ({ query: () => new Promise(() => {}) }),
        classifyDbConnectionError,
        closePool: () => new Promise(() => {}),   // wedged exactly like the query
      }),
    });
    assert.equal(r.ok, false);
    assert.ok(Date.now() - t0 < 2000, 'verdict bounded by connect deadline + teardown deadline');
  });

  it('REAL client against a port nothing listens on: configured-but-unreachable', async () => {
    const port = await new Promise((resolve) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); }); });
    const saved = { url: process.env.AUDIT_DB_URL, ssl: process.env.AUDIT_DB_SSL_MODE };
    process.env.AUDIT_DB_URL = `postgresql://u:p@127.0.0.1:${port}/audit_loop`;
    process.env.AUDIT_DB_SSL_MODE = 'disable';
    try {
      const r = await probeStoreReachability({ subjectRoot: '.', ...noEnv, timeoutMs: 8000 });
      assert.equal(classifyStoreReachability(r), STORE_VERDICT.UNREACHABLE, JSON.stringify(r));
      assert.doesNotMatch(JSON.stringify(r), /127\.0\.0\.1|u:p/);
    } finally {
      if (saved.url === undefined) delete process.env.AUDIT_DB_URL; else process.env.AUDIT_DB_URL = saved.url;
      if (saved.ssl === undefined) delete process.env.AUDIT_DB_SSL_MODE; else process.env.AUDIT_DB_SSL_MODE = saved.ssl;
    }
  });
});

describe('machine/store-reachability probe', () => {
  const probe = REGISTRY.find((p) => p.id === 'machine/store-reachability');
  const ctxFor = (root, connect) => ({ subjectRoot: root, fs, probeStore: async () => connect });

  it('is registered, machine-class (never gates) and has an actionable fix', () => {
    assert.ok(probe, 'probe not registered');
    assert.equal(probe.class, 'machine');
    assert.ok(probe.fix.trim().length > 0);
    assert.ok(probeIds().includes('machine/store-reachability'));
  });

  it('reachable: pass', async () => {
    const r = await runProbe(probe, ctxFor(repoWithPointer(undefined), { configured: true, ok: true }));
    assert.equal(r.status, 'pass');
    assert.match(r.detail, /store: reachable/);
  });
  it('configured-but-unreachable: warn, with the committed pointer', async () => {
    const root = repoWithPointer('{"check":"pwsh setup.ps1 -DryRun","docs":"tools/README.md"}');
    const r = await runProbe(probe, ctxFor(root, { configured: true, ok: false, cause: 'unreachable' }));
    assert.equal(r.status, 'warn');
    assert.match(r.detail, /configured-but-unreachable/);
    assert.match(r.detail, /pwsh setup\.ps1 -DryRun/);
  });
  it('unconfigured: warn (not a silent pass), local-only said aloud', async () => {
    const r = await runProbe(probe, ctxFor(repoWithPointer(undefined), { configured: false }));
    assert.equal(r.status, 'warn');
    assert.match(r.detail, /unconfigured \(local-only\)/);
  });
});
