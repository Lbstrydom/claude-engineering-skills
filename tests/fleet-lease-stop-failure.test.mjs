/**
 * @fileoverview `stopTree` used to swallow every taskkill / kill failure, so a tree that SURVIVED a stop kept burning the shared
 * machine while the lease was released over it, and no caller could tell (fleet p-...-c729). Now a failed stop is reported, and an
 * already-gone process is still the goal and still silent. Both directions, against fakes (a real tree kill cannot be made to fail
 * on demand), plus one real tree stopped for real as the positive control.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { stopTree, runChild } from '../scripts/lib/fleet/lease-spawn.mjs';
import { runStep } from '../scripts/lib/prepush-step.mjs';

const errno = (code) => Object.assign(new Error(code), { code });

describe('stopTree - Windows (taskkill)', () => {
  const win = (r) => stopTree(99, { platform: 'win32', spawnSync: () => r });
  it('exit 0 (stopped) and 128 (process not found: already gone) are both ok - the goal', () => {
    assert.deepEqual(win({ status: 0, stderr: '' }), { ok: true });
    assert.deepEqual(win({ status: 128, stderr: 'ERROR: The process "99" not found.' }), { ok: true });
  });
  it('any other status is a FAILURE that names the status and taskkill\'s own first line', () => {
    const r = win({ status: 1, stderr: 'ERROR: The process with PID 99 could not be terminated.\nReason: Access is denied.\n' });
    assert.equal(r.ok, false);
    assert.match(r.why, /taskkill \/PID 99 \/T \/F exited 1: ERROR: The process with PID 99 could not be terminated\./);
  });
  it('taskkill that could not run (spawn error, thrown, no result) is a failure, not "gone"', () => {
    assert.match(win({ status: null, error: new Error('spawn taskkill ENOENT') }).why, /taskkill could not run \(spawn taskkill ENOENT\)/);
    assert.equal(stopTree(99, { platform: 'win32', spawnSync: () => { throw new Error('boom'); } }).ok, false);
    assert.equal(win(undefined).ok, false);
    assert.match(win({ status: null, signal: 'SIGTERM', stderr: '' }).why, /on signal SIGTERM/);
  });
  it('still forces the whole tree in ONE call (audit R2 H1/H2) and asks for stderr so a failure can be named', () => {
    let seen;
    stopTree(99, { platform: 'win32', spawnSync: (cmd, args, o) => { seen = [cmd, args, o]; return { status: 0 }; } });
    assert.deepEqual(seen.slice(0, 2), ['taskkill', ['/PID', '99', '/T', '/F']]);
    assert.deepEqual(seen[2].stdio, ['ignore', 'ignore', 'pipe']);
  });
});

describe('stopTree - POSIX (kill)', () => {
  const posix = (impl) => stopTree(7, { platform: 'linux', kill: impl });
  it('the group signalled: ok', () => {
    assert.deepEqual(posix(() => {}), { ok: true });
  });
  it('ESRCH everywhere (nothing there any more) is the goal, not an error', () => {
    assert.deepEqual(posix(() => { throw errno('ESRCH'); }), { ok: true });
  });
  it('the group cannot be signalled (EPERM) and the root can: a PARTIAL stop is reported, naming the descendants at risk', () => {
    const r = posix((pid) => { if (pid < 0) throw errno('EPERM'); });
    assert.equal(r.ok, false);
    assert.match(r.why, /SIGTERM reached the root \(7\) but not its process group \(EPERM\), so descendants may still be running/);
  });
  it('the group is gone but the root is not signalable (EPERM): a failure naming the signal', () => {
    const r = posix((pid) => { throw errno(pid < 0 ? 'ESRCH' : 'EPERM'); });
    assert.equal(r.ok, false);
    assert.match(r.why, /SIGTERM to 7 failed \(EPERM\)/);
  });
  it('the group failed for a real reason and the root is gone: orphans are possible, and said', () => {
    const r = posix((pid) => { throw errno(pid < 0 ? 'EPERM' : 'ESRCH'); });
    assert.equal(r.ok, false);
    assert.match(r.why, /process group 7 failed \(EPERM\) and the root is gone, so its descendants may be orphans/);
  });
  it('force uses SIGKILL in the message, and a bad pid signals nothing and is ok', () => {
    assert.match(stopTree(7, { platform: 'linux', force: true, kill: (pid) => { throw errno(pid < 0 ? 'EPERM' : 'EPERM'); } }).why, /SIGKILL to 7 failed/);
    const calls = [];
    for (const bad of [0, -1, NaN, undefined, '12']) assert.deepEqual(stopTree(bad, { platform: 'linux', kill: (...a) => calls.push(a) }), { ok: true });
    assert.deepEqual(calls, []);
  });
});

describe('runChild - a failed stop reaches the result', () => {
  const NODE = process.execPath;
  it('stopFailed carries every failed attempt, labelled first / force', async () => {
    const ac = new AbortController();
    const res = await new Promise((resolve) => {
      // The fake stop never kills, as a failed kill would not; the child ends on its own after both attempts have run.
      const child = runChild({
        cmd: NODE, args: ['-e', 'setTimeout(() => process.exit(0), 600)'], signal: ac.signal, graceMs: 100,
        stop: (pid, o) => ({ ok: false, why: `kill refused (${o.force ? 'force' : 'first'})` }),
      });
      setTimeout(() => ac.abort(), 50);
      child.then(resolve);
    });
    assert.equal(res.stopped, true);
    assert.ok(res.stopFailed.includes('first stop: kill refused (first)'), JSON.stringify(res.stopFailed));
    assert.ok(res.stopFailed.includes('force stop: kill refused (force)'), JSON.stringify(res.stopFailed));
  });

  it('a stop that returns nothing (the old contract) or ok is not a failure: no stopFailed key at all', async () => {
    const ac = new AbortController();
    const p = runChild({ cmd: NODE, args: ['-e', 'setInterval(() => {}, 1000)'], signal: ac.signal, graceMs: 50 });
    setTimeout(() => ac.abort(), 200);
    const res = await p;
    assert.equal(res.stopped, true);
    assert.equal('stopFailed' in res, false, 'a real, successful stop of a real tree is not a failure');
  });

  it('with a stop that fails and a child that exits anyway, the failure is still reported (the root exiting does not clear it)', async () => {
    const ac = new AbortController();
    const res = await new Promise((resolve) => {
      const child = runChild({
        cmd: NODE, args: ['-e', 'setTimeout(() => process.exit(0), 300)'], signal: ac.signal, graceMs: 10_000,
        stop: () => ({ ok: false, why: 'taskkill exited 1: Access is denied.' }),
      });
      setTimeout(() => ac.abort(), 50);
      child.then(resolve);
    });
    assert.equal(res.stopped, true);
    assert.deepEqual(res.stopFailed, ['first stop: taskkill exited 1: Access is denied.']);
  });
});

describe('runStep - the prepush hook says when its step\'s tree may still be running', () => {
  it('a timeout whose stop FAILED logs a loud second line and returns stopFailed; the refusal itself is unchanged', async () => {
    const lines = [];
    const r = await runStep({
      step: 'code-audit', cmd: 'x', budgetMs: 1000, progressMs: 0, log: (l) => lines.push(l), leaseText: () => 'machine lease: free',
      run: async () => ({ code: null, signal: 'SIGTERM', timedOut: true, stopped: true, stopFailed: ['first stop: kill refused'] }),
    });
    assert.equal(r.timedOut, true);
    assert.deepEqual(r.stopFailed, ['first stop: kill refused']);
    const text = lines.join('\n');
    assert.match(text, /step 'code-audit': stopping its process tree FAILED \(first stop: kill refused\) - it may still be running on this machine/);
    assert.match(text, /exceeded its 1s budget/);
  });
  it('a clean stop prints no warning and carries no stopFailed key', async () => {
    const lines = [];
    const r = await runStep({
      step: 's', cmd: 'x', budgetMs: 1000, progressMs: 0, log: (l) => lines.push(l), leaseText: () => 'machine lease: free',
      run: async () => ({ code: null, signal: 'SIGTERM', timedOut: true, stopped: true }),
    });
    assert.equal('stopFailed' in r, false);
    assert.doesNotMatch(lines.join('\n'), /FAILED/);
  });
});
