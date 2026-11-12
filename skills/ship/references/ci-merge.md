---
summary: ci-merge.mjs - wait on every check of the pushed head, reject red or UNSTABLE, update BEHIND, squash-merge.
---

# `ci-merge` — CI on the exact pushed head, and the safe merge

One synced script owns the loop that consumers kept rebuilding by hand (about ten merges a day in one of them).
Run it by path; it needs no package manager and no `npm run` alias.

```bash
node scripts/ci-merge.mjs --pr 123 --wait-only                    # report: a verdict per check, changes nothing
node scripts/ci-merge.mjs --pr 123 --merge --allow-fail "lint"    # wait, then squash-merge if safe
node scripts/ci-merge.mjs --pr 123,124 --merge                    # serial queue, stops at the first PR that does not merge
```

`--merge` is the caller's explicit merge decision. Without it nothing is merged or updated, whatever the checks say.
Use `--merge` only when the user has said to merge this PR; a `/cycle --autonomous` run never does (its done report uses `--wait-only`).

## What it refuses, and why

| Situation | Result |
|---|---|
| Only some checks registered | all-terminal is not enough: the set of check names must hold still for `--settle-sec` (default 60) before a verdict. A heuristic: a workflow that registers later is missed, so name the checks you require with `--expect` for exactness |
| `--head <sha>` given and the PR head is another commit | refused `head-mismatch` |
| Any check still running, or an `--expect <name>` check not yet reported | keeps waiting; at the budget (`--timeout-min`, default 45) exits **3** and lists what is pending |
| No checks reported at all | refused `no-checks-reported` after a grace period: nothing measured is not green |
| A failing check whose exact name is not on `--allow-fail` | `failed`, exit 1, even when `mergeStateStatus` says UNSTABLE |
| `UNSTABLE` with no failing check to explain it | refused `unstable-unexplained` |
| `BEHIND` (merge mode) | `gh pr update-branch`, then re-waits on the NEW head (checked to be a two-parent merge commit on the old head, else treated as a foreign push; a concurrent push in the same instant cannot be told apart); at most 3 updates |
| `DIRTY`, draft, not open, `BLOCKED` after every check finished | refused (the allow-list never overrides branch protection) |
| The head moved while waiting and the script did not move it | refused `head-moved` in merge mode (the decision covered the old head); `--follow-head` opts in; report mode follows and records it |

The merge is `gh pr merge <n> --squash --match-head-commit <sha>` with the sha the checks passed on, so a push after the wait is rejected
by GitHub. A merge that did not reach `MERGED`, or whose read-back failed (`merge-unconfirmed`, exit 1), is not reported as merged.

## Other flags

`--repo owner/name` (gh resolves the checkout's repo otherwise; `origin` is never assumed) · `--gh-account <name>` runs gh as that signed-in
account for a repo only a second account can read (an ambient `GH_TOKEN` also works) · `--deploy-wait <check-run>` waits for that check on the
merge commit after merging (a failed deploy exits 1 but the merge stays reported) · `--fail-fast` · `--poll-sec` · `--blocked-grace-sec`.

## Output

One JSON envelope on stdout: `{ok, mode, exitCode, results[], report}`. Paste `report` into the done report. Exit 0 green or merged,
1 red or refused, 2 bad flags, 3 timed out.
