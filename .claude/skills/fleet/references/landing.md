---
summary: Landing beyond one combined run — required checks that ran, serial landing, restack, append-only files.
---

# Landing beyond one combined test run

## Required checks must have RUN

GitHub counts a SKIPPED check as satisfying a required check, so a PR made ready after draft-time runs were skipped can merge seconds later on checks
that never ran. fleet asks ONE oracle (`assessRequiredCi`) and maps its answer with ONE table (`decideCiAdmission`); every landing path uses both.

- **GitHub defines what is required**: the rulesets that apply to the base (`rules/branches/<base>`, one page) once the branch itself has been read
  (a missing branch's rules read is `[]`, which proves nothing). Classic branch protection ENABLED, a requirement with no pinned app, a rule type the
  oracle does not read (`workflows`, `code_scanning`, a merge queue, a future type), a same-name commit status, more than one page of results, and
  duplicate same-name runs that disagree are all UNSUPPORTED: the run stops, never "none required".
- **`.fleet.json` `requiredChecks` is an ASSERTION**, not a source: the set must equal what GitHub requires, or the run stops and prints the diff. It never
  fills in for a GitHub read that failed. `[]` asserts none. CES asserts `["full-suite"]`, so if its ruleset ever stops requiring it, landing stops
  instead of reading "none required".
- **Observation**: the check runs of the immutable head, matched by name AND pinned app. skipped, neutral and stale are `not-run`, never success.
- **Dispositions**: only `passed` and a PROVEN `none-required` permit. failed and not-run refuse the member; pending and missing wait; ANYTHING unknown
  stops the RUN (not one member). pr-mode `land --approve` now refuses unless every PR permits: it prints NO plan on a check that has not passed (it used
  to print a runnable plan with a WAIT line).

**What fleet does NOT guarantee.** The evidence is point-in-time. `land --approve` prints commands a human runs later; a later `gh pr merge` does not
re-assess, and GitHub's own ruleset counts a skipped check as satisfied, so `land --approve <t> --serial` (which re-assesses immediately before each
merge and verifies it after) is the safe executor. Even then a retarget or a CI re-run in the gap between the last read and `gh pr merge` is narrowed
and only partly detected after the fact (the post-merge check reads the state NOW), never closed by fleet. Closing it is repository policy: a merge queue
(the only server-side re-evaluation at merge time) with required checks that cannot be skipped. fleet does not build a merge-queue path; a base whose rules
carry one stops the run. A merge that fails its post-merge verification is `merged-unverified`: a loud stop, never reported as landed.

`status` warns on a draft with auto-merge armed (marking it ready merges it on draft-time checks), and on a green, CLEAN, auto-merge-armed PR still unmerged
after 15 minutes (re-arm it).

## A fast-tier probe, before the full train

`land --dry-run --tier <name>` builds the same combined candidate from every ready branch and runs ONLY that pre-land
tier. It takes no heavy slot of its own, is kept under `fleet/probes/` (where no approve, confirm or resume reader looks,
so no bundle can approve it), removes its worktree, and exits 0 green, 4 red, 3 on a conflict. Plain `--dry-run` still
only plans. Once two or more branches are ready, `status` prints `N ready branches never tested together` until a train
or probe has covered every ready head at its current commit, so run a probe when a second branch becomes ready and again
when a ready head moves: a clash then surfaces in minutes, not at the full train.

## Stale ready marks

A ready mark on a branch ahead 0 of the base (nothing left to land) reads `ready (stale — ahead 0 of base)`; it is
derived on every read, never written. `land` leaves it out and names it; `--include-stale` brings it back.

## A red train (exit 4)

A train whose tiers RAN and went red exits **4**, never 3 (3 means nothing ran or it was not allowed), and `land` prints
each red tier's failure summary: pytest's `short test summary info` block, else the last FAILED / ERROR / `not ok` lines,
else the log's last lines. The full log stays at the path the tier line names. `--approve` of a red train is still refused (3).
Each tier result carries `reasonCode` (`land --json`). A **guard-only** red (every test passed; `references/config.md`) can land only by a
recorded human decision: `decision record --scope accept-guard --train <id>` binds the train, its candidate and that tier result, then
`land --approve <id> --accept-guard <dec-id>`. It never covers a test failure, timeout or unclassified red.

## A failed CI run the diff cannot have caused (rule 8)

Source-repo-gated: this repo only, where `full-suite` runs in GitHub Actions. Run
`node scripts/test-tier.mjs ci-verdict --pr <n> --rerun-unrelated-flake`;
never `gh run rerun` by hand, never twice. It re-runs attempt 1 only when every
failed job names its failing test files (`run-tests/v1 failed-files:`), the only
failed step is `npm test`, no changed file is a shared input (package files, the
selector, the workflow) and no failing file is changed or reached by the diff.
It files a `ci-flakes` proposal with the run as evidence. **A rerun may
diagnose, never clear**: the verdict counts every attempt for the head, so a
head that failed once stays `failed` (`failed-then-rerun`, exit 4) even when
attempt 2 is green; the re-run only says "reproduces" or "did not reproduce".
Only a new commit clears it: fix the cause, or delete the test with a written
reason. Exit 4: the failure stands (re-run or not). Exit 1: indeterminate,
check `gh run view <id>` and decide; the tool never sends a second request. A `conflicting` reason means GitHub ran nothing: merge the base
in first. The reservation lives on one coordinator machine.

## `land --approve <train> --serial`

For repos whose rules demand each branch be up to date (each merge leaves the
next PR behind). pr mode only. For each PR in landing order, fleet:

1. verifies it is open, not a draft, on the right base, at a head this run can
   account for (`DIRTY` stops it with the restack remedy);
2. if it is `BEHIND`, updates it through the API with `expected_head_sha`,
   then polls (up to 60 s) for the new head;
3. waits until every REQUIRED check passed on that exact head. `missing` and
   `pending` keep polling, because a new head registers its checks
   asynchronously. A failed or skipped check stops the run;
   `serialTimeoutMs` (default 60 min) stops it as resumable;
4. merges with `--match-head-commit <head>` and confirms the PR shows merged.

Every step is recorded before it is taken (`fleet/serial/<train>.json`), so
`land --resume <train>` re-enters exactly there; an already-merged PR is
observed, never merged twice. A head the run did not make (not the tested head,
and not a clean merge of the base it can re-derive) stops the run for a new
approval. A shallow clone is refused up front. The result says plainly that
each PR merged at a head GitHub's CI tested, which may differ from the locally
tested train candidate.

## `fleet restack <branch> [--onto <ref>] [--from <oid>] [--replace]`

After a squash merge, a stacked branch still carries its parent's commits.
restack replays only the branch's OWN commits (`from` defaults to the newest
merged PR head inside the branch, else the merge-base) onto the base, in a
throwaway worktree with no hooks. Then it compares the patch-id of
`from..branch` with `base..result`, excluding `.fleet.json` `restackIgnore`
and any union-resolved files.

- equal: writes `<branch>-restack`; with `--replace`, moves `<branch>` itself
  with a compare-and-swap, but only when no worktree has it checked out. A
  checked-out branch is never moved by fleet; it prints the `git reset --keep`
  the owning session runs.
- different: writes only `<branch>-restack-mismatch`, never replaces, exit 3.
- a real conflict: aborts, removes the worktree, names the commit and files;
  nothing is written.

It never pushes; it prints the push command.

## Append-only files (`.fleet.json` `appendOnlyGlobs`)

Files two branches each append to (a plan's log, a decisions index) can be
merged keeping both sides. This is all or nothing: every conflicted file must
match a glob, have base, ours and theirs stages (so add/add, modify/delete and
renames don't qualify), be a regular text file, and have the same mode on both
sides. Resolutions are computed first and written only inside a throwaway
worktree. Used by direct-mode trains (fleet pushes that tree) and restack. A
pr-mode train still stops at the conflict, because GitHub would too; restack
the second branch after the first lands.

## Checks run in the combined tree

`.fleet.json` checks with `runIn: ["land"]` run inside the train worktree,
after dependencies are provisioned. A guard added by one branch therefore
applies to every other branch's change before CI does. A check script that
exists only on one train branch is found there. The script must be COMMITTED
(on the base or a train branch): an untracked script is not in the train tree,
so the check fails to run, which blocks a `block`-severity check, loudly. A
check that imports the synced tooling (`scripts/.claude-skills/`, gitignored)
will not find it there either.

- **File overlap** is three-dot (`base...branch`), taken from the FRESHER of the local base and its upstream (`--fetch` refreshes it); uncommitted edits in live sessions' worktrees count as advisory evidence.

## Rollup landing: ONE PR per batch (`landing: "rollup"`)

CI runs on `pull_request`, so the saving comes from chips NOT opening PRs: a branch push triggers no full CI in any repo (measured
2026-11-18), and a draft PR still triggers it. With `.fleet.json` `"landing": "rollup"`, a chip ends at **branch pushed, then
`fleet ready`** (its pre-authorised ship steps stay: they put the `AI-*` trailers on the head). `next` and `ready` print a `LANDING:`
line saying so. You land the batch with the user's standing grant (`references/ship-batch.md`), and nothing needs a GitHub setting.

1. `fleet land --rollup [--select a,b] [--hold c]`: each ready member is admitted (the child re-check, and its remote branch tip
   equal to its ready oid). A member that fails is **held** with its reason, never failed; two members touching one path never share
   a rollup (the later is held, and lands in the next after its restack and any re-audit). The candidate is the ordinary train build
   with each member squashed under a message that names it and carries **no `AI-*` trailer**, and the pre-land tiers run on it.
2. `fleet land --approve <train> --rollup` re-admits every member, requires the base to be where the candidate was built, pushes
   `rollup/<date>-<n>`, opens ONE PR (provisional manifest as its body), waits for the required checks, then merges with
   `--squash --match-head-commit <candidate oid>`, never `--auto`. The squash body is the FINAL manifest (each member against its
   own head, tree and gate; the rollup's CI against the candidate tree). Resume: `land --resume <train> --rollup`.
3. **Red rollup**: the candidate, logs, branch and PR stay. Eject a suspect and rebuild: `land --rollup --hold <member>`. There is no
   automatic bisect, and a green rebuild without a member does not prove it at fault.
4. **Base race**: if the base moves before the merge the run stops `base-moved`; rebuild (pinning the head does not pin the base).
5. **After the landing**, member PRs (if any) are closed "superseded by #N" only when the squash tree equals the candidate tree
   and only if their head is still the admitted one; an `untested-base`, `tree-mismatch` or `wrong-target` landing closes nothing and
   marks no session done: verify each member against the landed tree by hand. One rollup is live per repo; a rollup that never
   requested a merge is superseded by the next build.
