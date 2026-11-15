/**
 * @fileoverview The process TREE under a lease holder's recorded pid: who is in it (launcher first, then its descendants), when
 * each started (UTC), and the CPU time the whole tree has used. `lease run`'s heartbeat records the tree's CPU so an idle run
 * stops renewing; `lease status` prints the tree and its CPU so a PERSON can judge a stuck slot (consumer reports 2026-11-15).
 *
 * The TREE, never the pid alone: the recorded pid is usually a launcher (`npm.cmd` -> `cmd.exe` -> `node` -> `python`) whose own
 * CPU stays flat while a descendant works — one consumer's launcher read 0.41 s while a python grandchild used 1-2 s every 5 s.
 * Start times are UTC at the source (PowerShell `ToUniversalTime()`; `ps` elapsed time subtracted from the reading's clock),
 * because comparing a local-time start with a UTC expiry once "proved" a pid reuse that was not one.
 *
 * Nothing here decides anything: it measures. Reclaiming a slot stays a human action. Any failure is `null` — unmeasured, never
 * "idle". Never throws.
 *
 * @module scripts/lib/fleet/lease-cpu
 */
import cp from 'node:child_process';
import crypto from 'node:crypto';

const TIMEOUT_MS = 15_000;
const WIN_SCRIPT = "Get-CimInstance Win32_Process | ForEach-Object { $s = if ($_.CreationDate) { $_.CreationDate.ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ') } else { '-' }; '{0} {1} {2} {3} {4}' -f $_.ProcessId, $_.ParentProcessId, ($_.KernelModeTime + $_.UserModeTime), $s, $_.Name }";

/** `ps` time `[[dd-]hh:]mm:ss[.cc]` -> milliseconds, or null. Used for both cumulative CPU and elapsed time. */
export function psTimeMs(v) {
  const m = /^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+(?:\.\d+)?)$/.exec(String(v));
  if (!m) return null;
  const [, d = '0', h = '0', mi, s] = m;
  return Math.round((((Number(d) * 24 + Number(h)) * 60 + Number(mi)) * 60 + Number(s)) * 1000);
}

/** `pid ppid cpu100ns startUTC|- name` lines -> rows. */
export function parseWinTable(text) {
  return String(text).split(/\r?\n/).flatMap((line) => {
    const m = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s*(.*)$/.exec(line);
    if (!m) return [];
    const startedAt = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(m[4]) ? m[4] : null;
    return [{ pid: Number(m[1]), ppid: Number(m[2]), cpuMs: Math.floor(Number(m[3]) / 10_000), startedAt, name: m[5].trim() || '?' }];
  });
}

/** `pid ppid time etime comm` lines from `ps` -> rows; the start is the reading's clock minus the elapsed time. */
export function parsePsTable(text, nowMs = Date.now()) {
  return String(text).split(/\r?\n/).flatMap((line) => {
    const m = /^\s*(\d+)\s+(\d+)\s+(\S+)\s+(\S+)\s*(.*)$/.exec(line);
    if (!m) return [];
    const cpuMs = psTimeMs(m[3]);
    if (cpuMs === null) return [];
    const el = psTimeMs(m[4]);
    const startedAt = el === null ? null : new Date(Math.floor((nowMs - el) / 1000) * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z');
    return [{ pid: Number(m[1]), ppid: Number(m[2]), cpuMs, startedAt, name: m[5].trim() || '?' }];
  });
}

/**
 * `root` and its descendants, root first then depth-first, each with its depth; null when `root` is not in the table.
 * Cycle-safe (a reused parent pid can make the table claim one).
 */
export function treeOf(rows, root) {
  const byPid = new Map(rows.map((r) => [r.pid, r]));
  if (!byPid.has(root)) return null;
  const kids = new Map();
  for (const r of rows) if (r.pid !== r.ppid) { if (!kids.has(r.ppid)) kids.set(r.ppid, []); kids.get(r.ppid).push(r); }
  const out = []; const seen = new Set(); const stack = [[root, 0]];
  while (stack.length) {
    const [pid, depth] = stack.pop();
    if (seen.has(pid)) continue;
    seen.add(pid);
    out.push({ ...byPid.get(pid), depth });
    for (const k of [...(kids.get(pid) ?? [])].sort((a, b) => b.pid - a.pid)) stack.push([k.pid, depth + 1]);
  }
  return out;
}

/** Total CPU of a tree (from `treeOf`), or null. */
export const treeCpuMs = (rows, root) => { const t = treeOf(rows, root); return t ? t.reduce((a, r) => a + r.cpuMs, 0) : null; };

/**
 * One read of the machine's process table, or null.
 * @param {{platform?: string, spawnSync?: typeof cp.spawnSync, now?: () => number}} [deps]
 */
const winCmd = () => ['powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', WIN_SCRIPT]];
const psCmd = () => ['ps', ['-A', '-o', 'pid=,ppid=,time=,etime=,comm=']];

/**
 * Parse one table read, and drop THIS process's own sampler (`powershell.exe` / `ps` spawned by `selfPid`): when the monitored
 * root is the runner itself (a job that never attached a child), the sampler is a fresh descendant at every read and would make
 * the tree look busy forever (audit R2 H2).
 */
export function tableFrom(stdout, { win, nowMs = Date.now(), selfPid = process.pid }) {
  const rows = (win ? parseWinTable(stdout) : parsePsTable(stdout, nowMs))
    .filter((r) => !(r.ppid === selfPid && /^(powershell(\.exe)?|ps)$/i.test(r.name)));
  return rows.length ? rows : null;
}

/**
 * One read of the machine's process table, or null. SYNCHRONOUS — for `lease status` (a one-shot command); the heartbeat uses
 * `readProcessTableAsync` so a slow read never blocks the runner's event loop.
 * @param {{platform?: string, spawnSync?: typeof cp.spawnSync, now?: () => number}} [deps]
 */
export function readProcessTable({ platform = process.platform, spawnSync = cp.spawnSync, now = Date.now } = {}) {
  const win = platform === 'win32';
  const [file, args] = win ? winCmd() : psCmd();
  let r;
  try { r = spawnSync(file, args, { encoding: 'utf8', timeout: TIMEOUT_MS, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] }); } catch { return null; }
  if (!r || r.error || r.status !== 0) return null;
  return tableFrom(r.stdout, { win, nowMs: now() });
}

/** `readProcessTable`, asynchronously (bounded by the same timeout); resolves null on any failure. Never rejects. */
export function readProcessTableAsync({ platform = process.platform, execFile = cp.execFile, now = Date.now } = {}) {
  const win = platform === 'win32';
  const [file, args] = win ? winCmd() : psCmd();
  return new Promise((resolve) => {
    try {
      execFile(file, args, { encoding: 'utf8', timeout: TIMEOUT_MS, windowsHide: true, maxBuffer: 32 * 1024 * 1024 }, (err, stdout) => {
        resolve(err ? null : tableFrom(stdout, { win, nowMs: now() }));
      });
    } catch { resolve(null); }
  });
}

/** CPU ms used so far by `pid`'s whole tree, or null when it cannot be measured. */
export function processTreeCpuMs(pid, deps) {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  const rows = readProcessTable(deps);
  return rows ? treeCpuMs(rows, pid) : null;
}

/**
 * What a heartbeat records of the tree: its CPU so far AND a digest of its membership. A worker present at one read and gone
 * (or new) at the next changes the membership even when its CPU left the total with it. A worker that starts AND exits entirely
 * between two reads is invisible to both — sampling cannot see it, and nothing here claims otherwise. That costs at most a
 * stopped RENEWAL (a person then reads `lease status`); it never takes the slot. null when it cannot be measured.
 * @returns {Promise<{cpuMs: number, procs: string}|null>}
 */
export async function processTreeActivity(pid, { read = readProcessTableAsync } = {}) {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  const rows = await read();
  const tree = rows ? treeOf(rows, pid) : null;
  return tree ? { cpuMs: tree.reduce((a, r) => a + r.cpuMs, 0), procs: membershipDigest(tree) } : null;
}

/**
 * Stable 16-hex digest of a tree's membership (order-free): pid and name only. Never a reconstructed start time — on `ps` that
 * is the reading's clock minus a whole-second elapsed time, which differs between reads of the same process (audit R2 H3).
 */
export function membershipDigest(tree) {
  const key = tree.map((r) => `${r.pid}:${r.name}`).sort().join(',');
  return crypto.createHash('sha256').update(key).digest('hex').slice(0, 16);
}

/**
 * The tree under `pid` and the CPU it used over a live `sampleMs` window (two table reads), for `lease status`.
 * @returns {Promise<{measured: false, reason: string} | {measured: true, tree: object[], cpuMs: number, windowMs: number}>}
 */
export async function sampleTree(pid, { sampleMs = 5_000, read = readProcessTable, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), clock = Date.now } = {}) {
  const a = read();
  const t0 = clock();
  const first = a ? treeOf(a, pid) : null;
  if (!a) return { measured: false, reason: 'the process table could not be read' };
  if (!first) return { measured: false, reason: `pid ${pid} is not running` };
  await sleep(sampleMs);
  const b = read();
  const second = b ? treeOf(b, pid) : null;
  if (!second) return { measured: false, reason: b ? `pid ${pid} exited during the sample` : 'the process table could not be read a second time' };
  // Per-process delta, so a worker that started during the window counts from zero and one that exited is not negative.
  const before = new Map(first.map((r) => [r.pid, r.cpuMs]));
  const cpuMs = second.reduce((acc, r) => acc + Math.max(0, r.cpuMs - (before.get(r.pid) ?? 0)), 0);
  // A worker that came and went inside the window took its CPU with it: say the tree changed, so "no CPU" is never claimed
  // over a window in which processes started or exited.
  const now2 = new Set(second.map((r) => r.pid));
  const started = second.filter((r) => !before.has(r.pid)).length;
  const exited = first.filter((r) => !now2.has(r.pid)).length;
  return { measured: true, tree: second, cpuMs, windowMs: Math.max(1, clock() - t0), started, exited };
}
