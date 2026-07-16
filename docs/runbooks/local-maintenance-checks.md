# Local Weekly Maintenance Checks

Optional, default-OFF local replica of this repo's 5 weekly GitHub Actions
maintenance workflows, for operators whose org blocks GitHub-hosted Actions
runners (or who just prefer local-only). See
[`AGENTS.md`](../../AGENTS.md#local-weekly-maintenance-checks-opt-in) for the
one-paragraph pointer; this doc is the operational depth.

## What it replicates

6 checks, run as independent subprocesses (never crashes the whole run when
one is skipped or fails):

| Check | Source workflow | What it does | Required env |
|---|---|---|---|
| `arch-maintenance` | `architectural-drift.yml` | Incremental architectural-memory refresh + drift sweep + retention prune (bundled — the workflow runs these as one job, each step independent of the previous step's exit) | `AUDIT_DB_URL` |
| `migration-drift` | `migration-drift.yml` | Postgres migration-ledger drift check | `AUDIT_DB_URL` |
| `model-freshness` | `model-freshness.yml` | Live provider catalog vs `STATIC_POOL` | none (public catalogs) |
| `memory-health` | `memory-health.yml` | Findings-memory trigger metrics | `AUDIT_DB_URL` |
| `learning-weekly-review` | `learning-weekly-review.yml` | Recurring-issue digest | `AUDIT_DB_URL`, `LEARNING_REPO_NAME` |
| `cache-hitrate` | *(ad hoc weekly routine)* | `AUDIT_CACHE_SEED` payoff check | `AUDIT_DB_URL` |

`arch-maintenance` runs **incremental** refresh (`symbol-index/refresh.mjs`),
not `arch:refresh:full` — the workflow uses `:full` because CI is stateless;
a local machine already has the incremental cache, and `:full` makes real
LLM calls (Gemini embeddings + Claude summaries) that aren't worth spending
unattended. Note this check is **not** read-only: refresh writes to the
shared symbol index and prune deletes retained rows past their TTL. That's
safe to run opportunistically (idempotent/incremental, same as the GH
Actions job) but it does mean running the local path alongside working CI
means real writes happen twice, not a harmless double-read.

## Why opportunistic, not an OS scheduler

The obvious design is `schtasks`/`launchd`/cron — this repo deliberately
does **not** do that. Two incidents already burned this exact failure class:
the weekly cache-hitrate cloud routine was silently dead for months on stale
env vars, and a tiered-recall shadow-validation window read "met" while
every run was a silent fallback. An OS-scheduled job compounds that risk —
wrong PATH (`node` not resolved outside a login shell), wrong cwd, a `.env`
never loaded (scheduled tasks don't source your shell profile), and the
machine asleep at trigger time. Triggering from the pre-push hook instead
guarantees the run fires inside a live, correctly-configured session — the
same shell environment, cwd, and loaded `.env` as the push itself, on a
machine that is, by definition, not asleep.

Instead, `scripts/maintenance-checks.mjs --opportunistic` is invoked from
every `git push` (via the pre-push hook, unconditionally, cheap). It is a
silent no-op unless **both** hold:

1. `AUDIT_LOOP_WEEKLY_MAINTENANCE=1` is set (the opt-in gate).
2. The last recorded run (`.audit-loop/last-maintenance.json`, gitignored)
   is more than `AUDIT_LOOP_MAINTENANCE_INTERVAL_DAYS` days old (default 7)
   — OR a check that was previously skipped for missing env now has that
   env available (so adding `AUDIT_DB_URL` doesn't leave DB-backed checks
   waiting out the rest of the week).

The checks then run **detached in the background** (`round-1 code-audit
H1` — an earlier version merely appended `|| true`, which suppresses the
exit code but not the ~40-minute worst-case blocking wait for 6 sequential
checks). `git push` returns immediately; output goes to
`.audit-loop/last-maintenance.log` (gitignored), and a single-instance lock
(`.audit-loop/.maintenance.lock`) stops two quick pushes from running
DB-mutating checks concurrently. This means nobody watches the run live —
check `npm run maintenance:status` or the log file afterward, the same way
you'd check a CI run's log after the fact.

## Enabling it

Either:

- During `node setup.mjs`, answer **yes** at Step 4 ("Schedule weekly local
  maintenance checks?"). Default is **No** — a fresh clone with default
  answers behaves byte-identical to today.
- Or manually add `AUDIT_LOOP_WEEKLY_MAINTENANCE=1` to `.env`.

No separate install step is needed — the trigger lives in the pre-push hook
you already have (`npm run hooks:install`), and it reads the env var live at
push time.

## Commands

```bash
npm run maintenance:run       # run all 6 checks now, human output (foreground, not backgrounded)
npm run maintenance:run -- --json   # machine-readable
npm run maintenance:status    # show the last recorded run, without running anything
```

`--opportunistic` is the flag the hook uses internally; you don't need it
for a manual run — `maintenance:run` always runs regardless of the opt-in
flag or overdue check (an explicit manual invocation is its own consent),
and runs in the foreground so you see output live, unlike the backgrounded
push-triggered path above.

## Verifying it's running

```bash
npm run maintenance:status
```

prints the last run's timestamp, mode (`manual` / `opportunistic`), and each
check's status (`ok` / `attention` / `skipped`). If you've enabled the
opt-in and pushed at least once since, you should see a `mode: opportunistic`
entry within `AUDIT_LOOP_MAINTENANCE_INTERVAL_DAYS` days. For an
`attention`-status check, `.audit-loop/last-maintenance.log` has the actual
output from that push-triggered run.

## How this differs from GitHub Actions

If your org's Actions runners work fine, you don't need this — the 5
workflows in `.github/workflows/` already do the same job, with the added
benefit of a sticky GitHub issue when a check trips (this local path has no
equivalent; check the log file or `maintenance:status` instead). The two
are not mutually exclusive, but note `arch-maintenance` writes to and prunes
the shared architectural-memory store (see above) — running both means
those writes happen twice, not a harmless double-read.
