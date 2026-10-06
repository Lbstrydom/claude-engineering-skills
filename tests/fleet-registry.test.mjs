/**
 * @fileoverview /fleet Phase 3 — the registry. Throwaway repos and dirs; one
 * test per hazard: storage-key collisions, id/hash mismatch, a corrupted record,
 * a stale rev, a concurrent claim race between two real processes, liveness
 * against real commit times, train-id confinement and write-once manifests.
 */
import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { git } from './helpers/git.mjs';
import {
  storageKey, fleetDir, readSessions, writeSession, transact, quarantine, readHold, writeHold,
  newTrainId, assertTrainId, assertManaged, trainPath, readTrain, writeTrain, listTrains,
  SessionSchema, RegistryError, TRAIN_ID_RE,
} from '../scripts/lib/fleet/registry.mjs';
import { decideClaim, liveness, buildStatus } from '../scripts/lib/fleet/overlap.mjs';
import { tipCommitTime } from '../scripts/lib/fleet/git-facts.mjs';

const roots = [];
const mk = (prefix) => { const d = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), prefix))); roots.push(d); return d; };
after(() => { for (const d of roots) fs.rmSync(d, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }); });

const NOW = Date.parse('2026-10-05T12:00:00.000Z');
const iso = (ms) => new Date(ms).toISOString();
const OID = (c) => c.repeat(40);

function rec(id, over = {}) {
  return {
    schemaVersion: 1, rev: 1, id,
    source: { kind: 'branch', branch: id, repo: null, prNumber: null, headRepo: null, headRef: id, baseRef: 'main' },
    worktree: null, intent: `work on ${id}`, paths: [], state: 'working', gen: 1, startOid: OID('0'),
    waitingOn: [], ready: null, knownOverlaps: [],
    leaseExpiresAt: iso(NOW + 3_600_000), updatedAt: iso(NOW), createdAt: iso(NOW), ...over,
  };
}
const freshDir = () => path.join(mk('fleet-reg-'), 'fleet');
const sessionFile = (dir, id) => path.join(dir, 'sessions', `${storageKey(id)}.json`);

describe('storage key', () => {
  it('is readable prefix + 12 hex of sha256(id), prefix <= 40 chars', () => {
    const k = storageKey('feat/csv-export');
    assert.equal(k, `feat-csv-export-${crypto.createHash('sha256').update('feat/csv-export').digest('hex').slice(0, 12)}`);
    const long = storageKey('x'.repeat(100));
    assert.match(long, /^x{40}-[0-9a-f]{12}$/);
    assert.match(storageKey('///'), /^session-[0-9a-f]{12}$/);
  });
  it('feat/a vs feat-a, and Feat/A vs feat/a, never share a file', () => {
    const keys = ['feat/a', 'feat-a', 'Feat/A', 'feat/a ', 'FEAT-A'].map(storageKey);
    assert.equal(new Set(keys).size, keys.length);
    assert.equal(new Set(keys.map((k) => k.toLowerCase())).size, keys.length, 'distinct even on a case-insensitive filesystem');
  });
  it('ids sharing a 40+ char prefix stay distinct (hash decides)', () => {
    const a = `${'p'.repeat(45)}-one`; const b = `${'p'.repeat(45)}-two`;
    assert.notEqual(storageKey(a), storageKey(b));
  });
  it('colliding-looking ids coexist in the registry', () => {
    const dir = freshDir();
    const r = transact(dir, (ctx) => { for (const id of ['feat/a', 'feat-a', 'Feat/A']) ctx.writeSession(rec(id)); });
    assert.equal(r.ok, true);
    const read = readSessions(dir);
    assert.equal(read.complete, true);
    assert.deepEqual(read.sessions.map((s) => s.id).sort(), ['Feat/A', 'feat-a', 'feat/a']);
  });
  it('rejects an empty id', () => { assert.throws(() => storageKey(''), RegistryError); });
});

describe('reads never skip silently', () => {
  it('id/hash mismatch is invalid: a record copied under another id\'s filename', () => {
    const dir = freshDir();
    transact(dir, (ctx) => { ctx.writeSession(rec('feat/a')); });
    fs.copyFileSync(sessionFile(dir, 'feat/a'), sessionFile(dir, 'feat/b'));
    const read = readSessions(dir);
    assert.equal(read.complete, false);
    assert.equal(read.sessions.length, 1);
    assert.equal(read.invalid.length, 1);
    assert.match(read.invalid[0].reason, /does not hash to this filename/);
  });
  it('a hand-edited embedded id is invalid', () => {
    const dir = freshDir();
    transact(dir, (ctx) => { ctx.writeSession(rec('feat/a')); });
    const f = sessionFile(dir, 'feat/a');
    fs.writeFileSync(f, fs.readFileSync(f, 'utf-8').replace('"id": "feat/a"', '"id": "feat/evil"'));
    const read = readSessions(dir);
    assert.equal(read.complete, false);
    assert.match(read.invalid[0].reason, /does not hash/);
  });
  it('malformed JSON, schema violations, unknown fields and stray files => complete:false', () => {
    const dir = freshDir();
    transact(dir, (ctx) => { ctx.writeSession(rec('ok')); });
    const sd = path.join(dir, 'sessions');
    fs.writeFileSync(path.join(sd, 'broken.json'), '{ nope');
    fs.writeFileSync(path.join(sd, `${storageKey('x')}.json`), JSON.stringify({ ...rec('x'), extra: 1 }));
    fs.writeFileSync(path.join(sd, 'notes.txt'), 'hi');
    fs.writeFileSync(path.join(sd, '.tmp-123-456'), 'leftover from an atomic write'); // ignored, not invalid
    const read = readSessions(dir);
    assert.equal(read.complete, false);
    assert.equal(read.sessions.length, 1);
    assert.deepEqual(read.invalid.map((i) => i.file).sort(), [`${storageKey('x')}.json`, 'broken.json', 'notes.txt'].sort());
  });
  it('a corrupted LIVE claim makes admission refuse until quarantined; the file is moved, never deleted', () => {
    const dir = freshDir();
    transact(dir, (ctx) => { ctx.writeSession(rec('feat/live', { paths: ['src/**'] })); });
    const f = sessionFile(dir, 'feat/live');
    fs.writeFileSync(f, '{ corrupted');
    const claim = { id: 'feat/new', intent: 'z', paths: ['src/a.mjs'] };
    const admit = () => transact(dir, (ctx) => decideClaim({ claim, mode: 'new', others: ctx.sessions.map((s) => ({ session: s, live: true })), complete: ctx.complete })).value;
    const refused = admit();
    assert.deepEqual([refused.ok, refused.verdict], [false, 'refused']);
    assert.equal(quarantine(dir, 'nope.json').ok, false);
    assert.equal(quarantine(dir, '../hold.json').ok, false);
    const q = quarantine(dir, path.basename(f));
    assert.equal(q.ok, true);
    assert.equal(fs.readFileSync(q.to, 'utf-8'), '{ corrupted', 'content preserved');
    assert.equal(admit().verdict, 'ok');
  });
  it('a missing registry is complete and empty', () => {
    assert.deepEqual(readSessions(path.join(mk('fleet-none-'), 'fleet')), { sessions: [], invalid: [], complete: true });
  });
});

describe('transactions', () => {
  it('atomic round-trip leaves no temp files', () => {
    const dir = freshDir();
    const r = transact(dir, (ctx) => { ctx.writeSession(rec('a')); return 42; });
    assert.deepEqual(r, { ok: true, value: 42 });
    assert.equal(fs.readdirSync(path.join(dir, 'sessions')).some((n) => n.startsWith('.tmp-')), false);
    assert.equal(fs.existsSync(path.join(dir, '.lock')), false, 'lock released');
  });
  it('a stale writer is refused by the rev check (equal and lower rev)', () => {
    const dir = freshDir();
    transact(dir, (ctx) => { ctx.writeSession(rec('a', { rev: 1 })); });
    transact(dir, (ctx) => { ctx.writeSession(rec('a', { rev: 2, intent: 'newer' })); });
    for (const rev of [1, 2]) {
      assert.throws(() => transact(dir, (ctx) => { ctx.writeSession(rec('a', { rev, intent: 'stale writer' })); }), (e) => e.code === 'REV_STALE');
    }
    assert.equal(readSessions(dir).sessions[0].intent, 'newer');
    transact(dir, (ctx) => { ctx.writeSession(rec('a', { rev: 3, intent: 'newest' })); });
    assert.equal(readSessions(dir).sessions[0].rev, 3);
  });
  it('a throw inside releases the lock', () => {
    const dir = freshDir();
    assert.throws(() => transact(dir, () => { throw new Error('boom'); }), /boom/);
    assert.equal(transact(dir, () => 'again').ok, true);
  });
  it('the transaction re-reads inside the lock (sees a record written meanwhile)', () => {
    const dir = freshDir();
    transact(dir, (ctx) => { ctx.writeSession(rec('a')); });
    const seen = transact(dir, (ctx) => ctx.sessions.map((s) => s.id)).value;
    assert.deepEqual(seen, ['a']);
  });
  it('an unreadable record at the target is never overwritten', () => {
    const dir = freshDir();
    transact(dir, (ctx) => { ctx.writeSession(rec('a')); });
    fs.writeFileSync(sessionFile(dir, 'a'), 'garbage');
    assert.throws(() => writeSession(dir, rec('a', { rev: 9 })), (e) => e.code === 'TARGET_INVALID'
      && e.repairFile === path.basename(sessionFile(dir, 'a')) && !/fleet repair/.test(e.message),
    'the library names the file; the CLI entry point renders the exact repair command');
    assert.equal(fs.readFileSync(sessionFile(dir, 'a'), 'utf-8'), 'garbage');
  });

  it('two concurrent claims for overlapping NEW sessions: exactly one admitted, one blocked', async () => {
    const regUrl = pathToFileURL(path.resolve('scripts/lib/fleet/registry.mjs')).href;
    const ovUrl = pathToFileURL(path.resolve('scripts/lib/fleet/overlap.mjs')).href;
    const work = mk('fleet-race-');
    const child = path.join(work, 'child.mjs');
    fs.writeFileSync(child, `
      import fs from 'node:fs';
      import { transact } from ${JSON.stringify(regUrl)};
      import { decideClaim } from ${JSON.stringify(ovUrl)};
      const [, , dir, id, goFile, readyFile] = process.argv;
      fs.writeFileSync(readyFile, '1');
      while (!fs.existsSync(goFile)) { /* barrier: both children start the transaction together */ }
      const t = new Date().toISOString();
      const res = transact(dir, (ctx) => {
        const v = decideClaim({ claim: { id, intent: 'i ' + id, paths: ['src/export/**'] }, mode: 'new',
          others: ctx.sessions.map((s) => ({ session: s, live: true })), complete: ctx.complete });
        if (v.ok) ctx.writeSession({ schemaVersion: 1, rev: 1, id,
          source: { kind: 'branch', branch: id, repo: null, prNumber: null, headRepo: null, headRef: id, baseRef: 'main' },
          worktree: null, intent: 'i ' + id, paths: ['src/export/**'], state: 'working', gen: 1, startOid: null,
          waitingOn: [], ready: null, knownOverlaps: [], leaseExpiresAt: new Date(Date.now() + 3600000).toISOString(),
          updatedAt: t, createdAt: t });
        return v.verdict;
      });
      console.log(JSON.stringify(res));
    `);
    for (let round = 0; round < 3; round += 1) {
      const dir = path.join(work, `fleet-${round}`);
      const go = path.join(work, `go-${round}`);
      const runChild = (id) => new Promise((resolve, reject) => {
        const ready = path.join(work, `ready-${round}-${id.replace('/', '_')}`);
        const p = spawn(process.execPath, [child, dir, id, go, ready], { stdio: ['ignore', 'pipe', 'pipe'] });
        let out = ''; let err = '';
        p.stdout.on('data', (d) => { out += d; }); p.stderr.on('data', (d) => { err += d; });
        p.on('error', reject);
        p.on('close', (code) => (code === 0 ? resolve(JSON.parse(out)) : reject(new Error(`child exit ${code}: ${err}`))));
      });
      const both = Promise.all([runChild('feat/one'), runChild('feat/two')]);
      const deadline = Date.now() + 15_000;
      while (fs.readdirSync(work).filter((n) => n.startsWith(`ready-${round}-`)).length < 2) {
        assert.ok(Date.now() < deadline, 'children did not start');
        await new Promise((r) => setTimeout(r, 10));
      }
      fs.writeFileSync(go, '1');
      const results = await both;
      assert.deepEqual(results.map((r) => r.value).sort(), ['blocked', 'ok'], `round ${round}: ${JSON.stringify(results)}`);
      assert.equal(readSessions(dir).sessions.length, 1, 'exactly one admitted');
    }
  });
});

describe('schema', () => {
  it('waitingOn: kind/ref validated, note capped at 500, train refs are train ids', () => {
    const w = (o) => SessionSchema.safeParse(rec('a', { waitingOn: [{ kind: 'human', ref: 'louis', since: iso(NOW), ...o }] }));
    assert.equal(w({}).success, true);
    assert.equal(w({ note: 'x'.repeat(500) }).success, true);
    assert.equal(w({ note: 'x'.repeat(501) }).success, false);
    assert.equal(w({ kind: 'robot' }).success, false);
    assert.equal(w({ ref: '' }).success, false);
    assert.equal(w({ ref: 'a\nb' }).success, false);
    assert.equal(w({ ref: 'r'.repeat(201) }).success, false);
    assert.equal(w({ kind: 'train', ref: 'feat/a' }).success, false);
    assert.equal(w({ kind: 'train', ref: 't-20261005120000-abcd' }).success, true);
    assert.equal(w({ extra: 1 }).success, false, 'strict');
  });
  it('rejects control chars in ids and unknown top-level fields', () => {
    assert.equal(SessionSchema.safeParse(rec('a\u0000b')).success, false);
    assert.equal(SessionSchema.safeParse({ ...rec('a'), stray: true }).success, false);
    assert.equal(SessionSchema.safeParse(rec('a', { state: 'nope' })).success, false);
  });
  it('waitingOn set/clear round-trips under the transaction', () => {
    const dir = freshDir();
    const wo = [{ kind: 'session', ref: 'feat/b', note: 'needs refactor', since: iso(NOW) }];
    transact(dir, (ctx) => { ctx.writeSession(rec('a', { waitingOn: wo })); });
    assert.deepEqual(readSessions(dir).sessions[0].waitingOn, wo);
    transact(dir, (ctx) => { ctx.writeSession({ ...ctx.sessions[0], rev: 2, waitingOn: [] }); });
    assert.deepEqual(readSessions(dir).sessions[0].waitingOn, []);
  });
});

describe('hold flag', () => {
  it('absent is not held; round-trips; invalid file is reported not trusted', () => {
    const dir = freshDir();
    assert.equal(readHold(dir).held, false);
    writeHold(dir, { held: true, by: 'louis', reason: 'CI saturated', at: iso(NOW) });
    assert.deepEqual(readHold(dir), { held: true, by: 'louis', reason: 'CI saturated', at: iso(NOW) });
    fs.writeFileSync(path.join(dir, 'hold.json'), '{bad');
    assert.match(readHold(dir).invalid, /malformed/);
    assert.throws(() => writeHold(dir, { held: 'yes' }));
  });
});

describe('train ids and manifests', () => {
  it('newTrainId matches the pattern and is valid', () => {
    const id = newTrainId(new Date('2026-10-05T12:34:56.000Z'));
    assert.match(id, /^t-20261005123456-[0-9a-f]{4}$/);
    assert.equal(assertTrainId(id), id);
    assert.ok(TRAIN_ID_RE.test(newTrainId()));
  });
  it('a train id like ../x is rejected before any path is built', () => {
    const dir = freshDir();
    for (const bad of ['../x', '..\\x', 't-1', 't-20261005123456-ZZZZ', '', null, 't-20261005123456-abcd/../x', '/etc/passwd']) {
      assert.throws(() => assertTrainId(bad), (e) => e.code === 'BAD_TRAIN_ID', String(bad));
      assert.throws(() => trainPath(dir, bad), (e) => e.code === 'BAD_TRAIN_ID');
      assert.throws(() => readTrain(dir, bad));
    }
  });
  it('assertManaged refuses paths that resolve outside fleet/', () => {
    const dir = freshDir();
    assert.throws(() => assertManaged(dir, path.join(dir, '..', 'x')), (e) => e.code === 'ESCAPES_REGISTRY');
    assert.throws(() => assertManaged(dir, dir));
    assert.throws(() => assertManaged(dir, path.join(dir, 'sessions', '..', '..', 'x')));
    assert.ok(assertManaged(dir, path.join(dir, 'trains', 'a.json')).endsWith('a.json'));
  });

  const manifest = (id, over = {}) => ({
    schemaVersion: 1, trainId: id, createdAt: iso(NOW), phase: 'snapshot', baseOid: OID('b'),
    sources: [{ id: 'feat/a', gen: 1, rev: 2, oid: OID('a'), kind: 'branch' }], mergeMethod: 'pr',
    destination: { remote: 'origin', fetchUrl: 'u', pushUrl: 'u', ref: 'refs/heads/main', expectedOid: OID('b') },
    testCommand: [{ name: 'default', stage: 'pre-land', command: ['npm', 'test'] }], ...over,
  });
  it('round-trips; phase and result may change; a populated manifest field may not', () => {
    const dir = freshDir();
    const id = newTrainId(new Date(NOW));
    writeTrain(dir, manifest(id));
    assert.equal(readTrain(dir, id).train.phase, 'snapshot');
    // candidate: null -> value is the allowed first write
    writeTrain(dir, manifest(id, { phase: 'tested', result: 'green', candidate: { oid: OID('c'), tree: OID('d') } }));
    writeTrain(dir, manifest(id, { phase: 'approved', result: 'green', candidate: { oid: OID('c'), tree: OID('d') } }));
    assert.throws(() => writeTrain(dir, manifest(id, { candidate: { oid: OID('e'), tree: OID('d') } })), (e) => e.code === 'TRAIN_IMMUTABLE' && /candidate/.test(e.message));
    assert.throws(() => writeTrain(dir, manifest(id, { baseOid: OID('9'), candidate: { oid: OID('c'), tree: OID('d') } })), (e) => /baseOid/.test(e.message));
    assert.throws(() => writeTrain(dir, manifest(id, { mergeMethod: 'direct-squash', candidate: { oid: OID('c'), tree: OID('d') } })), (e) => /mergeMethod/.test(e.message));
    assert.throws(() => writeTrain(dir, manifest(id, { sources: [], candidate: { oid: OID('c'), tree: OID('d') } })), (e) => /sources/.test(e.message));
    assert.equal(readTrain(dir, id).train.phase, 'approved', 'refused writes changed nothing');
  });
  it('tierResults is append-only', () => {
    const dir = freshDir();
    const id = newTrainId(new Date(NOW));
    const t1 = { name: 'fast', stage: 'pre-land', result: 'green' };
    writeTrain(dir, manifest(id, { tierResults: [t1] }));
    writeTrain(dir, manifest(id, { tierResults: [t1, { name: 'full', stage: 'pre-land', result: 'red' }] }));
    assert.throws(() => writeTrain(dir, manifest(id, { tierResults: [{ ...t1, result: 'red' }] })), (e) => e.code === 'TRAIN_IMMUTABLE');
  });
  it('schema-invalid manifests are refused; listTrains reports unreadable ones', () => {
    const dir = freshDir();
    assert.throws(() => writeTrain(dir, manifest(newTrainId(), { phase: 'bogus' })));
    const good = newTrainId(new Date(NOW));
    writeTrain(dir, manifest(good));
    fs.writeFileSync(path.join(dir, 'trains', 't-20260101000000-ffff.json'), '{no');
    fs.writeFileSync(path.join(dir, 'trains', 'stray.txt'), 'x');
    fs.writeFileSync(path.join(dir, 'trains', '.lock'), '');
    const l = listTrains(dir);
    assert.equal(l.complete, false);
    assert.deepEqual(l.trains.map((t) => t.trainId), [good]);
    assert.equal(l.invalid.length, 2);
  });
});

describe('liveness against real commit times (throwaway repo)', () => {
  function repoWithTip(isoDate) {
    const dir = mk('fleet-live-');
    git(['init', '-q', '-b', 'main'], dir);
    git(['config', 'user.email', 't@example.com'], dir);
    git(['config', 'user.name', 'T'], dir);
    git(['config', 'commit.gpgsign', 'false'], dir);
    fs.writeFileSync(path.join(dir, 'a'), 'a');
    git(['add', '.'], dir);
    execFileSync('git', ['commit', '-q', '-m', 'c'], {
      cwd: dir, stdio: 'pipe', env: { ...process.env, GIT_COMMITTER_DATE: isoDate, GIT_AUTHOR_DATE: isoDate },
    });
    return dir;
  }
  const expired = { state: 'working', leaseExpiresAt: iso(NOW - 3_600_000) };
  const live = (dir) => liveness(expired, { now: NOW, leaseMs: 4 * 3_600_000, tipCommitAt: tipCommitTime(dir, 'HEAD').at });

  it('expired lease + no recent activity => stale', () => {
    const r = live(repoWithTip(iso(NOW - 10 * 3_600_000)));
    assert.deepEqual([r.live, r.reason], [false, 'stale']);
  });
  it('expired lease + a fresh commit => still live', () => {
    const r = live(repoWithTip(iso(NOW - 600_000)));
    assert.deepEqual([r.live, r.reason], [true, 'branch-activity']);
  });
  it('a future-dated commit (+1 day) does not keep an expired lease alive, and is reported', () => {
    const r = live(repoWithTip(iso(NOW + 24 * 3_600_000)));
    assert.deepEqual([r.live, r.futureDatedTipIgnored], [false, true]);
  });
});

describe('fleetDir and status read-only-ness', () => {
  it('every linked worktree resolves to the same registry under the common dir', () => {
    const dir = mk('fleet-wt-main-');
    git(['init', '-q', '-b', 'main'], dir);
    git(['config', 'user.email', 't@example.com'], dir);
    git(['config', 'user.name', 'T'], dir);
    fs.writeFileSync(path.join(dir, 'a'), 'a');
    git(['add', '.'], dir);
    git(['commit', '-q', '-m', 'c'], dir);
    const wt = path.join(mk('fleet-wt-link-'), 'linked');
    git(['worktree', 'add', '-q', '-b', 'feat/x', wt], dir);
    assert.equal(fleetDir(wt), fleetDir(dir));
    assert.equal(fleetDir(dir), path.join(dir, '.git', 'fleet'));
    assert.throws(() => fleetDir(mk('fleet-notrepo-')), (e) => e.code === 'NOT_A_REPO');
  });
  it('reading + buildStatus leaves every registry file byte-identical', () => {
    const dir = freshDir();
    transact(dir, (ctx) => { ctx.writeSession(rec('a', { state: 'ready', ready: { oid: OID('a'), at: iso(NOW) }, leaseExpiresAt: iso(NOW - 1000) })); });
    writeHold(dir, { held: false, by: null, reason: null, at: null });
    const snap = () => {
      const out = {};
      const walk = (d) => { for (const n of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, n.name); if (n.isDirectory()) walk(p); else out[p] = crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex'); } };
      walk(dir);
      return out;
    };
    const before = snap();
    const reg = readSessions(dir);
    buildStatus({
      now: NOW, base: { name: 'main' }, registry: reg, worktrees: { queried: false, reason: 'x' }, branches: { queried: false, reason: 'x' },
      prs: { queried: false, reason: 'x' }, trains: listTrains(dir).trains, hold: readHold(dir),
    });
    assert.deepEqual(snap(), before);
  });
});

describe('confinement is symlink-aware and segment-aware', () => {
  function linkOrSkip(t, target, linkPath) {
    try { fs.symlinkSync(target, linkPath, 'junction'); return true; } catch (e) {
      t.skip(`cannot create a symlink/junction on this OS (${e.code}); symlink confinement not exercised`);
      return false;
    }
  }
  it('a link at fleet/trains pointing outside cannot carry a train write out', (t) => {
    const dir = freshDir();
    fs.mkdirSync(dir, { recursive: true });
    const outside = mk('fleet-outside-');
    if (!linkOrSkip(t, outside, path.join(dir, 'trains'))) return;
    const id = newTrainId(new Date(NOW));
    assert.throws(() => trainPath(dir, id), (e) => e.code === 'ESCAPES_REGISTRY');
    assert.throws(() => writeTrain(dir, {
      schemaVersion: 1, trainId: id, createdAt: iso(NOW), phase: 'snapshot', baseOid: OID('b'), sources: [], mergeMethod: 'pr',
      destination: { remote: 'origin', fetchUrl: 'u', pushUrl: 'u', ref: 'refs/heads/main', expectedOid: null }, testCommand: [],
    }), (e) => e.code === 'ESCAPES_REGISTRY');
    assert.deepEqual(fs.readdirSync(outside), [], 'nothing was written through the link');
  });
  it('a link at fleet/sessions pointing outside cannot carry a session write out; quarantine too', (t) => {
    const dir = freshDir();
    fs.mkdirSync(dir, { recursive: true });
    const outside = mk('fleet-outside-');
    if (!linkOrSkip(t, outside, path.join(dir, 'sessions'))) return;
    assert.throws(() => writeSession(dir, rec('feat/a')), (e) => e.code === 'ESCAPES_REGISTRY');
    fs.writeFileSync(path.join(outside, 'x.json'), '{}');
    assert.throws(() => quarantine(dir, 'x.json'), (e) => e.code === 'ESCAPES_REGISTRY');
    assert.deepEqual(fs.readdirSync(outside), ['x.json']);
  });
  it('a child literally named "..fleet" is INSIDE (the old startsWith("..") test refused it)', () => {
    const dir = freshDir();
    fs.mkdirSync(path.join(dir, '..fleet'), { recursive: true });
    assert.ok(assertManaged(dir, path.join(dir, '..fleet', 'x.json')).endsWith('x.json'));
    assert.ok(assertManaged(dir, path.join(dir, '..fleet')));
    assert.throws(() => assertManaged(dir, path.join(dir, '..')), (e) => e.code === 'ESCAPES_REGISTRY');
  });
});

describe('registry oid contract', () => {
  it('startOid / ready.oid accept exactly 40 or 64 hex: 40 ok, 41 reject, 63 reject, 64 ok', () => {
    for (const [n, okExpected] of [[40, true], [41, false], [63, false], [64, true]]) {
      assert.equal(SessionSchema.safeParse(rec('a', { startOid: 'a'.repeat(n) })).success, okExpected, `startOid ${n}`);
      assert.equal(SessionSchema.safeParse(rec('a', { ready: { oid: 'a'.repeat(n), at: iso(NOW) } })).success, okExpected, `ready.oid ${n}`);
    }
  });
});
