/**
 * @fileoverview Waiting `lease run` processes on the machine lease (plan docs/plans/fleet-lease-orphan-waiters-and-priority.md):
 * D1 a waiter records its runners (pid, priority), D2 the queue reaps a runner whose pid is gone or that stopped polling,
 * D3 a runner stops waiting on a stop signal or when its launcher is gone, and never runs its job, D4 a train (`priority:
 * 'high'`) goes ahead of its own repo's normal runs. The consumer report it answers (2026-11-27): a killed train script left
 * its `lease run` queued for up to 12 h, able to start a train for nobody, and a train waited behind its sessions' targeted runs.
 * Hermetic: pure decisions over a fake clock and pid probe; `runUnderLease` over a temp lease directory, fake sleep and signals.
 */
import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as L from '../scripts/lib/fleet/lease.mjs';
import * as R from '../scripts/lib/fleet/lease-run.mjs';
import { LIMITS, withRunner, reapRunners } from '../scripts/lib/fleet/lease-model.mjs';
import { launcherChain } from '../scripts/lib/fleet/lease-cpu.mjs';
import { leaseRunResult } from '../scripts/lib/fleet/lease-cmd.mjs';

const { LeaseSchema, decideAcquire, decideRelease, decideWait, decideWithdrawRunner, emptyLease, readLease, settleQueue } = L;

const SCOPE = 'win32:box';
/** Pids in `alive` are running; every other pid is dead. */
const probeOf = (...alive) => ({ scope: SCOPE, isPidAlive: (p) => alive.includes(p) });
const A = { repoKey: 'aaaaaaaaaaaa', holder: 'main' };
const TRAIN = { repoKey: 'aaaaaaaaaaaa', holder: 'train' };
const CHIP = { repoKey: 'aaaaaaaaaaaa', holder: 'chip-1' };
const CHIP2 = { repoKey: 'aaaaaaaaaaaa', holder: 'chip-2' };
const B = { repoKey: 'bbbbbbbbbbbb', holder: 'main' };
const repoOf = (id) => (id.repoKey.startsWith('a') ? 'o/a' : 'o/b');
const T = (hm) => new Date(`2026-11-27T${hm}:00.000Z`);
const q = (id, extra = {}) => ({ identity: id, repo: repoOf(id), forMin: 30, ...extra });
const run = (id, pid, extra = {}) => q(id, { exclusive: true, pid, ...extra });
const ok = (d) => { assert.equal(d.ok, true, JSON.stringify({ code: d.code, reason: d.reason })); return d.lease; };
const waiterOf = (lease, repoKey = 'aaaaaaaaaaaa') => (lease.waiters ?? []).find((w) => w.repoKey === repoKey);
const valid = (lease) => { const r = LeaseSchema.safeParse(lease); assert.equal(r.success, true, JSON.stringify(r.error?.issues)); return lease; };
/** B holds the slot from 08:00 for 60 minutes. */
const heldByB = () => ok(decideAcquire(emptyLease(), q(B, { forMin: 60, pid: 900, newToken: 'bbbbbbbbbbbbbbbb' }), T('08:00'), probeOf(900)));
/** A's chip holds the slot from 08:00 (the targeted run the train waits behind). */
const heldByChip = () => ok(decideAcquire(emptyLease(), run(CHIP, 501, { newToken: 'cccccccccccccccc' }), T('08:00'), probeOf(501)));

describe('D1: a waiter records its runners', () => {
  it('a refused lease run records {holder, pid, scope, priority, forMin, since, at}; a second refusal refreshes it, never duplicates', () => {
    const l0 = heldByB();
    const d1 = decideAcquire(l0, run(TRAIN, 700, { priority: 'high' }), T('08:01'), probeOf(900, 700));
    assert.equal(d1.ok, false);
    assert.equal(d1.queued, true);
    const r1 = waiterOf(valid(d1.lease)).runners;
    assert.deepEqual(r1, [{ holder: 'train', pid: 700, scope: SCOPE, priority: 'high', forMin: 30, since: T('08:01').toISOString(), at: T('08:01').toISOString() }]);
    assert.equal(waiterOf(d1.lease).pidless, undefined, 'only runners waited, so the entry can be reaped');
    const d2 = decideAcquire(d1.lease, run(TRAIN, 700, { priority: 'high' }), T('08:02'), probeOf(900, 700));
    const r2 = waiterOf(valid(d2.lease)).runners;
    assert.equal(r2.length, 1);
    assert.equal(r2[0].since, T('08:01').toISOString(), 'the wait keeps its start');
    assert.equal(r2[0].at, T('08:02').toISOString(), 'each poll refreshes it');
  });
  it('a one-shot acquire or `lease wait` marks the entry pidless: nothing can ever show that request gone', () => {
    const l0 = heldByB();
    const d = decideAcquire(l0, q(A), T('08:01'), probeOf(900));
    assert.equal(waiterOf(valid(d.lease)).pidless, true);
    assert.equal(waiterOf(d.lease).runners, undefined);
    const w = ok(decideWait(l0, q(A), T('08:01'), probeOf(900)));
    assert.equal(waiterOf(valid(w)).pidless, true);
  });
  const blank = () => ({ repoKey: A.repoKey, repo: 'o/a', by: 'x@o/a', since: T('08:00').toISOString(), forMin: 30, refusals: 0 });
  const at = (i) => ({ forMin: 30, now: new Date(T('08:00').getTime() + i * 1000), scope: SCOPE });
  it('the runner list is bounded: the stalest runner of no higher rank makes room for a new one', () => {
    let w = blank();
    for (let i = 0; i < LIMITS.maxRunners + 2; i += 1) w = withRunner(w, run({ ...A, holder: `h${i}` }, 100 + i), at(i));
    assert.equal(w.runners.length, LIMITS.maxRunners);
    assert.ok(w.runners.some((r) => r.holder === `h${LIMITS.maxRunners + 1}`));
    assert.ok(!w.runners.some((r) => r.holder === 'h0'));
  });
  it('at capacity a train is never evicted for a targeted run; when every runner outranks the new one, the entry turns pidless (audit R1 H2/H10)', () => {
    let w = withRunner(blank(), run(TRAIN, 700, { priority: 'high' }), at(0)); // the stalest runner, and high
    for (let i = 1; i < LIMITS.maxRunners; i += 1) w = withRunner(w, run({ ...A, holder: `h${i}` }, 100 + i), at(i));
    const full = withRunner(w, run(CHIP, 501), at(50));
    assert.ok(full.runners.some((r) => r.holder === 'train'), 'the train stays');
    assert.ok(!full.runners.some((r) => r.holder === 'h1'), 'the stalest NORMAL runner made room');
    let highs = blank();
    for (let i = 0; i < LIMITS.maxRunners; i += 1) highs = withRunner(highs, run({ ...A, holder: `t${i}` }, 100 + i, { priority: 'high' }), at(i));
    const refusedRoom = withRunner(highs, run(CHIP, 501), at(60));
    assert.equal(refusedRoom.runners.length, LIMITS.maxRunners);
    assert.ok(!refusedRoom.runners.some((r) => r.holder === 'chip-1'));
    assert.equal(refusedRoom.pidless, true, 'never reaped for want of the runner it could not record');
  });
  it('an eviction marks the entry pidless: the evicted run still waits, unrecorded (audit R2 H2)', () => {
    let w = blank();
    for (let i = 0; i < LIMITS.maxRunners; i += 1) w = withRunner(w, run({ ...A, holder: `h${i}` }, 100 + i), at(i));
    assert.equal(w.pidless, undefined, 'not full yet: still reapable');
    assert.equal(withRunner(w, run(CHIP, 501), at(50)).pidless, true);
  });
  it('a runner joining after an older checkout refused keeps that refusal as pidless before overwriting lastRefusal (audit R2 H1)', () => {
    const l0 = decideAcquire(heldByB(), run(TRAIN, 700), T('08:01'), probeOf(900, 700)).lease;
    const old = { ...l0, waiters: l0.waiters.map((x) => ({ ...x, refusals: x.refusals + 1, lastRefusal: T('08:02').toISOString() })) };
    const l1 = decideAcquire(old, run(TRAIN, 700), T('08:03'), probeOf(900, 700)).lease;
    assert.equal(waiterOf(l1).pidless, true);
    assert.ok(waiterOf(settleQueue(l1, T('08:04'), probeOf(900))), 'the older request still waits after the runner dies');
  });
  it('two runs sharing a holder are two runners; withdrawing one leaves the other (audit R1 H1/M3)', () => {
    const l0 = decideAcquire(heldByB(), run(TRAIN, 700), T('08:01'), probeOf(900, 700, 701)).lease;
    const l1 = decideAcquire(l0, run(TRAIN, 701), T('08:01'), probeOf(900, 700, 701)).lease;
    assert.deepEqual(waiterOf(l1).runners.map((r) => r.pid), [700, 701]);
    const l2 = ok(decideWithdrawRunner(l1, q(TRAIN, { pid: 700 }), T('08:02'), probeOf(900, 700, 701)));
    assert.deepEqual(waiterOf(l2).runners.map((r) => r.pid), [701]);
  });
  it('a runner joining an entry an older checkout (or a pid-less request) opened marks it pidless (audit R1 H3)', () => {
    const legacy = { ...emptyLease(), waiters: [{ repoKey: A.repoKey, repo: 'o/a', by: 'old@o/a', since: T('08:00').toISOString(), forMin: 30, refusals: 3, lastRefusal: T('08:00').toISOString() }] };
    const d = decideAcquire({ ...heldByB(), waiters: legacy.waiters }, run(TRAIN, 700), T('08:01'), probeOf(900, 700));
    assert.equal(waiterOf(d.lease).pidless, true);
    assert.ok(waiterOf(settleQueue(d.lease, T('08:02'), probeOf(900))), 'its runner dying does not end the older request\'s wait');
  });
  it('an older checkout refusing after the runners last polled keeps the entry when they are reaped (audit R1 M1)', () => {
    const l0 = decideAcquire(heldByB(), run(TRAIN, 700), T('08:01'), probeOf(900, 700)).lease;
    // what an older checkout's openWait does: bump the count and lastRefusal, nothing else
    const old = { ...l0, waiters: l0.waiters.map((w) => ({ ...w, refusals: w.refusals + 1, lastRefusal: T('08:03').toISOString() })) };
    assert.ok(waiterOf(settleQueue(old, T('08:04'), probeOf(900))), 'kept');
    assert.equal(waiterOf(settleQueue(l0, T('08:04'), probeOf(900))), undefined, 'control: without the foreign refusal it is reaped');
  });
});

describe('D2: the queue reaps runners that are gone', () => {
  const waiting = () => decideAcquire(heldByB(), run(TRAIN, 700), T('08:01'), probeOf(900, 700)).lease;

  it('a dead pid in this scope ends the episode (abandoned) at the next settle, journalled', () => {
    const l = settleQueue(waiting(), T('08:02'), probeOf(900));
    assert.equal(waiterOf(valid(l)), undefined);
    const ended = l.journal.filter((e) => e.kind === 'wait-ended');
    assert.equal(ended.at(-1).reason, 'abandoned');
  });
  it('a live pid is kept, and the settle returns the SAME object when nothing changed', () => {
    const l = waiting();
    assert.equal(settleQueue(l, T('08:02'), probeOf(900, 700)), l);
  });
  it('a pid in another scope cannot be probed: kept until it stops polling for runnerStaleMs, then reaped', () => {
    const l = waiting();
    const other = { scope: 'linux:wsl', isPidAlive: () => false };
    assert.ok(waiterOf(settleQueue(l, T('08:05'), other)), 'not provably gone yet');
    const late = new Date(T('08:01').getTime() + LIMITS.runnerStaleMs + 1000);
    assert.equal(waiterOf(settleQueue(l, late, other)), undefined);
  });
  it('an entry a pid-less request shares keeps its place when its runners go', () => {
    const l0 = waiting();
    const shared = decideAcquire(l0, q(A), T('08:02'), probeOf(900, 700)).lease; // a one-shot acquire of the same repo
    const l = settleQueue(shared, T('08:03'), probeOf(900));
    assert.ok(waiterOf(l), 'the one-shot request still waits');
    assert.deepEqual(waiterOf(l).runners, []);
  });
  it('one dead runner of two leaves the other waiting', () => {
    const l0 = decideAcquire(waiting(), run(CHIP, 501), T('08:02'), probeOf(900, 700, 501)).lease;
    const l = settleQueue(l0, T('08:03'), probeOf(900, 501));
    assert.deepEqual(waiterOf(l).runners.map((r) => r.holder), ['chip-1']);
  });
  it('the reaping changes the cross-repo queue: a dead waiter no longer holds another repo off', () => {
    // A waited first (dead runner); B releases, then a fresh acquire by a third party of B's repo is NOT told "o/a goes first".
    const l0 = waiting();
    const rel = ok(decideRelease(l0, q(B, { token: 'bbbbbbbbbbbbbbbb', endTurn: true }), T('08:10'), probeOf()));
    assert.equal(waiterOf(rel), undefined, 'reaped during the release\'s own settle');
  });
});

describe('D4: priority inside one repo', () => {
  const trainWaits = () => decideAcquire(heldByChip(), run(TRAIN, 700, { priority: 'high' }), T('08:01'), probeOf(501, 700)).lease;
  const freed = () => ok(decideRelease(trainWaits(), q(CHIP, { token: 'cccccccccccccccc' }), T('08:10'), probeOf(700)));

  it('the train waits behind the running targeted run (no slot is taken from a live holder)', () => {
    const d = decideAcquire(heldByChip(), run(TRAIN, 700, { priority: 'high' }), T('08:01'), probeOf(501, 700));
    assert.equal(d.code, 'held');
  });
  it('once the slot is free, a NEW targeted run of the same repo is refused `priority`; the train is granted', () => {
    const l = freed();
    const chip2 = decideAcquire(l, run(CHIP2, 502), T('08:10'), probeOf(700, 502));
    assert.equal(chip2.ok, false);
    assert.equal(chip2.code, 'priority');
    assert.match(chip2.reason, /high-priority run of this repo \(train/);
    assert.equal(chip2.queued, true, 'the refused run waits like any other');
    const train = decideAcquire(chip2.lease, run(TRAIN, 700, { priority: 'high' }), T('08:11'), probeOf(700, 502));
    assert.equal(train.ok, true, JSON.stringify(train));
    assert.equal(train.heavy.holder, 'train');
  });
  it('a one-shot acquire of the same repo is refused too (it is a normal-priority request)', () => {
    assert.equal(decideAcquire(freed(), q(CHIP2), T('08:10'), probeOf(700)).code, 'priority');
  });
  it('does not apply when the train is gone (reaped), is the requester, or ranks no higher', () => {
    assert.equal(decideAcquire(freed(), run(CHIP2, 502), T('08:10'), probeOf(502)).ok, true, 'dead train: reaped, not waited for');
    const normal = ok(decideRelease(decideAcquire(heldByChip(), run(TRAIN, 700), T('08:01'), probeOf(501, 700)).lease, q(CHIP, { token: 'cccccccccccccccc' }), T('08:10'), probeOf(700)));
    assert.equal(decideAcquire(normal, run(CHIP2, 502), T('08:10'), probeOf(700, 502)).ok, true, 'a normal waiter is not jumped');
    assert.equal(decideAcquire(freed(), run(CHIP2, 502, { priority: 'high' }), T('08:10'), probeOf(700, 502)).ok, true, 'equal rank: first come');
  });
  it('never reorders repos: another repo is not refused for this repo\'s train', () => {
    const l = freed();
    const b = decideAcquire(l, q(B, { pid: 900 }), T('08:10'), probeOf(700, 900));
    assert.notEqual(b.code, 'priority');
  });
  it('a renewal of the running job is not a fresh grant and is never refused for priority', () => {
    const l0 = heldByChip();
    const withTrain = decideAcquire(l0, run(TRAIN, 700, { priority: 'high' }), T('08:01'), probeOf(501, 700)).lease;
    const renew = decideAcquire(withTrain, q(CHIP, { token: 'cccccccccccccccc', pid: 501 }), T('08:05'), probeOf(501, 700));
    assert.equal(renew.ok, true, JSON.stringify(renew));
  });
  it('a normal run sharing the train\'s holder (another process) is still refused for it (audit R2 H3)', () => {
    const l = freed();
    const sameHolder = decideAcquire(l, run(TRAIN, 702), T('08:10'), probeOf(700, 702));
    assert.equal(sameHolder.code, 'priority');
  });
  it('an unknown priority is a bad request', () => {
    assert.equal(decideAcquire(emptyLease(), run(TRAIN, 700, { priority: 'urgent' }), T('08:00'), probeOf(700)).code, 'bad-request');
  });
});

describe('decideWithdrawRunner', () => {
  const l0 = () => decideAcquire(heldByB(), run(TRAIN, 700), T('08:01'), probeOf(900, 700)).lease;
  it('a stopped runner leaves; the episode ends `cancelled` when nothing else waits in it', () => {
    const l = ok(decideWithdrawRunner(l0(), q(TRAIN, { pid: 700 }), T('08:02'), probeOf(900, 700)));
    assert.equal(waiterOf(l), undefined);
    assert.equal(l.journal.at(-1).reason, 'cancelled');
  });
  it('keepPlace (gave up at the deadline): the runner leaves and the repo stays queued, as a refused acquire does', () => {
    const l = ok(decideWithdrawRunner(l0(), q(TRAIN, { pid: 700 }), T('08:02'), probeOf(900, 700), { keepPlace: true }));
    assert.equal(waiterOf(valid(l)).pidless, true);
    assert.deepEqual(waiterOf(l).runners, []);
  });
  it('is a no-op for a session that is not waiting', () => {
    const base = l0();
    const d = decideWithdrawRunner(base, q(CHIP, { pid: 501 }), T('08:01'), probeOf(900, 700));
    assert.equal(d.withdrawn, false);
  });
});

describe('launcherChain', () => {
  const row = (pid, ppid, startedAt) => ({ pid, ppid, cpuMs: 0, startedAt, name: 'x' });
  it('walks parent first, at most depth, stopping at system roots', () => {
    const rows = [row(50, 40, '2026-11-27T08:03:00Z'), row(40, 30, '2026-11-27T08:02:00Z'), row(30, 20, '2026-11-27T08:01:00Z'), row(20, 4, '2026-11-27T08:00:00Z'), row(4, 0, null)];
    assert.deepEqual(launcherChain(rows, 50), { chain: [40, 30, 20], broken: null });
    assert.deepEqual(launcherChain(rows, 50, 2), { chain: [40, 30], broken: null });
    assert.deepEqual(launcherChain(rows, 20), { chain: [], broken: null }, 'a parent at a system root ends the chain');
  });
  it('a "parent" that started after its child is a reused pid: the real launcher was already gone (broken)', () => {
    const rows = [row(50, 40, '2026-11-27T08:03:00Z'), row(40, 30, '2026-11-27T08:02:00Z'), row(30, 20, '2026-11-27T09:00:00Z')];
    assert.deepEqual(launcherChain(rows, 50), { chain: [40], broken: 40 });
  });
  it('a parent absent from the table is broken: the train died before the read, its cmd.exe lives on (audit R1 H5)', () => {
    const rows = [row(50, 40, '2026-11-27T08:03:00Z'), row(40, 30, '2026-11-27T08:02:00Z')];
    assert.deepEqual(launcherChain(rows, 50), { chain: [40], broken: 40 });
  });
  it('is cycle-safe and empty for an unknown pid', () => {
    assert.deepEqual(launcherChain([row(10, 11, null), row(11, 10, null)], 10), { chain: [11], broken: null });
    assert.deepEqual(launcherChain([], 10), { chain: [], broken: null });
  });
});

describe('launcherWatch', () => {
  it('reads the table once, then reports the first dead ancestor', async () => {
    let reads = 0; const alive = new Set([40, 30]);
    const w = R.launcherWatch({ pid: 50, ppid: () => 40, platform: 'win32', isAlive: (p) => alive.has(p), readTable: async () => { reads += 1; return [{ pid: 50, ppid: 40 }, { pid: 40, ppid: 30 }, { pid: 30, ppid: 4 }]; } });
    assert.equal(await w.gone(), null);
    alive.delete(30);
    assert.match(await w.gone(), /pid 30\) is gone/);
    assert.equal(reads, 1);
  });
  it('a failed table read falls back to the parent alone, and says so; on POSIX a reparented process is orphaned', async () => {
    let parent = 40; const lines = [];
    const w = R.launcherWatch({ pid: 50, ppid: () => parent, platform: 'linux', isAlive: () => true, readTable: async () => null, log: (m) => lines.push(m) });
    assert.equal(await w.gone(), null);
    assert.match(lines[0], /could not be read/);
    parent = 1;
    assert.match(await w.gone(), /parent \(pid 40\) exited/);
  });
  it('a launcher already gone at the first read is gone (the chain is broken)', async () => {
    const w = R.launcherWatch({ pid: 50, ppid: () => 40, platform: 'win32', isAlive: () => true, readTable: async () => [{ pid: 50, ppid: 40 }, { pid: 40, ppid: 30 }] });
    assert.match(await w.gone(), /launched pid 40 was already gone/);
  });
  it('a launcher pid reused by a new process is caught at the periodic re-read by its start time (audit R2 H4)', async () => {
    let t = 0; let reads = 0;
    const table = [[{ pid: 50, ppid: 40, startedAt: '2026-11-27T08:01:00Z' }, { pid: 40, ppid: 4, startedAt: '2026-11-27T08:00:00Z' }]];
    const w = R.launcherWatch({ pid: 50, ppid: () => 40, platform: 'win32', isAlive: () => true, clock: () => t, recheckMs: 300_000,
      readTable: async () => { reads += 1; return table[Math.min(reads - 1, table.length - 1)]; } });
    assert.equal(await w.gone(), null);
    t = 100_000;
    assert.equal(await w.gone(), null);
    assert.equal(reads, 1, 'no re-read before recheckMs');
    table.push([{ pid: 50, ppid: 40, startedAt: '2026-11-27T08:01:00Z' }, { pid: 40, ppid: 7, startedAt: '2026-11-27T09:30:00Z' }]);
    t = 300_000;
    assert.match(await w.gone(), /pid 40\) is gone; that pid now belongs to another process/);
    assert.equal(reads, 2);
  });
  it('a probe that throws keeps the wait (the safe direction) and is said once', async () => {
    const lines = [];
    const w = R.launcherWatch({ pid: 50, ppid: () => 40, platform: 'win32', isAlive: () => { throw new Error('boom'); }, readTable: async () => [{ pid: 50, ppid: 40 }, { pid: 40, ppid: 4 }], log: (m) => lines.push(m) });
    assert.equal(await w.gone(), null);
    assert.equal(await w.gone(), null);
    assert.equal(lines.length, 1);
    assert.match(lines[0], /could not check/);
  });
});

describe('cancellableSleep', () => {
  it('an abort resolves it at once and clears its timer, so nothing holds the process open (audit R1 H6)', async () => {
    const ac = new AbortController();
    const t0 = Date.now();
    const p = R.cancellableSleep(60_000, ac.signal);
    ac.abort();
    await p;
    assert.ok(Date.now() - t0 < 1000);
    assert.equal(process.getActiveResourcesInfo().filter((x) => x === 'Timeout').length, 0, 'no live timer left');
  });
  it('without an abort it sleeps its time', async () => {
    const t0 = Date.now();
    await R.cancellableSleep(30);
    assert.ok(Date.now() - t0 >= 25);
  });
});

describe('D3: runUnderLease stops waiting for nobody', () => {
  let dir;
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fleet-lease-runners-')); });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }));
  const seed = (lease) => fs.writeFileSync(path.join(dir, 'lease.json'), JSON.stringify(lease, null, 2));
  const fileLease = () => readLease(dir).lease;
  function world() {
    const w = { t: T('08:00'), sleeps: 0, hook: null };
    w.now = () => w.t;
    w.sleep = async (ms) => { w.sleeps += 1; w.t = new Date(w.t.getTime() + ms); if (w.hook) await w.hook(w.sleeps); };
    return w;
  }
  function fakeSignals() {
    const s = { handler: null, installs: 0, removes: 0 };
    s.install = (h) => { s.handler = h; s.installs += 1; return () => { s.handler = null; s.removes += 1; }; };
    s.fire = (sig) => s.handler?.(sig);
    return s;
  }
  const opts = (w, extra = {}) => ({ dir, identity: TRAIN, repo: 'o/a', kind: 'gate', forMin: 30, pid: 700, now: w.now, sleep: w.sleep, probe: probeOf(900, 700), log: () => {}, waitMin: 60, pollMs: 30_000, jitter: 0, ...extra });

  it('a stop signal DURING the wait is handled: the job never runs, the runner leaves the queue, `stopped` with the signal', async () => {
    seed(heldByB());
    const w = world(); const signals = fakeSignals();
    w.hook = (n) => { if (n === 2) signals.fire('SIGTERM'); };
    let ran = false;
    const res = await R.runUnderLease(opts(w, { signals }), async () => { ran = true; });
    assert.equal(ran, false);
    assert.equal(res.outcome, 'not-granted');
    assert.equal(res.code, 'stopped');
    assert.equal(res.signalled, 'SIGTERM');
    assert.equal(signals.installs, 1, 'installed before the wait');
    assert.equal(signals.removes, 1);
    assert.equal(waiterOf(fileLease()), undefined, 'the queue no longer holds it');
  });
  it('a signal that interrupts a long sleep ends the wait at once, not at the next poll', async () => {
    seed(heldByB());
    const w = world(); const signals = fakeSignals();
    let release;
    const hang = new Promise((r) => { release = r; });
    const res = R.runUnderLease(opts(w, { signals, sleep: () => hang }), async () => {});
    await new Promise((r) => setImmediate(r));
    signals.fire('SIGINT');
    const out = await res;
    release();
    assert.equal(out.code, 'stopped');
  });
  it('a stop during a slow launcher check is not held up by it (audit R2 H6)', async () => {
    seed(heldByB());
    const w = world(); const signals = fakeSignals();
    const launcher = { gone: () => { setImmediate(() => signals.fire('SIGTERM')); return new Promise(() => {}); } }; // a table read that never returns
    const res = await R.runUnderLease(opts(w, { signals, launcher }), async () => {});
    assert.equal(res.code, 'stopped');
    assert.equal(waiterOf(fileLease()), undefined);
  });
  it('a second stop signal while waiting forces the exit', async () => {
    seed(heldByB());
    const w = world(); const signals = fakeSignals(); const exits = [];
    const launcher = { gone: () => { setImmediate(() => { signals.fire('SIGINT'); signals.fire('SIGINT'); }); return new Promise(() => {}); } };
    await R.runUnderLease(opts(w, { signals, launcher, forceExit: (c) => exits.push(c) }), async () => {});
    assert.deepEqual(exits, [130]);
  });
  it('the launcher dying mid-wait ends it `orphaned`: the job never runs, the repo leaves the queue', async () => {
    seed(heldByB());
    const w = world();
    let polls = 0;
    const launcher = { gone: async () => { polls += 1; return polls >= 3 ? 'the process that launched it (pid 600) is gone' : null; } };
    let ran = false;
    const res = await R.runUnderLease(opts(w, { signals: fakeSignals(), launcher }), async () => { ran = true; });
    assert.equal(ran, false);
    assert.equal(res.code, 'orphaned');
    assert.match(res.orphaned, /pid 600/);
    assert.equal(waiterOf(fileLease()), undefined);
    assert.equal(fileLease().journal.at(-1).reason, 'cancelled');
  });
  it('a launcher that dies DURING the sleep while the slot frees is caught before the next acquire: never granted (audit R1 H4/H7/H8)', async () => {
    seed(heldByB());
    const w = world();
    let dead = false;
    w.hook = (n) => {
      if (n !== 1) return;
      dead = true; // the train script is killed mid-sleep ...
      L.transactLease(dir, (r) => ({ value: 1, write: ok(decideRelease(r.lease, q(B, { token: 'bbbbbbbbbbbbbbbb' }), w.t, probeOf(700))) })); // ... and the slot frees
    };
    const launcher = { gone: async () => (dead ? 'the process that launched it (pid 600) is gone' : null) };
    let ran = false;
    const res = await R.runUnderLease(opts(w, { signals: fakeSignals(), launcher }), async () => { ran = true; });
    assert.equal(ran, false);
    assert.equal(res.code, 'orphaned');
    assert.equal(fileLease().heavy, null, 'the freed slot was not taken');
  });
  it('giving up at the deadline keeps the repo queued (as before), without a runner pinned to an exited pid', async () => {
    seed(heldByB());
    const w = world();
    const res = await R.runUnderLease(opts(w, { signals: fakeSignals(), waitMin: 1 }), async () => {});
    assert.equal(res.code, 'held');
    assert.equal(res.queued, true);
    const wt = waiterOf(fileLease());
    assert.equal(wt.pidless, true);
    assert.deepEqual(wt.runners, []);
  });
  it('a `priority` refusal is retried: a targeted run waits until the train has gone', async () => {
    // The train waits for the chip's slot; the chip releases; a second chip's run is refused `priority`, retries, and runs after the train.
    const l0 = decideAcquire(heldByChip(), run(TRAIN, 700, { priority: 'high' }), T('08:00'), probeOf(501, 700)).lease;
    seed(ok(decideRelease(l0, q(CHIP, { token: 'cccccccccccccccc' }), T('08:00'), probeOf(700))));
    const w = world();
    const p = probeOf(700, 502);
    w.hook = (n) => {
      if (n !== 1) return;
      // the train takes the slot and finishes between the chip's polls
      const g = L.transactLease(dir, (r) => { const d = decideAcquire(r.lease, run(TRAIN, 700, { priority: 'high', newToken: 'dddddddddddddddd' }), w.t, p); return { value: d.ok, write: d.lease }; });
      assert.equal(g.value, true);
      L.transactLease(dir, (r) => ({ value: 1, write: ok(decideRelease(r.lease, q(TRAIN, { token: 'dddddddddddddddd' }), w.t, p)) }));
    };
    let ran = false;
    const res = await R.runUnderLease(opts(w, { identity: CHIP2, pid: 502, probe: p, signals: fakeSignals() }), async () => { ran = true; });
    assert.equal(ran, true);
    assert.equal(res.outcome, 'ran');
    assert.equal(w.sleeps, 1);
  });
});

describe('leaseRunResult: the two new not-granted outcomes', () => {
  it('stopped while waiting exits 128+n; orphaned exits 75; neither ran', () => {
    const lines = [];
    const s = leaseRunResult({ ran: false, outcome: 'not-granted', code: 'stopped', signalled: 'SIGTERM' }, { say: (m) => lines.push(m) });
    assert.equal(s.exitCode, 143);
    assert.equal(s.ran, false);
    const o = leaseRunResult({ ran: false, outcome: 'not-granted', code: 'orphaned', reason: 'stopped waiting: x' }, { say: (m) => lines.push(m) });
    assert.equal(o.exitCode, 75);
    assert.ok(lines.every((l) => /did NOT run/.test(l)));
  });
});
