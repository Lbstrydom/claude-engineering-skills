---
summary: Landing beyond one combined run — required checks that ran, serial landing, restack, append-only files.
---

# Landing beyond one combined test run

## Required checks must have RUN

GitHub counts a SKIPPED check as satisfying a required check, so a PR made
ready after draft-time runs were skipped can merge seconds later on checks that
never ran. fleet asks three questions apart:

- **Inventory**: which checks are required. It reads rulesets
  (`rules/branches/<base>`) AND classic branch protection (`branches/<base>`),
  plus `.fleet.json` `requiredChecks`. If either GitHub source cannot be read and
  the config declares nothing, the inventory is `unknown`, never "none".
  `"requiredChecks": []` is the only way to say none are required.
- **Observation**: every check on the PR head. A required check observed as
  skipped is `not-run`; one never observed is `missing`.
- **Head binding**: the head is read before and after observing; if it moves,
  the answer is `unknown`.

pr-mode `land --approve` refuses a draft PR and a `failed` or `not-run` required
check. `missing`, `pending` and `unknown` print a `WAIT` line above that merge
command. `status` warns on a draft with auto-merge armed (marking it ready merges
it on draft-time checks), and on a green, CLEAN, auto-merge-armed PR still
unmerged after 15 minutes (re-arm it). Limit: checks are matched by name; `gh`
does not say which app produced an observed check.

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
