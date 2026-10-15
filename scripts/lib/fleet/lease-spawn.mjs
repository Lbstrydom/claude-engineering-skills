/**
 * @fileoverview The child process of `fleet lease run -- <cmd>`: spawn it with the caller's argv VERBATIM (`shell: false`, nothing
 * interpolated), stop it as a process TREE, and report how it ended (plan docs/plans/fleet-lease-turns-and-journal.md D7, audit
 * R1 H1). A `git push` starts a pre-push hook that starts npm and test workers; killing the launcher alone leaves them running,
 * so a stop that only signals the first pid would release the lease while heavy work continues.
 *
 *  - POSIX: the child is spawned `detached` (its own process group) and every stop signals the GROUP (`kill(-pid, ...)`).
 *  - Windows: a stop runs `taskkill /PID <pid> /T` (the tree), then `/F` after the grace.
 *
 * Stated limits: a descendant that leaves the group on purpose (`setsid`, a daemon) is not stopped; a root that exits normally
 * while descendants keep running is a command that said it was done.
 *
 * @module scripts/lib/fleet/lease-spawn
 */
import cp from 'node:child_process';

/**
 * Stop the process tree rooted at `pid`. Never throws: a process that is already gone is the goal, not an error.
 */
export function stopTree(pid, { force = false, platform = process.platform, kill = process.kill.bind(process), spawnSync = cp.spawnSync } = {}) {
  if (!Number.isInteger(pid) || pid <= 0) return;
  if (platform === 'win32') {
    try { spawnSync('taskkill', ['/PID', String(pid), '/T', ...(force ? ['/F'] : [])], { stdio: 'ignore', windowsHide: true }); } catch { /* gone */ }
    return;
  }
  const sig = force ? 'SIGKILL' : 'SIGTERM';
  try { kill(-pid, sig); } catch {
    try { kill(pid, sig); } catch { /* gone */ }
  }
}

/**
 * Run `cmd args...` to completion, stopping its whole tree when `signal` aborts or `timeoutMs` passes.
 * @returns {Promise<{code: number|null, signal: string|null, timedOut: boolean, stopped: boolean, spawnError?: string}>}
 */
export function runChild({ cmd, args = [], signal, timeoutMs, graceMs = 10_000, onSpawn, spawn = cp.spawn, stop = stopTree, platform = process.platform }) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(cmd, args, { stdio: 'inherit', shell: false, detached: platform !== 'win32', windowsHide: true });
    } catch (e) { resolve({ code: null, signal: null, timedOut: false, stopped: false, spawnError: e.message }); return; }
    let stopped = false; let timedOut = false; let graceTimer = null; let timeoutTimer = null; let settled = false;
    const onAbort = () => stopNow();
    const finish = (r) => {
      if (settled) return;
      settled = true;
      clearTimeout(graceTimer); clearTimeout(timeoutTimer);
      signal?.removeEventListener('abort', onAbort); // a caller-owned controller aborted LATER must not reach a finished child
      resolve({ timedOut, stopped, ...r });
    };
    function stopNow() {
      if (stopped || settled) return;
      stopped = true;
      stop(child.pid, { force: false });
      graceTimer = setTimeout(() => stop(child.pid, { force: true }), graceMs);
    }
    child.once('error', (e) => finish({ code: null, signal: null, spawnError: e.message }));
    child.once('spawn', () => { try { onSpawn?.(child.pid); } catch { /* attaching is best effort */ } });
    child.once('close', (code, sig) => {
      // After a deliberate stop, sweep the group once more so a descendant that ignored SIGTERM cannot outlive the release.
      if (stopped && Number.isInteger(child.pid)) stop(child.pid, { force: true });
      finish({ code, signal: sig });
    });
    if (signal) {
      if (signal.aborted) stopNow(); else signal.addEventListener('abort', onAbort, { once: true });
    }
    if (timeoutMs > 0) timeoutTimer = setTimeout(() => { timedOut = true; stopNow(); }, timeoutMs);
  });
}
