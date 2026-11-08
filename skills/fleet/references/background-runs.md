---
summary: Background-run heartbeats — launch a long job under a journal, arm a stale-watch that wakes its session.
---

# Background runs — heartbeat + stale-watch

`/fleet` is turn-based: nothing watches between turns. A long job (a labelling run, a
model comparison, an overnight eval) that dies at 3 a.m. stays dead and silent until
someone looks — and "nobody said anything" reads like "still fine". This convention
makes a dead or hung run say so, and wakes the session that launched it.

## 1. Launch under a journal

```bash
node scripts/run-heartbeat.mjs run --run-id adjudicate-2026-11-09 --stale-after 900 -- node scripts/campaign.mjs adjudicate --campaign final-review-2026q3 --limit 10
```

The command is spawned without a shell. On Windows name the executable directly
(`node …`); a package script runs as `node --run test` (the script name), because Node refuses to
spawn an `npm.cmd`/`npx.cmd` shim without a shell (a spawn failure ends the run as
ENDED_FAILED, exit 127 — never as RUNNING).

- The journal is reserved BEFORE the command starts, so a reused id spawns nothing.
- Every line of output is a heartbeat (at most one per 5 s). Pick `--stale-after` above
  the job's longest silent stretch.
- The wrapper exits with the command's exit code and writes an `end` record.
- Journals live in the git common dir (`<common-dir>/audit-loop/runs/`), so a run in a
  pinned fixture worktree is visible from every checkout. An unwritable dir is an error,
  never a silent local fallback.
- A job that writes its own progress can beat directly instead:
  `run-heartbeat start` once, `run-heartbeat beat --run-id <id>` per unit of progress,
  `run-heartbeat end --run-id <id> --exit <code>` at the end.

Run the launch itself in the background (Claude Code: Bash `run_in_background`), so
this session keeps working.

## 2. Arm the stale-watch

```bash
node scripts/run-heartbeat.mjs watch --run-id adjudicate-2026-11-09 --poll 60
```

`watch` prints one line per state change and **exits** on a terminal state — ENDED_OK,
ENDED_FAILED, STALE or UNKNOWN. Arm it with Claude Code's `Monitor` tool (each exit is
one notification that wakes this session), or as a Bash `run_in_background` command.

**Honest limits** — say these, do not paper over them:

- A Monitor expires (at most 30 minutes). After it expires **nothing is watching**;
  re-arm it, or for an unattended night use a scheduled task that runs `check`.
  An expired watcher is not a verdict.
- STALE means "no progress observed", not "stopped". A wrapper killed uncatchably
  writes no `end`, and its child may still be running and spending. `check` reports the
  child pid and whether it is alive (pid reuse makes "alive" a hint — confirm the
  command line before stopping anything).

## 3. Read the verdict

```bash
node scripts/run-heartbeat.mjs check --run-id adjudicate-2026-11-09
node scripts/run-heartbeat.mjs list
```

| State | Means | Exit |
|---|---|---|
| RUNNING | a heartbeat within the declared cadence | 0 |
| ENDED_OK | the command exited 0 | 0 |
| ENDED_FAILED | non-zero exit, a signal, or a spawn failure (127) | 1 |
| STALE | no heartbeat for longer than `--stale-after` and no end | 3 |
| UNKNOWN | no journal, no start, no cadence, or a timestamp from the future | 3 |

Absence is never health: a missing journal is UNKNOWN, not RUNNING. `/fleet status`
prints one `runs:` line from the same reader (`runs: 1 running · STALE <id> (last beat
41m ago, child pid alive)`); an unreadable runs dir prints `runs: UNMEASURED`, never
nothing.
