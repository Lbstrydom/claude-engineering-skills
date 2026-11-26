/**
 * Unit tests for the hang guard (scripts/lib/test-hang-guard.mjs) and the runner's use of it, plus the LIMITS test: the
 * per-test limit, the idle watchdog and the CI job cap must stay in that order, because nested budgets that reach the outer
 * cap read as "flaky" instead of failing by name. Plan: docs/plans/test-runner-hang-guard.md (revision 2). The real-runner
 * controls are in tests/run-tests-hang-controls.test.mjs.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { EventEmitter } from 'node:events';

import {
  PROFILES, callerTestTimeout, childrenToSweep, createIdleWatchdog, createProgressTracker, describeInFlight, describeStalls,
  findStalls, identityMatches, isNodeTestFileName, reconcileRecord, resolveLimits, timedOutFiles,
} from '../scripts/lib/test-hang-guard.mjs';
import { SCRUBBED_RUNNER_ENV, adjudicateRun, finishRun, runSupervised, sweepOrphans } from '../scripts/run-tests.mjs';
import { GUARD_REPORT_VERSION } from '../scripts/lib/test-guard-reporter.mjs';

const ROOT = path.join(import.meta.dirname, '..');

/** A tiny event writer that numbers lines per proc, like the preload. */
function writer() {
  const seq = new Map();
  return (o) => {
    const n = (seq.get(o.proc) ?? 0) + 1;
    seq.set(o.proc, n);
    return JSON.stringify({ v: 1, seq: n, file: `/r/${o.proc}.test.mjs`, ...o });
  };
}
const feedAll = (lines) => { const t = createProgressTracker(); t.feed(`${lines.join('\n')}\n`); return t; };
const none = new Set();

describe('a caller\'s --test-timeout is node\'s own, read from node\'s option region only', () => {
  it('both spellings; a token after -- is a file; a bare flag; Infinity', () => {
    assert.deepEqual(callerTestTimeout(['--test-timeout=5000', 'a.test.mjs']), { present: true, ms: 5000 });
    assert.deepEqual(callerTestTimeout(['--test-timeout', '7000']), { present: true, ms: 7000 });
    assert.equal(callerTestTimeout(['a.test.mjs', '--', '--test-timeout=5']).present, false);
    assert.deepEqual(callerTestTimeout(['--test-timeout']), { present: true, ms: null });
    assert.equal(callerTestTimeout(['--test-timeout=Infinity']).ms, Infinity);
  });
  it('a repeated option keeps the LAST occurrence, as node does', () => {
    assert.deepEqual(callerTestTimeout(['--test-timeout=1000', '--test-timeout', '2000', '--test-timeout=3000']), { present: true, ms: 3000 });
    assert.deepEqual(callerTestTimeout(['--test-timeout', '2000', 'a.test.mjs']), { present: true, ms: 2000 });
  });
});

describe('resolveLimits', () => {
  it('picks the profile from CI=true', () => {
    assert.equal(resolveLimits({ env: { CI: 'true' }, argv: [] }).stallMs, PROFILES.ci.stallMs);
    assert.equal(resolveLimits({ env: {}, argv: [] }).stallMs, PROFILES.local.stallMs);
    assert.equal(resolveLimits({ env: { CI: '1' }, argv: [] }).profile, 'local', 'only GitHub\'s exact value selects ci');
  });
  it('a caller timeout leaves the stall limit alone and raises the watchdog only above the threshold', () => {
    const small = resolveLimits({ env: { CI: 'true' }, argv: ['--test-timeout=4000'] });
    assert.equal(small.stallMs, PROFILES.ci.stallMs);
    assert.equal(small.watchdogMs, PROFILES.ci.watchdogMs, '4 s + gap is below the profile watchdog');
    assert.equal(small.fileTimeoutMs, 4000);
    const big = resolveLimits({ env: { CI: 'true' }, argv: ['--test-timeout=900000'] });
    assert.equal(big.stallMs, PROFILES.ci.stallMs);
    assert.equal(big.watchdogMs, 900_000 + PROFILES.ci.gapMs);
    assert.equal(resolveLimits({ env: {}, argv: ['--test-timeout=Infinity'] }).watchdogMs, PROFILES.local.watchdogMs);
  });
  it('explicit overrides win; anything but a positive integer throws, and there is no "off"', () => {
    const r = resolveLimits({ env: { TEST_STALL_TIMEOUT_MS: '3000', TEST_IDLE_WATCHDOG_MS: '4000' }, argv: ['--test-timeout=900000'] });
    assert.deepEqual([r.stallMs, r.stallSource, r.watchdogMs, r.watchdogSource], [3000, 'env', 4000, 'env']);
    for (const bad of ['0', '-1', 'abc', '1.5', 'off', '1e3']) {
      assert.throws(() => resolveLimits({ env: { TEST_IDLE_WATCHDOG_MS: bad }, argv: [] }), /positive integer/, bad);
      assert.throws(() => resolveLimits({ env: { TEST_STALL_TIMEOUT_MS: bad }, argv: [] }), /positive integer/, bad);
    }
  });
  it('both overrides are scrubbed from the test children, so a nested runner never inherits them', () => {
    for (const k of ['TEST_IDLE_WATCHDOG_MS', 'TEST_STALL_TIMEOUT_MS', 'TEST_PROGRESS_EXTRA_FILES']) assert.ok(SCRUBBED_RUNNER_ENV.includes(k), k);
  });
  it('the preload\'s eligibility follows node\'s default test-file patterns', () => {
    for (const ok of ['/r/a.test.mjs', '/r/a.test.cjs', '/r/a-test.js', '/r/a_test.mjs', '/r/test-a.js', '/r/test.js', '/r/test/x.mjs']) assert.ok(isNodeTestFileName(ok), ok);
    for (const no of ['/r/scripts/run.mjs', '/r/a.test.ts', '/r/latest.mjs', '/r/tests/helper.mjs']) assert.ok(!isNodeTestFileName(no), no);
  });
});

describe('the progress tracker', () => {
  it('reassembles lines split across chunks', () => {
    const w = writer();
    const text = `${[w({ ev: 'load', proc: 'a', pid: 1, at: 0 }), w({ ev: 'start', proc: 'a', id: 1, name: 't', at: 0 })].join('\n')}\n`;
    const t = createProgressTracker();
    for (const ch of text.match(/.{1,7}/gs)) t.feed(ch);
    assert.equal(t.procs.get('a').active.size, 1);
    assert.equal(t.torn, 0);
  });
  it('pairs by id: two concurrent same-named instances ending out of order leave the right one running', () => {
    // The instances start at DIFFERENT times so the survivor is identifiable: pairing by name would close instance 1 (the
    // hung one, started at 0) when instance 2 ends, and leave instance 2 (started at 1000) looking 1 s younger than the truth.
    // With identical start times the two outcomes print identically, which is why the real-runner control cannot pin this.
    const w = writer();
    const t = feedAll([
      w({ ev: 'load', proc: 'a', pid: 1, at: 0 }),
      w({ ev: 'start', proc: 'a', id: 1, name: 'pair > same', at: 0 }),
      w({ ev: 'start', proc: 'a', id: 2, name: 'pair > same', at: 1000 }),
      w({ ev: 'end', proc: 'a', id: 2, name: 'pair > same', at: 1050 }),
    ]);
    const { stalls } = findStalls(t, { now: 10_000, stallMs: 3000, stopped: none });
    assert.deepEqual(stalls.map((s) => s.overdue), [[{ name: 'pair > same', ageMs: 10_000 }]]);
  });
  it('times each instance from its own start, never reset: a parent that keeps finishing subtests is still bounded', () => {
    const w = writer();
    const lines = [w({ ev: 'load', proc: 'a', pid: 1, at: 0 }), w({ ev: 'start', proc: 'a', id: 1, name: 'parent', at: 0 })];
    for (let i = 0; i < 20; i += 1) {
      lines.push(w({ ev: 'start', proc: 'a', id: i + 2, name: `parent > kid ${i}`, at: i * 500 }));
      lines.push(w({ ev: 'end', proc: 'a', id: i + 2, name: `parent > kid ${i}`, at: i * 500 + 100 }));
    }
    const { stalls } = findStalls(feedAll(lines), { now: 10_000, stallMs: 3000, stopped: none });
    assert.deepEqual(stalls[0].overdue, [{ name: 'parent', ageMs: 10_000 }]);
  });
  it('lists every overdue instance, deepest name first', () => {
    const w = writer();
    const t = feedAll([
      w({ ev: 'load', proc: 'a', pid: 1, at: 0 }),
      w({ ev: 'start', proc: 'a', id: 1, name: 'outer', at: 0 }),
      w({ ev: 'start', proc: 'a', id: 2, name: 'outer > inner', at: 0 }),
    ]);
    assert.deepEqual(findStalls(t, { now: 5000, stallMs: 3000, stopped: none }).stalls[0].overdue.map((o) => o.name), ['outer > inner', 'outer']);
  });
  it('a child outside any test is timed from its last event; an exited or already-stopped child never is', () => {
    const w = writer();
    const t = feedAll([
      w({ ev: 'load', proc: 'idle', pid: 1, at: 0 }),
      w({ ev: 'load', proc: 'gone', pid: 2, at: 0 }), w({ ev: 'exit', proc: 'gone', at: 1 }),
      w({ ev: 'load', proc: 'done', pid: 3, at: 0 }), w({ ev: 'start', proc: 'done', id: 1, name: 'x', at: 0 }),
    ]);
    const { stalls } = findStalls(t, { now: 5000, stallMs: 3000, stopped: new Set(['done']) });
    assert.deepEqual(stalls.map((s) => [s.proc, s.overdue.length]), [['idle', 0]]);
    assert.match(describeStalls(stalls.map((s) => ({ ...s, stopped: true })), { stallMs: 3000 }).join('\n'), /outside any test/);
  });
  it('a seq gap means a lost line: the proc is never stall-killed and is reported apart', () => {
    const t = feedAll([
      JSON.stringify({ v: 1, seq: 1, proc: 'a', file: '/r/a.test.mjs', ev: 'load', pid: 1, at: 0 }),
      JSON.stringify({ v: 1, seq: 3, proc: 'a', file: '/r/a.test.mjs', ev: 'start', id: 1, name: 't', at: 0 }),
    ]);
    const r = findStalls(t, { now: 5000, stallMs: 3000, stopped: none });
    assert.deepEqual(r.stalls, []);
    assert.deepEqual(r.gaps.map((g) => g.proc), ['a']);
  });
  it('a reused pid under a different nonce is a different process; torn lines are counted, not fatal', () => {
    const w = writer();
    const t = feedAll([
      w({ ev: 'load', proc: 'old', pid: 5, at: 0 }), w({ ev: 'exit', proc: 'old', at: 1 }),
      w({ ev: 'load', proc: 'new', pid: 5, at: 2 }), w({ ev: 'start', proc: 'new', id: 1, name: 't', at: 2 }),
      '{"v":1,"ev":"sta',
    ]);
    assert.equal(t.procs.get('old').exited, true);
    assert.equal(t.procs.get('new').active.size, 1);
    assert.equal(t.torn, 1);
    assert.match(describeInFlight(t, { now: 4000 }).join('\n'), /- t\s+in \/r\/new\.test\.mjs \(pid 5\), running 4s[\s\S]*1 progress line/);
  });
  it('ignores a record whose parent is not the runner (a helper a test spawned with the preload)', () => {
    const w = writer();
    const t = feedAll([
      w({ ev: 'load', proc: 'mine', pid: 1, ppid: 100, at: 0 }), w({ ev: 'start', proc: 'mine', id: 1, name: 't', at: 0 }),
      w({ ev: 'load', proc: 'helper', pid: 2, ppid: 1, at: 0 }), w({ ev: 'start', proc: 'helper', id: 1, name: 'h', at: 0 }),
    ]);
    t.setOwner(100);
    assert.deepEqual(findStalls(t, { now: 5000, stallMs: 3000, stopped: none }).stalls.map((s) => s.proc), ['mine']);
  });
  it('a later load under the same pid supersedes a record that never exited: it is never a candidate again', () => {
    const w = writer();
    const t = feedAll([
      w({ ev: 'load', proc: 'old', pid: 5, at: 0 }), w({ ev: 'start', proc: 'old', id: 1, name: 'killed by node', at: 0 }),
      w({ ev: 'load', proc: 'new', pid: 5, at: 4000 }), w({ ev: 'start', proc: 'new', id: 1, name: 'fresh', at: 4000 }),
    ]);
    assert.equal(t.procs.get('old').superseded, true);
    assert.deepEqual(findStalls(t, { now: 5000, stallMs: 3000, stopped: none }).stalls, []);
    assert.deepEqual(childrenToSweep(t, { timedOut: [], sameFile: (a, b) => a === b, stopped: none }).map((c) => c.pid), [5]);
  });
  it('an empty record says no progress was recorded, which is not the same as naming a test', () => {
    assert.deepEqual(describeInFlight(createProgressTracker(), { now: 0 }), ['  no progress was recorded: no test file had loaded.']);
  });
});

describe('the end-of-run record check (a passing run must have a complete record)', () => {
  const id = (p) => p;
  it('is empty for a complete record', () => {
    const w = writer();
    const t = feedAll([w({ ev: 'load', proc: 'a', pid: 1, at: 0 }), w({ ev: 'exit', proc: 'a', at: 1 })]);
    assert.deepEqual(reconcileRecord(t, { ran: ['/r/a.test.mjs'], eligible: () => true, fold: id }), []);
  });
  it('names a file that ran with no load record, and a record with no exit', () => {
    const w = writer();
    const t = feedAll([w({ ev: 'load', proc: 'a', pid: 1, at: 0 }), w({ ev: 'start', proc: 'a', id: 1, name: 't', at: 0 })]);
    assert.deepEqual(reconcileRecord(t, { ran: ['/r/a.test.mjs', '/r/silent.test.mjs', '/r/x.mjs'], eligible: (f) => f.endsWith('.test.mjs'), fold: id }), [
      '/r/silent.test.mjs: ran, but no progress record (load) arrived',
      '/r/a.test.mjs (pid 1): no exit record, so its record is incomplete',
    ]);
  });
  it('a lost start, a lost load or a lost end each make the record incomplete, even when exit arrived', () => {
    const t = feedAll([
      // lost start (seq 2): end and exit arrive
      JSON.stringify({ v: 1, seq: 1, proc: 'gap', file: '/r/gap.test.mjs', ev: 'load', pid: 1, at: 0 }),
      JSON.stringify({ v: 1, seq: 3, proc: 'gap', file: '/r/gap.test.mjs', ev: 'end', id: 1, name: 't', at: 1 }),
      JSON.stringify({ v: 1, seq: 4, proc: 'gap', file: '/r/gap.test.mjs', ev: 'exit', at: 2 }),
      // lost load (seq 1)
      JSON.stringify({ v: 1, seq: 2, proc: 'noload', file: '/r/noload.test.mjs', ev: 'exit', at: 2 }),
      // lost end: exited with a test still open
      JSON.stringify({ v: 1, seq: 1, proc: 'noend', file: '/r/noend.test.mjs', ev: 'load', pid: 3, at: 0 }),
      JSON.stringify({ v: 1, seq: 2, proc: 'noend', file: '/r/noend.test.mjs', ev: 'start', id: 1, name: 't', at: 0 }),
      JSON.stringify({ v: 1, seq: 3, proc: 'noend', file: '/r/noend.test.mjs', ev: 'exit', at: 1 }),
    ]);
    const out = reconcileRecord(t, { ran: ['/r/gap.test.mjs', '/r/noload.test.mjs', '/r/noend.test.mjs'], eligible: () => true, fold: id });
    assert.ok(out.includes('/r/gap.test.mjs (pid 1): its record lost lines (a gap in its sequence)'), out.join('\n'));
    assert.ok(out.includes('/r/noload.test.mjs: ran, but no progress record (load) arrived'), out.join('\n'));
    assert.ok(out.includes('/r/noload.test.mjs: its record has no load line'), out.join('\n'));
    assert.ok(out.includes('/r/noend.test.mjs (pid 3): exited with 1 test(s) whose end line never arrived'), out.join('\n'));
  });
  it('an unavailable file inventory is itself a problem, never an empty pass', () => {
    assert.equal(reconcileRecord(createProgressTracker(), { ran: null, eligible: () => true, fold: id }).length, 1);
  });
  it('a superseded record is not incomplete (its process is provably gone)', () => {
    const w = writer();
    const t = feedAll([w({ ev: 'load', proc: 'o', pid: 5, at: 0 }), w({ ev: 'load', proc: 'n', pid: 5, at: 1 }), w({ ev: 'exit', proc: 'n', at: 2 })]);
    assert.deepEqual(reconcileRecord(t, { ran: [], eligible: () => true, fold: id }), []);
  });
});

describe('the stall kill\'s identity check fails safe', () => {
  const base = { runnerPid: 100, runStartMs: 1_000_000, loadAt: 1_005_000 };
  it('matches only a child of this runner created between the run start and its load', () => {
    assert.equal(identityMatches({ ...base, row: { ppid: 100, createdMs: 1_004_900 } }), true);
    assert.equal(identityMatches({ ...base, row: { ppid: 101, createdMs: 1_004_900 } }), false, 'another parent');
    assert.equal(identityMatches({ ...base, row: { ppid: 100, createdMs: 1_010_000 } }), false, 'created after the record (a reused pid)');
    assert.equal(identityMatches({ ...base, row: { ppid: 100, createdMs: 900_000 } }), false, 'older than the run');
    assert.equal(identityMatches({ ...base, row: null }), false, 'unreadable');
    assert.equal(identityMatches({ ...base, loadAt: null, row: { ppid: 100, createdMs: 1_004_900 } }), false, 'no load record');
  });
});

describe('what the orphan sweep selects, and its budget', () => {
  const w = writer();
  const t = feedAll([
    w({ ev: 'load', proc: 'hook', pid: 1, at: 0 }), w({ ev: 'start', proc: 'hook', id: 1, name: 't', at: 0 }), w({ ev: 'end', proc: 'hook', id: 1, name: 't', at: 1 }),
    w({ ev: 'load', proc: 'clean', pid: 2, at: 0 }), w({ ev: 'exit', proc: 'clean', at: 1 }),
    w({ ev: 'load', proc: 'stuck', pid: 3, at: 0 }), w({ ev: 'start', proc: 'stuck', id: 1, name: 't', at: 0 }),
    w({ ev: 'load', proc: 'mine', pid: 4, at: 0 }), w({ ev: 'start', proc: 'mine', id: 1, name: 't', at: 0 }),
  ]);
  const report = JSON.stringify({ version: GUARD_REPORT_VERSION, failures: [
    { name: '/r/clean.test.mjs', file: '/r/clean.test.mjs', error: 'test timed out after 4000ms' },
    { name: 'an ordinary failure', file: '/r/hook.test.mjs', error: 'expected 1 to equal 2' },
  ] });
  it('every child that never exited and that the runner did not stop, plus every file node timed out', () => {
    assert.deepEqual(timedOutFiles(report), ['/r/clean.test.mjs']);
    const picked = childrenToSweep(t, { timedOut: timedOutFiles(report), sameFile: (a, b) => a === b, stopped: new Set(['mine']) }).map((c) => c.pid);
    assert.deepEqual(picked, [2, 1, 3]);
  });
  it('POSIX signals the group only when needed; Windows reaps within one budget and lists what it missed', () => {
    const stops = [];
    const stop = (pid) => { stops.push(pid); return { ok: true }; };
    assert.deepEqual(sweepOrphans({ children: [], runnerPid: 7, platform: 'linux', stop }), []);
    sweepOrphans({ children: [], runnerPid: 7, groupNeeded: true, platform: 'linux', stop });
    assert.deepEqual(stops, [7]);
    let now = 0;
    const lines = sweepOrphans({
      children: [{ file: 'a', pid: 1 }, { file: 'b', pid: 2 }, { file: 'c', pid: 3 }], runnerPid: 7, platform: 'win32',
      clock: () => now, reap: (c) => { now += 30_000; return c.pid === 1 ? { ok: true, killed: 2 } : { ok: false, killed: 0, reason: 'boom' }; },
    });
    assert.deepEqual(lines, [
      'run-tests: orphan sweep: stopped 2 process(es) left by a (pid 1)',
      'run-tests: orphan sweep: b (pid 2): boom',
      'run-tests: orphan sweep: not reached within 60s: c (pid 3)',
    ]);
  });
});

describe('the watchdog clock (fake clock)', () => {
  const rig = (sizes, idleMs = 100) => {
    let now = 0;
    let i = 0;
    const fired = [];
    const dog = createIdleWatchdog({
      idleMs, clock: () => now, onIdle: (ms) => fired.push(ms),
      probe: () => { const v = sizes[Math.min(i, sizes.length - 1)]; i += 1; if (v instanceof Error) throw v; return v; },
    });
    return { dog, fired, advance: (ms) => { now += ms; dog.tick(); } };
  };
  it('fires once after idleMs with no growth, and never again', () => {
    const { dog, fired, advance } = rig([0]);
    dog.start();
    advance(50); assert.deepEqual(fired, []);
    advance(50); assert.deepEqual(fired, [100]);
    advance(500); assert.deepEqual(fired, [100]);
  });
  it('growth resets the clock', () => {
    const { dog, fired, advance } = rig([0, 0, 10, 10, 10]);
    dog.start();
    advance(90); advance(90);
    advance(90); assert.deepEqual(fired, []);
    advance(20); assert.deepEqual(fired, [110]);
  });
  it('a probe that throws counts as no growth, and stop() means it never fires', () => {
    const a = rig([0, new Error('gone')]);
    a.dog.start(); a.advance(150);
    assert.deepEqual(a.fired, [150]);
    const b = rig([0]);
    b.dog.start(); b.dog.stop(); b.advance(1000);
    assert.deepEqual(b.fired, []);
  });
});

describe('a hang can never read as a pass', () => {
  const clean = JSON.stringify({ version: GUARD_REPORT_VERSION, failures: [] });
  it('a fired watchdog, a stall, or a lost-line guard error each fail a run whose status is 0', () => {
    assert.equal(adjudicateRun({ status: 0, reportText: clean }).exitCode, 0, 'the same inputs without the guard pass');
    const dog = adjudicateRun({ status: 0, reportText: clean, watchdog: { idleForMs: 420_000, idleMs: 420_000, detail: ['  - x'] } });
    assert.equal(dog.exitCode, 1);
    assert.match(dog.message, /IDLE WATCHDOG[\s\S]*- x/);
    const stall = adjudicateRun({ status: 0, reportText: clean, hang: { stallLines: ['  - y'], gapFiles: [] } });
    assert.equal(stall.exitCode, 1);
    assert.match(stall.message, /PER-TEST LIMIT[\s\S]*- y/);
    const gap = adjudicateRun({ status: 0, reportText: clean, hang: { stallLines: [], gapFiles: ['z.test.mjs'] } });
    assert.equal(gap.exitCode, 1);
    assert.match(gap.message, /GUARD ERROR[\s\S]*z\.test\.mjs/);
    const broke = adjudicateRun({ status: 0, reportText: clean, hang: { stallLines: [], gapFiles: [], errors: ['EBADF'] } });
    assert.equal(broke.exitCode, 1);
    assert.match(broke.message, /cannot vouch for this run[\s\S]*EBADF/);
  });
  it('end-of-run naming lines go on a failing run only, and never move its exit code', () => {
    const failing = JSON.stringify({ version: GUARD_REPORT_VERSION, failures: [{ name: 'f', file: null, error: 'x' }] });
    const out = finishRun({ status: 1, reportText: failing, hangLines: ['  named'] });
    assert.equal(out.exitCode, 1);
    assert.ok(out.lines.includes('  named'));
    const passing = finishRun({ status: 0, reportText: clean, hangLines: ['  named'] });
    assert.equal(passing.exitCode, 0);
    assert.ok(!passing.lines.includes('  named'));
  });
});

describe('runSupervised settles exactly once and cleans up on every path', () => {
  const fakeChild = () => Object.assign(new EventEmitter(), { pid: 4242 });
  const noTimer = { schedule: () => 'h', cancel: () => {} };
  it('close: resolves with the status, cancels its timer and removes its signal handlers', async () => {
    const child = fakeChild();
    const sig = new EventEmitter();
    let cancelled = 0;
    const p = runSupervised({ cmd: 'x', args: [], env: {}, idleMs: 60_000, probe: () => 0, spawnFn: () => child, signals: sig, stop: () => ({ ok: true }), schedule: () => 'h', cancel: () => { cancelled += 1; } });
    assert.equal(sig.listenerCount('SIGINT'), 1);
    child.emit('close', 3, null);
    child.emit('close', 0, null);
    const r = await p;
    assert.equal(r.status, 3);
    assert.equal(cancelled, 1);
    assert.equal(sig.listenerCount('SIGINT') + sig.listenerCount('SIGTERM'), 0);
  });
  it('a spawn error resolves with it', async () => {
    const r = await runSupervised({ cmd: 'x', args: [], env: {}, idleMs: 60_000, probe: () => 0, spawnFn: () => { throw new Error('ENOENT'); }, signals: new EventEmitter(), ...noTimer });
    assert.match(r.spawnError.message, /ENOENT/);
  });
  it('a stall check that throws is handed to onTickError, never swallowed', async () => {
    const child = fakeChild();
    let tick;
    const errors = [];
    const p = runSupervised({ cmd: 'x', args: [], env: {}, idleMs: 60_000, probe: () => 0, spawnFn: () => child, signals: new EventEmitter(), onTick: () => { throw new Error('EBADF'); }, onTickError: (e) => errors.push(e.message), schedule: (fn) => { tick = fn; return 'h'; }, cancel: () => {} });
    tick();
    child.emit('close', 0, null);
    await p;
    assert.deepEqual(errors, ['EBADF']);
  });
  it('each tick runs the stall check with the runner pid, then the watchdog', async () => {
    const child = fakeChild();
    let tick;
    const seen = [];
    const p = runSupervised({ cmd: 'x', args: [], env: {}, idleMs: 60_000, probe: () => 0, spawnFn: () => child, signals: new EventEmitter(), onTick: (pid) => seen.push(pid), schedule: (fn) => { tick = fn; return 'h'; }, cancel: () => {} });
    tick(); tick();
    child.emit('close', 0, null);
    await p;
    assert.deepEqual(seen, [4242, 4242]);
  });
  it('an interrupt stops the tree and is reported as one', async () => {
    const child = fakeChild();
    const sig = new EventEmitter();
    const stopped = [];
    const p = runSupervised({ cmd: 'x', args: [], env: {}, idleMs: 60_000, probe: () => 0, spawnFn: () => child, signals: sig, stop: (pid) => { stopped.push(pid); return { ok: true }; }, ...noTimer });
    sig.emit('SIGINT');
    child.emit('close', null, 'SIGKILL');
    const r = await p;
    assert.deepEqual(stopped, [4242]);
    assert.deepEqual(r.interrupted, { signal: 'SIGINT', code: 130 });
  });
});

describe('the limits are ordered: per-test limit < idle watchdog < the CI job cap', () => {
  // The slowest single test instance (parents included) measured in each environment, with its source.
  // CI: run 45872119612 on 2026-11-26, every `type: 'test'` duration_ms in its TAP. Local: `npm test` on 2026-11-26 under the
  // machine's usual load, the same reading. Re-measure both when these limits are next questioned.
  const SLOWEST_TEST_MS = { ci: 61_400, local: 857_500 };
  const workflow = fs.readFileSync(path.join(ROOT, '.github', 'workflows', 'full-suite.yml'), 'utf8');
  const capMinutes = Number(/^\s*timeout-minutes:\s*(\d+)\s*$/m.exec(workflow)?.[1]);

  it('reads a real cap from the workflow (an unreadable source must not pass vacuously)', () => {
    assert.ok(Number.isInteger(capMinutes) && capMinutes > 0, 'full-suite timeout-minutes');
  });
  for (const name of ['ci', 'local']) {
    it(`${name}: the per-test limit is at least twice the slowest test measured there`, () => {
      assert.ok(PROFILES[name].stallMs >= 2 * SLOWEST_TEST_MS[name], `${PROFILES[name].stallMs} vs ${SLOWEST_TEST_MS[name]}`);
    });
    it(`${name}: the idle watchdog sits at least a minute above the per-test limit, and equals stall + gap`, () => {
      assert.ok(PROFILES[name].watchdogMs >= PROFILES[name].stallMs + 60_000);
      assert.equal(PROFILES[name].watchdogMs, PROFILES[name].stallMs + PROFILES[name].gapMs);
    });
  }
  it('ci: the idle watchdog is below the CI job cap, so it is never the larger of two nested budgets', () => {
    assert.ok(PROFILES.ci.watchdogMs < capMinutes * 60_000, `${PROFILES.ci.watchdogMs} vs ${capMinutes} min`);
  });
});
