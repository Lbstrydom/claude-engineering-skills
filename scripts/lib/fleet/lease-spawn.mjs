/**
 * @fileoverview The child process of `fleet lease run -- <cmd>`: spawn it with the caller's argv VERBATIM (`shell: false`, nothing
 * interpolated), stop it as a process TREE, and report how it ended (plan docs/plans/fleet-lease-turns-and-journal.md D7, audit
 * R1 H1). A `git push` starts a pre-push hook that starts npm and test workers; killing the launcher alone leaves them running,
 * so a stop that only signals the first pid would release the lease while heavy work continues.
 *
 *  - POSIX: the child is spawned `detached` (its own process group) and every stop signals the GROUP (`kill(-pid, ...)`).
 *  - Windows: a stop runs `taskkill /PID <pid> /T /F` at once. There is no graceful stop for a console tree (a plain `taskkill` only
 *    asks windows to close, and `child.kill()` is TerminateProcess anyway), and it matters that the tree dies WHILE THE ROOT IS
 *    ALIVE: `/T` finds descendants through their parent pid, so once the root has exited they are orphans no later call can reach
 *    (audit R2 H1/H2). So the tree is forced in one call, never "asked, then forced after the grace".
 *
 * Stated limits: a descendant that leaves the group on purpose (`setsid`, a daemon) is not stopped; a root that exits normally
 * while descendants keep running is a command that said it was done.
 *
 * @module scripts/lib/fleet/lease-spawn
 */
import cp from 'node:child_process';

import { describeSpawnFailure, resolveSpawnTarget } from '../spawn-target.mjs';

// Moved to scripts/lib/spawn-target.mjs (shared-lib); re-exported so every existing importer is unchanged.
export { describeSpawnFailure, resolveSpawnTarget };

/** taskkill's "the process was not found" status: the tree is already gone, which is the goal. */
const TASKKILL_NOT_FOUND = 128;

/**
 * Stop the process tree rooted at `pid`. Never throws, and never pretends: a process that is already gone is the goal (ok), but a
 * kill that FAILED is returned as `{ok: false, why}` so a caller can say the tree may still be running (c729: this used to swallow
 * every failure, so a surviving tree burned the shared machine while the slot was released over it and nobody was told).
 *
 *  - Windows: `taskkill` exit 0 = stopped, 128 = not found (gone); any other status, a spawn failure or a signal is a failure.
 *  - POSIX: `kill(-pid)` then `kill(pid)`; ESRCH (no such process) is gone, anything else (EPERM, ...) is a failure.
 * @returns {{ok: true} | {ok: false, why: string}}
 */
export function stopTree(pid, { force = false, platform = process.platform, kill = process.kill.bind(process), spawnSync = cp.spawnSync } = {}) {
  if (!Number.isInteger(pid) || pid <= 0) return { ok: true };
  if (platform === 'win32') {
    // `force` is irrelevant here by design: the first call already forces the whole tree (see the header).
    let r;
    try { r = spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true, encoding: 'utf8' }); } catch (e) { return { ok: false, why: `taskkill could not run (${e?.message ?? e})` }; }
    if (!r || r.error) return { ok: false, why: `taskkill could not run (${r?.error?.message ?? 'no result'})` };
    if (r.status === 0 || r.status === TASKKILL_NOT_FOUND) return { ok: true };
    const detail = String(r.stderr ?? '').trim().split('\n')[0].trim();
    return { ok: false, why: `taskkill /PID ${pid} /T /F exited ${r.status ?? `on signal ${r.signal}`}${detail ? `: ${detail}` : ''}` };
  }
  const sig = force ? 'SIGKILL' : 'SIGTERM';
  let groupErr = null;
  try { kill(-pid, sig); return { ok: true }; } catch (e) { groupErr = e; }
  try { kill(pid, sig); } catch (e) {
    if (e?.code === 'ESRCH') return groupErr?.code === 'ESRCH' ? { ok: true } : { ok: false, why: `${sig} to process group ${pid} failed (${groupErr?.code ?? groupErr?.message}) and the root is gone, so its descendants may be orphans` };
    return { ok: false, why: `${sig} to ${pid} failed (${e?.code ?? e?.message})` };
  }
  // The root was signalled but the GROUP was not (it exists but may not be signalled, e.g. EPERM): descendants are not covered.
  return groupErr?.code === 'ESRCH' ? { ok: true } : { ok: false, why: `${sig} reached the root (${pid}) but not its process group (${groupErr?.code ?? groupErr?.message}), so descendants may still be running` };
}

/**
 * Run `cmd args...` to completion, stopping its whole tree when `signal` aborts or `timeoutMs` passes.
 * `stopFailed` is present (and non-empty) only when a stop request FAILED: the tree may still be running, whatever the root did next.
 * @returns {Promise<{code: number|null, signal: string|null, timedOut: boolean, stopped: boolean, spawnError?: string, stopFailed?: string[]}>}
 */
export function runChild({ cmd, args = [], signal, timeoutMs, graceMs = 10_000, onSpawn, spawn = cp.spawn, stop = stopTree, platform = process.platform, execPath, exists, stdio = 'inherit' }) {
  return new Promise((resolve) => {
    let child;
    const target = resolveSpawnTarget({ cmd, args, platform, ...(execPath ? { execPath } : {}), ...(exists ? { exists } : {}) });
    try {
      child = spawn(target.cmd, target.args, { stdio, shell: false, detached: platform !== 'win32', windowsHide: true });
    } catch (e) { resolve({ code: null, signal: null, timedOut: false, stopped: false, spawnError: e.message, target }); return; }
    let stopped = false; let timedOut = false; let graceTimer = null; let timeoutTimer = null; let settled = false;
    const stopFailed = [];
    // An injected `stop` that returns nothing (the old contract) is read as ok: only an explicit {ok: false} is a failure.
    const attempt = (opts) => { const r = stop(child.pid, opts); if (r && r.ok === false) stopFailed.push(`${opts.force ? 'force' : 'first'} stop: ${r.why}`); };
    const onAbort = () => stopNow();
    const finish = (r) => {
      if (settled) return;
      settled = true;
      clearTimeout(graceTimer); clearTimeout(timeoutTimer);
      signal?.removeEventListener('abort', onAbort); // a caller-owned controller aborted LATER must not reach a finished child
      resolve({ timedOut, stopped, target, ...r, ...(stopFailed.length > 0 ? { stopFailed: [...stopFailed] } : {}) });
    };
    function stopNow() {
      if (stopped || settled) return;
      stopped = true;
      attempt({ force: false });
      graceTimer = setTimeout(() => attempt({ force: true }), graceMs);
    }
    child.once('error', (e) => finish({ code: null, signal: null, spawnError: e.message }));
    child.once('spawn', () => { try { onSpawn?.(child.pid); } catch { /* attaching is best effort */ } });
    child.once('close', (code, sig) => {
      // After a deliberate stop on POSIX, sweep the group once more so a descendant that ignored SIGTERM cannot outlive the release
      // (the group outlives its leader). On Windows the tree is already gone or unreachable: the root's pid no longer names it.
      if (stopped && platform !== 'win32' && Number.isInteger(child.pid)) attempt({ force: true });
      finish({ code, signal: sig });
    });
    if (signal) {
      if (signal.aborted) stopNow(); else signal.addEventListener('abort', onAbort, { once: true });
    }
    if (timeoutMs > 0) timeoutTimer = setTimeout(() => { timedOut = true; stopNow(); }, timeoutMs);
  });
}
