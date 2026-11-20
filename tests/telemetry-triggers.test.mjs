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
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
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
