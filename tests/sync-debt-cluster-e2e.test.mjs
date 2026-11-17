/**
 * @fileoverview End-to-end proof for the sync debt cluster's consumer-IO cluster (C), driving the REAL CLI
 * against scratch consumers through `--target-path` (the single-target route; never a registry target).
 *
 *   3b96a5ef7971  bookkeeping writes bypassed containment -> nothing may land outside the consumer
 *   8fca02c6915a  an unreadable .gitignore read as "absent" -> it was REPLACED by the managed block
 *   d6003d6472e6  an unreadable/malformed receipt was overwritten; one sync at a time per consumer
 *
 * The parent behaviour is proven in the unit suites (tests/sync-consumer-io.test.mjs, sync-receipt-commit.test.mjs),
 * where a parent replay is possible without spawning old code; here every case asserts what the CLI does NOW, and
 * each one aborts BEFORE any payload is written, so none of them is a long run.
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { seedInstalledDeps, runSyncCli, whySyncFailed } from './helpers/consumer-fixture.mjs';

let tmp;
const rm = (p) => fs.rmSync(p, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
before(() => { tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ces-c-e2e-'))); });
after(() => rm(tmp));

function mkRepo(name) {
  const dir = path.join(tmp, name);
  fs.mkdirSync(path.join(dir, '.git'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name, type: 'module' }, null, 2));
  fs.writeFileSync(path.join(dir, '.gitignore'), '');
  seedInstalledDeps(dir);
  return dir;
}
const run = (dir, extra = []) => runSyncCli(['--target-path', dir, '--no-prompt', ...extra]);
const lockOf = (dir) => path.join(dir, 'scripts', '.claude-skills', '.sync.lock');
const link = (target, at) => fs.symlinkSync(target, at, process.platform === 'win32' ? 'junction' : 'dir');
const tree = (dir) => {
  const out = new Map();
  for (const rel of fs.readdirSync(dir, { recursive: true })) {
    const abs = path.join(dir, rel);
    if (rel.split(path.sep)[0] === 'node_modules' || rel.split(path.sep)[0] === '.git') continue;
    const st = fs.lstatSync(abs);
    out.set(String(rel).replaceAll('\\', '/'), st.isFile() ? crypto.createHash('sha256').update(fs.readFileSync(abs)).digest('hex') : 'dir');
  }
  return out;
};
const hasPayload = (dir) => fs.existsSync(path.join(dir, 'scripts', '.claude-skills', 'lib')) || fs.existsSync(path.join(dir, '.claude', 'skills'));

describe('a symlinked/junctioned tooling dir never lets a write land outside the consumer', () => {
  it('SKIPs the target, exits non-zero, and the outside directory stays EMPTY', async () => {
    const dir = mkRepo('junction');
    const outside = path.join(tmp, 'junction-outside');
    fs.mkdirSync(outside);
    fs.mkdirSync(path.join(dir, 'scripts'));
    link(outside, path.join(dir, 'scripts', '.claude-skills'));
    const r = await run(dir);
    assert.notEqual(r.code, 0, whySyncFailed(r));
    assert.match(r.out, /SKIP|ABORT|symlink|reparse/i);
    assert.deepEqual(fs.readdirSync(outside), [], 'nothing may be written through the link (the parent wrote the manifest there)');
    assert.equal(hasPayload(dir), false);
  });
});

describe('8fca02c6915a — an existing but unreadable .gitignore is never rebuilt from nothing', () => {
  it('ABORTs the target with the read failure named; the file is untouched and no payload was written', async () => {
    const dir = mkRepo('gitignore-unreadable');
    fs.unlinkSync(path.join(dir, '.gitignore'));
    fs.mkdirSync(path.join(dir, '.gitignore')); // EISDIR on read: deterministic on every platform, unlike chmod
    const r = await run(dir);
    assert.notEqual(r.code, 0, whySyncFailed(r));
    assert.match(r.out, /\.gitignore preflight: unreadable \(.*EISDIR|\.gitignore preflight: unreadable/);
    assert.match(r.out, /not treated as absent/);
    assert.equal(fs.statSync(path.join(dir, '.gitignore')).isDirectory(), true, 'the consumer\'s entry is untouched');
    assert.equal(hasPayload(dir), false, 'the abort comes BEFORE the write loop');
    assert.equal(fs.existsSync(lockOf(dir)), false, 'the lock taken for the run is released on the abort path');
  });
});

describe('d6003d6472e6 — a malformed receipt is the rollback guard\'s history: never replaced', () => {
  it('ABORTs, leaves the receipt byte-identical, writes no payload, and does not say "move it aside"', async () => {
    const dir = mkRepo('receipt-malformed');
    const conflicted = '<<<<<<< HEAD\n{"version":2}\n=======\n{"version":2,"x":1}\n>>>>>>> branch\n';
    fs.writeFileSync(path.join(dir, '.sync-receipt.json'), conflicted);
    const r = await run(dir);
    assert.notEqual(r.code, 0, whySyncFailed(r));
    assert.match(r.out, /\.sync-receipt\.json: malformed/);
    assert.doesNotMatch(r.out, /move (it|the file) aside/i);
    assert.equal(fs.readFileSync(path.join(dir, '.sync-receipt.json'), 'utf8'), conflicted);
    assert.equal(hasPayload(dir), false);
  });

  it('valid JSON that is not a receipt is refused too', async () => {
    const dir = mkRepo('receipt-notareceipt');
    fs.writeFileSync(path.join(dir, '.sync-receipt.json'), '{"hello":"world"}\n');
    const r = await run(dir);
    assert.notEqual(r.code, 0, whySyncFailed(r));
    assert.match(r.out, /not a receipt/);
    assert.equal(fs.readFileSync(path.join(dir, '.sync-receipt.json'), 'utf8'), '{"hello":"world"}\n');
  });
});

describe('the per-consumer lock', () => {
  it('a STALE lock (dead owner, old file) is recovered, the run proceeds to its abort, and the lock is gone afterwards', async () => {
    const dir = mkRepo('lock-stale');
    const lf = lockOf(dir);
    fs.mkdirSync(path.dirname(lf), { recursive: true });
    fs.writeFileSync(lf, JSON.stringify({ pid: 2 ** 22 + 4242, token: 'dead', acquiredAt: new Date(0).toISOString() }));
    const old = new Date(Date.now() - 10 * 60_000);
    fs.utimesSync(lf, old, old);
    fs.writeFileSync(path.join(dir, '.sync-receipt.json'), 'not json');
    const r = await run(dir);
    assert.match(r.out, /\.sync-receipt\.json: malformed/, 'the run got past lock acquisition to the receipt check');
    assert.equal(fs.existsSync(lf), false, 'finally{release} removed the lock on the abort path');
  });

  it('--dry-run takes NO lock and writes nothing: the consumer tree is byte-identical', async () => {
    const dir = mkRepo('dry-run');
    const before = tree(dir);
    const r = await run(dir, ['--dry-run']);
    assert.equal(r.code, 0, whySyncFailed(r));
    assert.deepEqual([...tree(dir)], [...before], 'a dry run must not touch the consumer, the lock file included');
    assert.equal(before.size > 0, true, 'vacuous-pass guard: the fixture is not empty');
  });

  it('a REAL sync leaves no lock file behind (the release is awaited before the process exits)', async () => {
    const dir = mkRepo('lock-released');
    const r = await run(dir);
    assert.equal(r.code, 0, whySyncFailed(r));
    assert.equal(hasPayload(dir), true, 'vacuous-pass guard: the sync really delivered');
    assert.equal(fs.existsSync(lockOf(dir)), false,
      'a lock left by a finished run makes the NEXT sync wait out the stale window on a dead owner');
    assert.equal(fs.existsSync(path.join(dir, '.sync-receipt.json')), true, 'and the receipt was committed');
  });
});
