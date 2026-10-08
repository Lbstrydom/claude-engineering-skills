/**
 * @fileoverview Source snippets the two /fleet supervisors (the check hook's, in
 * `checks.mjs`, and the tier's, in `tier-supervisor.mjs`) embed into their inline
 * programs, so "reap what an EXITED child left behind" has ONE implementation.
 *
 * Both are JavaScript SOURCE (the supervisors run as `node -e <program>`), and each
 * defines one function; the embedding program must already have `spawnSync` and
 * `fs`/`require` in scope as noted.
 *
 *  - `reapWinOrphans(rootPid, timeoutMs)` — win32. Windows does not reparent an
 *    orphan: its `ParentProcessId` still names the dead parent, so the exited
 *    child's descendants are found by walking that link. GUARD against pid reuse:
 *    if a live process holds `rootPid` again, it is not our child, and its
 *    children are not ours — nothing is touched.
 *  - `linuxStdioEnds(pid)` / `killLinuxHolders(ends)` — Linux. A descendant that
 *    escaped the process group (`setsid`/detached) but still holds the child's
 *    stdio is found through `/proc/<pid>/fd`. The child's OWN ends are recorded
 *    right after spawn (libuv has completed the exec by then) because libuv's
 *    stdio are socketpairs, whose two ends have DIFFERENT inodes — matching the
 *    supervisor's end would never find the holder. Elsewhere both are no-ops.
 *
 * NOT guaranteed (documented limit): on POSIX, a descendant that escaped the group
 * AND holds none of the child's stdio (on macOS, any escaped descendant — no /proc).
 *
 * @module scripts/lib/fleet/reap
 */

/** Needs `spawnSync` in scope. */
export const REAP_WIN_ORPHANS_JS = `
function reapWinOrphans(rootPid, timeoutMs) {
  const ps = '$r=' + rootPid + '; if (-not (Get-CimInstance Win32_Process -Filter "ProcessId=$r")) { '
    + 'function K($p){ Get-CimInstance Win32_Process -Filter "ParentProcessId=$p" | ForEach-Object { K $_.ProcessId; Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue } }; K $r }';
  try { spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], { windowsHide: true, shell: false, timeout: timeoutMs }); } catch { /* best effort */ }
}
`;

/** Needs `require` in scope. */
export const KILL_LINUX_HOLDERS_JS = `
function linuxStdioEnds(pid) {
  const ends = new Set();
  if (process.platform !== 'linux' || !pid) return ends;
  const fs = require('node:fs');
  for (const n of [0, 1, 2]) { try { const l = fs.readlinkSync('/proc/' + pid + '/fd/' + n); if (/^(pipe|socket):/.test(l)) ends.add(l); } catch { /* gone */ } }
  return ends;
}
function killLinuxHolders(ends) {
  if (process.platform !== 'linux' || !ends || !ends.size) return;
  const fs = require('node:fs');
  const link = (p) => { try { return fs.readlinkSync(p); } catch { return null; } };
  let pids = [];
  try { pids = fs.readdirSync('/proc').filter((p) => /^\\d+$/.test(p) && Number(p) !== process.pid); } catch { return; }
  for (const p of pids) {
    let fds; try { fds = fs.readdirSync('/proc/' + p + '/fd'); } catch { continue; }
    if (fds.some((n) => ends.has(link('/proc/' + p + '/fd/' + n)))) { try { process.kill(Number(p), 'SIGKILL'); } catch { /* gone */ } }
  }
}
`;
