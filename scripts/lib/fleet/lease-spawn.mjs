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
import fs from 'node:fs';
import path from 'node:path';

const NODE_CLI_SHIMS = Object.freeze({ npm: 'npm-cli.js', npx: 'npx-cli.js' });

/**
 * Where to actually spawn `cmd`. On Windows `npm`/`npx` are `.cmd` shims: `spawn('npm')` is ENOENT and `spawn('npm.cmd')` is EINVAL
 * without a shell, and `shell: true` is exactly what this module must not use (the argv is passed verbatim, nothing interpolated).
 * npm ships its own Node entry point (`<dir>/node_modules/npm/bin/npm-cli.js`) beside its shim, so the shim is replaced by
 * `node <entry> args...`, which needs no shell. WHICH npm is chosen follows what a shell would do: the first PATH directory holding
 * the shim AND its entry point wins (a globally upgraded npm in %APPDATA%
pm shadows the bundled one, as it does at a prompt);
 * only when PATH has none is the npm beside the running node used. Anything else, any other platform, or no entry point found is
 * returned unchanged.
 *
 * @returns {{cmd: string, args: string[], rewritten: boolean, entry?: string}}
 */
export function resolveSpawnTarget({ cmd, args = [], platform = process.platform, execPath = process.execPath, exists = fs.existsSync, pathEnv = process.env.Path ?? process.env.PATH ?? '' }) {
  const same = { cmd, args, rewritten: false };
  if (platform !== 'win32' || typeof cmd !== 'string') return same;
  const w = path.win32;
  const base = w.basename(cmd).replace(/\.cmd$/i, '').toLowerCase();
  const shim = NODE_CLI_SHIMS[base];
  // Only a bare command name is rewritten: an explicit path is the caller choosing a binary.
  if (!shim || cmd !== w.basename(cmd)) return same;
  const entryIn = (dir) => w.join(dir, 'node_modules', 'npm', 'bin', shim);
  const fromPath = String(pathEnv).split(';').map((d) => d.trim().replace(/^"|"$/g, '')).filter(Boolean)
    .find((d) => exists(w.join(d, `${base}.cmd`)) && exists(entryIn(d)));
  const entry = entryIn(fromPath ?? w.dirname(execPath));
  return fromPath !== undefined || exists(entry) ? { cmd: execPath, args: [entry, ...args], rewritten: true, entry } : same;
}

/**
 * The one line printed when the child could not be started: what was asked for, what was resolved, from where, and (on Windows)
 * why a shim fails. Never prints the environment, and never the arguments (they can carry tokens or credential URLs): only how
 * many there were.
 */
export function describeSpawnFailure({ cmd, spawnError, target, cwd = process.cwd(), platform = process.platform }) {
  const t = target ?? { cmd, args: [] };
  const n = (t.args ?? []).length - (t.rewritten ? 1 : 0); // the rewritten entry point is not a caller argument
  const exe = t.rewritten ? `${t.cmd} ${t.entry}` : t.cmd;
  const hint = platform === 'win32' && !t.rewritten
    ? ' On Windows a .cmd shim cannot be spawned without a shell: run the tool through node <entry-point>.js (for npm that is node_modules/npm/bin/npm-cli.js beside node.exe).'
    : '';
  return `could not start ${JSON.stringify(cmd)}: ${spawnError} (resolved: ${exe} +${n} arg(s); cwd: ${cwd}).${hint}`;
}

/**
 * Stop the process tree rooted at `pid`. Never throws: a process that is already gone is the goal, not an error.
 */
export function stopTree(pid, { force = false, platform = process.platform, kill = process.kill.bind(process), spawnSync = cp.spawnSync } = {}) {
  if (!Number.isInteger(pid) || pid <= 0) return;
  if (platform === 'win32') {
    // `force` is irrelevant here by design: the first call already forces the whole tree (see the header).
    try { spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true }); } catch { /* gone */ }
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
export function runChild({ cmd, args = [], signal, timeoutMs, graceMs = 10_000, onSpawn, spawn = cp.spawn, stop = stopTree, platform = process.platform, execPath, exists }) {
  return new Promise((resolve) => {
    let child;
    const target = resolveSpawnTarget({ cmd, args, platform, ...(execPath ? { execPath } : {}), ...(exists ? { exists } : {}) });
    try {
      child = spawn(target.cmd, target.args, { stdio: 'inherit', shell: false, detached: platform !== 'win32', windowsHide: true });
    } catch (e) { resolve({ code: null, signal: null, timedOut: false, stopped: false, spawnError: e.message, target }); return; }
    let stopped = false; let timedOut = false; let graceTimer = null; let timeoutTimer = null; let settled = false;
    const onAbort = () => stopNow();
    const finish = (r) => {
      if (settled) return;
      settled = true;
      clearTimeout(graceTimer); clearTimeout(timeoutTimer);
      signal?.removeEventListener('abort', onAbort); // a caller-owned controller aborted LATER must not reach a finished child
      resolve({ timedOut, stopped, target, ...r });
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
      // After a deliberate stop on POSIX, sweep the group once more so a descendant that ignored SIGTERM cannot outlive the release
      // (the group outlives its leader). On Windows the tree is already gone or unreachable: the root's pid no longer names it.
      if (stopped && platform !== 'win32' && Number.isInteger(child.pid)) stop(child.pid, { force: true });
      finish({ code, signal: sig });
    });
    if (signal) {
      if (signal.aborted) stopNow(); else signal.addEventListener('abort', onAbort, { once: true });
    }
    if (timeoutMs > 0) timeoutTimer = setTimeout(() => { timedOut = true; stopNow(); }, timeoutMs);
  });
}
