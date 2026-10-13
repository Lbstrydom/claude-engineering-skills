# Gate cost — where the test step's time goes, and `test:preflight`

**What it is.** `npm test` (the last step of the pre-push `check`) now prints, on
stderr, the slowest test files by test-body time. `npm run test:preflight` runs
the same suite minus the declared slow files, so a late guard-test failure can be
found in minutes instead of after a 17–40 minute gate.

**When you need it.** Before your **first** push of a branch (run
`npm run test:preflight`), when a gate "feels slow" and you want to know why, or
before anyone proposes speeding the suite up (read §2: the cost is a
critical-path cost, which changes which fix is worth building).

Plan: [`docs/plans/gate-cost-slice-1.md`](../plans/gate-cost-slice-1.md).

---

## 0. `guards:preflight` — the whole-suite guards, before you ask for a gate slot

**Then take the slot from the machine lease, not from a message:** `node scripts/fleet.mjs lease acquire --kind gate --for 30`,
`lease attach --pid <pid>` once the run starts, `lease release` after. The lease is one file shared by every repo's fleet
(`~/.claude-fleet/lease.json`, or `FLEET_MACHINE_DIR`; two OS users or WSL beside Windows must set that variable to one
shared path). Plan: [`docs/plans/fleet-machine-lease.md`](../plans/fleet-machine-lease.md).

```bash
npm run guards:preflight
```

**What it is.** Every static gate of `check` plus a declared list of whole-suite guard tests, in
about 30 s to 2 min (measured 2026-10-13: 25 s for the 24 guard test files, ~100 s for the 31 static gates on a loaded
machine). **Why.** At least four full gate runs of 12–20 min failed *only* on such a guard after
green targeted runs (`rmsync-retry-guard` x3, `dashboard-cli`, `check-status-log-integrity`,
`prepush-sandbox-honesty`; [gate-cost-slice-2.md](../plans/gate-cost-slice-2.md) §1.4): a guard's subject is
repo content, so no targeted run of the changed files reaches it. **When you need it.** Before asking the
coordinator for a gate slot, and before the first push of a branch.

- **Real checks, never copies.** The static half is *derived* from the `check` script in `package.json`
  (each `npm run <gate>` step before the final `npm test`), so a gate added to `check` joins it with no edit;
  the tests go through `scripts/run-tests.mjs`, the same runner and false-green guard as `npm test`.
- **Declared omissions.** `db:suites:gate` (72 s) and `gates:poison` (64 s) are left out, each with its measured cost and
  reason in `DECLARED_SLOW_GATES`; a stale entry (not a `check` step) fails `tests/guards-preflight.test.mjs`.
- **Never a bare pass.** Exit 0 PASS, 1 FAIL, 2 cannot plan or run (a stale list entry, an unreadable `package.json`), 3 INCOMPLETE. The status-log gate needs commits ahead of
  `origin/main` to compare; on a branch with none it is reported **NOT MEASURED** (exit 3), not skipped quietly.
- **Not the gate.** The line it prints says so. The pre-push gate and `npm run check` still run everything.
- **Adding a guard.** When a full gate fails on a corpus guard the preflight did not run, add that test file to
  `GUARD_TESTS` in [`scripts/lib/guards-preflight.mjs`](../../scripts/lib/guards-preflight.mjs) with the failure that
  earned it. The list is hand-kept because a heuristic for "corpus guard" missed 2 of 10 real failures
  (gate-cost-slice-2.md §1.4).

## 1. Commands

```bash
npm run test:preflight
```

The default set minus `PREFLIGHT_SKIPPED_FILES` ([`run-tests.mjs`](../../scripts/run-tests.mjs)),
which is now every heavy file in `.test-tiers.json` (the 48-file fleet and archive-lane family, 57% of the suite's
test time; see section 6). Before 2026-10-13 it skipped `tests/fleet-cli.test.mjs` alone, which after #214 saved about
3%. It prints a banner before and a summary after,
both naming the skipped files and saying **not the gate**. It exits non-zero on any
failure it ran and never prints a bare pass. It is not a substitute for the push
gate, which still runs everything.

```bash
npm test
```

Unchanged verdict. Adds a `Slowest test files (8 of N; …)` table on stderr.

```powershell
$env:TEST_TIMING_KEEP = "$env:TEMP\timing-full.json"; npm test
```

Keeps the **full** per-file report (the printed table is the top 8). The JSON is
`{version: "test-timing/v1", files:[{file, ms, tests}], totalMs, ignored}`. `TEST_TIMING_KEEP` is an
instruction to the runner and is scrubbed from the child's environment.

The timing reporter is a sibling of the false-green guard and **cannot change a
verdict**: it writes its own file, yields nothing to stdout, and a failure inside it
is swallowed. `tests/run-tests-timing.test.mjs` runs the real fixtures with and
without it and compares exit code and canonical TAP.

## 2. What was measured (2026-10-12, on the tree BEFORE #214)

> **#214 has since split the file.** Everything below describes the tree before
> `tests/fleet-cli.test.mjs` was split into 10 files (#214, merged 2026-10-12: nine
> new `tests/fleet-cli-*.test.mjs` files, the 36-test remainder in the original,
> and a template-copied fixture). It is kept as the evidence for why the split was
> the right lever, not as the current state. #214 measured, each a single sample on a
> busy machine so read it as direction: full `npm test` 803 s after against 1,636 s
> before, and its own gate's test step 522 s. **This runbook has not re-measured the
> post-split tree.** Re-run the `TEST_TIMING_KEEP` command in §1 for the new floor
> before quoting a number.

One full `npm test` on a 32-CPU Windows machine under ordinary load, with
`TEST_TIMING_KEEP` set: **949 test files, exit 0, 1,009 s wall**. All figures below
are *measured* from that run's kept report unless marked *derived*.

| Fact | Figure | Label |
|---|---|---|
| Wall time of the whole run | **1,009 s** | measured |
| Σ test-body time across all files (summed over parallel workers, **not** wall; elapsed time inside test bodies, waiting on subprocesses included, so worker-seconds, **not** CPU) | **7,344 s** | measured |
| `tests/fleet-cli.test.mjs` test-body | **972 s** (26 top-level suites, 132 cases) | measured |
| …as a share of Σ test-body | **13.2%** | derived |
| …as a share of the run's wall time | **96%** | derived (972 / 1,009) |
| The whole `fleet-*` family (30 files) | 3,270 s, **44.5%** of Σ | derived |
| `fleet-*` without `fleet-cli` | 29 files, 2,298 s | derived |
| Next-longest single file | `tests/fleet-handover.test.mjs`, **218 s** | measured |
| Files over 10 s / over 60 s / median file | 114 / 31 / **76 ms** | measured |
| Wall-time lower bound with 31 workers, with `fleet-cli` | **972 s** (the file is the floor) | derived: `max(longest file, Σ / workers)` |
| …without `fleet-cli` | **218 s** (`fleet-handover` becomes the floor) | derived |
| The same suite without that file, an earlier and lighter run | 159.6 s, 6,860 tests, 927 files (`tests/*.test.mjs` only) | measured 2026-10-11, **not** comparable under load |

**The reading that matters.** Two numbers look contradictory and are not.
`fleet-cli` is only **13%** of the summed test-body time the suite spends (worker-seconds,
not CPU: a test that waits on a spawned subprocess is still running), yet **96%** of its
wall time. `node --test` runs files in parallel but the tests *inside* one file
serially, so a file's test body is a floor on wall time however many cores are
idle. 948 other files share ~6,370 s of work across 31 workers and finish in the
shadow of the one file that cannot be split. Wall time is a critical-path cost.

Consequences, in order of how confident they are:

1. **The saving is in the one file, not in the suite.** Taking `fleet-cli` off the
   critical path bounds the run at about 218 s (*derived*, an idealised
   bound; the run's other ~37 s is start-up and queueing around `fleet-cli`).
   While `fleet-cli` is the floor, making the other 948 files 20% faster would save almost nothing on wall time.
2. **Fixture sharing and spawn memoisation reduce the file's total work; splitting or
   parallelising it reduces wall.** They are different levers. The earlier
   framing treated the first as the fix. Splitting `fleet-cli` into several files
   (or running its independent `describe` blocks with `concurrency`), without
   changing a single assertion, moves the floor from 972 s toward the next-longest
   file. That needs no new mechanism and removes no check. It is unproven: the
   972 s was measured with 31 workers competing for the same disk and process
   table, so the isolated cost of the file is lower and the split's real saving is
   smaller than the bound. **Measure that first** (§4).
3. **A failure after a full gate costs a whole gate.** The measured case: 2 of
   18,747 tests failed on a chip's first gate after green targeted runs, and the
   second gate was another ~27 minutes. That is what `test:preflight` is for.

*Not measured, and not claimed:* how much of `fleet-cli`'s 972 s is contention
with the other workers; whether any non-`fleet` file would become the floor once
`fleet-cli` is off the path (the second-longest is 218 s, so the floor can fall
by at most ~4.5x); the cost of the *other* `check` steps (this table is the
test step only).

Re-measure with the `TEST_TIMING_KEEP` command above and, for the shares:

```powershell
$r = Get-Content "$env:TEMP/timing-full.json" | ConvertFrom-Json; $c = $r.files | Where-Object file -eq 'tests/fleet-cli.test.mjs'; '{0:N1}% of summed test time; {1:N0} s' -f (100*$c.ms/$r.totalMs), ($c.ms/1000)
```

## 3. Using the preflight

- Run it once, before the first push. It takes roughly the wall time of the
  slowest remaining file plus start-up. **Measured on the pre-#214 tree**: 274 s for the test step
  (948 files, 18,626 tests, 0 failed) on the same machine that took 1,009 s for
  the full run (73% less), against a derived floor of 218 s. The first real run,
  under heavier load, took 483 s; there is no full run at that load to compare it
  with, so quote the 274 s against 1,009 s pair, which shares a load.
- It catches the guard tests (`tests/prepush-sandbox-honesty.test.mjs`,
  `tests/rmsync-retry-guard.test.mjs`) that targeted runs of the files you touched
  miss. That is its whole purpose: the measured case in §2 was exactly those two.
- A green preflight means *every file except the declared ones passed on this tree*.
  It says nothing about `tests/fleet-cli.test.mjs` (36 tests). If you touched
  `scripts/fleet.mjs`, `scripts/lib/fleet/**` or `tests/fleet-*.test.mjs`, run those
  files directly too.
- Its selection is verified after the run from the timing report. If a declared
  file ran, an expected file did not, or the report is missing, unreadable or
  partial (so the selection cannot be verified), the preflight **fails** and says
  which. A clean guard report proves the tests that ran passed, not that the right
  ones ran. This is the one place the timing report can move an exit code; an
  ordinary `npm test` never lets it.

## 4. Follow-ups, in the order the evidence now supports

1. **DONE by #214: split `tests/fleet-cli.test.mjs`.** This runbook's first
   recommendation, taken up in the same session it was written (nine files plus the
   36-test remainder, `describe` bodies moved verbatim). Its own caution still holds:
   a split only helps when there are spare cores, and nine files run concurrently on
   a saturated machine took 2,282 s, worse than serial (#214's PR). **Next step:
   re-measure** (`TEST_TIMING_KEEP`, §1) on a quiet machine, then decide whether
   `PREFLIGHT_SKIPPED_FILES` still names the slowest file. If it no longer does, replace
   it with whatever is now slowest; the list must stay non-empty, or the preflight
   becomes the gate under another name.
2. **Cut the fleet tests' own work, the part #214 did not.** #214 copies a
   per-process template instead of rebuilding the fixture (9 git spawns each). Still
   open: memoise duplicate `rev-parse` calls inside one command (9× `rev-parse
   --verify` and 6× `--path-format=absolute` in one `claim`) and skip `gh pr list` in
   `claim` when nothing needs it. It also shrinks the other 29 `fleet-*` files, which
   together held 2,298 s before the split.
3. **Train `testCommand` tiers in `.fleet.json`.** Moves the trust boundary (what
   runs per push versus per train); needs enforcement in the landing path, not
   prose. Do it after (1) and (2) shrink the number. Today `.fleet.json` has no
   `testCommand`, so `fleet land` runs `package.json`'s `npm test` once per train
   on top of each chip's own pre-push gate.
4. **Branch pre-push DIRECT-impact tier** (proposed in `ship-trains.md` §2.10):
   a policy decision for the maintainer, not a mechanical one. Bring this table.
5. **Shadow train-interaction audit** and **impact-tiered audit depth**: see the
   plan. The latter is sized at ≤10% of PRs (4 docs-only and 4 docs+tests of 80
   merged since 2026-09-25), and skill prose and gate docs change behaviour, so
   even those are not safe to skip.

## 5. Reading the numbers without fooling yourself

- **Test-body time is not process wall time.** It excludes node start-up and
  module import, which is why a file's wall cost is a little above its row.
- **Σ across workers is not elapsed time.** 7,344 s of work finished in 1,009 s.
  Quote shares of Σ for "where does the work go" and shares of wall for "what do I
  wait for"; they answer different questions and differ by a factor of seven here.
- **File attribution is by declaration.** Node's `file` field says where a test was
  declared, so a suite declared in a helper would be credited to the helper. On the
  real tree all 949 default files were reported, none missing, no strays, so nothing
  does this today; the preflight's selection check would turn it into a failure.
- **Compare timings only from the same run.** Two full gates of the same branch took
  1,647 s and 2,416 s; machine load alone moves a figure by 1.5x. The table above
  takes every share from one run for that reason.

## 6. The test tier (stages 0 and 1)

Plan: [`gate-cost-slice-2.md`](../plans/gate-cost-slice-2.md). **What it is.** A work-in-progress push may leave out the
heavy test files its diff cannot reach. **When you need it.** Reading a `test-tier/v1` line in a gate's output, opting a
push in, or maintaining `.test-tiers.json`.

| Stage | What a push does | Status |
|---|---|---|
| 0, shadow | runs the FULL suite and prints `test-tier/v1 shadow: would skip N of M heavy file(s)` | live: this is the default |
| 1, opt-in | `AUDIT_PREPUSH_TIER=branch git push` skips the unreached heavy files | live, per push, by your choice |
| 2, default | the default flips to the branch tier for work-in-progress pushes | NOT built; needs the user's approval and stage 1's evidence |

```bash
AUDIT_PREPUSH_TIER=branch git push        # opt this push in
AUDIT_PREPUSH_TIER=full git push          # force the full suite (also the default)
node scripts/test-tier.mjs select --head <sha> [--base <sha>] --json   # what the branch tier would skip for that head
node scripts/prepush-check.mjs --tier full --head <sha> --base <merge-base>   # full verdict for an already-pushed sha
node scripts/test-tier.mjs refresh-heavy --timing <TEST_TIMING_KEEP file>      # report-only: drifted timings, unlisted heavy files
```

**The list.** `.test-tiers.json` names the heavy files, each with a measured time and date and the reach the import graph
cannot compute (the fleet family declares `scripts/fleet.mjs`, `scripts/lib/fleet/**`, `tests/helpers/fleet-*.mjs`,
`.fleet.json`, and so on). Only listed files are ever skipped; every other file always runs, because the measured late
failures are cheap corpus guards no import graph can see. `npm run test:preflight` skips the same list, so a slow file is
named in one place.

**Reach.** A heavy file runs when the diff touches it, anything in its import closure, a literal repo path its tests
name, or its declared reach. An import that cannot be resolved, or a non-literal `import()` in the test layer, counts as
reached. **Measured deviation from the plan:** a non-literal `import()` inside a `scripts/**` module does NOT count (14
modules have one and the fleet tests reach them, so 40 of 48 heavy files were "reached" by every diff and the tier could
never skip); it is recorded as a blind spot, and the declared reach plus the full verdict before merge are its backstops.

**When a push is full anyway** (the envelope lists every reason): it updates the default branch; `AUDIT_PREPUSH_TIER=full`;
the diff touches the selector or what it reads (`SELECTOR_DEPENDENCIES` in `scripts/lib/test-tier.mjs`);
`package.json`, `package-lock.json` or `.nvmrc` changed; the list is stale (a missing file, or a timing older than
`maxAgeDays`, 30); there is no selection base; the selector fails in any way; or the pushed head predates the tier (then
the legacy `npm run check` runs).

**Reading the output.** A run ends with ONE line, `test-tier/v1 <full|branch> <sha> skipped=<n> base=<sha|none>
[reason=<why>]`, and the hook's success line repeats it: `checks passed (full)`, `(branch tier: N heavy files skipped -
NOT the full suite)`, or `(tier NOT reported: <why>)`. Only a `full` line is a full verdict. **A merge candidate needs a
`test-tier/v1 full <sha>` line for the sha it merges**: push it with `AUDIT_PREPUSH_TIER=full`, or run the command above,
then merge pinned with `--match-head-commit <sha>`.

**Re-measuring.** Run `TEST_TIMING_KEEP=<file> npm test` in a gate slot, then `refresh-heavy` and edit
`.test-tiers.json` by hand (report-only on purpose). **Open:** the 48-file variant has not been timed beside a full run,
so the savings quoted in the plan are *derived*, not measured; that measurement gates stage 2.

**Revert.** One line: `DEFAULT_BRANCH_TIER` in `scripts/lib/test-tier.mjs` (already `full`), or per machine
`AUDIT_PREPUSH_TIER=full`. Nothing persisted, nothing to migrate.
