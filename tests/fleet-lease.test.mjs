/**
 * @fileoverview The machine-wide lease: policy (plan D4-D7), store, recovery and the lines `fleet next` shows.
 * Hermetic: an injected clock and process probe, a throwaway directory per test, never the real home directory.
 * Plan: docs/plans/fleet-machine-lease.md.
 */
import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  LIMITS, LeaseConfigError, appendEvent, classifyHeavy, decideAcquire, decideAnnounce, decideAttach, decideClearWindow,
  decideRelease, emptyLease, formatPeakRange, leasePaths, machineDir, nextLines, parsePeakHours, peakState, readLease, recoverUnreadable,
  renderStatus, repoKeyOf, repoLabel, summarise, transactLease, writeLease, LeaseSchema,
} from '../scripts/lib/fleet/lease.mjs';

const NOW = new Date('2026-10-13T20:00:00.000Z');
const at = (min) => new Date(NOW.getTime() + min * 60_000);
const A = { repoKey: 'aaaaaaaaaaaa', holder: 'main' };
const B = { repoKey: 'bbbbbbbbbbbb', holder: 'main' }; // same holder name, different repo
const SCOPE = 'win32:box';
const alive = new Set();
const probe = { scope: SCOPE, isPidAlive: (p) => alive.has(p) };
const T1 = '1111111111111111';
const T2 = '2222222222222222';
const rmDir = (d) => fs.rmSync(d, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });

let dir;
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fleet-lease-')); alive.clear(); });
afterEach(() => rmDir(dir));

/** A lease whose slot is held by `id`, expiring `min` minutes from NOW. */
const held = (id, min, extra = {}) => ({
  ...emptyLease(),
  heavy: {
    holder: id.holder, repoKey: id.repoKey, repo: id === A ? 'o/a' : 'o/b', kind: 'gate', scope: SCOPE, token: T1,
    startedAt: at(-10).toISOString(), expiresAt: at(min).toISOString(), ...extra,
  },
});
const acq = (lease, id, extra = {}, when = NOW) => decideAcquire(lease, { identity: id, repo: id === A ? 'o/a' : 'o/b', newToken: T2, ...extra }, when, probe);

describe('location', () => {
  it('uses FLEET_MACHINE_DIR when absolute, the home directory otherwise, and refuses a relative path', () => {
    assert.equal(machineDir({ FLEET_MACHINE_DIR: dir }), path.resolve(dir));
    assert.equal(machineDir({}, '/home/u'), path.join('/home/u', '.claude-fleet'));
    assert.throws(() => machineDir({ FLEET_MACHINE_DIR: 'relative/dir' }), LeaseConfigError);
    assert.throws(() => machineDir({ FLEET_MACHINE_DIR: '  ' }), LeaseConfigError);
  });
  it('keys a repo on its real common directory: stable for one path, different for two', () => {
    const x = fs.mkdtempSync(path.join(dir, 'x-')); const y = fs.mkdtempSync(path.join(dir, 'y-'));
    assert.equal(repoKeyOf(x), repoKeyOf(x));
    assert.notEqual(repoKeyOf(x), repoKeyOf(y));
    assert.match(repoKeyOf(x), /^[0-9a-f]{12}$/);
  });
  it('refuses to key a path it cannot resolve instead of hashing its spelling (audit H6)', () => {
    assert.throws(() => repoKeyOf(path.join(dir, 'does', 'not', 'exist')));
  });
});

describe('the repo display label always fits the record (Gemini round 2 G1)', () => {
  it('reads owner/repo from an origin URL in the usual spellings', () => {
    for (const u of ['https://github.com/o/r.git', 'git@github.com:o/r.git', 'https://github.com/o/r', 'ssh://git@host/o/r.git/']) assert.equal(repoLabel(u, ''), 'o/r', u);
  });
  it('falls back to the folder name, then to "unknown": a repo at a filesystem root has an empty folder name', () => {
    assert.equal(repoLabel('', path.join('x', 'my-checkout')), 'my-checkout');
    for (const top of ['', undefined, path.parse(process.cwd()).root]) assert.equal(repoLabel('', top), 'unknown', JSON.stringify(top));
  });
  it('is clipped to 80 characters and has no control characters', () => {
    assert.equal(repoLabel('', 'x'.repeat(200)).length, 80);
    assert.doesNotMatch(repoLabel('', 'a\u0007b'), /[\u0000-\u001f]/);
  });
});

describe('acquire: the slot rules (D4)', () => {
  it('grants a free slot with a 16-hex token, the requested length, and no pid it was not given', () => {
    const r = acq(emptyLease(), A, { forMin: 45 });
    assert.equal(r.ok, true);
    assert.match(r.heavy.token, /^[0-9a-f]{16}$/);
    assert.equal(r.heavy.expiresAt, at(45).toISOString());
    assert.equal(r.heavy.startedAt, NOW.toISOString());
    assert.equal('pid' in r.heavy, false, 'the CLI never records its own pid (audit G3)');
    assert.equal(r.heavy.kind, 'gate');
    assert.equal(decideAcquire(emptyLease(), { identity: A, repo: 'o/a' }, NOW, probe).heavy.expiresAt, at(30).toISOString(), 'default is 30 minutes');
  });

  it('records a pid only when the caller names one', () => {
    assert.equal(acq(emptyLease(), A, { pid: 4242 }).heavy.pid, 4242);
  });

  it('refuses another holder while the lease is live, naming holder, repo and end', () => {
    const r = acq(held(A, 20), B);
    assert.equal(r.ok, false); assert.equal(r.code, 'held');
    assert.match(r.reason, /main \(o\/a\)/);
  });

  it('treats the same holder NAME in another repo as a different holder (audit H1)', () => {
    const r = acq(held(A, 20), B); // B.holder === A.holder === 'main'
    assert.equal(r.code, 'held');
    const rel = decideRelease(held(A, 20), { identity: B, repo: 'o/b' }, NOW, probe);
    assert.equal(rel.code, 'not-holder');
  });

  it('renews with the matching token (token kept), rotates an EXPIRED own slot without one, refuses a wrong one (a live own slot is not rotated: D12)', () => {
    const renewed = acq(held(A, 5), A, { token: T1, forMin: 60 });
    assert.equal(renewed.ok, true); assert.equal(renewed.renewed, true);
    assert.equal(renewed.heavy.token, T1);
    assert.equal(renewed.heavy.startedAt, at(-10).toISOString(), 'a renewal keeps the original start');
    assert.equal(renewed.heavy.expiresAt, at(60).toISOString());

    const rotated = acq(held(A, 5), A, {}, at(30)); // expired at +5, no pid: unverifiable is for ANOTHER holder; the same identity takes it back
    assert.equal(rotated.ok, true); assert.equal(rotated.rotated, true);
    assert.equal(rotated.heavy.token, T2, 'an unauthenticated re-acquire must not inherit the old token (Gemini round 2)');
    const live = acq(held(A, 5), A);
    assert.equal(live.ok, false); assert.equal(live.code, 'held');
    assert.match(live.reason, /--token/);

    const wrong = acq(held(A, 5), A, { token: 'ffffffffffffffff' });
    assert.equal(wrong.code, 'stale-token');
  });

  it('a token-authenticated renewal UPDATES the record: the attached pid, scope, kind, note and unknown fields survive (audit H1)', () => {
    const lease = held(A, 5, { pid: 321, note: 'full gate', kind: 'test', cpuCount: 8 });
    const r = acq(lease, A, { token: T1, forMin: 60 });
    assert.equal(r.ok, true);
    assert.equal(r.heavy.pid, 321, 'the pid attached to the job is not dropped by a renewal');
    assert.equal(r.heavy.scope, SCOPE);
    assert.equal(r.heavy.kind, 'test'); assert.equal(r.heavy.note, 'full gate'); assert.equal(r.heavy.cpuCount, 8);
    assert.equal(r.heavy.expiresAt, at(60).toISOString());
    const restated = acq(lease, A, { token: T1, forMin: 60, kind: 'gate', note: 'longer', pid: 999 });
    assert.equal(restated.heavy.kind, 'gate'); assert.equal(restated.heavy.note, 'longer'); assert.equal(restated.heavy.pid, 999);
    assert.equal(acq(lease, A, { forMin: 60 }, at(30)).heavy.pid, undefined, 'a bare re-acquire of an expired own slot is a NEW job: it does not inherit the old pid');
  });

  it('expiry is exact: held one millisecond before expiresAt, expired at it', () => {
    const lease = held(A, 10);
    const exp = new Date(lease.heavy.expiresAt);
    assert.equal(classifyHeavy(lease.heavy, new Date(exp.getTime() - 1), probe).state, 'held');
    assert.equal(classifyHeavy(lease.heavy, exp, probe).state, 'expired');
  });

  it('an expired lease is not proof the process stopped: a live pid in the same scope refuses', () => {
    alive.add(777);
    const r = acq(held(A, -1, { pid: 777 }), B);
    assert.equal(r.code, 'expired-pid-alive');
    assert.match(r.reason, /still running/);
  });

  it('an expired lease whose recorded pid is dead in the same scope is granted, with a taken-over event', () => {
    const r = acq(held(A, -1, { pid: 778 }), B);
    assert.equal(r.ok, true);
    assert.equal(r.heavy.holder, 'main'); assert.equal(r.heavy.repoKey, B.repoKey);
    assert.equal(r.event.kind, 'taken-over');
    assert.equal(r.lease.events.at(-1).kind, 'taken-over');
  });

  it('negative control for the line above: the SAME fixture with the pid alive must refuse', () => {
    alive.add(778);
    assert.equal(acq(held(A, -1, { pid: 778 }), B).ok, false);
  });

  it('an expired lease with no pid, or a pid from another scope, is unverifiable and refused (never read as dead)', () => {
    assert.equal(acq(held(A, -1), B).code, 'unverifiable');
    const other = acq(held(A, -1, { pid: 5, scope: 'linux:box' }), B);
    assert.equal(other.code, 'unverifiable');
    assert.match(other.reason, /linux:box/);
  });

  it('validates the request: --for 1..180 whole minutes, --kind, --pid, --note', () => {
    for (const forMin of [0, 181, 1.5, -3, Number.NaN]) assert.equal(acq(emptyLease(), A, { forMin }).code, 'bad-request', String(forMin));
    for (const forMin of [1, 180]) assert.equal(acq(emptyLease(), A, { forMin }).ok, true, String(forMin));
    assert.equal(acq(emptyLease(), A, { kind: 'bogus' }).code, 'bad-request');
    assert.equal(acq(emptyLease(), A, { pid: 0 }).code, 'bad-request');
    assert.equal(acq(emptyLease(), A, { note: 'x'.repeat(LIMITS.noteMax + 1) }).code, 'bad-request');
    assert.equal(acq(emptyLease(), A, { note: 'x'.repeat(LIMITS.noteMax) }).ok, true);
    assert.equal(acq(emptyLease(), A, { note: 'a\nb' }).code, 'bad-request');
  });
});

describe('identity labels fit the record, and every generated event fits the schema (audit H2)', () => {
  const long = (n) => 'h'.repeat(n);
  it('refuses a holder or repo label over 80 characters or with control characters; accepts exactly 80', () => {
    assert.equal(decideAcquire(emptyLease(), { identity: { repoKey: A.repoKey, holder: long(81) }, repo: 'o/a' }, NOW, probe).code, 'bad-request');
    assert.equal(decideAcquire(emptyLease(), { identity: A, repo: long(81) }, NOW, probe).code, 'bad-request');
    assert.equal(decideAcquire(emptyLease(), { identity: { repoKey: A.repoKey, holder: 'a\nb' }, repo: 'o/a' }, NOW, probe).code, 'bad-request');
    assert.equal(decideAcquire(emptyLease(), { identity: { repoKey: A.repoKey, holder: long(80) }, repo: long(80) }, NOW, probe).ok, true);
  });
  it('a takeover, a forced release and a window clear between maximal labels still produce a lease the schema accepts', () => {
    const big = { repoKey: B.repoKey, holder: long(80) };
    const expiredBig = { ...held(A, -1, { pid: 778, holder: long(80), repo: long(80) }) };
    const took = decideAcquire(expiredBig, { identity: big, repo: long(80), newToken: T2 }, NOW, probe);
    assert.equal(took.ok, true);
    assert.doesNotThrow(() => LeaseSchema.parse(took.lease), 'taken-over reason is clipped to the schema limit');
    const forced = decideRelease(held(A, -1, { holder: long(80), repo: long(80) }), { identity: big, repo: long(80), force: true, reason: 'r'.repeat(LIMITS.noteMax) }, NOW, probe);
    assert.equal(forced.ok, true);
    assert.doesNotThrow(() => LeaseSchema.parse(forced.lease));
    const w = { id: 'w-20261013200000-abcd', repoKey: A.repoKey, repo: long(80), kind: 'ci', from: at(1).toISOString(), until: at(9).toISOString() };
    const cleared = decideClearWindow({ ...emptyLease(), windows: [w] }, { identity: big, repo: long(80), id: w.id }, NOW);
    assert.doesNotThrow(() => LeaseSchema.parse(cleared.lease));
  });
});

describe('announced windows against acquire (D6)', () => {
  const win = (repoKey, fromMin, untilMin, kind = 'ci') => ({
    id: 'w-20261013200000-abcd', repoKey, repo: 'o/b', kind, from: at(fromMin).toISOString(), until: at(untilMin).toISOString(),
  });
  const withWin = (w) => ({ ...emptyLease(), windows: [w] });

  it('refuses when another repo\'s window overlaps the requested interval, and says how to proceed', () => {
    const r = acq(withWin(win(B.repoKey, 10, 40)), A, { forMin: 30 });
    assert.equal(r.code, 'window'); assert.match(r.reason, /shorten --for/);
  });
  it('allows a request that ends exactly when the window starts, and one made after it ended', () => {
    assert.equal(acq(withWin(win(B.repoKey, 30, 60)), A, { forMin: 30 }).ok, true, 'window from === end is not an overlap');
    assert.equal(acq(withWin(win(B.repoKey, -60, 0)), A, { forMin: 30 }).ok, true, 'window until === now is not an overlap');
  });
  it('ignores this repo\'s own windows', () => {
    assert.equal(acq(withWin(win(A.repoKey, 0, 90)), A, { forMin: 30 }).ok, true);
  });
});

describe('attach (D5b)', () => {
  it('lets the holder record the job\'s pid and scope', () => {
    const r = decideAttach(held(A, 20), { identity: A, pid: 99 }, NOW, probe);
    assert.equal(r.ok, true); assert.equal(r.heavy.pid, 99); assert.equal(r.heavy.scope, SCOPE);
  });
  it('refuses a non-holder, a free slot, an expired slot, a stale token and a bad pid', () => {
    assert.equal(decideAttach(held(A, 20), { identity: B, pid: 99 }, NOW, probe).code, 'not-holder');
    assert.equal(decideAttach(emptyLease(), { identity: A, pid: 99 }, NOW, probe).code, 'free');
    assert.equal(decideAttach(held(A, -1), { identity: A, pid: 99 }, NOW, probe).code, 'expired');
    assert.equal(decideAttach(held(A, 20), { identity: A, pid: 99, token: T2 }, NOW, probe).code, 'stale-token');
    assert.equal(decideAttach(held(A, 20), { identity: A, pid: -1 }, NOW, probe).code, 'bad-request');
  });
});

describe('release', () => {
  it('frees the slot for the holder, and is idempotent on a free slot', () => {
    const r = decideRelease(held(A, 20), { identity: A }, NOW, probe);
    assert.equal(r.ok, true); assert.equal(r.lease.heavy, null);
    assert.equal(decideRelease(emptyLease(), { identity: A }, NOW, probe).already, true);
  });
  it('fences a stale token and accepts the current one', () => {
    assert.equal(decideRelease(held(A, 20), { identity: A, token: T2 }, NOW, probe).code, 'stale-token');
    assert.equal(decideRelease(held(A, 20), { identity: A, token: T1 }, NOW, probe).ok, true);
  });
  it('refuses another holder, and --force without a reason', () => {
    assert.equal(decideRelease(held(A, -1), { identity: B, repo: 'o/b' }, NOW, probe).code, 'not-holder');
    assert.equal(decideRelease(held(A, -1), { identity: B, repo: 'o/b', force: true }, NOW, probe).code, 'bad-request');
    assert.equal(decideRelease(held(A, -1), { identity: B, repo: 'o/b', force: true, reason: '  ' }, NOW, probe).code, 'bad-request');
  });
  it('never forces a LIVE lease; forces an expired one with a recorded event, even over a live pid', () => {
    assert.equal(decideRelease(held(A, 20), { identity: B, repo: 'o/b', force: true, reason: 'because' }, NOW, probe).code, 'live');
    alive.add(5);
    const r = decideRelease(held(A, -1, { pid: 5 }), { identity: B, repo: 'o/b', force: true, reason: 'owner confirmed it is gone' }, NOW, probe);
    assert.equal(r.ok, true); assert.equal(r.lease.heavy, null);
    assert.equal(r.event.kind, 'forced-release');
    assert.match(r.event.reason, /owner confirmed it is gone.*pid-alive/);
  });
  it('keeps the newest 20 events: a 21st is accepted and the oldest drops (the ring never refuses)', () => {
    let lease = emptyLease();
    for (let i = 0; i < LIMITS.maxEvents; i += 1) lease = appendEvent(lease, { at: NOW.toISOString(), kind: 'forced-release', by: 'x', reason: `e${i}` });
    assert.equal(lease.events.length, 20);
    lease = appendEvent(lease, { at: NOW.toISOString(), kind: 'forced-release', by: 'x', reason: 'e20' });
    assert.equal(lease.events.length, 20);
    assert.equal(lease.events[0].reason, 'e1'); assert.equal(lease.events.at(-1).reason, 'e20');
  });
});

describe('announce (D6) and its limits', () => {
  const ann = (lease, extra = {}, when = NOW) => decideAnnounce(lease, { identity: A, repo: 'o/a', kind: 'ci', until: '+30m', newId: 'abcd', ...extra }, when);

  it('records a window for this repo; --until accepts an ISO time or +Nm; --from defaults to now', () => {
    const r = ann(emptyLease());
    assert.equal(r.ok, true);
    assert.equal(r.window.from, NOW.toISOString()); assert.equal(r.window.until, at(30).toISOString());
    assert.match(r.window.id, /^w-20261013200000-abcd$/);
    assert.equal(ann(emptyLease(), { until: at(45).toISOString(), from: '+5m' }).window.from, at(5).toISOString());
  });
  it('validates kind, order, note and time format', () => {
    assert.equal(ann(emptyLease(), { kind: 'peak' }).code, 'bad-request');
    assert.equal(ann(emptyLease(), { from: '+30m', until: '+30m' }).code, 'bad-request');
    assert.equal(ann(emptyLease(), { until: 'tomorrow' }).code, 'bad-request');
    assert.equal(ann(emptyLease(), { from: '2026-10-13 20:00' }).code, 'bad-request');
    assert.equal(ann(emptyLease(), { note: 'a\tb' }).code, 'bad-request');
  });
  it('a window may be exactly 24 hours long; one millisecond more is refused', () => {
    const day = 24 * 60 * 60_000;
    assert.equal(ann(emptyLease(), { until: new Date(NOW.getTime() + day).toISOString() }).ok, true);
    assert.equal(ann(emptyLease(), { until: new Date(NOW.getTime() + day + 1).toISOString() }).code, 'limit');
  });
  it('a window must end within 14 days: exactly 14 is accepted, one millisecond more is refused', () => {
    const d14 = LIMITS.maxHorizonMs;
    const from = new Date(NOW.getTime() + d14 - 60_000).toISOString();
    assert.equal(ann(emptyLease(), { from, until: new Date(NOW.getTime() + d14).toISOString() }).ok, true);
    assert.equal(ann(emptyLease(), { from, until: new Date(NOW.getTime() + d14 + 1).toISOString() }).code, 'limit');
  });
  it('at most 10 windows per repo and 50 on the machine: the limit itself is accepted, the next is refused', () => {
    const mk = (n, id) => Array.from({ length: n }, (_, i) => ({ id: `w-20261013200000-${String(i).padStart(4, '0')}`, repoKey: id.repoKey, repo: 'x', kind: 'ci', from: at(1).toISOString(), until: at(9).toISOString() }));
    assert.equal(ann({ ...emptyLease(), windows: mk(9, A) }).ok, true, 'the 10th for a repo');
    assert.equal(ann({ ...emptyLease(), windows: mk(10, A) }).code, 'limit', 'the 11th');
    const others = Array.from({ length: 5 }, (_, i) => B).flatMap((b, i) => mk(10, { repoKey: `${String(i).repeat(12)}` }).map((w, j) => ({ ...w, id: `w-20261013200000-${String(i)}${String(j).padStart(3, '0')}` })));
    assert.equal(others.length, 50);
    assert.equal(ann({ ...emptyLease(), windows: others }).code, 'limit', 'the 51st on the machine');
    assert.equal(ann({ ...emptyLease(), windows: others.slice(0, 49) }).ok, true, 'the 50th');
  });
  it('prunes windows that ended more than an hour ago when it writes', () => {
    const old = { id: 'w-20261013100000-0001', repoKey: B.repoKey, repo: 'o/b', kind: 'ci', from: at(-300).toISOString(), until: at(-61).toISOString() };
    const recent = { ...old, id: 'w-20261013100000-0002', until: at(-59).toISOString() };
    const r = ann({ ...emptyLease(), windows: [old, recent] });
    assert.deepEqual(r.lease.windows.map((w) => w.id).sort(), [recent.id, r.window.id].sort());
  });
  it('never issues an id already in use (audit H3): a colliding candidate is replaced, and a clear removes exactly one window', () => {
    const first = ann(emptyLease()).window;
    const second = ann({ ...emptyLease(), windows: [first] }); // newId 'abcd' collides with the existing window
    assert.equal(second.ok, true);
    assert.notEqual(second.window.id, first.id);
    assert.equal(new Set(second.lease.windows.map((w) => w.id)).size, 2);
    const dup = { ...emptyLease(), windows: [first, { ...first, kind: 'quiet' }] }; // a hand-made duplicate
    const cleared = decideClearWindow(dup, { identity: A, repo: 'o/a', id: first.id }, NOW);
    assert.equal(cleared.lease.windows.length, 1, 'only the window that was found is removed');
  });
  it('clears a window; clearing another repo\'s leaves an event, clearing one\'s own does not', () => {
    const w = ann(emptyLease()).window;
    const own = decideClearWindow({ ...emptyLease(), windows: [w] }, { identity: A, repo: 'o/a', id: w.id }, NOW);
    assert.equal(own.ok, true); assert.equal(own.lease.windows.length, 0); assert.equal(own.lease.events.length, 0);
    const other = decideClearWindow({ ...emptyLease(), windows: [w] }, { identity: B, repo: 'o/b', id: w.id }, NOW);
    assert.equal(other.lease.events[0].kind, 'window-cleared');
    assert.equal(decideClearWindow(emptyLease(), { identity: A, repo: 'o/a', id: 'nope' }, NOW).code, 'no-such-window');
  });
});

describe('peak hours (D7)', () => {
  it('parses ranges, including one across midnight, and names the bad part', () => {
    assert.deepEqual(parsePeakHours('09:00-12:00, 22:00-02:00').peakHours, [{ from: '09:00', to: '12:00' }, { from: '22:00', to: '02:00' }]);
    for (const bad of ['', '9:00-12:00', '09:00-09:00', '25:00-26:00', '09:00', '09:00-12:00,x']) assert.equal(parsePeakHours(bad).ok, false, JSON.stringify(bad));
    assert.equal(parsePeakHours(Array.from({ length: 8 }, (_, i) => `0${i}:00-0${i}:30`).join(',')).ok, true, '8 ranges');
    assert.equal(parsePeakHours(Array.from({ length: 9 }, (_, i) => `0${i}:00-0${i}:30`).join(',')).ok, false, '9 ranges');
  });
  it('says whether now is inside a range (machine-local time), and the next range otherwise', () => {
    const ranges = [{ from: '09:00', to: '12:00' }, { from: '22:00', to: '02:00' }];
    const local = (h, m) => new Date(2026, 9, 13, h, m);
    assert.equal(peakState(ranges, local(10, 0)).now, true);
    assert.equal(peakState(ranges, local(12, 0)).now, false, 'the end is exclusive');
    assert.equal(peakState(ranges, local(23, 30)).now, true, 'before midnight');
    assert.equal(peakState(ranges, local(1, 0)).now, true, 'after midnight');
    assert.deepEqual(peakState(ranges, local(15, 0)).next, { from: '22:00', to: '02:00' });
    assert.deepEqual(peakState([], local(15, 0)), { now: false });
  });
  it('a range with no days is Monday to Friday: weekends are not peak (a318)', () => {
    const peak = parsePeakHours('14:00-20:00').peakHours;
    assert.deepEqual(peak, [{ from: '14:00', to: '20:00' }], 'the default adds nothing to the record');
    const at = (d, h) => new Date(2026, 9, d, h, 0); // 2026-10-16 Fri, 17 Sat, 18 Sun, 19 Mon
    assert.equal(peakState(peak, at(16, 15)).now, true, 'Friday');
    assert.equal(peakState(peak, at(17, 15)).now, false, 'Saturday');
    assert.equal(peakState(peak, at(18, 15)).now, false, 'Sunday');
    assert.equal(peakState(peak, at(19, 15)).now, true, 'Monday');
    assert.deepEqual(peakState(peak, at(17, 15)).next, peak[0], 'the next range is Monday\'s, not tomorrow\'s');
    assert.deepEqual(peakState(peak, at(16, 21)).next, peak[0], 'Friday evening: next is Monday');
  });
  it('an explicit day set: sat+sun, daily, wrapped and listed days; the spelling round-trips', () => {
    const wk = parsePeakHours('10:00-12:00@sat+sun').peakHours;
    assert.deepEqual(wk, [{ from: '10:00', to: '12:00', days: [0, 6] }]);
    assert.equal(peakState(wk, new Date(2026, 9, 17, 11, 0)).now, true);
    assert.equal(peakState(wk, new Date(2026, 9, 16, 11, 0)).now, false);
    assert.equal(peakState(parsePeakHours('10:00-12:00@daily').peakHours, new Date(2026, 9, 18, 11, 0)).now, true);
    assert.deepEqual(parsePeakHours('10:00-12:00@fri-mon').peakHours[0].days, [0, 1, 5, 6]);
    assert.deepEqual(parsePeakHours('10:00-12:00@MON+wed+fri').peakHours[0].days, [1, 3, 5]);
    for (const spec of ['10:00-12:00@mon-fri', '10:00-12:00@sat+sun', '10:00-12:00@mon+wed+fri', '10:00-12:00@daily', '10:00-12:00@sun-mon+fri-sat']) {
      const r = parsePeakHours(spec).peakHours[0];
      assert.deepEqual(parsePeakHours(formatPeakRange(r)).peakHours[0], r, spec);
    }
    assert.equal(formatPeakRange({ from: '14:00', to: '20:00' }), '14:00-20:00@mon-fri');
    for (const bad of ['10:00-12:00@', '10:00-12:00@xyz', '10:00-12:00@mon-xyz', '10:00-12:00@mon,fri', '10:00-12:00@mon++fri']) assert.equal(parsePeakHours(bad).ok, false, bad);
  });
  it('a range across midnight belongs to the day it starts on', () => {
    const night = parsePeakHours('22:00-02:00@fri').peakHours; // Friday 22:00 to Saturday 02:00
    assert.equal(peakState(night, new Date(2026, 9, 16, 23, 0)).now, true, 'Friday evening');
    assert.equal(peakState(night, new Date(2026, 9, 17, 1, 0)).now, true, 'Saturday small hours');
    assert.equal(peakState(night, new Date(2026, 9, 16, 1, 0)).now, false, 'Friday small hours belong to Thursday');
    assert.equal(peakState(night, new Date(2026, 9, 17, 23, 0)).now, false, 'Saturday evening');
  });
  it('a peak range stored before days existed (no days key) reads as Monday to Friday', () => {
    const stored = [{ from: '14:00', to: '20:00' }];
    assert.equal(peakState(stored, new Date(2026, 9, 18, 15, 0)).now, false);
    assert.match(nextLines({ state: 'ok', lease: { ...emptyLease(), peakHours: stored } }, new Date(2026, 9, 17, 15, 0), { probe }).join(''), /^$/, 'no peak note on a Saturday');
  });
});

describe('store', () => {
  it('reads an absent file as an empty lease and round-trips a written one', () => {
    assert.equal(readLease(dir).state, 'absent');
    const lease = acq(emptyLease(), A).lease;
    writeLease(dir, lease);
    const back = readLease(dir);
    assert.equal(back.state, 'ok');
    assert.deepEqual(back.lease, lease);
  });
  it('tolerates and preserves unknown keys within a schemaVersion (Gemini G1): never "corrupt"', () => {
    const lease = acq(emptyLease(), A).lease;
    const { file } = leasePaths(dir);
    fs.writeFileSync(file, JSON.stringify({ ...lease, futureTop: { a: 1 }, heavy: { ...lease.heavy, cpuCount: 8 } }));
    const r = readLease(dir);
    assert.equal(r.state, 'ok');
    assert.deepEqual(r.lease.futureTop, { a: 1 }); assert.equal(r.lease.heavy.cpuCount, 8);
    writeLease(dir, r.lease);
    const again = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.deepEqual(again.futureTop, { a: 1 }); assert.equal(again.heavy.cpuCount, 8, 'a rewrite keeps the newer checkout\'s field');
  });
  it('reads a newer schemaVersion as newer-version, not unreadable', () => {
    fs.writeFileSync(leasePaths(dir).file, JSON.stringify({ schemaVersion: 2, whatever: true }));
    const r = readLease(dir);
    assert.equal(r.state, 'newer-version'); assert.match(r.reason, /newer/);
  });
  it('reads malformed JSON, a wrong shape and a bad time as unreadable with a reason, never as free', () => {
    const { file } = leasePaths(dir);
    fs.writeFileSync(file, '{not json');
    assert.equal(readLease(dir).state, 'unreadable'); assert.match(readLease(dir).reason, /malformed JSON/);
    fs.writeFileSync(file, JSON.stringify({ schemaVersion: 1, heavy: null, windows: 'x', peakHours: [], events: [] }));
    assert.equal(readLease(dir).state, 'unreadable');
    const lease = acq(emptyLease(), A).lease;
    fs.writeFileSync(file, JSON.stringify({ ...lease, heavy: { ...lease.heavy, expiresAt: 'soon' } }));
    assert.equal(readLease(dir).state, 'unreadable');
    fs.writeFileSync(file, JSON.stringify({ ...lease, heavy: { ...lease.heavy, expiresAt: '2026-01-01T00:00:00.000Z' } }));
    assert.match(readLease(dir).reason, /startedAt is after expiresAt/);
  });
  it('a machine directory that is really a FILE is an unreadable store, not an empty lease (audit H4)', () => {
    const asFile = path.join(dir, 'not-a-dir');
    fs.writeFileSync(asFile, 'x');
    const r = readLease(asFile);
    assert.equal(r.state, 'unreadable'); assert.match(r.reason, /not a directory/);
    assert.equal(readLease(path.join(dir, 'missing-dir')).state, 'absent', 'control: a missing directory is simply nothing announced');
  });
  it('refuses a symbolic lease.json: read as unreadable, never written through', (t) => {
    const real = path.join(dir, 'elsewhere.json'); fs.writeFileSync(real, JSON.stringify(emptyLease()));
    try { fs.symlinkSync(real, leasePaths(dir).file); } catch (e) { t.skip(`cannot create a symlink here (${e.code})`); return; }
    assert.equal(readLease(dir).state, 'unreadable'); assert.match(readLease(dir).reason, /symbolic link/);
    assert.throws(() => writeLease(dir, emptyLease()), LeaseConfigError);
    assert.equal(JSON.parse(fs.readFileSync(real, 'utf8')).heavy, null, 'the link target was not touched');
  });
  it('refuses to write an invalid lease', () => {
    assert.throws(() => writeLease(dir, { ...emptyLease(), windows: [{ id: 'bad' }] }));
  });
});

describe('recovering an unreadable file (D5)', () => {
  it('copies the bytes aside first, then returns a fresh lease with a corrupt-recovered event', () => {
    const { file } = leasePaths(dir);
    fs.writeFileSync(file, '{broken');
    const r = recoverUnreadable(dir, readLease(dir), { by: 'main@o/a', reason: 'x', now: NOW });
    assert.equal(r.ok, true);
    assert.equal(fs.readFileSync(r.aside, 'utf8'), '{broken', 'the unreadable bytes are kept');
    assert.equal(fs.readFileSync(file, 'utf8'), '{broken', 'the original is untouched until the caller publishes the fresh record');
    assert.equal(r.lease.heavy, null); assert.equal(r.lease.events[0].kind, 'corrupt-recovered');
    assert.match(r.lease.events[0].reason, /^x; malformed JSON/, 'the operator\'s reason is kept (audit M1)');
  });
  it('leaves the original alone when the copy cannot be made', () => {
    const { file } = leasePaths(dir);
    fs.writeFileSync(file, '{broken');
    fs.writeFileSync(`${file}.corrupt-${NOW.toISOString().replace(/\D/g, '').slice(0, 14)}`, 'taken');
    const r = recoverUnreadable(dir, readLease(dir), { by: 'x', reason: 'x', now: NOW });
    assert.equal(r.code, 'recover-failed');
    assert.equal(fs.readFileSync(file, 'utf8'), '{broken');
  });
  it('does not recover a newer-version file or a valid one', () => {
    fs.writeFileSync(leasePaths(dir).file, JSON.stringify({ schemaVersion: 9 }));
    assert.equal(recoverUnreadable(dir, readLease(dir), { by: 'x', reason: 'x', now: NOW }).code, 'not-recoverable');
    writeLease(dir, emptyLease());
    assert.equal(recoverUnreadable(dir, readLease(dir), { by: 'x', reason: 'x', now: NOW }).code, 'not-recoverable');
  });
});

describe('transactLease', () => {
  it('runs the decision under the lock and publishes only what it returns', () => {
    const r = transactLease(dir, (read) => ({ value: read.state, write: acq(read.lease, A).lease }));
    assert.deepEqual(r, { ok: true, value: 'absent' });
    assert.equal(readLease(dir).lease.heavy.holder, 'main');
    const r2 = transactLease(dir, () => ({ value: 'no write' }));
    assert.equal(r2.value, 'no write');
    assert.equal(readLease(dir).lease.heavy.holder, 'main', 'no write → unchanged');
  });
  it('reports lock contention instead of waiting forever', () => {
    fs.writeFileSync(leasePaths(dir).lock, JSON.stringify({ pid: process.pid, token: 'abc', acquiredAt: new Date().toISOString() }));
    const r = transactLease(dir, () => ({ value: 1 }), { maxWaitMs: 60 });
    assert.deepEqual(r, { ok: false, reason: 'lock-contention' });
  });
});

describe('what fleet next and status say', () => {
  const read = (lease) => ({ state: 'ok', lease });
  const next = (lease, extra = {}) => nextLines(read(lease), NOW, { cmd: 'fleet', repoKey: A.repoKey, probe, ...extra });

  it('is silent when measured and quiet', () => {
    assert.deepEqual(next(emptyLease()), []);
    assert.deepEqual(nextLines({ state: 'absent', lease: emptyLease() }, NOW, { probe }), []);
  });
  it('says who holds the slot, and marks this repo\'s own', () => {
    const [l] = next(held(A, 12));
    assert.match(l, /HELD by main \(o\/a\) \[this repo\] for gate until 20:12Z \(in 12m\)/);
    assert.doesNotMatch(next(held(B, 12))[0], /this repo/);
  });
  it('says an expired lease is expired and why it cannot be granted', () => {
    const [l] = next(held(A, -3));
    assert.match(l, /EXPIRED/); assert.match(l, /unverifiable/);
  });
  it('mentions a window that is active or starts within 4 hours, not one further out', () => {
    const w = (from, until) => ({ id: 'w-20261013200000-abcd', repoKey: B.repoKey, repo: 'o/b', kind: 'ci', from: at(from).toISOString(), until: at(until).toISOString() });
    assert.match(next({ ...emptyLease(), windows: [w(-10, 20)] })[0], /ci window for o\/b active/);
    assert.match(next({ ...emptyLease(), windows: [w(200, 230)] })[0], /ci window for o\/b from/);
    assert.deepEqual(next({ ...emptyLease(), windows: [w(300, 330)] }), []);
    assert.deepEqual(next({ ...emptyLease(), windows: [w(-90, -30)] }), [], 'an ended window is not mentioned');
  });
  it('mentions peak hours only while they are on', () => {
    const lease = { ...emptyLease(), peakHours: [{ from: '09:00', to: '12:00' }] };
    assert.match(nextLines(read(lease), new Date(2026, 9, 13, 10, 0), { probe })[0], /peak-cost hours now/);
    assert.deepEqual(nextLines(read(lease), new Date(2026, 9, 13, 13, 0), { probe }), []);
  });
  it('an unreadable or newer-version file is UNMEASURED, never free and never silent', () => {
    const l = nextLines({ state: 'unreadable', reason: 'malformed JSON (x)' }, NOW, { probe });
    assert.equal(l.length, 1); assert.match(l[0], /unmeasured \(malformed JSON \(x\)\)/);
    assert.match(nextLines({ state: 'newer-version', reason: 'schemaVersion 2 is newer' }, NOW, { probe })[0], /unmeasured/);
  });
  it('status renders free, held, windows, peak hours and the unmeasured case', () => {
    const view = (lease) => renderStatus(summarise(read(lease), NOW, probe), { dir: '/m', now: NOW, repoKey: A.repoKey }).join('\n');
    assert.match(view(emptyLease()), /heavy slot: FREE[\s\S]*windows: none announced[\s\S]*peak hours: none set/);
    assert.match(view(held(A, 12)), /HELD by main/);
    assert.match(renderStatus(summarise({ state: 'unreadable', reason: 'r' }, NOW, probe), { dir: '/m', now: NOW }).join('\n'), /UNMEASURED: r/);
  });
});
