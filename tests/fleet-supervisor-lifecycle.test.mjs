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

// ── /audit-code round-1 fixes (session audit-code-1791467919) ───────────────
describe('R1 fixes', () => {
  const reapWith = (fakeSpawnSync) => new Function('spawnSync', `${REAP_WIN_ORPHANS_JS}; return reapWinOrphans;`)(fakeSpawnSync);

  it('M2/H6: every way the win32 reap can fail is REPORTED, never read as a clean reap', () => {
    const cases = [
      [() => ({ error: Object.assign(new Error('spawn powershell.exe ENOENT'), { code: 'ENOENT' }) }), /could not start powershell/],
      [() => ({ error: Object.assign(new Error('t'), { code: 'ETIMEDOUT' }) }), /timed out/],
      [() => ({ status: 1, stdout: 'garbage' }), /printed no result/],
      [() => ({ status: 1, stdout: '{"error":"Access denied"}' }), /query failed: Access denied/],
      [() => ({ status: 0, stdout: '{"guarded":false,"killed":1,"failed":2}' }), /2 descendant\(s\) could not be stopped/],
    ];
    for (const [fake, why] of cases) {
      const o = reapWith(fake)(1234, Date.now(), 1000);
      assert.equal(o.ok, false, String(why));
      assert.match(o.reason, why);
    }
    assert.deepEqual(reapWith(() => ({ status: 0, stdout: '{"guarded":false,"killed":2,"failed":0}' }))(1, 0, 1000), { ok: true, killed: 2 }, 'control: a clean reap is ok');
  });

  it('M2/H6: a failed cleanup reaches the check result, the status findings and the train render', async () => {
    const { runChecks, resultsToFindings } = await import('../scripts/lib/fleet/checks.mjs');
    const { renderBuilt } = await import('../scripts/lib/fleet/render-train.mjs');
    const dir = tmpRoot('fleet-cleanup-warn-');
    fs.writeFileSync(path.join(dir, 'c.mjs'), '');
    const exec = () => ({ status: 0, stdout: FINDINGS, stderr: '', cleanup: { ok: false, reason: '1 descendant(s) could not be stopped' } });
    const [r] = runChecks({ cwd: dir, phase: 'status', payload: {}, exec, checks: [{ name: 'c', script: 'c.mjs', severity: 'warn', runIn: ['status'] }] });
    assert.equal(r.status, 'ok', 'the hook\'s own result is unchanged');
    assert.equal(r.cleanupWarning, '1 descendant(s) could not be stopped');
    assert.match(resultsToFindings([r]).map((f) => `${f.level}: ${f.message}`).join('\n'), /^warn: check "c": cleanup after the hook exited failed/m);
    const [clean] = runChecks({ cwd: dir, phase: 'status', payload: {}, exec: () => ({ status: 0, stdout: FINDINGS, stderr: '', cleanup: null }), checks: [{ name: 'c', script: 'c.mjs', severity: 'warn', runIn: ['status'] }] });
    assert.equal(clean.cleanupWarning, undefined, 'control: no warning when cleanup did not fail');
    const train = { trainId: 't', phase: 'tested', result: 'green', mergeMethod: 'pr', baseOid: 'a'.repeat(40), destination: { remote: 'origin', ref: 'refs/heads/main' }, sources: [],
      tierResults: [{ name: 'unit', result: 'green', cleanupWarning: 'the orphan query timed out after 10000ms' }], checkResults: [r] };
    const text = renderBuilt({ train, approvability: { ok: true, reason: 'green' }, cmd: 'fleet' });
    assert.match(text, /tier unit: green[^\n]*\n {4}warn: cleanup after the tier exited failed \(the orphan query timed out/);
    assert.match(text, /check c \[warn\]: ok\n {4}warn: cleanup after the hook exited failed/);
  });

  it('H2: only descendants created at/after the hook\'s spawn are reaped (an older orphan of a dead same-pid parent is not ours)', { skip: !IS_WIN && 'win32 only' }, async () => {
    const reap = reapWith(spawnSync);
    const dir = tmpRoot('fleet-since-');
    const pidFile = path.join(dir, 'child.pid');
    const parent = spawn(process.execPath, ['-e', `
      const c = require('node:child_process').spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { stdio: 'ignore', detached: true });
      require('node:fs').writeFileSync(${JSON.stringify(pidFile)}, String(c.pid));
      setTimeout(() => {}, 60000);`], { stdio: 'ignore' });
    const childPid = await waitFor(pidFile);
    try {
      parent.kill(); await settle(parent.pid);
      const later = reap(parent.pid, Date.now() + 60_000, 10000); // "the hook spawned AFTER this orphan existed"
      assert.equal(later.ok, true);
      assert.equal(alive(childPid), true, 'an orphan older than the hook must not be touched');
      const o = reap(parent.pid, Date.now() - 60_000, 10000); // control: created after the (earlier) spawn — ours
      assert.equal(o.ok, true, o.reason);
      assert.equal(await settle(childPid), false, 'control: the same orphan IS reaped when it postdates the spawn');
    } finally { killQuietly(childPid); }
  });

  it('H4: a hook that exits near its deadline is not reported "timed out" while cleanup waits', { skip: !IS_WIN && 'win32: on Linux the stdio-ends scan always finds such a holder' }, async () => {
    // The helper is started through an intermediate that exits at once (a double fork). The win32 reaper walks
    // ParentProcessId through LIVE processes only, so it cannot reach the helper (a documented limit), the helper
    // keeps the hook's pipes, and the supervisor waits out its 1 s finish delay — which spans the 3 s deadline.
    // Pre-fix the deadline then fired on a hook that had already exited; measured with the fix reverted.
    const dir = tmpRoot('fleet-near-deadline-');
    const pidFile = path.join(dir, 'pid');
    const hook = path.join(dir, 'hook.cjs');
    const helper = 'setTimeout(() => {}, 60000)';
    const intermediate = `const g = require('node:child_process').spawn(process.execPath, ['-e', ${JSON.stringify(helper)}], { stdio: ['ignore', 'inherit', 'inherit'], detached: true }); g.unref(); require('node:fs').writeFileSync(${JSON.stringify(pidFile)}, String(g.pid));`;
    fs.writeFileSync(hook, `
      setTimeout(() => {
        require('node:child_process').spawnSync(process.execPath, ['-e', ${JSON.stringify(intermediate)}], { stdio: ['ignore', 'inherit', 'inherit'] });
        process.stdout.write(${JSON.stringify(FINDINGS)});
      }, 2300);
    `);
    const r = spawnExec([process.execPath, hook], { cwd: dir, input: '{}', timeoutMs: 3000 });
    const pid = await waitFor(pidFile);
    try {
      assert.ok(pid > 0, 'the helper really started');
      assert.equal(r.error, undefined, `got ${r.error?.code} — the hook had already exited`);
      assert.equal(r.status, 0);
      assert.equal(r.stdout, FINDINGS);
    } finally { if (pid) killQuietly(pid); }
  });
});
