/**
 * @fileoverview A long `lease run` never reads EXPIRED, and a stuck slot is shown to a PERSON — never taken automatically
 * (consumer reports 2026-11-15). One consumer's expired holder, alive but idle, refused a waiter 343 times over 38+ minutes;
 * another's recorded pid was a launcher using 0.41 s CPU while a python grandchild worked, so reading the pid alone (or a
 * local-time start time against a UTC expiry) nearly forced a live 2-hour suite.
 *
 *  - `lease run` heartbeats renew the lease while the job's process TREE is not idle, up to a ceiling;
 *  - a tree idle for `treeIdleMs` stops renewing, so the lease expires — and waiters are STILL refused;
 *  - `lease status` prints the tree (UTC start times) and its CPU; the force remedy is suggested only for a measured-idle tree.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  LIMITS, classifyHeavy, decideAcquire, decideHeartbeat, emptyLease, forceSuggestion, nextLines, renderStatus, stuckLines, summarise, treeLines,
} from '../scripts/lib/fleet/lease.mjs';
import { parsePsTable, parseWinTable, processTreeCpuMs, psTimeMs, sampleTree, treeCpuMs, treeOf } from '../scripts/lib/fleet/lease-cpu.mjs';
import { runUnderLease } from '../scripts/lib/fleet/lease-run.mjs';
import { holderTree } from '../scripts/lib/fleet/lease-cmd.mjs';

const NOW = new Date('2026-11-15T10:00:00.000Z');
const at = (min) => new Date(NOW.getTime() + min * 60_000);
const A = { repoKey: 'aaaaaaaaaaaa', holder: 'chip-a' };
const B = { repoKey: 'bbbbbbbbbbbb', holder: 'chip-b' };
const SCOPE = 'win32:box';
const T1 = '1111111111111111';
const probe = { scope: SCOPE, isPidAlive: (p) => p === 42 };

/** A slot A took at NOW for 30 minutes (the default `--for`), pid 42. */
const granted = (extra = {}) => ({
  ...emptyLease(),
  heavy: { holder: A.holder, repoKey: A.repoKey, repo: 'o/a', kind: 'test', scope: SCOPE, pid: 42, token: T1, startedAt: NOW.toISOString(), expiresAt: at(30).toISOString(), ...extra },
});

/** Beat once a minute for `minutes`, CPU from `cpuAt(m)`; returns each minute's classification and the last lease. */
function beatFor(minutes, cpuAt, { ceilingAt = at(12 * 60) } = {}) {
  let lease = granted(); const seen = [];
  for (let m = 1; m <= minutes; m += 1) {
    const d = decideHeartbeat(lease, { identity: A, token: T1, cpuMs: cpuAt(m) }, at(m), { ceilingAt });
    assert.equal(d.ok, true, d.reason);
    lease = d.lease;
    seen.push({ m, state: classifyHeavy(lease.heavy, at(m), probe).state, renewing: d.renewing });
  }
  return { lease, seen };
}

describe('the heartbeat keeps a working run from ever reading EXPIRED', () => {
  it('a 2-hour run with no --for, its tree busy throughout, is HELD at every minute', () => {
    const { seen, lease } = beatFor(120, (m) => m * 1300);
    assert.ok(seen.every((x) => x.state === 'held' && x.renewing), JSON.stringify(seen.find((x) => x.state !== 'held')));
    assert.equal(lease.heavy.expiresAt, at(130).toISOString());
  });

  it('busy means the TREE: a flat launcher with a working grandchild counts as busy', () => {
    const rows = (m) => [{ pid: 42, ppid: 1, cpuMs: 410 }, { pid: 43, ppid: 42, cpuMs: 30 }, { pid: 44, ppid: 43, cpuMs: 1000 + m * 1500 }];
    const { seen } = beatFor(60, (m) => treeCpuMs(rows(m), 42));
    assert.ok(seen.every((x) => x.state === 'held'));
  });

  it('never renews past the ceiling (--timeout)', () => {
    const { lease } = beatFor(90, (m) => m * 100, { ceilingAt: at(60) });
    assert.equal(lease.heavy.expiresAt, at(60).toISOString());
  });

  it('is fenced: a beat with another token, or from another holder, is refused and changes nothing', () => {
    assert.equal(decideHeartbeat(granted(), { identity: A, token: '2222222222222222', cpuMs: 5 }, at(1), { ceilingAt: at(60) }).code, 'stale-token');
    assert.equal(decideHeartbeat(granted(), { identity: B, token: T1, cpuMs: 5 }, at(1), { ceilingAt: at(60) }).code, 'not-holder');
    assert.equal(decideHeartbeat(emptyLease(), { identity: A, token: T1 }, at(1), { ceilingAt: at(60) }).code, 'free');
  });

  it('unreadable CPU keeps renewing (unmeasured is never idle)', () => {
    const { seen } = beatFor(90, () => null);
    assert.ok(seen.every((x) => x.state === 'held' && x.renewing));
  });
});

describe('an idle tree stops renewing; the slot is shown, never stolen', () => {
  // Busy for 10 minutes, then flat: the beat at minute 40 (30 idle) stops renewing; minute 39's renewal expires at 49.
  const idleRun = () => beatFor(70, (m) => Math.min(m, 10) * 1000);

  it('stops renewing after treeIdleMs of no CPU, then expires', () => {
    const { seen } = idleRun();
    assert.equal(seen.find((x) => !x.renewing).m, 10 + LIMITS.treeIdleMs / 60_000);
    assert.equal(seen.find((x) => x.state === 'expired').m, 49);
  });

  it('a waiter is STILL refused (expired-pid-alive): reclaim is a human action', () => {
    const { lease } = idleRun();
    const d = decideAcquire(lease, { identity: B, repo: 'o/b', kind: 'test', forMin: 30, pid: 77 }, at(70), probe);
    assert.equal(d.ok, false);
    assert.equal(d.code, 'expired-pid-alive');
  });

  it('lease status shows "idle" and suggests the force remedy', () => {
    const { lease } = idleRun();
    const s = summarise({ state: 'ok', lease }, at(70), probe);
    const text = renderStatus(s, { dir: 'D', now: at(70), cmd: 'fleet' }).join('\n');
    // Never a bare EXPIRED: the line LEADS with why renewal stopped, and says a quiet tree may be blocked, not lost.
    assert.match(text, /heavy slot: renewal stopped: tree idle 60 min \(since 10:10Z\) — the runner is still beating; the run may be blocked on I\/O or a lock rather than lost\. Lease expired at 10:49Z/);
    assert.doesNotMatch(text, /heavy slot: EXPIRED/);
    assert.match(text, /idle: its whole process tree used no CPU for 60 min — that can be a run blocked on I\/O or a lock.*`fleet lease release --force --reason "<why>"`/);
  });

  it('a CRASHED runner reads differently: its heartbeat went stale, and nothing suggests forcing on idleness', () => {
    // Busy throughout, then the runner dies at minute 20: no beat after that; the last renewal (minute 20) expires at 30.
    const { lease } = beatFor(20, (m) => m * 1000);
    const s = summarise({ state: 'ok', lease }, at(45), probe);
    const text = renderStatus(s, { dir: 'D', now: at(45), cmd: 'fleet' }).join('\n');
    assert.match(text, /heavy slot: EXPIRED at 10:30Z .*heartbeat STOPPED at 10:20Z \(25 min ago\): the lease run runner is gone or frozen/);
    assert.doesNotMatch(text, /renewal stopped/);
    assert.doesNotMatch(text, /--force/);
  });

  it('past stuckRefusals, next names the holder WITH the remedy for a measured-idle tree', () => {
    const { lease } = idleRun();
    const l = { ...lease, waiters: [{ repoKey: B.repoKey, repo: 'o/b', by: 'chip-b@o/b', since: at(50).toISOString(), forMin: 30, refusals: LIMITS.stuckRefusals }] };
    const line = nextLines({ state: 'ok', lease: l }, at(70), { cmd: 'fleet', probe }).find((x) => /heavy slot is blocked/.test(x));
    assert.match(line, /chip-a \(o\/a\) expired at 10:49Z, pid 42/);
    assert.match(line, /o\/b has been refused 20 times/);
    assert.match(line, /lease release --force/);
  });
});

describe('without a measured-idle tree, nothing suggests forcing', () => {
  const noBeat = { ...granted({ expiresAt: at(-1).toISOString() }), waiters: [{ repoKey: B.repoKey, repo: 'o/b', by: 'chip-b@o/b', since: at(0).toISOString(), forMin: 30, refusals: 500 }] };
  it('an expired live holder with no heartbeat: named, pointed at lease status, no --force', () => {
    const s = summarise({ state: 'ok', lease: noBeat }, at(40), probe);
    assert.equal(forceSuggestion(s), null);
    const [line] = stuckLines(s, { cmd: 'fleet' });
    assert.match(line, /not measured here — `fleet lease status` shows its process tree and CPU/);
    assert.doesNotMatch(line, /--force/);
  });
  it('a held slot, or one below the refusal threshold, says nothing', () => {
    assert.deepEqual(stuckLines(summarise({ state: 'ok', lease: { ...noBeat, waiters: [{ ...noBeat.waiters[0], refusals: LIMITS.stuckRefusals - 1 }] } }, at(40), probe)), []);
    assert.deepEqual(stuckLines(summarise({ state: 'ok', lease: { ...noBeat, heavy: { ...noBeat.heavy, expiresAt: at(90).toISOString() } } }, at(40), probe)), []);
  });
});

describe('notes carry their write time', () => {
  it('an acquire with --note shows "(note from HH:MMZ)"', () => {
    const d = decideAcquire(emptyLease(), { identity: A, repo: 'o/a', kind: 'test', forMin: 30, note: 'full suite' }, at(5), probe);
    const text = renderStatus(summarise({ state: 'ok', lease: d.lease }, at(20), probe), { dir: 'D', now: at(20) }).join('\n');
    assert.match(text, /— full suite \(note from 10:05Z\)/);
  });
});

describe('runUnderLease beats while the job runs, and stops with it', () => {
  it('calls decideHeartbeat on its timer with the CHILD tree, and cancels the timer after the job', async () => {
    let lease = emptyLease();
    const transact = (_d, fn) => { const r = fn({ state: 'ok', lease }); if (r.write) lease = r.write; return { ok: true, value: r.value }; };
    let tick = null; let cancelled = false;
    const timers = { every: (_ms, fn) => { tick = fn; return 1; }, cancel: () => { cancelled = true; } };
    const cpuFor = []; let clock = NOW.getTime();
    const res = await runUnderLease({
      dir: 'D', identity: A, repo: 'o/a', kind: 'test', pid: 4000, probe, transact, timers, signals: { install: () => () => {} },
      now: () => new Date(clock), cpuOf: (p) => { cpuFor.push(p); return clock; }, heartbeatMs: 60_000,
    }, async ({ attach }) => {
      await attach(42);
      for (let m = 1; m <= 120; m += 1) { clock = at(m).getTime(); await tick(); assert.equal(classifyHeavy(lease.heavy, at(m), probe).state, 'held', `minute ${m}`); }
      return 0;
    });
    assert.equal(res.ran, true);
    assert.ok(cpuFor.length >= 120 && cpuFor.every((p) => p === 42));
    assert.equal(cancelled, true);
    assert.equal(lease.heavy, null);
  });
});

describe('heartbeat robustness (audit R1 H5/H6/H7)', () => {
  const harness = (cpuOf, transactOverride) => {
    let lease = emptyLease();
    const real = (_d, fn) => { const r = fn({ state: 'ok', lease }); if (r.write) lease = r.write; return { ok: true, value: r.value }; };
    let beatsLeft = 0;
    const transact = (d, fn) => (transactOverride && beatsLeft-- > 0 ? transactOverride(d, fn) : real(d, fn));
    let tick = null;
    const logs = [];
    const run = runUnderLease({
      dir: 'D', identity: A, repo: 'o/a', kind: 'test', pid: 4000, probe, transact, signals: { install: () => () => {} },
      timers: { every: (_ms, fn) => { tick = fn; return 1; }, cancel: () => {} }, now: () => NOW, cpuOf, heartbeatMs: 60_000, log: (l) => logs.push(l),
    }, async ({ attach }) => { await attach(42); beatsLeft = 3; await tick(); await tick(); await tick(); await tick(); return 0; });
    return { run, logs, lease: () => lease };
  };
  it('a throwing CPU probe never escapes the timer: the job finishes, the slot is released, and it is said once', async () => {
    const h = harness(() => { throw new Error('powershell gone'); });
    const res = await h.run;
    assert.equal(res.ran, true);
    assert.equal(h.lease().heavy, null);
    assert.equal(h.logs.filter((l) => /heartbeat failed \(powershell gone\)/.test(l)).length, 1);
  });
  it('lock contention is said once per streak, then recovery is said', async () => {
    const h = harness(() => ({ cpuMs: 5, procs: 'x' }), () => ({ ok: false }));
    await h.run;
    assert.equal(h.logs.filter((l) => /heartbeat not recorded \(could not take the lease lock/.test(l)).length, 1);
    assert.ok(h.logs.includes('heartbeat recorded again'));
  });
  it('flat CPU but a changing process set counts as activity: a run of short-lived workers keeps renewing', () => {
    let lease = granted();
    for (let m = 1; m <= 60; m += 1) {
      const d = decideHeartbeat(lease, { identity: A, token: T1, cpuMs: 500, procs: `gen-${m}` }, at(m), { ceilingAt: at(600) });
      lease = d.lease;
      assert.equal(d.renewing, true, `minute ${m}`);
    }
  });
  it('a status sample in which processes came and went never says "no CPU"', () => {
    const text = treeLines({ measured: true, tree: [{ pid: 42, name: 'node', startedAt: null, cpuMs: 1, depth: 0 }], cpuMs: 0, windowMs: 5000, started: 2, exited: 2 }).join('\n');
    assert.match(text, /busy: processes started \(2\) or exited \(2\) in the last 5\.0 s/);
    assert.doesNotMatch(text, /no CPU/);
  });
});

describe('process tree (lease-cpu.mjs)', () => {
  const WIN = ['10 1 100000 2026-11-15T09:00:00Z explorer.exe', '42 10 4100000 2026-11-15T10:00:01Z node.exe', '43 42 300000 2026-11-15T10:00:02Z cmd.exe',
    '44 43 250000000 2026-11-15T10:00:03Z python.exe', '99 1 999999999 - System Idle Process', 'junk'].join('\r\n');
  it('parses the Windows table (UTC starts, names with spaces) and orders the tree launcher-first', () => {
    const rows = parseWinTable(WIN);
    assert.equal(rows.find((r) => r.pid === 99).name, 'System Idle Process');
    assert.equal(rows.find((r) => r.pid === 99).startedAt, null);
    const t = treeOf(rows, 42);
    assert.deepEqual(t.map((r) => [r.pid, r.depth, r.name]), [[42, 0, 'node.exe'], [43, 1, 'cmd.exe'], [44, 2, 'python.exe']]);
    assert.equal(treeCpuMs(rows, 42), 410 + 30 + 25_000);
    assert.equal(treeOf(rows, 7), null);
  });
  it('ps: CPU and elapsed time, start = reading clock minus elapsed (UTC)', () => {
    assert.equal(psTimeMs('1-02:00:00'), 26 * 3_600_000);
    assert.equal(psTimeMs('3:04.50'), 184_500);
    const [r] = parsePsTable('  42     1 00:00:03 01:00:00 python3 -m pytest\n', Date.parse('2026-11-15T12:00:00Z'));
    assert.deepEqual(r, { pid: 42, ppid: 1, cpuMs: 3000, startedAt: '2026-11-15T11:00:00Z', name: 'python3 -m pytest' });
  });
  it('is cycle-safe', () => {
    assert.equal(treeCpuMs([{ pid: 1, ppid: 2, cpuMs: 5 }, { pid: 2, ppid: 1, cpuMs: 7 }], 1), 12);
  });
  it('a failed table read is null, never 0', () => {
    assert.equal(processTreeCpuMs(42, { platform: 'linux', spawnSync: () => ({ status: 1, stdout: '' }) }), null);
    assert.equal(processTreeCpuMs(42, { platform: 'win32', spawnSync: () => { throw new Error('no powershell'); } }), null);
    assert.equal(processTreeCpuMs(0), null);
  });
  it('sampleTree measures the tree over a window; status renders busy or no CPU', async () => {
    const reads = [parseWinTable(WIN), parseWinTable(WIN.replace('250000000', '263000000'))];
    let t = 0;
    const s = await sampleTree(42, { sampleMs: 5000, read: () => reads.shift(), sleep: async () => { t += 5000; }, clock: () => t });
    assert.equal(s.cpuMs, 1300);
    const text = treeLines(s).join('\n');
    assert.match(text, /pid 42 node\.exe {2}started 10:00:01Z 2026-11-15/);
    assert.match(text, / {6}pid 44 python\.exe/);
    assert.match(text, /tree CPU: busy: 1\.3 s CPU \/ 5\.0 s/);
    const flat = await sampleTree(42, { read: () => parseWinTable(WIN), sleep: async () => { t += 5000; }, clock: () => t });
    assert.match(treeLines(flat).join('\n'), /no CPU in the last 5\.0 s/);
    assert.equal((await sampleTree(7, { read: () => parseWinTable(WIN), sleep: async () => {} })).measured, false);
  });
  it('lease status samples only a pid in this process scope, and FLEET_LEASE_SAMPLE_MS=0 turns it off', async () => {
    const s = summarise({ state: 'ok', lease: granted() }, at(5), probe);
    const sample = async () => ({ measured: true, tree: [], cpuMs: 0, windowMs: 1 });
    assert.equal(await holderTree(s, { ...probe, scope: 'linux:other' }, {}, { sample }), null);
    assert.equal(await holderTree(s, probe, { FLEET_LEASE_SAMPLE_MS: '0' }, { sample }), null);
    assert.equal((await holderTree(s, probe, {}, { sample })).measured, true);
  });
});

describe('audit R2: sampling gaps, process identity, self-observation', () => {
  it('a beat whose sample failed keeps the last good one: flicker neither restarts nor advances the idle clock (M4)', () => {
    let lease = granted();
    const beatAt = (m, cpuMs) => { const d = decideHeartbeat(lease, { identity: A, token: T1, cpuMs, procs: 'same' }, at(m), { ceilingAt: at(600) }); lease = d.lease; return d; };
    beatAt(1, 100);
    for (let m = 2; m <= 40; m += 1) assert.equal(beatAt(m, null).renewing, true, `minute ${m}: unmeasured is never idle`);
    assert.equal(lease.heavy.beat.cpuMs, 100);
    // The next good sample shows no growth since minute 1: idle is measured from there, so renewal stops at once.
    assert.equal(beatAt(41, 100).renewing, false);
  });

  it('the membership digest ignores reconstructed start times (H3): two ps reads a second apart agree', async () => {
    const { membershipDigest, parsePsTable: parse } = await import('../scripts/lib/fleet/lease-cpu.mjs');
    const text = '  42     1 00:00:03 01:00:00 python\n  43    42 00:00:01 00:59:59 worker\n';
    const a = treeOf(parse(text, Date.parse('2026-11-15T12:00:00.400Z')), 42);
    const b = treeOf(parse(text.replace('01:00:00', '01:00:01'), Date.parse('2026-11-15T12:00:01.600Z')), 42);
    assert.equal(membershipDigest(a), membershipDigest(b));
  });

  it('this process\'s own sampler is dropped from the table (H2): a runner sampling itself is not "busy" forever', async () => {
    const { tableFrom } = await import('../scripts/lib/fleet/lease-cpu.mjs');
    const rows = tableFrom(['100 1 5 2026-11-15T10:00:00Z node.exe', '200 100 1 2026-11-15T10:05:00Z powershell.exe', '300 100 1 2026-11-15T10:05:00Z python.exe'].join('\n'), { win: true, selfPid: 100 });
    assert.deepEqual(treeOf(rows, 100).map((r) => r.pid), [100, 300]);
  });

  it('processTreeActivity is asynchronous and reads through the injected table (M3)', async () => {
    const { processTreeActivity } = await import('../scripts/lib/fleet/lease-cpu.mjs');
    const act = await processTreeActivity(42, { read: async () => parseWinTable('42 1 20000 2026-11-15T10:00:00Z node.exe\n43 42 30000 - py.exe') });
    assert.equal(act.cpuMs, 5);
    assert.match(act.procs, /^[0-9a-f]{16}$/);
    assert.equal(await processTreeActivity(42, { read: async () => null }), null);
  });
});
