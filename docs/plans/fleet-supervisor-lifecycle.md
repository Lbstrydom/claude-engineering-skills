# Plan: /fleet — supervisors end promptly and reap what an exited hook/tier left behind
- **Date**: 2026-10-08
- **Status**: Complete
- **Author**: Claude + Louis
- **Scope**: backend (CLI internals; no UI, no skill text) · stack `js-ts`
- **Target domain(s)**: `fleet`
- **Depends on**: docs/plans/fleet-capstone-feedback.md (Complete) — deferred findings R2-H1 and
  R1-M3 of its /audit-code session (audit-code-1791459567); docs/plans/fleet-storyline-feedback.md
  follow-ups ("still open: win32 strays after a normally-exited hook/tier")

## 1. Context Summary

Two defects in the supervisors that run a check hook (`checks.mjs` SUPERVISOR) and a land tier
(`tier-supervisor.mjs`), both MEASURED on 2026-10-08 before any change:

- **R2-H1 (POSIX).** A hook that prints its findings and exits while a helper that escaped its
  process group (`detached`/`setsid`) still holds the hook's stdio: `finish()` printed the result
  but the supervisor stayed alive on the open streams until the OUTER `spawnSync` timeout killed
  it, and `spawnExec` then reported the finished check as `timed out after 30000ms` (45 s). The
  repo already had a test for exactly this (`fleet-checks.test.mjs` "H1/H3") — it fails on Linux
  and had only ever run on a Windows host.
- **M3 (win32).** After a hook exited normally, a quiet descendant survived: a `detached` child of
  a node hook, and a `Start-Process` child of a PowerShell hook (a node hook's plain child is
  reaped by node's own job object). The close path reaped only on POSIX, on the stated grounds
  that "the parent link is gone once the hook exited" — false: Windows keeps `ParentProcessId` on
  orphans, which the held-pipes path already relied on. The tier supervisor had the same gap,
  documented as a limit.

**Instrument note.** Run the POSIX proof as `docker run --init`: without an init process, killed
orphans become zombies nothing reaps, `kill(pid, 0)` still succeeds on them, and five of the
existing lifecycle tests then "fail" on a correct implementation (measured: 6 fail without
`--init`, 1 with it — the real one).

## 2. Proposed Architecture

- **The check supervisor EXITS once its result has drained** (`stdout.write(json, () =>
  process.exit(0))`), after destroying the hook's stdio. Nothing a hook leaves behind can hold the
  check open any more, on any platform.
- **One reaper module, `reap.mjs`**, holding the two snippets both inline supervisor programs
  embed (they run as `node -e`, so they share SOURCE, not an import):
  - `reapWinOrphans(rootPid)`: walk `ParentProcessId` from the exited child; **pid-reuse guard** —
    if a live process holds `rootPid` again, touch nothing.
  - `linuxStdioEnds(pid)` / `killLinuxHolders(ends)`: record the hook's OWN stdio ends from
    `/proc/<pid>/fd/0-2` right after spawn (libuv has completed the exec by then), and after exit
    kill any other process holding one. Libuv's stdio are socketpairs, whose two ends have
    different inodes, so matching the supervisor's end (the first attempt) finds nothing.
- Check supervisor: the close path reaps on every platform; the held-pipes path also kills
  escaped holders on Linux. Tier supervisor: reaps orphans on win32 after a normal exit.
- **Cost, stated:** on win32 every check/tier now spawns one PowerShell CIM query after the
  child exits — measured ~1.3–2.3 s per check on this host (was ~0.12 s).
- **Still not guaranteed (documented):** on POSIX, a descendant that escaped the group and holds
  none of the child's stdio; on macOS, any escaped descendant (no `/proc`).

**Right-sizing.** Band-aid: raise the outer timeout, or skip the win32 tests. Over-built: a
platform process-tree tracker (job objects via native code, a Linux subreaper). Chosen: exit on
finish + two ~10-line platform snippets in one module.

## 9. Testing Strategy

`tests/fleet-supervisor-lifecycle.test.mjs` (new) plus the existing `fleet-checks` /
`fleet-hardening` lifecycle tests, whose two win32 "documented limit" skips are removed. Run on
BOTH platforms: Windows host, and Linux via `docker run --init node:22`. Red-then-green: each fix
reverted in turn (exit-on-finish, Linux holder kill, win32 close-path reap, win32 tier reap,
pid-reuse guard) must turn a test red on the platform it protects.
