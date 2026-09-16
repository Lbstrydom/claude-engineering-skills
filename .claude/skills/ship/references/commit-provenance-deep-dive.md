---
summary: Step 6.2/6.3's AI-Gate and worktree-identity deep-dive — why each value/flag exists and the incidents behind them.
---

# Commit provenance and worktree identity — design rationale

This is the "why" behind Step 6.2 (`--gate`) and Step 6.3 (`--expect-head` /
`--expect-branch`). The main flow keeps the operative contract (the four
`--gate` values, the two required identity flags); this file carries the
incidents and edge-case reasoning behind them.

## Commit message routing

Prefer stdin for a one-shot message — it sidesteps a scratchpad/repo
collision entirely. The file route (`.claude/tmp/ship-commit-msg-<epoch>.txt`)
is what filled `.claude/tmp` with 658 files / 39MB by 2026-08-10, nearly all
of them spent commit messages nobody deleted — the directory is gitignored,
so nothing ever prompted anyone to notice.

**Not your session scratchpad dir** — Claude Code's own default steers agents
to write temp files there, but it sits outside the repo and `--message-file`
refuses any path that resolves outside `repoRoot` (`escapes-repo`, upstream
`1c792b2e`). Use `.claude/tmp/` for this one file. Use `-`, not `/dev/stdin`:
Git-Bash resolves the latter to `/proc/self/fd/0`, which is not a regular
file, so it looked to the helper like a path that simply was not there
(upstream `575256de`).

## `--gate`'s four values

**`passed` and `converged` are mutually exclusive halves of ONE comparison**,
so each refusal names the other: asking for `passed` on a moved tree points
at `converged`, and asking for `converged` on an unchanged tree points at
`passed` — you may not under-claim. Both clear the identical store bar, so
cloud off or a non-converged run refuses either and leaves `waived`. A
partial commit of an audited worktree differs from the audited tree, so it
is `converged` territory, never `passed`.

**`passed` is rare BY DESIGN, and its rarity is not a defect to engineer
around.** `/ship`'s own Steps 2–5 write `status.md`, sometimes CLAUDE.md, and
the plan's Implementation Log *after* the audit and *before* the commit — so
even a zero-finding, converged, otherwise-untouched audit moves the tree and
lands on `converged`. Measured over this repo's history when `converged` was
added: 647 `not-run`, 86 `waived`, 2 `passed`. Do NOT hand-write
`.audit/last-audit-run.json`, re-run a review purely to populate the column,
or reorder your ship to chase `passed`. **The value worth investigating is a
`passed` that should not be there.**

**`--no-run-id` exists, and it means "that audit was unrelated to this
commit".** Fresh evidence makes `not-run` illegal, so a docs-only follow-up
commit after an audited ship inherits the previous commit's marker and must
disclaim it: `--no-run-id --gate not-run`. It omits `AI-Run-ID` entirely. Use
it **only** when the claim is true — on a fix-heavy ship the audit was very
much related, and the honest value there is `converged`, not a disclaimed
`not-run`.

**Freshness is `evidenceMs > headCommitTs`, so someone ELSE's commit ages out
your evidence.** In a repo with a concurrent session, a foreign commit
landing between your audit and your ship makes the marker stale — which also
removes `waived` (it requires `fresh`) and leaves `not-run` as the only legal
value. If you need the trailer to reflect your audit, don't ship across
another session's commits. Note the converse is NOT guaranteed: committer
timestamps are user-controlled and non-monotonic, so freshness does not
prove that no commit intervened, and `converged` claims no such thing.

**`--no-tests` caps the gate.** With hooks skipped the helper forces
`waived` (fresh evidence) or `not-run` (otherwise), loudly, whatever you
asked for. Skipping hooks can never buy a stronger verdict.

## Worktree identity (`--expect-head` / `--expect-branch`)

**Why identity is a precondition and not a warning.** A concurrent session
can amend, rebase or check out between your first command and your commit —
this repo saw HEAD move six times in one session. An amend changes NO
working-tree file, so a content-hash check sails past it; only a sha
comparison catches it. And the pair is ATOMIC: a head-only check passes
whenever two refs sit on the same commit — a feature branch freshly cut from
`main` is exactly that — and the commit then lands on the wrong branch.

**On a detached HEAD** pass `--expect-detached` instead of `--expect-branch`.
A head with no ref disposition is `incomplete-expectation` → exit 2, never a
silent degrade to a sha-only check.

**You may omit the flags only when a FRESH audit ran in this session**: the
evidence marker carries `auditedSha` + `auditedBranch` and supplies the
bundle for you. A marker written before that field existed reports
`pre-bundle-evidence` and you must pass the flags explicitly — it can never
half-match.

**After a successful commit, `ship-commit` re-verifies** that the new
commit's parent and branch are the ones it checked. That DETECTS drift; it
does not prevent it — `git commit` has already moved the ref by then. On
`post-commit-drift` it exits 1 and prints a recovery command: do not push.
The commit exists but was not built on the base you verified, and an
unpushed wrong-parent commit is recoverable in seconds whereas a pushed one
needed a human to notice a 12-line change with a 2,324-line diff.

## Continuing work after a squash merge

**Rebase, never merge.** If a follow-up branch shares history with a
`/ship`-created branch whose PR was **squash-merged**, `git merge
origin/<base>` reports a **false conflict** on that file even when the
content is byte-identical — a squash merge creates a new commit on `<base>`
with no parent relationship to the original, so the 3-way merge treats an
identical insertion as two independent ones. `gh pr create` then shows
`mergeable: CONFLICTING`. Use `git rebase origin/<base>` instead: patch-id
matching recognises the commit's patch is already present, skips it, and
replays only the genuinely new commits; `git push --force-with-lease` then
produces a clean PR (`mergeable: MERGEABLE`). **A PR stuck at `mergeable:
CONFLICTING` can also correlate with zero CI runs firing at all** (not
merely a cancelled run) — "no checks reported" is not on its own proof the
CI trigger is broken; check mergeability first.
