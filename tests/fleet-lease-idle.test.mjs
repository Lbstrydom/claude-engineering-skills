/**
 * @fileoverview An expired holder whose pid is ALIVE but IDLE is reclaimable (consumer report 2026-11-15: such a holder
 * refused every waiter with `expired-pid-alive` for 38+ minutes, 343 refusals for one waiter). Idle means the holder's
 * process TREE used no CPU for `idleGraceMs`, watched continuously; a live holder whose CPU moves, or cannot be read, keeps
 * the slot exactly as before. Past `stuckRefusals` refusals, `next` names the holder and `lease release --force`.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { LIMITS, classifyHeavy, decideAcquire, emptyLease, nextLines, stuckLines, summarise } from '../scripts/lib/fleet/lease.mjs';
import { memoCpuOf, parsePsTable, parseWinTable, processTreeCpuMs, psTimeMs, treeCpuMs } from '../scripts/lib/fleet/lease-cpu.mjs';

const NOW = new Date('2026-11-15T10:00:00.000Z');
const at = (min) => new Date(NOW.getTime() + min * 60_000);
const A = { repoKey: 'aaaaaaaaaaaa', holder: 'chip-a' };
const B = { repoKey: 'bbbbbbbbbbbb', holder: 'chip-b' };
const SCOPE = 'win32:box';
const T1 = '1111111111111111';

/** A slot A took 31 minutes before NOW for 30 minutes: it expired at NOW-1m, pid 42. */
const expired = () => ({
  ...emptyLease(),
  heavy: { holder: A.holder, repoKey: A.repoKey, repo: 'o/a', kind: 'gate', scope: SCOPE, pid: 42, token: T1, startedAt: at(-31).toISOString(), expiresAt: at(-1).toISOString() },
});
const probeWith = (cpuAt) => ({ scope: SCOPE, isPidAlive: (p) => p === 42, cpuOf: (p) => (p === 42 ? cpuAt() : null) });

/** B asks once a minute for `minutes` minutes, persisting each decision's lease like `lease run` does. */
function poll(lease, probe, minutes, { clock = (m) => at(m) } = {}) {
  let cur = lease; const out = [];
  for (let m = 0; m <= minutes; m += 1) {
    const d = decideAcquire(cur, { identity: B, repo: 'o/b', kind: 'gate', forMin: 30, pid: 77 }, clock(m), probe.at ? probe.at(m) : probe);
    out.push({ m, d });
    if (d.lease) cur = d.lease;
    if (d.ok) break;
  }
  return { out, lease: cur };
}

describe('an expired, live but IDLE holder is reclaimed after the grace period', () => {
  it('flat CPU, watched every minute: refused until idleGraceMs, then taken over and journaled', () => {
    const { out } = poll(expired(), probeWith(() => 1234), 15);
    const grant = out.find((x) => x.d.ok);
    assert.ok(grant, 'never granted');
    assert.equal(grant.m, LIMITS.idleGraceMs / 60_000);
    for (const x of out.filter((y) => !y.d.ok)) assert.equal(x.d.code, 'expired-pid-alive');
    assert.equal(grant.d.event.kind, 'taken-over');
    assert.match(grant.d.event.reason, /pid 42 is running but its process tree has used no CPU for 10 minutes/);
    const j = grant.d.lease.journal.at(-1);
    assert.equal(j.kind, 'acquired');
    assert.equal(j.mode, 'taken-over');
  });

  it('a WORKING holder (CPU moving) is never reclaimed — the conservative default', () => {
    let cpu = 0;
    const { out } = poll(expired(), { scope: SCOPE, isPidAlive: (p) => p === 42, cpuOf: () => (cpu += 50) }, 40);
    assert.ok(out.every((x) => !x.d.ok && x.d.code === 'expired-pid-alive'));
  });

  it('unreadable CPU, or a probe without cpuOf, never reads idle', () => {
    assert.ok(poll(expired(), probeWith(() => null), 40).out.every((x) => !x.d.ok));
    assert.ok(poll(expired(), { scope: SCOPE, isPidAlive: (p) => p === 42 }, 40).out.every((x) => !x.d.ok));
  });

  it('an observation gap longer than idleObserveGapMs restarts the watch (a sleeping laptop is not idleness)', () => {
    // Polls at 0..4, then nothing until 30 (asleep), then every minute: the grant comes 10 minutes after the wake, not at once.
    const times = [0, 1, 2, 3, 4, 30, 31, 32, 33, 34, 35, 36, 37, 38, 39, 40, 41];
    const { out } = poll(expired(), probeWith(() => 1234), times.length - 1, { clock: (i) => at(times[i]) });
    const grant = out.find((x) => x.d.ok);
    assert.equal(times[grant.m], 40);
  });

  it('classifyHeavy alone (a read-only summarise) never turns a fresh watch into idle', () => {
    const cls = classifyHeavy(expired().heavy, at(30), probeWith(() => 1234));
    assert.equal(cls.verdict, 'pid-alive');
  });
});

describe('a stuck slot is named, with the remedy, past stuckRefusals', () => {
  const withWaiter = (refusals) => ({
    ...expired(),
    waiters: [{ repoKey: B.repoKey, repo: 'o/b', by: 'chip-b@o/b', since: at(0).toISOString(), forMin: 30, refusals }],
  });
  const alive = { scope: SCOPE, isPidAlive: (p) => p === 42 };
  it('names holder, pid, refusals and `lease release --force` in next', () => {
    const lines = nextLines({ state: 'ok', lease: withWaiter(LIMITS.stuckRefusals) }, at(5), { cmd: 'fleet', probe: alive });
    const stuck = lines.find((l) => /STUCK/.test(l));
    assert.ok(stuck, lines.join('\n'));
    assert.match(stuck, /chip-a \(o\/a\) expired at 09:59Z, pid 42/);
    assert.match(stuck, /o\/b has been refused 20 times/);
    assert.match(stuck, /`fleet lease release --force --reason "<why>"`/);
  });
  it('is silent below the threshold, and when the slot is merely held', () => {
    assert.deepEqual(stuckLines(summarise({ state: 'ok', lease: withWaiter(LIMITS.stuckRefusals - 1) }, at(5), alive)), []);
    const live = { ...withWaiter(500), heavy: { ...expired().heavy, expiresAt: at(60).toISOString() } };
    assert.deepEqual(stuckLines(summarise({ state: 'ok', lease: live }, at(5), alive)), []);
  });
});

describe('process-tree CPU (lease-cpu.mjs)', () => {
  it('sums the TREE: a wrapper whose own CPU is flat still reads busy through its child', () => {
    const rows = parseWinTable(['10 1 100000', '42 10 0', '43 42 250000000', '44 43 50000000', '99 1 999999999', 'junk'].join('\r\n'));
    assert.equal(treeCpuMs(rows, 42), 30_000);
    assert.equal(treeCpuMs(rows, 7), null);
  });
  it('is cycle-safe', () => {
    assert.equal(treeCpuMs([{ pid: 1, ppid: 2, cpuMs: 5 }, { pid: 2, ppid: 1, cpuMs: 7 }], 1), 12);
  });
  it('parses ps cumulative time', () => {
    assert.equal(psTimeMs('00:01:02'), 62_000);
    assert.equal(psTimeMs('1-02:00:00'), 26 * 3_600_000);
    assert.equal(psTimeMs('3:04.50'), 184_500);
    assert.equal(psTimeMs('x'), null);
    assert.deepEqual(parsePsTable('  42     1 00:00:03\n'), [{ pid: 42, ppid: 1, cpuMs: 3000 }]);
  });
  it('a failed process-table read is null, never 0', () => {
    assert.equal(processTreeCpuMs(42, { platform: 'linux', spawnSync: () => ({ status: 1, stdout: '' }) }), null);
    assert.equal(processTreeCpuMs(42, { platform: 'win32', spawnSync: () => { throw new Error('no powershell'); } }), null);
    assert.equal(processTreeCpuMs(0), null);
  });
  it('memoises per pid within the ttl', () => {
    let calls = 0; let t = 0;
    const f = memoCpuOf({ ttlMs: 1000, clock: () => t, measure: () => { calls += 1; return 5; } });
    f(1); f(1); t = 2000; f(1);
    assert.equal(calls, 2);
  });
});
