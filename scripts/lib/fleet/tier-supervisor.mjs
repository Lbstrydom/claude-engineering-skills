/**
 * @fileoverview Run one `land` tier so that a TIMEOUT kills the whole process tree.
 *
 * `spawnSync(..., {timeout})` kills only the process it spawned. A tier is
 * routinely a launcher (`npm test`, a shell string, a test runner with workers),
 * so after a timeout its descendants kept running inside the integration
 * worktree, writing to the same log and racing the `reset --hard`/`clean` that
 * `land` does next.
 *
 * Same shape as the check hook's supervisor (`checks.mjs`): a tiny node program
 * run via `process.execPath` that owns the tier in its OWN PROCESS GROUP (POSIX) /
 * kills `/T` the tree (win32), and prints one JSON envelope. The tier's stdout
 * and stderr go straight to the log file (opened by the supervisor), so no
 * output is buffered or lost.
 *
 * GUARANTEE (and its limits):
 *  - on timeout, the tier's process group (POSIX) / process tree (win32) is killed;
 *  - on POSIX, anything the tier left running in its group after it EXITED is
 *    killed too (a daemon in a verification worktree is a leak, not a result);
 *  - SIGINT/SIGTERM/SIGHUP to the supervisor kill the tier first, so Ctrl-C on
 *    `fleet land` does not orphan a running test run;
 *  - NOT guaranteed: a descendant that deliberately escapes the group
 *    (`setsid`/detached/a job object), and on win32 strays left after a tier
 *    that exited normally (the parent link is gone once it exits).
 *
 * @module scripts/lib/fleet/tier-supervisor
 */
import { spawnSync } from 'node:child_process';

const KILL_TIMEOUT_MS = 10_000; // a hung `taskkill` must not hang the supervisor

const SUPERVISOR = `
const cfg = JSON.parse(process.argv[1]);
const fs = require('node:fs');
const { spawn, spawnSync } = require('node:child_process');
const win = process.platform === 'win32';
let fd = null, child = null, done = false, timedOut = false, spawnErr = null, exitInfo = null, timer = null;
function killTree() {
  if (!child || child.pid === undefined) return;
  try {
    if (win) spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true, shell: false, timeout: cfg.killTimeoutMs });
    else process.kill(-child.pid, 'SIGKILL');
  } catch { /* nothing left to kill */ }
}
function finish() {
  if (done) return; done = true; clearTimeout(timer);
  if (fd !== null) { try { fs.closeSync(fd); } catch { /* already closed */ } }
  process.stdout.write(JSON.stringify({ status: exitInfo ? exitInfo[0] : null, signal: exitInfo ? exitInfo[1] : null, timedOut, error: spawnErr }));
}
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(sig, () => { killTree(); process.exit(130); });
try {
  fd = fs.openSync(cfg.logPath, 'a');
  child = spawn(cfg.file, cfg.args, { cwd: cfg.cwd, shell: cfg.shell, windowsHide: true, detached: !win, stdio: ['ignore', fd, fd], env: process.env });
} catch (e) { spawnErr = { code: e.code, message: e.message }; finish(); }
if (child) {
  if (cfg.timeoutMs) timer = setTimeout(() => { timedOut = true; killTree(); }, cfg.timeoutMs);
  child.on('error', (e) => { spawnErr = { code: e.code, message: e.message }; finish(); });
  child.on('exit', (status, signal) => {
    exitInfo = [status, signal];
    if (!win) killTree(); // reap anything the tier left in its group
    finish();
  });
}
`;

/**
 * Run a resolved tier spawn plan and wait for it. Never throws.
 * @param {{file: string, args: string[], shell: boolean|string, cwd: string, logPath: string, timeoutMs?: number}} p
 * @returns {{exitCode: number|null, timedOut: boolean, error: string|null, signal: string|null}}
 */
export function superviseTier({ file, args, shell, cwd, logPath, timeoutMs }) {
  const cfg = { file, args, shell, cwd, logPath, timeoutMs: timeoutMs ?? 0, killTimeoutMs: KILL_TIMEOUT_MS };
  const res = spawnSync(process.execPath, ['-e', SUPERVISOR, JSON.stringify(cfg)], {
    encoding: 'utf-8', shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], killSignal: 'SIGKILL',
    // The supervisor enforces `timeoutMs` itself; this only bounds a supervisor that has itself hung.
    ...(timeoutMs ? { timeout: timeoutMs + 2 * KILL_TIMEOUT_MS } : {}),
  });
  if (res.error) {
    const hung = res.error.code === 'ETIMEDOUT';
    return { exitCode: null, timedOut: hung, error: hung ? null : `tier supervisor failed: ${res.error.message}`, signal: res.signal ?? null };
  }
  let env;
  try { env = JSON.parse(res.stdout); } catch {
    return { exitCode: null, timedOut: false, error: `tier supervisor produced no result${res.stderr ? `: ${String(res.stderr).trim().split('\n')[0]}` : ''}`, signal: null };
  }
  return {
    exitCode: env.status ?? null,
    timedOut: Boolean(env.timedOut),
    error: env.error && !env.timedOut ? String(env.error.message) : null,
    signal: env.signal ?? null,
  };
}
