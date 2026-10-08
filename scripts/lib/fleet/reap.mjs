/**
 * @fileoverview Source snippets the two /fleet supervisors (the check hook's, in
 * `checks.mjs`, and the tier's, in `tier-supervisor.mjs`) embed into their inline
 * programs, so "reap what an EXITED child left behind" has ONE implementation.
 *
 * Both are JavaScript SOURCE (the supervisors run as `node -e`). Each function
 * returns an outcome `{ok, killed, reason?}` — a reap that could not run, timed
 * out or failed to stop something is REPORTED, never read as a clean reap.
 *
 *  - `reapWinOrphans(rootPid, sinceMs, timeoutMs)` — win32; needs `spawnSync` in
 *    scope. Windows does not reparent an orphan: its `ParentProcessId` still names
 *    the dead parent, so the exited child's descendants are found by walking that
 *    link. Two guards against pid reuse: if a live process holds `rootPid` again it
 *    is not our child and nothing is touched; and only processes CREATED at or after
 *    the child's spawn (`sinceMs`, minus 1 s clock slack) are walked or stopped, so
 *    an older unrelated orphan whose dead parent once had the same pid is not ours.
 *  - `linuxStdioEnds(pid)` / `killLinuxHolders(ends)` — Linux; need `require` in
 *    scope. A descendant that escaped the process group (`setsid`/detached) but still
 *    holds the child's stdio is found through `/proc/<pid>/fd`. The child's OWN ends
 *    are recorded right after spawn (libuv has completed the exec by then) because
 *    libuv's stdio are socketpairs, whose two ends have DIFFERENT inodes — matching
 *    the supervisor's end would never find the holder. Elsewhere both are no-ops.
 *
 * NOT guaranteed (documented limits):
 *  - on POSIX, a descendant that escaped the group AND holds none of the child's
 *    stdio; on macOS, any escaped descendant (no /proc);
 *  - a hook that exits within the microseconds between spawn returning and its
 *    stdio ends being read leaves them unrecorded, so its escaped helper is not
 *    found (the check RESULT is unaffected: the supervisor exits once it is written);
 *  - termination is by numeric pid after inspection; a pid freed and reused in that
 *    microsecond window could be hit (node has no pidfd / process handles);
 *  - on win32 the walk descends through LIVE processes only: a helper started via an
 *    intermediate that has already exited (a double fork) is not reached. The check
 *    result is still correct — the supervisor reports it after its 1 s finish delay —
 *    but that helper is not terminated.
 *
 * @module scripts/lib/fleet/reap
 */

// PowerShell, kept as plain text and embedded via JSON.stringify (no hand-escaped quoting).
// __ROOT__ / __SINCE__ are substituted with integers at run time. Prints ONE JSON line.
const WIN_REAP_PS = [
  "$ErrorActionPreference = 'Stop'",
  'try {',
  '  $r = __ROOT__; $since = [DateTimeOffset]::FromUnixTimeMilliseconds(__SINCE__).UtcDateTime',
  '  $script:k = 0; $script:f = 0; $guarded = $false',
  '  if (@(Get-CimInstance Win32_Process -Filter "ProcessId=$r").Count -gt 0) { $guarded = $true } else {',
  '    function K($p) {',
  '      foreach ($c in @(Get-CimInstance Win32_Process -Filter "ParentProcessId=$p")) {',
  '        if ($c.CreationDate.ToUniversalTime() -lt $since) { continue }',
  '        K $c.ProcessId',
  '        try { Stop-Process -Id $c.ProcessId -Force -ErrorAction Stop; $script:k++ }',
  '        catch { if (Get-Process -Id $c.ProcessId -ErrorAction SilentlyContinue) { $script:f++ } }',
  '      }',
  '    }',
  '    K $r',
  '  }',
  "  Write-Output ('{\"guarded\":' + $guarded.ToString().ToLower() + ',\"killed\":' + $script:k + ',\"failed\":' + $script:f + '}')",
  "} catch { Write-Output ('{\"error\":' + (ConvertTo-Json -Compress ([string]$_.Exception.Message)) + '}'); exit 1 }",
].join('\n');

export const REAP_WIN_ORPHANS_JS = `
function reapWinOrphans(rootPid, sinceMs, timeoutMs) {
  const ps = ${JSON.stringify(WIN_REAP_PS)}.replace('__ROOT__', String(Number(rootPid))).replace('__SINCE__', String(Math.max(0, Math.floor(Number(sinceMs) - 1000))));
  let r;
  try { r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], { windowsHide: true, shell: false, timeout: timeoutMs, encoding: 'utf8' }); }
  catch (e) { return { ok: false, killed: 0, reason: 'could not start powershell: ' + e.message }; }
  if (r.error) return { ok: false, killed: 0, reason: r.error.code === 'ETIMEDOUT' ? 'the orphan query timed out after ' + timeoutMs + 'ms' : 'could not start powershell: ' + r.error.message };
  let out = null;
  try { out = JSON.parse(String(r.stdout).trim().split(/\\r?\\n/).pop()); } catch { /* reported below */ }
  if (!out) return { ok: false, killed: 0, reason: 'the orphan query printed no result (exit ' + r.status + ')' };
  if (out.error) return { ok: false, killed: 0, reason: 'the orphan query failed: ' + out.error };
  if (out.failed > 0) return { ok: false, killed: out.killed, reason: out.failed + ' descendant(s) could not be stopped' };
  return { ok: true, killed: out.killed, ...(out.guarded ? { guarded: true } : {}) };
}
`;

export const KILL_LINUX_HOLDERS_JS = `
function linuxStdioEnds(pid) {
  const ends = new Set();
  if (process.platform !== 'linux' || !pid) return ends;
  const fs = require('node:fs');
  for (const n of [0, 1, 2]) { try { const l = fs.readlinkSync('/proc/' + pid + '/fd/' + n); if (/^(pipe|socket):/.test(l)) ends.add(l); } catch { /* gone */ } }
  return ends;
}
function killLinuxHolders(ends) {
  if (process.platform !== 'linux' || !ends || !ends.size) return { ok: true, killed: 0 };
  const fs = require('node:fs');
  const link = (p) => { try { return fs.readlinkSync(p); } catch { return null; } };
  let pids = [];
  try { pids = fs.readdirSync('/proc').filter((p) => /^\\d+$/.test(p) && Number(p) !== process.pid); }
  catch (e) { return { ok: false, killed: 0, reason: 'cannot list /proc: ' + e.message }; }
  let killed = 0; let failed = 0;
  for (const p of pids) {
    let fds; try { fds = fs.readdirSync('/proc/' + p + '/fd'); } catch { continue; }
    if (!fds.some((n) => ends.has(link('/proc/' + p + '/fd/' + n)))) continue;
    try { process.kill(Number(p), 'SIGKILL'); killed += 1; } catch (e) { if (e.code !== 'ESRCH') failed += 1; }
  }
  return failed ? { ok: false, killed, reason: failed + ' process(es) holding the hook\\'s stdio could not be killed' } : { ok: true, killed };
}
`;
