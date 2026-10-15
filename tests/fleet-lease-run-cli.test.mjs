/**
 * @fileoverview `fleet lease run -- <cmd>` through the REAL CLI with REAL child processes (plan D7): the command's exit code
 * comes back, a refused acquire never runs the command, a wait in the queue works, the process TREE is stopped, and the slot is
 * free afterwards. Also `runChild` directly (timeout, abort, a command that cannot start).
 */
import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { cleanupFleetRoots, runFleetAsync, FLEET_CLI } from './helpers/fleet-repo.mjs';
import { world } from './helpers/fleet-lease-world.mjs';
import { runChild, stopTree } from '../scripts/lib/fleet/lease-spawn.mjs';

after(cleanupFleetRoots);

const NODE = process.execPath;
const POSIX = process.platform !== 'win32';
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'lease-run-cli-'));
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const until = async (fn, ms = 20_000) => { const end = Date.now() + ms; while (Date.now() < end) { if (fn()) return true; await new Promise((r) => setTimeout(r, 100)); } return false; };

describe('lease run: exit codes and the refused acquire', () => {
  it('returns the command\'s exit code, passes its argv verbatim, and leaves the slot free', () => {
    const w = world();
    const r = w.runA(['lease', 'run', '--for', '5', '--', NODE, '-e', 'process.stdout.write(JSON.stringify(process.argv.slice(1)));process.exit(7)', 'a b', '--flag', "x'y"]);
    assert.equal(r.status, 7, r.stderr);
    assert.deepEqual(JSON.parse(r.stdout), ['a b', '--flag', "x'y"], 'the child owns stdout and its argv arrives untouched');
    assert.equal(w.read().heavy, null);
    const kinds = w.read().journal.map((e) => e.kind);
    assert.ok(kinds.indexOf('acquired') < kinds.indexOf('released'));
  });

  it('REFUSED means the command did NOT run: exit 75, a marker file is never written, stderr says so, and the repo is queued', () => {
    const w = world();
    assert.equal(w.runB(['lease', 'acquire', '--for', '30']).status, 0);
    const marker = path.join(tmp(), 'ran.txt');
    const r = w.runA(['lease', 'run', '--', NODE, '-e', `require('fs').writeFileSync(${JSON.stringify(marker)}, 'ran')`]);
    assert.equal(r.status, 75, r.stdout + r.stderr);
    assert.equal(fs.existsSync(marker), false, 'the 2026-10-14 incident: a refused acquire must never run the command');
    assert.match(r.stderr, /REFUSED \(held\)/);
    assert.match(r.stderr, /The command did NOT run/);
    assert.match(r.stderr, /now waiting for the slot/);
    assert.equal(w.read().waiters.length, 1);
    assert.equal(w.read().heavy.holder, 'main', 'the other repo\'s slot is untouched');
  });

  it('waits in the queue (--wait) and runs once the holder releases', async () => {
    const w = world();
    assert.equal(w.runB(['lease', 'acquire', '--for', '30']).status, 0);
    const marker = path.join(tmp(), 'ran.txt');
    const running = runFleetAsync(['lease', 'run', '--wait', '2', '--', NODE, '-e', `require('fs').writeFileSync(${JSON.stringify(marker)}, 'ran')`], { cwd: w.a.repo, env: w.env({ FLEET_LEASE_POLL_MS: '300' }) });
    assert.equal(await until(() => w.read().waiters?.length === 1), true, 'it queued while the other repo held the slot');
    assert.equal(fs.existsSync(marker), false);
    assert.equal(w.runB(['lease', 'release', '--end-turn']).status, 0);
    const r = await running;
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.equal(fs.readFileSync(marker, 'utf8'), 'ran');
    assert.equal(w.read().heavy, null);
  });

  it('a wait that runs out is still a refusal: exit 75 and no command', async () => {
    const w = world();
    assert.equal(w.runB(['lease', 'acquire', '--for', '30']).status, 0);
    const marker = path.join(tmp(), 'ran.txt');
    const r = await runFleetAsync(['lease', 'run', '--wait', '1', '--', NODE, '-e', `require('fs').writeFileSync(${JSON.stringify(marker)}, 'ran')`], { cwd: w.a.repo, env: w.env({ FLEET_LEASE_POLL_MS: '400' }), timeoutMs: 120_000 });
    assert.equal(r.status, 75);
    assert.equal(fs.existsSync(marker), false);
  });

  it('argument errors are exit 2 before anything is acquired: --json, no --, nothing after --, bad numbers', () => {
    const w = world();
    assert.equal(w.runA(['lease', 'run', '--json', '--', NODE, '-v']).status, 2);
    assert.equal(w.runA(['lease', 'run', NODE, '-v']).status, 2);
    assert.equal(w.runA(['lease', 'run', '--']).status, 2);
    assert.equal(w.runA(['lease', 'run', '--wait', '9999', '--', NODE, '-v']).status, 2);
    assert.equal(w.runA(['lease', 'run', '--timeout', '0', '--', NODE, '-v']).status, 2);
    assert.equal(fs.existsSync(w.leaseFile), false, 'nothing was acquired or written');
  });

  it('a command that cannot start is 127, the slot is freed, and --end-turn yields the turn', () => {
    const w = world();
    const r = w.runA(['lease', 'run', '--end-turn', '--', 'definitely-not-a-command-xyz-123']);
    assert.equal(r.status, 127, r.stderr);
    assert.match(r.stderr, /could not start/);
    assert.equal(w.read().heavy, null);
    assert.equal(w.read().turn, undefined);
  });
});

describe('lease run: stopping the whole process tree', () => {
  it('SIGTERM to the runner stops the command AND a grandchild, frees the slot, and exits 143 (POSIX)', { skip: !POSIX && 'signals reach the runner differently on Windows; the tree stop is covered by the runChild tests below' }, async () => {
    const w = world();
    const dir = tmp();
    const pidFile = path.join(dir, 'grandchild.pid');
    const script = `const {spawn}=require('child_process');const g=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});require('fs').writeFileSync(${JSON.stringify(pidFile)},String(g.pid));setInterval(()=>{},1000)`;
    const runner = spawn(NODE, [FLEET_CLI, 'lease', 'run', '--for', '5', '--', NODE, '-e', script], { cwd: w.a.repo, env: w.env(), stdio: 'ignore' });
    const exited = new Promise((resolve) => runner.once('exit', (code, sig) => resolve({ code, sig })));
    try {
      assert.equal(await until(() => fs.existsSync(pidFile)), true, 'the grandchild started');
      const grandchild = Number(fs.readFileSync(pidFile, 'utf8'));
      assert.equal(alive(grandchild), true);
      runner.kill('SIGTERM');
      const { code } = await exited;
      assert.equal(code, 143);
      assert.equal(await until(() => !alive(grandchild), 15_000), true, 'the grandchild was stopped with the command (the process group), not left behind');
      assert.equal(w.read().heavy, null);
    } finally {
      // Teardown that runs even when an assertion above fails: a leaked runner and its process group would run forever.
      try { runner.kill('SIGKILL'); } catch { /* gone */ }
      try { const g = Number(fs.readFileSync(pidFile, 'utf8')); if (g) process.kill(g, 'SIGKILL'); } catch { /* gone */ }
    }
  });
});

describe('stopTree (the platform branches, with fakes)', () => {
  it('POSIX signals the whole GROUP (negative pid): SIGTERM, then SIGKILL when forced; a group that cannot be signalled falls back to the pid', () => {
    const sent = [];
    stopTree(4242, { platform: 'linux', kill: (p, s) => sent.push([p, s]) });
    stopTree(4242, { platform: 'linux', force: true, kill: (p, s) => sent.push([p, s]) });
    assert.deepEqual(sent, [[-4242, 'SIGTERM'], [-4242, 'SIGKILL']]);
    const fallback = [];
    stopTree(7, { platform: 'linux', kill: (p, s) => { fallback.push([p, s]); if (p < 0) throw new Error('ESRCH'); } });
    assert.deepEqual(fallback, [[-7, 'SIGTERM'], [7, 'SIGTERM']]);
  });
  it('Windows forces the whole TREE in ONE call, whether or not "force" was asked (audit R2 H1/H2: once the root exits, its descendants cannot be found by pid)', () => {
    for (const force of [false, true]) {
      const calls = [];
      stopTree(99, { platform: 'win32', force, spawnSync: (cmd, args) => calls.push([cmd, ...args]) });
      assert.deepEqual(calls, [['taskkill', '/PID', '99', '/T', '/F']], `force=${force}`);
    }
  });
  it('a pid that is not a positive integer signals nothing, and a process that is already gone is not an error', () => {
    const calls = [];
    for (const bad of [0, -1, NaN, undefined, '12']) stopTree(bad, { platform: 'linux', kill: (...a) => calls.push(a) });
    assert.deepEqual(calls, []);
    assert.doesNotThrow(() => stopTree(5, { platform: 'linux', kill: () => { throw new Error('ESRCH'); } }));
    assert.doesNotThrow(() => stopTree(5, { platform: 'win32', spawnSync: () => { throw new Error('gone'); } }));
  });
});

describe('runChild (the tree stop, timeout and abort, with real processes)', () => {
  const sleeper = ['-e', 'setInterval(()=>{},1000)'];
  it('stops a command that runs past its timeout: timedOut, stopped, and it returns promptly', async () => {
    const t0 = Date.now();
    const r = await runChild({ cmd: NODE, args: sleeper, timeoutMs: 400, graceMs: 2000 });
    assert.equal(r.timedOut, true);
    assert.equal(r.stopped, true);
    assert.ok(Date.now() - t0 < 15_000);
  });
  it('stops a command when the AbortSignal fires', async () => {
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 300);
    const r = await runChild({ cmd: NODE, args: sleeper, signal: ac.signal, graceMs: 2000 });
    assert.equal(r.stopped, true);
    assert.equal(r.timedOut, false);
  });
  it('a stop also takes down a grandchild', async () => {
    const dir = tmp();
    const pidFile = path.join(dir, 'g.pid');
    const script = `const {spawn}=require('child_process');const g=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});require('fs').writeFileSync(${JSON.stringify(pidFile)},String(g.pid));setInterval(()=>{},1000)`;
    const ac = new AbortController();
    const done = runChild({ cmd: NODE, args: ['-e', script], signal: ac.signal, graceMs: 2000 });
    assert.equal(await until(() => fs.existsSync(pidFile)), true);
    const g = Number(fs.readFileSync(pidFile, 'utf8'));
    assert.equal(alive(g), true);
    ac.abort();
    await done;
    assert.equal(await until(() => !alive(g), 15_000), true, 'the whole tree is gone');
  });
  it('a parent that exits GRACEFULLY on the stop still takes its stubborn worker with it (audit R2 H1/H2)', async () => {
    const dir = tmp();
    const pidFile = path.join(dir, 'w.pid');
    // The WORKER writes the pid file, and only after its SIGTERM handler is installed: seeing the file proves the worker is
    // already stubborn, so an early abort cannot let a default-disposition SIGTERM kill it and pass the test for the wrong reason.
    const worker = 'process.on("SIGTERM",()=>{});require("fs").writeFileSync(' + JSON.stringify(pidFile) + ',String(process.pid));setInterval(()=>{},1000)';
    const script = `const {spawn}=require('child_process');process.on('SIGTERM',()=>process.exit(0));`
      + `spawn(process.execPath,['-e',${JSON.stringify(worker)}],{stdio:'ignore'});setInterval(()=>{},1000)`;
    const ac = new AbortController();
    const done = runChild({ cmd: NODE, args: ['-e', script], signal: ac.signal, graceMs: 2000 });
    let w = 0;
    try {
      assert.equal(await until(() => fs.existsSync(pidFile)), true);
      w = Number(fs.readFileSync(pidFile, 'utf8'));
      assert.equal(alive(w), true);
      ac.abort();
      const r = await done;
      assert.equal(r.stopped, true);
      assert.equal(await until(() => !alive(w), 15_000), true, 'the worker did not outlive the parent that exited on the stop');
    } finally {
      if (w) { try { process.kill(w, 'SIGKILL'); } catch { /* gone */ } }
    }
  });
  it('a controller aborted AFTER the child finished does not reach it (audit R1 H2)', async () => {
    const stops = [];
    const ac = new AbortController();
    const r = await runChild({ cmd: NODE, args: ['-e', 'process.exit(0)'], signal: ac.signal, stop: (pid, o) => stops.push([pid, o]) });
    assert.equal(r.code, 0);
    ac.abort();
    assert.deepEqual(stops, [], 'no stop call for a child that is already gone (its pid could now belong to another process)');
  });
  it('reports a command that cannot start, and a normal exit code', async () => {
    const bad = await runChild({ cmd: 'definitely-not-a-command-xyz-123', args: [] });
    assert.ok(bad.spawnError);
    const seven = await runChild({ cmd: NODE, args: ['-e', 'process.exit(7)'] });
    assert.equal(seven.code, 7);
    assert.equal(seven.timedOut, false);
  });
});
