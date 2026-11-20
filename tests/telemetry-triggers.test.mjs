/**
 * @fileoverview Phase 3 of the telemetry path: the triggers and the doctor line.
 *
 *   - `telemetry-export --if-older-than <h>`: cheap to call from anywhere; a recent export means nothing is read
 *   - the weekly-maintenance check: opt-in on BOTH env names, so invisible to a consumer that never chose it
 *   - `machine/telemetry-export` (doctor): not configured is silence; configured, it says overdue / never /
 *     rejected / could-not-look as four DIFFERENT facts
 */
import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { buildExport } from '../scripts/lib/telemetry-export/build.mjs';
import { deliverExport } from '../scripts/lib/telemetry-export/deliver.mjs';
import { REGISTRY, runProbe } from '../scripts/lib/doctor/registry.mjs';
import { CHECKS, missingEnv } from '../scripts/maintenance-checks.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DAY = 86_400_000;
const roots = [];
afterEach(() => { for (const r of roots.splice(0)) fs.rmSync(r, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }); });
const tmp = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'tel-trig-')); roots.push(d); return d; };

const deps = () => ({
  reachability: async () => ({ configured: false }),
  drift: async () => ({ ok: false, reason: 'read-failed' }),
  readRows: async () => ({ status: 'repo-unresolved' }),
});
async function put(drop, { alias = 'acme', ageMs = 0 } = {}) {
  const doc = await buildExport({ now: new Date(Date.now() - ageMs), consumerAlias: alias, storeFingerprint: null, toolBundleSha: null, exportId: crypto.randomUUID(), deps: deps() });
  return deliverExport({ doc, dropDir: drop }).file;
}
const listFiles = (drop, alias = 'acme') => (fs.existsSync(path.join(drop, alias)) ? fs.readdirSync(path.join(drop, alias)) : []);

describe('telemetry-export --if-older-than', () => {
  const run = (args, env = {}) => spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'telemetry-export.mjs'), ...args], {
    cwd: ROOT, encoding: 'utf-8', timeout: 90000, windowsHide: true,
    env: { ...process.env, AUDIT_DB_URL: '', TELEMETRY_CONSUMER_ALIAS: '', TELEMETRY_DROP_DIR: '', TELEMETRY_EXPORT_PUSH: '', ...env },
  });
  const lastJson = (r) => JSON.parse(r.stdout.trim().split('\n').filter((l) => l.startsWith('{')).pop());

  it('a recent export for this alias means nothing is done: exit 0, no new file, no store read', async () => {
    const drop = tmp(); await put(drop, { ageMs: 2 * 3_600_000 });
    const r = run(['--alias', 'acme', '--drop-dir', drop, '--if-older-than', '24']);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(lastJson(r).skipped, 'recent-export');
    assert.equal(listFiles(drop).length, 1);
  });

  it('CONTROL — an older export does not skip: a new one is written', async () => {
    const drop = tmp(); await put(drop, { ageMs: 30 * 3_600_000 });
    const r = run(['--alias', 'acme', '--drop-dir', drop, '--if-older-than', '24']);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(lastJson(r).ok, true);
    assert.equal(listFiles(drop).length, 2);
  });

  it('CONTROL — no prior export at all: it writes one', () => {
    const drop = tmp();
    const r = run(['--alias', 'acme', '--drop-dir', drop, '--if-older-than', '24']);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(listFiles(drop).length, 1);
  });

  it("another alias's recent export does not satisfy this alias", async () => {
    const drop = tmp(); await put(drop, { alias: 'someone-else', ageMs: 1000 });
    const r = run(['--alias', 'acme', '--drop-dir', drop, '--if-older-than', '24']);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(listFiles(drop).length, 1);
  });

  it('a bad threshold is a usage error (exit 2) and writes nothing', () => {
    const drop = tmp();
    for (const v of ['0', '-3', 'abc', '']) assert.equal(run(['--alias', 'acme', '--drop-dir', drop, '--if-older-than', v]).status, 2, v);
    assert.deepEqual(listFiles(drop), []);
  });

  it('TELEMETRY_EXPORT_PUSH=1 is --push: a drop that is not a git root is refused BEFORE anything is published', () => {
    const drop = tmp();
    const r = run(['--alias', 'acme', '--drop-dir', drop], { TELEMETRY_EXPORT_PUSH: '1' });
    assert.equal(r.status, 1);
    assert.deepEqual(listFiles(drop), []);
  });
});

describe('the weekly-maintenance check', () => {
  const check = CHECKS.find((c) => c.key === 'telemetry-export');

  it('is registered, runs the exporter with the 24h throttle, and needs BOTH opt-in names', () => {
    assert.ok(check);
    assert.deepEqual(check.requiredEnv, ['TELEMETRY_CONSUMER_ALIAS', 'TELEMETRY_DROP_DIR']);
    assert.deepEqual(check.steps, [{ script: 'telemetry-export.mjs', args: ['--if-older-than', '24'] }]);
  });

  it('is skipped (never attempted) unless both are set', () => {
    const KEYS = ['TELEMETRY_CONSUMER_ALIAS', 'TELEMETRY_DROP_DIR'];
    const saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
    const setEnv = (e) => { for (const k of KEYS) delete process.env[k]; Object.assign(process.env, e); };
    try {
      setEnv({});
      assert.deepEqual(missingEnv(check.requiredEnv), ['TELEMETRY_CONSUMER_ALIAS', 'TELEMETRY_DROP_DIR']);
      setEnv({ TELEMETRY_CONSUMER_ALIAS: 'a' });
      assert.deepEqual(missingEnv(check.requiredEnv), ['TELEMETRY_DROP_DIR']);
      setEnv({ TELEMETRY_CONSUMER_ALIAS: 'a', TELEMETRY_DROP_DIR: '/d' });
      assert.deepEqual(missingEnv(check.requiredEnv), []);
    } finally {
      for (const k of KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
    }
  });
});

describe('doctor: machine/telemetry-export', () => {
  const probe = REGISTRY.find((p) => p.id === 'machine/telemetry-export');
  const KEYS = ['TELEMETRY_CONSUMER_ALIAS', 'TELEMETRY_DROP_DIR'];
  const withEnv = async (env, fn) => {
    const saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
    for (const k of KEYS) delete process.env[k];
    Object.assign(process.env, env);
    try { return await fn(); } finally { for (const k of KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; } }
  };
  const ctx = () => ({ subjectRoot: tmp(), fs });
  const go = (env) => withEnv(env, () => runProbe(probe, ctx()));

  it('is registered as a machine probe (never gates) with an actionable fix', () => {
    assert.ok(probe);
    assert.equal(probe.class, 'machine');
    assert.ok(probe.fix.trim());
  });

  it('not configured: not_applicable — silence is correct for an opt-in feature', async () => {
    assert.equal((await go({})).status, 'not_applicable');
  });

  it('half-configured is a warning that names the missing half', async () => {
    const a = await go({ TELEMETRY_CONSUMER_ALIAS: 'acme' });
    assert.equal(a.status, 'warn');
    assert.match(a.detail, /TELEMETRY_DROP_DIR is missing/);
    const b = await go({ TELEMETRY_DROP_DIR: tmp() });
    assert.match(b.detail, /TELEMETRY_CONSUMER_ALIAS is missing/);
  });

  it('a fresh export passes', async () => {
    const drop = tmp(); await put(drop, { ageMs: 2 * DAY });
    const r = await go({ TELEMETRY_CONSUMER_ALIAS: 'acme', TELEMETRY_DROP_DIR: drop });
    assert.equal(r.status, 'pass');
    assert.match(r.detail, /last export 2 day/);
  });

  it('exactly 8 days is still within weekly-plus-grace; just past it is overdue', async () => {
    const d1 = tmp(); await put(d1, { ageMs: 8 * DAY - 60_000 });
    assert.equal((await go({ TELEMETRY_CONSUMER_ALIAS: 'acme', TELEMETRY_DROP_DIR: d1 })).status, 'pass');
    const d2 = tmp(); await put(d2, { ageMs: 8 * DAY + 3_600_000 });
    const r = await go({ TELEMETRY_CONSUMER_ALIAS: 'acme', TELEMETRY_DROP_DIR: d2 });
    assert.equal(r.status, 'warn');
    assert.match(r.detail, /export overdue/);
  });

  it('never exported, only-rejected and could-not-look are three DIFFERENT warnings (none says overdue)', async () => {
    const empty = await go({ TELEMETRY_CONSUMER_ALIAS: 'acme', TELEMETRY_DROP_DIR: tmp() });
    assert.match(empty.detail, /no export has ever been written/);

    const bad = tmp(); fs.mkdirSync(path.join(bad, 'acme'));
    fs.writeFileSync(path.join(bad, 'acme', '2026-11-19-0b9c1f3e-6d1a-4b6e-8a53-3f5a2f1c9d77.json'), '{nope');
    const rej = await go({ TELEMETRY_CONSUMER_ALIAS: 'acme', TELEMETRY_DROP_DIR: bad });
    assert.match(rej.detail, /only rejected files found \(newest: not-json\)/);

    const unreadable = await go({ TELEMETRY_CONSUMER_ALIAS: 'acme', TELEMETRY_DROP_DIR: path.join(tmp(), 'nope') });
    assert.match(unreadable.detail, /could not read the drop directory/);
    assert.match(unreadable.detail, /unknown, not overdue/);
    for (const r of [empty, rej, unreadable]) { assert.equal(r.status, 'warn'); assert.doesNotMatch(r.detail, /export overdue/); }
  });

  it("another alias's fresh export does not make this alias healthy", async () => {
    const drop = tmp(); await put(drop, { alias: 'someone-else', ageMs: 1000 });
    const r = await go({ TELEMETRY_CONSUMER_ALIAS: 'acme', TELEMETRY_DROP_DIR: drop });
    assert.match(r.detail, /no export has ever been written/);
  });
});

describe('throttle audit round 1: it must really read nothing, deliver what is pending, and not trust the clock blindly', () => {
  const run = (args, env = {}) => spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'telemetry-export.mjs'), ...args], {
    cwd: ROOT, encoding: 'utf-8', timeout: 90000, windowsHide: true,
    env: {
      ...process.env, AUDIT_DB_URL: '', TELEMETRY_CONSUMER_ALIAS: '', TELEMETRY_DROP_DIR: '', TELEMETRY_EXPORT_PUSH: '',
      GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.test', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.test', ...env,
    },
  });
  const lastJson = (r) => JSON.parse(r.stdout.trim().split('\n').filter((l) => l.startsWith('{')).pop());
  const git = (cwd, ...a) => spawnSync('git', a, { cwd, encoding: 'utf-8', windowsHide: true }).stdout.trim();

  /**
   * ASYNC runner for the counting-store test: `spawnSync` blocks this process's event loop, so a TCP server living in
   * the same process could not even ACCEPT the child's connection while it ran, and the count would read 0 for a
   * child that did connect. (A control that cannot see a connection proves nothing.)
   */
  const runAsync = (args, env) => new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(ROOT, 'scripts', 'telemetry-export.mjs'), ...args], {
      cwd: ROOT, windowsHide: true, env: { ...process.env, TELEMETRY_CONSUMER_ALIAS: '', TELEMETRY_DROP_DIR: '', TELEMETRY_EXPORT_PUSH: '', ...env },
    });
    let stdout = ''; let stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('close', (status) => resolve({ status, stdout, stderr }));
  });

  /** A TCP listener that counts connections: the observable store boundary. */
  async function countingStore() {
    const conns = { n: 0 };
    const server = net.createServer((s) => { conns.n++; s.destroy(); });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    return { conns, port: server.address().port, close: () => new Promise((r) => server.close(r)) };
  }

  it('a skipped run makes NO connection to the store; a real run does (the boundary is observable)', async () => {
    const store = await countingStore();
    const env = { AUDIT_DB_URL: `postgresql://u:p@127.0.0.1:${store.port}/audit_loop`, AUDIT_DB_SSL_MODE: 'disable' };
    try {
      const recent = tmp(); await put(recent, { ageMs: 2 * 3_600_000 });
      const skipped = await runAsync(['--alias', 'acme', '--drop-dir', recent, '--if-older-than', '24'], env);
      assert.equal(skipped.status, 0, skipped.stderr);
      assert.equal(lastJson(skipped).skipped, 'recent-export');
      assert.equal(store.conns.n, 0, 'the skip path touched the store');

      const empty = tmp();
      const ran = await runAsync(['--alias', 'acme', '--drop-dir', empty, '--if-older-than', '24'], env);
      assert.equal(ran.status, 0, ran.stderr);
      assert.ok(store.conns.n > 0, 'CONTROL: a real run reaches the store');
    } finally { await store.close(); }
  });

  it('--print and --if-older-than together are a usage error (printing is never throttled)', () => {
    assert.equal(run(['--alias', 'acme', '--print', '--if-older-than', '24']).status, 2);
  });

  it('a FUTURE-dated export (within the reader\'s clock-skew tolerance) does not throttle', async () => {
    const drop = tmp(); await put(drop, { ageMs: -3 * 3_600_000 });
    const r = run(['--alias', 'acme', '--drop-dir', drop, '--if-older-than', '24']);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(lastJson(r).ok, true);
    assert.equal('skipped' in lastJson(r), false);
    assert.equal(listFiles(drop).length, 2);
  });

  describe('with --push: a recent FILE is not a delivered export', () => {
    function gitDrop() {
      const base = tmp();
      const remote = path.join(base, 'remote.git');
      spawnSync('git', ['init', '-q', '--bare', remote], { windowsHide: true });
      const drop = path.join(base, 'drop');
      spawnSync('git', ['clone', '-q', remote, drop], { windowsHide: true });
      fs.writeFileSync(path.join(drop, 'README'), 'x');
      git(drop, 'add', '.'); git(drop, '-c', 'user.name=t', '-c', 'user.email=t@example.test', 'commit', '-q', '-m', 'init');
      git(drop, 'push', '-q', '-u', 'origin', 'HEAD');
      return { remote, drop };
    }
    const pushEnv = { TELEMETRY_EXPORT_PUSH: '1' };

    it('an UNCOMMITTED recent export is delivered, then the run skips', async () => {
      const { remote, drop } = gitDrop();
      await put(drop, { ageMs: 3_600_000 });   // written earlier, push never happened
      assert.equal(git(remote, 'log', '--oneline', '--all').split('\n').length, 1);
      const r = run(['--alias', 'acme', '--drop-dir', drop, '--if-older-than', '24'], pushEnv);
      assert.equal(r.status, 0, r.stderr);
      assert.equal(lastJson(r).skipped, 'recent-export');
      assert.match(git(remote, 'log', '--oneline', '--all'), /retry of an undelivered export/);
    });

    it('a COMMITTED-BUT-UNPUSHED export is NOT pushed on the exporter\'s behalf: reported (exit 1), remote unchanged', async () => {
      const { remote, drop } = gitDrop();
      await put(drop, { ageMs: 3_600_000 });
      git(drop, 'add', '.'); git(drop, '-c', 'user.name=t', '-c', 'user.email=t@example.test', 'commit', '-q', '-m', 'local only');
      const before = git(remote, 'rev-list', '--all', '--count');
      const r = run(['--alias', 'acme', '--drop-dir', drop, '--if-older-than', '24'], pushEnv);
      assert.equal(r.status, 1);
      assert.match(r.stderr, /committed but not pushed/);
      assert.equal(git(remote, 'rev-list', '--all', '--count'), before);
    });

    it('a FRESH export on top of unpushed history is refused BEFORE it is written (a push would publish the ancestors too)', async () => {
      const { remote, drop } = gitDrop();
      fs.mkdirSync(path.join(drop, 'acme'));
      fs.writeFileSync(path.join(drop, 'other.txt'), 'unrelated unpushed work');
      git(drop, 'add', '.'); git(drop, '-c', 'user.name=t', '-c', 'user.email=t@example.test', 'commit', '-q', '-m', 'unrelated');
      const before = git(remote, 'rev-list', '--all', '--count');
      const r = run(['--alias', 'acme', '--drop-dir', drop], pushEnv);
      assert.equal(r.status, 1);
      assert.match(r.stderr, /committed but not pushed/);
      assert.deepEqual(fs.readdirSync(path.join(drop, 'acme')), [], 'no export was written');
      assert.equal(git(remote, 'rev-list', '--all', '--count'), before);
    });

    it('CONTROL — nothing pending: it skips and makes no commit', async () => {
      const { remote, drop } = gitDrop();
      await put(drop, { ageMs: 3_600_000 });
      git(drop, 'add', '.'); git(drop, '-c', 'user.name=t', '-c', 'user.email=t@example.test', 'commit', '-q', '-m', 'delivered');
      git(drop, 'push', '-q');
      const before = git(remote, 'rev-list', '--all', '--count');
      const r = run(['--alias', 'acme', '--drop-dir', drop, '--if-older-than', '24'], pushEnv);
      assert.equal(r.status, 0, r.stderr);
      assert.equal(git(remote, 'rev-list', '--all', '--count'), before);
    });

    it('a stray file beside the export is NEVER swept into the commit: the retry stops, nothing staged, remote unchanged', async () => {
      const { remote, drop } = gitDrop();
      await put(drop, { ageMs: 3_600_000 });
      fs.writeFileSync(path.join(drop, 'acme', 'notes.txt'), 'internal hostname db.corp.example');
      const before = git(remote, 'rev-list', '--all', '--count');
      const r = run(['--alias', 'acme', '--drop-dir', drop, '--if-older-than', '24'], pushEnv);
      assert.equal(r.status, 1);
      assert.match(r.stderr, /not a telemetry export/);
      assert.equal(git(remote, 'rev-list', '--all', '--count'), before);
      assert.equal(git(drop, 'diff', '--cached', '--name-only'), '', 'nothing was staged');
    });

    it('a hand-edited export (right name, fails the schema) is never pushed: it is not "recent", so a fresh valid one is written and only IT is delivered', async () => {
      const { remote, drop } = gitDrop();
      const file = await put(drop, { ageMs: 3_600_000 });
      const doc = JSON.parse(fs.readFileSync(file, 'utf8'));
      doc.repoName = 'acme-secret-repo';
      fs.writeFileSync(file, JSON.stringify(doc));
      const r = run(['--alias', 'acme', '--drop-dir', drop, '--if-older-than', '24'], pushEnv);
      assert.equal(r.status, 0, r.stderr);
      const pushed = git(remote, 'ls-tree', '-r', '--name-only', 'HEAD').split('\n');
      assert.equal(pushed.some((n) => n.endsWith(path.basename(file))), false, 'the tampered file reached the remote');
      assert.equal(pushed.filter((n) => n.startsWith('acme/')).length, 1, 'only the fresh valid export was delivered');
    });

    it('an unpushed commit that touches anything at all is not pushed on the exporter\'s behalf', async () => {
      const { remote, drop } = gitDrop();
      await put(drop, { ageMs: 3_600_000 });
      git(drop, 'add', '.'); git(drop, '-c', 'user.name=t', '-c', 'user.email=t@example.test', 'commit', '-q', '-m', 'exports');
      git(drop, 'push', '-q');
      fs.writeFileSync(path.join(drop, 'other.txt'), 'unrelated');
      git(drop, 'add', '.'); git(drop, '-c', 'user.name=t', '-c', 'user.email=t@example.test', 'commit', '-q', '-m', 'unrelated work');
      const before = git(remote, 'rev-list', '--all', '--count');
      const r = run(['--alias', 'acme', '--drop-dir', drop, '--if-older-than', '24'], pushEnv);
      assert.equal(r.status, 1);
      assert.match(r.stderr, /committed but not pushed/);
      assert.equal(git(remote, 'rev-list', '--all', '--count'), before);
    });

    it('no upstream is an UNKNOWN delivery state, reported — not assumed to mean nothing is pending', async () => {
      const base = tmp();
      const drop = path.join(base, 'drop');
      fs.mkdirSync(drop);
      spawnSync('git', ['init', '-q', drop], { windowsHide: true });
      await put(drop, { ageMs: 3_600_000 });
      git(drop, 'add', '.'); git(drop, '-c', 'user.name=t', '-c', 'user.email=t@example.test', 'commit', '-q', '-m', 'exports');
      const r = run(['--alias', 'acme', '--drop-dir', drop, '--if-older-than', '24'], pushEnv);
      assert.equal(r.status, 1);
      assert.match(r.stderr, /cannot tell whether earlier exports were pushed/);
    });

    it('a staged RENAME in the alias directory is refused (its second path must never be parsed as an export)', async () => {
      const { remote, drop } = gitDrop();
      const file = await put(drop, { ageMs: 3_600_000 });
      git(drop, 'add', '.'); git(drop, '-c', 'user.name=t', '-c', 'user.email=t@example.test', 'commit', '-q', '-m', 'exports'); git(drop, 'push', '-q');
      fs.renameSync(file, path.join(path.dirname(file), '2026-01-01-1b9c1f3e-6d1a-4b6e-8a53-3f5a2f1c9d77.json'));
      git(drop, 'add', '-A');
      const before = git(remote, 'rev-list', '--all', '--count');
      const r = run(['--alias', 'acme', '--drop-dir', drop, '--if-older-than', '24'], pushEnv);
      assert.equal(r.status, 1);
      assert.match(r.stderr, /rename or copy is staged/);
      assert.equal(git(remote, 'rev-list', '--all', '--count'), before);
    });

    it('a push that fails after the exporter committed leaves NO unpushed commit behind: its own commit is undone, the file stays for the next attempt', async () => {
      const { remote, drop } = gitDrop();
      await put(drop, { ageMs: 3_600_000 });
      const headBefore = git(drop, 'rev-parse', 'HEAD');
      // The remote is reachable and the gate passes, but it REJECTS the push: the failure happens after our commit.
      fs.writeFileSync(path.join(remote, 'hooks', 'pre-receive'), '#!/bin/sh\nexit 1\n', { mode: 0o755 });
      const r = run(['--alias', 'acme', '--drop-dir', drop, '--if-older-than', '24'], pushEnv);
      assert.equal(r.status, 1);
      assert.equal(git(drop, 'rev-parse', 'HEAD'), headBefore, 'HEAD is back where it was');
      assert.match(git(drop, 'status', '--porcelain', '-uall'), /\?\? acme\/.*\.json/, 'the validated file is still there, uncommitted');
    });

    it('a separate push URL, a custom fetch refspec and an ignoring .gitignore each REFUSE (a drop must be a plain clone)', async () => {
      for (const [prep, re] of [
        [(drop) => git(drop, 'config', 'remote.origin.pushurl', 'ssh://elsewhere.example.test/drop.git'), /pushes somewhere other than where it fetches/],
        [(drop) => git(drop, 'config', 'remote.origin.fetch', '+refs/heads/main:refs/remotes/origin/other'), /default fetch refspec|cannot tell whether earlier exports were pushed/],   // a remapped refspec usually breaks the upstream lookup first: refused either way
        [(drop) => { fs.writeFileSync(path.join(drop, '.gitignore'), '*.json\n'); git(drop, 'add', '.gitignore'); git(drop, '-c', 'user.name=t', '-c', 'user.email=t@example.test', 'commit', '-q', '-m', 'ignore'); git(drop, 'push', '-q'); }, /ignores exports of this name/],
      ]) {
        const { drop } = gitDrop();
        prep(drop);
        const r = run(['--alias', 'acme', '--drop-dir', drop], pushEnv);
        assert.equal(r.status, 1, r.stdout);
        assert.match(r.stderr, re);
        assert.equal(fs.existsSync(path.join(drop, 'acme')), false, 'nothing was written');
      }
    });

    it('a failing delivery of the earlier export is REPORTED (exit 1), not skipped over', async () => {
      const { remote, drop } = gitDrop();
      await put(drop, { ageMs: 3_600_000 });
      fs.rmSync(remote, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });   // the remote is gone: push must fail
      const r = run(['--alias', 'acme', '--drop-dir', drop, '--if-older-than', '24'], pushEnv);
      assert.equal(r.status, 1);
      assert.match(r.stderr, /earlier export could not be delivered/);
    });
  });
});

describe('doctor: configuration semantics (audit round 1)', () => {
  const probe = REGISTRY.find((p) => p.id === 'machine/telemetry-export');
  const KEYS = ['TELEMETRY_CONSUMER_ALIAS', 'TELEMETRY_DROP_DIR'];
  const clean = async (fn) => {
    const saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
    for (const k of KEYS) delete process.env[k];
    try { return await fn(); } finally { for (const k of KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; } }
  };

  it('a RELATIVE drop path in the subject\'s own .env resolves against the subject root, not the doctor\'s cwd', async () => {
    const subject = tmp();
    fs.mkdirSync(path.join(subject, 'drop'));
    const doc = await buildExport({ now: new Date(Date.now() - DAY), consumerAlias: 'acme', storeFingerprint: null, toolBundleSha: null, exportId: crypto.randomUUID(), deps: deps() });
    deliverExport({ doc, dropDir: path.join(subject, 'drop') });
    fs.writeFileSync(path.join(subject, '.env'), 'TELEMETRY_CONSUMER_ALIAS=acme\nTELEMETRY_DROP_DIR=drop\n');
    const r = await clean(() => runProbe(probe, { subjectRoot: subject, fs }));
    assert.equal(r.status, 'pass', r.detail);
  });

  it('a state the probe does not know is UNKNOWN, never waved through as healthy', async () => {
    const stub = () => ({ scanError: null, aliases: [{ state: 'something-new', generatedAt: 'not-a-date' }] });
    const r = await clean(() => {
      process.env.TELEMETRY_CONSUMER_ALIAS = 'acme'; process.env.TELEMETRY_DROP_DIR = tmp();
      return runProbe(probe, { subjectRoot: tmp(), fs, scanTelemetryDrop: stub });
    });
    assert.equal(r.status, 'unknown');
    assert.match(r.detail, /could not judge/);
  });
});
