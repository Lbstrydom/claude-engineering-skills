/**
 * @fileoverview /fleet supervisors — what an EXITED hook/tier leaves behind.
 * Plan: docs/plans/fleet-supervisor-lifecycle.md.
 *
 *   R2-H1 (POSIX): a hook that prints its findings and exits while a helper that
 *     escaped its process group still holds the pipes kept the check supervisor
 *     alive until the OUTER spawnSync timeout, which then reported a finished check
 *     as "timed out". (Pinned on Linux by fleet-checks.test.mjs H1/H3, which fails
 *     there pre-fix; run it with `docker run --init` — without an init process,
 *     killed orphans stay as unreaped zombies and every "is it gone?" probe lies.)
 *   M3 (win32): after a hook/tier exited normally its quiet descendants survived
 *     (Windows keeps ParentProcessId on orphans; the reaper only ran on POSIX).
 *
 * The win32 cases are skipped elsewhere and vice versa: each names its platform.
 */
import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { spawnExec } from '../scripts/lib/fleet/checks.mjs';
import { REAP_WIN_ORPHANS_JS } from '../scripts/lib/fleet/reap.mjs';
import { cleanupFleetRoots, tmpRoot } from './helpers/fleet-repo.mjs';

after(cleanupFleetRoots);

const IS_WIN = process.platform === 'win32';
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const settle = async (pid, ms = 5000) => { const end = Date.now() + ms; while (alive(pid) && Date.now() < end) await new Promise((r) => setTimeout(r, 100)); return alive(pid); };
const killQuietly = (pid) => { try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ } };
const waitFor = async (file, ms = 5000) => { const end = Date.now() + ms; while (!fs.existsSync(file) && Date.now() < end) await new Promise((r) => setTimeout(r, 50)); return fs.existsSync(file) ? Number(fs.readFileSync(file, 'utf8').trim()) : null; };
const FINDINGS = '{"schemaVersion":1,"findings":[]}';

describe('a hook that exits leaving an ESCAPED helper on its pipes', () => {
  it('returns its result well inside a SHORT timeout, never "timed out", and the helper is gone (Linux) / reaped (win32)', async () => {
    const dir = tmpRoot('fleet-escape-');
    const pidFile = path.join(dir, 'pid');
    const hook = path.join(dir, 'hook.cjs');
    fs.writeFileSync(hook, `
      const { spawn } = require('node:child_process');
      const fs = require('node:fs');
      const g = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { stdio: ['ignore', 'inherit', 'inherit'], detached: true });
      g.unref();
      fs.writeFileSync(${JSON.stringify(pidFile)}, String(g.pid));
      process.stdout.write(${JSON.stringify(FINDINGS)});
    `);
    const t0 = Date.now();
    // 15s check timeout: the OUTER spawnSync bound is timeout + 15s (30s), which is where pre-fix POSIX ended.
    // A 5s bound flaked once in a full parallel win32 run (node start-up + the ~2s CIM reap under load).
    const r = spawnExec([process.execPath, hook], { cwd: dir, input: '{}', timeoutMs: 15000 });
    const took = Date.now() - t0;
    const pid = await waitFor(pidFile);
    try {
      assert.equal(r.error, undefined, `no error (pre-fix POSIX: the outer timeout fired) — got ${r.error?.code}`);
      assert.equal(r.status, 0);
      assert.equal(r.stdout, FINDINGS);
      assert.ok(took < 15000, `returned inside the check's own timeout, far from the outer one (${took}ms)`);
      assert.ok(pid > 0, 'the helper really started');
      if (IS_WIN || process.platform === 'linux') assert.equal(await settle(pid), false, 'the escaped helper holding the pipes is terminated');
    } finally { if (pid) killQuietly(pid); }
  });
});

describe('win32: an exited NON-node hook\'s quiet child is reaped', () => {
  it('a PowerShell hook that Start-Process-es a child and exits leaves nothing running', { skip: !IS_WIN && 'win32 only' }, async () => {
    const dir = tmpRoot('fleet-ps-hook-');
    const pidFile = path.join(dir, 'pid');
    const ps = `$p = Start-Process -FilePath '${process.execPath}' -ArgumentList '-e','setTimeout(()=>{},60000)' -WindowStyle Hidden -PassThru; Set-Content -Path '${pidFile}' -Value $p.Id; Write-Output '${FINDINGS}'`;
    const r = spawnExec(['powershell.exe', '-NoProfile', '-NonInteractive', '-Command', ps], { cwd: dir, input: '{}', timeoutMs: 30000 });
    const pid = await waitFor(pidFile);
    try {
      assert.equal(r.status, 0, r.stderr);
      assert.ok(pid > 0, 'the child really started');
      assert.equal(await settle(pid), false, 'pre-fix this child survived the check (measured 2026-10-08)');
    } finally { if (pid) killQuietly(pid); }
  });
});

describe('win32 reaper: the pid-reuse guard', () => {
  // The reaper walks ParentProcessId from the EXITED child's pid. If that pid is live again it belongs to
  // someone else, and so do its children: nothing may be touched.
  const reapWinOrphans = new Function('spawnSync', `${REAP_WIN_ORPHANS_JS}; return reapWinOrphans;`)(spawnSync);
  const parentWithChild = async (dir) => {
    const pidFile = path.join(dir, 'child.pid');
    const parent = spawn(process.execPath, ['-e', `
      const c = require('node:child_process').spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { stdio: 'ignore', detached: true });
      require('node:fs').writeFileSync(${JSON.stringify(pidFile)}, String(c.pid));
      setTimeout(() => {}, 60000);`], { stdio: 'ignore' });
    return { parent, childPid: await waitFor(pidFile) };
  };

  it('a LIVE root pid (reused) is left alone, with its children', { skip: !IS_WIN && 'win32 only' }, async () => {
    const { parent, childPid } = await parentWithChild(tmpRoot('fleet-reuse-'));
    try {
      reapWinOrphans(parent.pid, 10000);
      assert.equal(alive(childPid), true, 'a child of a live process must not be touched');
    } finally { killQuietly(childPid); killQuietly(parent.pid); }
  });
  it('control: once the root has exited, the same child IS reaped (so the probe can fail)', { skip: !IS_WIN && 'win32 only' }, async () => {
    const { parent, childPid } = await parentWithChild(tmpRoot('fleet-reuse-'));
    try {
      parent.kill();
      await settle(parent.pid);
      reapWinOrphans(parent.pid, 10000);
      assert.equal(await settle(childPid), false);
    } finally { killQuietly(childPid); }
  });
});
