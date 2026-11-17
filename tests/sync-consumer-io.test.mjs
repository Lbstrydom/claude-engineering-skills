/**
 * @fileoverview Debts 3b96a5ef7971 (bookkeeping writes bypassed containment) and
 * 8fca02c6915a (a failed read of `.gitignore`/`.gitattributes` read as "absent").
 *
 * Reads answer in four states and only `absent` means "no file"; every write and
 * remove is contained first. The symlink cases use directory JUNCTIONS on Windows
 * (no privilege needed) and symlinks elsewhere.
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  readConsumerFile, readConsumerJson, writeConsumerFile, removeConsumerFile, acquireConsumerLock,
} from '../scripts/lib/sync-consumer-io.mjs';
import { LAYOUT_CONSTANTS } from '../scripts/lib/sync-path-map.mjs';

let tmp;
const rm = (p) => fs.rmSync(p, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
before(() => { tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ces-cio-'))); });
after(() => rm(tmp));

/** A fresh consumer root plus an OUTSIDE directory a link can point at. */
function fixture(name) {
  const root = path.join(tmp, name, 'consumer');
  const outside = path.join(tmp, name, 'outside');
  fs.mkdirSync(root, { recursive: true });
  fs.mkdirSync(outside, { recursive: true });
  return { root, outside };
}
const link = (target, at) => fs.symlinkSync(target, at, process.platform === 'win32' ? 'junction' : 'dir');
const treeOf = (dir) => fs.readdirSync(dir, { recursive: true }).sort();

describe('readConsumerFile — four states, only `absent` means no file', () => {
  it('present: returns the text', () => {
    const { root } = fixture('present');
    fs.writeFileSync(path.join(root, '.gitignore'), 'node_modules\n');
    assert.deepEqual(readConsumerFile(root, '.gitignore'), { state: 'present', content: 'node_modules\n' });
  });

  it('absent: ENOENT on a contained path', () => {
    const { root } = fixture('absent');
    assert.deepEqual(readConsumerFile(root, '.gitignore'), { state: 'absent' });
  });

  it('unreadable: a DIRECTORY where the file should be (EISDIR) is NOT absent', () => {
    const { root } = fixture('eisdir');
    fs.mkdirSync(path.join(root, '.gitignore'));
    const r = readConsumerFile(root, '.gitignore');
    assert.equal(r.state, 'unreadable');
    assert.equal(r.code, 'EISDIR');
  });

  it('unreadable: an injected EACCES is NOT absent (red evidence: the parent catch folded this to null)', () => {
    const { root } = fixture('eacces');
    fs.writeFileSync(path.join(root, '.gitignore'), 'x');
    const parentRead = () => { try { throw Object.assign(new Error('denied'), { code: 'EACCES' }); } catch { return null; } };
    assert.equal(parentRead(), null, 'the parent read renders EACCES as an absent file');
    const r = readConsumerFile(root, '.gitignore', { read: () => { throw Object.assign(new Error('denied'), { code: 'EACCES' }); } });
    assert.deepEqual([r.state, r.code], ['unreadable', 'EACCES']);
  });

  it('refused: a symlinked ANCESTOR is refused, never read through', () => {
    const { root, outside } = fixture('anc');
    fs.writeFileSync(path.join(outside, 'secret.json'), '{"outside":true}');
    link(outside, path.join(root, 'scripts'));
    assert.equal(readConsumerFile(root, 'scripts/secret.json').state, 'refused');
  });

  it('refused: a DANGLING symlink leaf is refused (not "absent")', (t) => {
    const { root } = fixture('dangling');
    try { fs.symlinkSync(path.join(root, 'nowhere'), path.join(root, '.gitignore'), 'file'); } catch { return t.skip('cannot create a file symlink on this platform/user'); }
    assert.equal(readConsumerFile(root, '.gitignore').state, 'refused');
  });
});

describe('readConsumerJson', () => {
  it('parses; keeps absent distinct; reports malformed; passes refused through', () => {
    const { root } = fixture('json');
    assert.equal(readConsumerJson(root, 'a.json').state, 'absent');
    fs.writeFileSync(path.join(root, 'a.json'), '{"v":1}');
    assert.deepEqual(readConsumerJson(root, 'a.json').json, { v: 1 });
    fs.writeFileSync(path.join(root, 'a.json'), '<<<<<<< HEAD\n{}\n');
    assert.equal(readConsumerJson(root, 'a.json').state, 'malformed');
  });
});

describe('writeConsumerFile / removeConsumerFile — contained, and the outside is untouched', () => {
  it('writes (creating parents) and removes a contained file', () => {
    const { root } = fixture('rw');
    writeConsumerFile(root, 'scripts/deep/x.json', '{"a":1}\n');
    assert.equal(fs.readFileSync(path.join(root, 'scripts/deep/x.json'), 'utf8'), '{"a":1}\n');
    assert.deepEqual(removeConsumerFile(root, 'scripts/deep/x.json'), { state: 'removed' });
    assert.deepEqual(removeConsumerFile(root, 'scripts/deep/x.json'), { state: 'absent' });
  });

  it('a symlinked ancestor: the write THROWS and the outside directory is byte-unchanged', () => {
    const { root, outside } = fixture('wlink');
    link(outside, path.join(root, 'scripts'));
    const before = treeOf(outside);
    assert.throws(() => writeConsumerFile(root, 'scripts/.sync-manifest.json', '{}'), /symlink|reparse|escapes/i);
    assert.deepEqual(treeOf(outside), before, 'nothing may land outside the consumer');
    assert.deepEqual(before, [], 'vacuous-pass guard: the outside dir started empty');
  });

  it('a symlinked ancestor: remove is refused and the outside file survives', () => {
    const { root, outside } = fixture('rlink');
    fs.writeFileSync(path.join(outside, 'victim.json'), '{}');
    link(outside, path.join(root, 'scripts'));
    const r = removeConsumerFile(root, 'scripts/victim.json');
    assert.equal(r.state, 'failed');
    assert.match(r.reason, /refused/);
    assert.equal(fs.existsSync(path.join(outside, 'victim.json')), true);
  });

  it('an escaping relative path is refused', () => {
    const { root } = fixture('esc');
    assert.throws(() => writeConsumerFile(root, '../elsewhere.json', '{}'));
  });
});

describe('acquireConsumerLock — one sync at a time per consumer', () => {
  const lockFile = (root) => path.join(root, LAYOUT_CONSTANTS.SYNC_LOCK);

  it('a FIRST sync into a consumer with no scripts/.claude-skills/ yet still takes the lock', async () => {
    const { root } = fixture('lockfirst');
    assert.equal(fs.existsSync(path.join(root, 'scripts')), false, 'precondition: nothing exists yet');
    const held = await acquireConsumerLock(root);
    assert.equal(fs.existsSync(lockFile(root)), true);
    await held.release();
    assert.equal(fs.existsSync(lockFile(root)), false, 'released: the lock file is gone IMMEDIATELY (release is awaited)');
  });

  it('a second acquire while it is held times out; after release it succeeds', async () => {
    const { root } = fixture('lockcontend');
    const first = await acquireConsumerLock(root);
    await assert.rejects(acquireConsumerLock(root, { maxWaitMs: 150 }), (err) => err.code === 'LOCK_TIMEOUT');
    await first.release();
    const second = await acquireConsumerLock(root, { maxWaitMs: 1000 });
    await second.release();
  });

  it('the lock path is contained: a symlinked tooling dir is refused and nothing lands outside', async () => {
    const { root, outside } = fixture('lockref');
    fs.mkdirSync(path.join(root, 'scripts'));
    link(outside, path.join(root, 'scripts', '.claude-skills'));
    await assert.rejects(acquireConsumerLock(root), /symlink|reparse|escapes/i);
    assert.deepEqual(treeOf(outside), []);
  });

  it('a dead owner with an old lock file is recovered (the primitive\'s stale rule)', async () => {
    const { root } = fixture('lockstale');
    const lf = lockFile(root);
    fs.mkdirSync(path.dirname(lf), { recursive: true });
    fs.writeFileSync(lf, JSON.stringify({ pid: 2 ** 22 + 12345, token: 'dead', acquiredAt: new Date(0).toISOString() }));
    const old = new Date(Date.now() - 5 * 60_000);
    fs.utimesSync(lf, old, old);
    const held = await acquireConsumerLock(root, { maxWaitMs: 2000 });
    await held.release();
  });
});
