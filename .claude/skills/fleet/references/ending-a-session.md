---
summary: Ending a session — release, archive-check, prune, archive, and stopping branch and worktree clutter.
---

# Ending a session

Verbs that retire a claim or remove a branch or worktree. Removing a worktree is the
user's decision; the coordinator rules that govern when to bring it to them are in
`references/coordination.md` ("Rules for a coordinator", rules 7 and 8).

- `fleet release [--abandoned]` retires the claim now: the session stops blocking
  claims and leaves the landing order. It never refuses; it prints the
  archive verdict as advice.
- `fleet archive-check [<id|branch|path>]` is read-only. It exits 0 only when
  every probe ran and nothing would be lost. Exit 3 means `AT RISK` (staged or
  unstaged changes, untracked files, gitignored files outside `archiveIgnore`,
  commits no remote holds, including on a detached HEAD) or `UNVERIFIED` (a probe
  failed, or skip-worktree/assume-unchanged files hide edits from git). Run it
  before archiving a worktree: archiving can empty gitignored folders such as
  `.claude/tmp`.
- `fleet prune` is read-only by default. It lists the local branches (and their
  worktrees) that can be removed with nothing lost, with the exact commands, and
  runs none of them. `fleet prune --apply` runs exactly that list, nothing else:
  per branch, under the registry lock, it first re-checks that the branch tip is
  still the judged tip and that no session has registered the branch since, then
  removes the worktree and the branch with git's own refusals intact (never
  `--force`), stopping a branch at its first failure. It exits 1 if any removal
  failed, and a second run finds nothing left. `--apply --remote` also deletes
  the remote branch, leased on the judged tip (a remote that moved is refused,
  one already gone counts as done).
  A branch qualifies only when its tip is already in base (`git branch -d`) or
  merged evidence covers its exact tip (a merged PR head, or a squash that
  postdates the fork: `-D`, since git cannot see squash merges). No registered
  session, no open PR, a readable PR list, and a worktree that passes the
  archive-check evidence (its "unpushed" commits excepted, because their content
  is proven on base). Idle branches, locked worktrees, the main checkout and the
  current worktree are never listed. Nor is a worktree that another worktree's
  hooks directory (as `git rev-parse --git-path hooks` names it there, so
  `config.worktree`, the inherited repo-level value or the default) lies inside
  or passes through via a link: once it is gone git runs no hooks there and says
  nothing. The kept reason names the dependent worktree and the remedy, e.g.
  `git -C <wt> config --worktree core.hooksPath <the main checkout's hooks dir>`
  (never a rewrite of a global or system setting); a config git cannot read
  keeps it too, and `--apply` re-checks under the lock.
  Every kept branch says why. A worktree or
  branch active within `staleWorktreeDays` (default 7) is skipped unless
  `--include-fresh`. `prune` also lists directories under the worktree root that
  git no longer knows (`empty`, `ignored-only`, `holds N files`), printing a
  removal command only for the first two, and shows `upstream gone` as a hint
  (never as a reason to delete). A `review` section lists two classes that are
  never removable, so a person can decide quickly: a branch whose merged PR's
  head is behind its tip (post-merge commits), and a branch no PR covers. Each
  names its files and whether each file's committed content already equals base;
  uncommitted work in its worktree is not part of that comparison, and the line
  says so. Its output ends with the session-list check line:
  before running any printed removal, check the desktop session list (pinned and
  dormant sessions included) for a session whose cwd is that worktree.
- **The prune count reaches you without running prune.** `fleet status` plans a
  prune under a 30 s budget and prints one `prune:` line (removable, fresh,
  review classes, orphan directories). It writes the count to
  `<git-common-dir>/fleet-cache/prune.json`, as does a read-only `fleet prune`.
  `fleet next` reads it and prints an `FYI for the user/coordinator` line: relay
  it, never act on it. A count that could not be measured says `unmeasured`
  with the reason, never 0. A budget-cut count is a lower bound (`≥N`, with how
  many were not judged). A count over 24 h old, or missing, asks for a `status`
  run. `prune --apply`, or a status run that could not plan, replaces the count
  with an unmeasured one, never leaving the old number readable. Bring the list to the user on a cadence;
  removal stays their decision.
- `fleet archive <worktree|branch|id>` is a dry run by default: what it would
  snapshot, and every refusal. `--apply` snapshots the worktree's committed,
  staged, unstaged and untracked state into a local `archive/*` tag, verifies the
  tag holds it, re-checks everything under the registry lock, and only then
  removes the worktree; the branch is left alone. It refuses a live claim, a
  locked worktree, the main checkout, a partially staged or conflicted path, a
  sensitive file, ignored data without `--discard-ignored`, an oversize tree,
  a worktree another worktree's `core.hooksPath` points into (the same check and
  remedy as `prune`, repeated under the lock), and a worktree active within
  `staleWorktreeDays` without `--include-fresh`. It never
  pushes: the tag is local, and `status` reports archive tags as `local-only` or
  `remote`. **`--apply` deletes a worktree, so it runs only on the user's go-ahead**,
  after the session-list check above.
- **Stop the clutter at the source.** Squash merges rewrite commit ids, so every
  ancestry check (`git branch --merged`) misreports, and nothing runs `prune` on
  its own. Two settings by the repo owner remove most of it: GitHub, Settings,
  General, "Automatically delete head branches" (remote branches go on merge), and
  `git config fetch.prune true` (each fetch drops the stale `origin/*` refs). Then
  `fleet prune --apply` clears the LOCAL branches and worktrees those two do not.
