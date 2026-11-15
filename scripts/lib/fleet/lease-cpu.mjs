/**
 * @fileoverview CPU time used so far by a process AND its descendants: the measurement that tells a lease holder whose pid is
 * alive but IDLE from one that is still working (consumer report 2026-11-15: an expired holder alive but idle refused every
 * waiter with `expired-pid-alive` for 38+ minutes, 343 refusals for one waiter).
 *
 * The TREE, not the pid: the pid `lease run` records is the job it spawned, and on Windows that is usually a wrapper
 * (`npm.cmd` -> `cmd.exe` -> `node`) whose own CPU stays flat while a descendant does the work. Reading the recorded pid alone
 * would call a working job idle; summing the tree cannot, and a tree that has grown an unrelated subtree through pid reuse only
 * reads as busier, the safe side.
 *
 * One process-table read per call: `Get-CimInstance Win32_Process` on Windows (100 ns units), `ps -A -o pid=,ppid=,time=`
 * elsewhere (whole seconds). Any failure is `null` — unmeasured, never "idle". Never throws.
 *
 * @module scripts/lib/fleet/lease-cpu
 */
import cp from 'node:child_process';

const TIMEOUT_MS = 15_000;
const WIN_SCRIPT = "Get-CimInstance Win32_Process | ForEach-Object { '{0} {1} {2}' -f $_.ProcessId, $_.ParentProcessId, ($_.KernelModeTime + $_.UserModeTime) }";

const rowsOf = (text, cpuOf) => String(text).split(/\r?\n/).flatMap((line) => {
  const m = /^\s*(\d+)\s+(\d+)\s+(\S+)\s*$/.exec(line);
  if (!m) return [];
  const cpuMs = cpuOf(m[3]);
  return cpuMs === null ? [] : [{ pid: Number(m[1]), ppid: Number(m[2]), cpuMs }];
});

/** `pid ppid kernel+user` lines (100 ns units) -> rows. */
export const parseWinTable = (text) => rowsOf(text, (v) => (/^\d+$/.test(v) ? Math.floor(Number(v) / 10_000) : null));

/** `ps` cumulative time `[[dd-]hh:]mm:ss[.cc]` -> milliseconds, or null. */
export function psTimeMs(v) {
  const m = /^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+(?:\.\d+)?)$/.exec(String(v));
  if (!m) return null;
  const [, d = '0', h = '0', mi, s] = m;
  return Math.round((((Number(d) * 24 + Number(h)) * 60 + Number(mi)) * 60 + Number(s)) * 1000);
}

/** `pid ppid time` lines from `ps` -> rows. */
export const parsePsTable = (text) => rowsOf(text, psTimeMs);

/** Total CPU of `root` and every descendant; null when `root` is not in the table. Cycle-safe. */
export function treeCpuMs(rows, root) {
  if (!rows.some((r) => r.pid === root)) return null;
  const kids = new Map();
  for (const r of rows) { if (!kids.has(r.ppid)) kids.set(r.ppid, []); kids.get(r.ppid).push(r); }
  const byPid = new Map(rows.map((r) => [r.pid, r]));
  const seen = new Set(); const stack = [root]; let total = 0;
  while (stack.length) {
    const pid = stack.pop();
    if (seen.has(pid)) continue;
    seen.add(pid);
    total += byPid.get(pid)?.cpuMs ?? 0;
    for (const k of kids.get(pid) ?? []) if (k.pid !== pid) stack.push(k.pid);
  }
  return total;
}

/**
 * CPU milliseconds used by `pid`'s process tree, or null when it cannot be measured.
 * @param {number} pid
 * @param {{platform?: string, spawnSync?: typeof cp.spawnSync}} [deps]
 */
export function processTreeCpuMs(pid, { platform = process.platform, spawnSync = cp.spawnSync } = {}) {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  const win = platform === 'win32';
  let r;
  try {
    r = win
      ? spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', WIN_SCRIPT], { encoding: 'utf8', timeout: TIMEOUT_MS, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] })
      : spawnSync('ps', ['-A', '-o', 'pid=,ppid=,time='], { encoding: 'utf8', timeout: TIMEOUT_MS, stdio: ['ignore', 'pipe', 'ignore'] });
  } catch { return null; }
  if (!r || r.error || r.status !== 0) return null;
  return treeCpuMs(win ? parseWinTable(r.stdout) : parsePsTable(r.stdout), pid);
}

/** `processTreeCpuMs` memoised per pid for `ttlMs`: one decision asks the same question several times. */
export function memoCpuOf({ ttlMs = 5_000, clock = Date.now, measure = processTreeCpuMs } = {}) {
  const cache = new Map();
  return (pid) => {
    const hit = cache.get(pid);
    if (hit && clock() - hit.at < ttlMs) return hit.value;
    const value = measure(pid);
    cache.set(pid, { at: clock(), value });
    return value;
  };
}
