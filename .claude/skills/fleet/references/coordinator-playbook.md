---
summary: Coordinator playbook — merging, stacks, archiving, fast-forwards and rebases when one session coordinates the others.
---

# Coordinator playbook

For the session that coordinates the others: it merges, archives, syncs and hands out
work across sessions, while each implementation session does one task in one repo.
Implementation sessions do not need this file.

The numbered coordinator rules (chip authority, archive sweep, confirm-idle, WIP limits,
one heavy job at a time, message budget, …) are in `coordination.md` §Rules for a
coordinator, with their reasons in `coordination-rationale.md`. Retiring a session is
`ending-a-session.md`; landing several branches is `landing.md`. This file adds the
operations those do not cover.

## 1. Merge only the audited head

"Audit converged" and "final review approved" name a TREE. A squash merge takes whatever
commit is the PR's REMOTE head, and green checks describe that commit — not the one that
was reviewed. A rebased re-push can fail quietly (a hook refusal, a lease rejection)
while the session believes its fixes are on the PR.

Before merging another session's PR, ask it for the audited sha, compare, and bind the
merge to the commit you checked:

```bash
gh pr view <n> --json headRefOid --jq .headRefOid            # equals the audited sha?
git rev-parse <audited-sha>^{tree} <head-sha>^{tree}          # or: the two trees are identical
gh pr merge <n> --squash --match-head-commit <head-sha>       # refuses if the head moved since
```

Compare trees by object id, not by an empty `git diff` (diff settings such as
ignored submodules can hide a difference). Mismatch → do not merge; ask the session. When handing off your own audited PR, report
both the audited sha and the PR head sha.

## 2. Stacked PRs: retarget before deleting a branch

`gh pr merge <n> --squash --delete-branch` on the bottom of a stack deletes the base
branch of the next PR, and GitHub CLOSES that dependent PR instead of retargeting it.
Retarget first, then delete:

```bash
gh pr edit <next> --base main
```

or merge without `--delete-branch`. After a squash merge, rebasing the rest of the stack
and force-pushing can be refused by a pre-push gate that compares against the remote's
old sha; expect that refusal and resolve it rather than bypassing the hook.

## 3. Before archiving a session or removing a worktree

A session's working directory is not proof that it owns the worktree, and archiving can
cascade to the side sessions it started. Hosts can also place a NEW session in an
EXISTING worktree. So, before any archive or `git worktree remove`:

1. Compare every live session's worktree path (including the side sessions the archive
   would cascade to) — never archive a session whose worktree a live session uses.
2. If the only copy of a commit lives on a local branch there, pin it first
   (`git tag archive/<name> <sha>`).
3. Back up non-regenerable ignored files (scratch notes, saved sessions, run outputs).
4. Check every other worktree's hooks path
   (`git -C <wt> config --show-origin --get core.hooksPath`); repoint any that resolves
   inside the worktree being removed — a missing hooks directory runs no hooks, silently.
5. Afterwards, re-run `git worktree list` to confirm what is actually gone.

## 4. Fast-forwarding a checkout that other repos execute is a deploy

When consumer repos run tooling from a shared checkout (for example a hook pointing at
this bundle's main checkout), `git merge --ff-only` there takes effect in every consumer
immediately — no sync step needed. If the change carries a schema migration, apply it to
EVERY store the consumers use before fast-forwarding; otherwise the next consumer run
fails its schema precondition. If you fast-forwarded too early, roll back with
`git reset --keep <previous-sha>` and migrate first.

## 5. Before rebasing onto a moved main: look for competing implementations

A concurrent session can implement the SAME feature and land it on main while you work —
worse than a conflict, because both sides may apply cleanly into duplicate code. Before
rebasing, list the files both lines changed:

```bash
comm -12 <(git diff --name-only HEAD...origin/main | sort) \
         <(git diff --name-only $(git merge-base HEAD origin/main)..HEAD | sort)
```

A non-empty overlap is a reason to read both diffs before rebasing.

## 6. Run the whole suite before a branch's first push

Guards that catch a change are named after the invariant they protect, not after the
feature, so a name-targeted test run misses them, and a slow pre-push gate then fails
late. Before a branch's first push, run the full test suite once in the background and
read its failures; after that, targeted runs are fine.
