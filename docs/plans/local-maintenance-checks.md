# Plan: Local Weekly Maintenance Checks (opt-in)

- **Date**: 2026-07-15
- **Status**: Complete — implemented (retroactive plan — written after implementation, for /audit-code)
- **Author**: Claude + Louis
- **Scope**: backend (tooling)

- **Target domain(s)**: `scripts`, `sync-isolation`, `setup`

## Context Summary

The user's corporate ("work") clone of this repo cannot use GitHub Actions
(org policy blocks hosted runners), so it has no way to run the 5 weekly
maintenance workflows in `.github/workflows/` (architectural-drift,
migration-drift, model-freshness, memory-health, learning-weekly-review).

The original proposal (pasted from a prior session) was an OS-scheduled task
(`schtasks`/`launchd`/cron) with install/uninstall/status subcommands. That
was rejected in favour of an **opportunistic** design consistent with this
repo's already-documented local-first-CI convention (calendar workflows
become "catch-up on next push", not a background daemon) — an unattended
scheduled job risks wrong PATH/cwd, an unloaded `.env`, and a machine asleep
at trigger time, three failure classes this repo has already been burned by
(the months-dead cache-hitrate cron; the tiered-recall shadow window that
read "met" while 20/20 runs were silent fallbacks).

## Design

- **`scripts/maintenance-checks.mjs`** (new) — spawns each of the 6 replicated
  checks as a subprocess (never `import`s them — `memory-health.mjs` calls
  `process.exit()` unconditionally at module scope, which would kill an
  in-process orchestrator). Each check is individually skipped when its
  required env var is absent. Writes a heartbeat
  (`.audit-loop/last-maintenance.json`, gitignored) recording per-check
  status. `--status` reports without running; `--opportunistic` is a silent
  no-op unless `AUDIT_LOOP_WEEKLY_MAINTENANCE=1` AND the heartbeat is
  overdue (default 7 days, `AUDIT_LOOP_MAINTENANCE_INTERVAL_DAYS`).
- **A real, pre-existing gap this closes**: `memory-health.mjs` and
  `check-model-freshness.mjs` were never in `sync-to-repos.mjs`'s `CORE_ENTRY`
  — unreachable in any consumer before this change, independent of this
  feature. Both are now synced alongside `maintenance-checks.mjs` itself.
  `maintenance-checks.mjs` is also added to the relocation-guard
  `CLI_SMOKE_SET` (`scripts/lib/sync-isolation-verify.mjs`).
- **`install-prepush-hook.mjs`** — `HOOK_BODY` gains an unconditional,
  non-blocking (`|| true`) call to the CONSUMER's own synced
  `scripts/.claude-skills/maintenance-checks.mjs --opportunistic` (repo-scoped
  checks like `arch:refresh` need cwd = consumer repo, not the source
  sibling the audit call above it already uses). No-ops cleanly if the
  synced file is absent (stale consumer). The opt-in/overdue decision lives
  in the Node script (which loads `.env` via `dotenv`), not the shell, so
  there's no shell/dotenv env-visibility mismatch.
- **`package.json`** — `maintenance:run`, `maintenance:status`. Registered in
  `scripts/.cli-catalog.json` for the dashboard's CLI section (a pre-existing
  regression gate test enforces this).
- **`setup.mjs`** — new Step 4 (renumbering Dependencies→5, Skills→6,
  Hook→7), `ask()`/headless pattern, default **No**. On yes, writes
  `AUDIT_LOOP_WEEKLY_MAINTENANCE=1` to `.env`. Headless / default-No path is
  byte-identical to before (verified: `.env` diff empty under `--headless`).
- **`AGENTS.md`** — a 6-line stub (the repo was already at the 1200-line cap;
  two existing multi-line doc-pointer blocks were condensed to single lines
  to make room, no content dropped) + **`docs/runbooks/local-maintenance-checks.md`**
  (full operational detail, what-it-replicates table, why-not-a-scheduler
  rationale, enable/verify instructions).
- **`.gitignore`** (source) + the managed consumer-gitignore list in
  `sync-to-repos.mjs` (`AUDIT_RUNTIME_IGNORES`) both gained
  `.audit-loop/last-maintenance.json` — verified end-to-end against a real
  sync to `wine-cellar-app` (heartbeat file no longer shows as untracked).

## Verification performed

- `npm test` — 5439 passed, 0 failed (full suite, final state).
- `npm run check` (context:check + skills:check + plans:lint + efficacy:check
  + full suite) — green.
- Real end-to-end run against `wine-cellar-app` (a real consumer, not a
  mock), repeated after each round of fixes: `node
  scripts/.claude-skills/maintenance-checks.mjs --json` executed all 6
  checks correctly from the relocated position, against the consumer's own
  Postgres store and `.env`; `--selfcheck-relocation` passes;
  `learning-weekly-review` correctly skipped (missing `LEARNING_REPO_NAME`
  in that repo); heartbeat written to the consumer's own `.audit-loop/`, not
  the source repo's; `--opportunistic` with the flag enabled ran the full
  `runExclusive`/lock path for real.
- Hook-snippet non-blocking test + a dedicated ordering regression test that
  runs the FULL hook body with no `docs/plans/` directory present, proving
  the maintenance block fires despite the code-audit section's early exits
  (the G1 regression below).

## Audit trail (/audit-code, 4 GPT rounds + Gemini final gate)

**Round 1** (H:2 M:16 L:4) — fixed: H1 hook ran synchronously despite
`|| true` (backgrounded via detached subshell + log + lock); H2/M1/M5
aggregate heartbeat conflated skip-for-missing-env with a real run (added
`hasNewlyEligibleCheck`); M2 `Number()||fallback` accepted Infinity/negative
(added `positiveIntEnv`); M3 lossy stdout/stderr capture; L1 heartbeat shape
validation; L2/L3 doc said 6 checks, had 8 (bundled arch-refresh/drift/prune
into one `arch-maintenance` check); M6 added a script-path-resolution
regression test; M8 deduped `hasBash` into `tests/lib/hook-test-helpers.mjs`.
Dismissed: M4 (a correctly-gitignored file misread as "included"), M9-M16 +
L4 (pre-existing, unrelated `architecture-intent.md` graph edges). M7
(CHECKS duplicates workflow definitions, no shared source of truth) accepted
as documented debt.

**Round 2** (H:1 M:7 L:2) — fixed: M3/M4 `acquireLock`/`releaseLock`
reimplemented (with a real TOCTOU gap) what `lib/brainstorm/file-lock.mjs`
already solved; refactored to reuse `withFileLock` via a new `runExclusive`
wrapper. Dismissed: H1 (stale re-raise of M4), M1 (pre-existing `gate2A`
symlink gap, unrelated to my one-line `CLI_SMOKE_SET` edit in the same
file), M2 (diff-annotation rendering artifact mistaken for real file
content — verified the real file's first bytes), M5 (stale duplicate
re-raise), M6/M7/L1/L2 (pre-existing Architecture-pass noise).

**Round 3** (H:1 M:2 L:0) — fixed: H1 the lock only covered
`--opportunistic`, so an attended `maintenance:run` could overlap a
backgrounded push-triggered run (`runExclusive` now wraps both modes;
manual mode gets a loud contention message, opportunistic stays silent).
M3 (`file-lock.mjs` misplaced under `lib/brainstorm/`, evidenced by
`requirements.mjs` also being an independent consumer) accepted as
documented debt. M2 (third `hasBash` re-raise) root-caused to this repo's
own architectural-memory snapshot being stale since the round-1 dedup fix —
resolved by running `npm run arch:refresh`, not a code change.

**Round 4** (H:0 M:3 L:0) — 0 findings attributable to this diff. All 3
were either the same pre-existing `gate2A` area (a different specific
angle), an unrelated pre-existing 2026-03-30 migration, or the JS analyzer
choking on a **concurrent, unrelated session's** in-progress uncommitted
deletion of `scripts/lib/audit/seeded-random.mjs` sitting in the shared
working tree. Dismissed all three as independent.

**Gemini final review (Step 7) — first pass: `CONCERNS`.** Caught two real
issues all 4 GPT rounds missed:
- **G1 (HIGH)** — the maintenance block was placed at the *end* of the
  pre-push hook, after the code-audit section's early `exit 0`s for
  "`docs/plans` absent" / "no active plan file" (the common state on most
  pushes). It would almost never actually run — the feature was
  functionally dead in the ordinary case. **Fixed**: moved the block to the
  top, right after the `AUDIT_PREPUSH_DISABLE` check, so it always runs
  regardless of plan state. Added a regression test that runs the full hook
  body with no `docs/plans/` directory and proves the mock fires.
- **G2 (MEDIUM)** — the round-1/round-3 fixes introduced two new generated
  files (`.audit-loop/last-maintenance.log`, `.audit-loop/.maintenance.lock`)
  that were never added to the gitignore lists. **Fixed**: added both to
  the source `.gitignore` and the consumer-managed `AUDIT_RUNTIME_IGNORES`
  list; re-verified propagation against `wine-cellar-app`.

**Gemini final review — second pass: `APPROVE`.** 0 new findings, 0
wrongly-dismissed. Both fixes verified.

## Out of scope (explicitly deferred, not silently dropped)

- No OS-scheduler backend (rejected by design, see Context Summary).
- No change to the 5 GitHub Actions workflows themselves.
- `arch-refresh` runs incremental (`symbol-index/refresh.mjs`), not
  `arch:refresh:full` — the workflow uses `:full` because CI is stateless; a
  local machine already has the incremental cache, and `:full` makes real
  billed LLM calls not worth spending unattended.
