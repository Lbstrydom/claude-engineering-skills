# Pre-push sandbox — checking the commit, not the working tree

**What it is.** `npm run check` runs inside a throwaway `git worktree` checked
out at the exact commit being pushed, rather than against the working tree.

**When you need it.** Reading this if a push failed with `pre-push sandbox
failed`, if you're adding a check to the `check` chain, or if you're wondering
why the hook no longer reacts to your uncommitted edits.

---

## 1. Why

Two problems, one cause: the hook used to verify an artifact that nobody
receives.

**False blocks.** We routinely run two agent sessions against one working tree.
Session A pushes; the checks run over session B's half-written edits and block
a push whose own commits are fine. This is the corrosive failure — a gate that
cries wolf gets `--no-verify`'d, and a routinely-bypassed gate is a disarmed
gate.

**False passes (worse).** A fix present in the working tree but absent from the
commit — unstaged, or part of the other session's change set — made the hook
green while the pushed commit was broken. Working-tree checking cannot catch
this by construction.

A clean checkout of the pushed sha fixes both: it verifies exactly what the
remote is about to receive.

**Why not `git stash`.** With two live sessions, stashing yanks the other
session's files out from under it mid-edit, and a pop conflict wedges both.
It also violates the repo's standing rule against auto-stashing unrelated work
(AGENTS.md §"Scope discipline"). A worktree touches nothing the other session
can observe.

## 2. The sandbox-honesty invariant (load-bearing)

A fresh worktree has **no gitignored inputs**. Any check that *degrades to a
skip* when an input is missing would therefore pass having read nothing — the
sandbox would convert a real gate into decoration, silently.

So the sandbox turns every known silent-skip path into a **hard error**:

| Env var set by the runner | Closes |
|---|---|
| `AUDIT_PUSH_RANGE_REQUIRED=1` | Drift gates inferring a range. A detached tree has no upstream and is never dirty, so every inference collapses to `HEAD~1` — scoping a multi-commit push to its tip while reporting clean. |
| `ARCH_COVERAGE_REQUIRE_ENVELOPE=1` | `arch:coverage-gate` exiting 0 because the gitignored `.audit-loop/domain-deps-observed.json` is absent. |

> **Adding a check to the `check` chain?** Ask the AGENTS.md success-path
> question: *can this return green in a clean checkout without having actually
> checked anything?* If yes, it needs a strictness flag wired into
> `PROVISIONED_ARTIFACTS` or the env block in
> [`scripts/prepush-check.mjs`](../../scripts/prepush-check.mjs) — **not** a
> tolerated skip. Pin it in
> [`tests/prepush-sandbox-honesty.test.mjs`](../../tests/prepush-sandbox-honesty.test.mjs).

Note that `ARCH_COVERAGE_REQUIRE_ENVELOPE` is **opt-in**. The gate's default
leniency on an absent envelope is deliberate — it protects first-time consumers
who have never run `arch:render` — and that default is itself pinned by a test.
Only a caller that *promised* the evidence gets the strict reading.

### 2.1 Hashing working-tree bytes ≠ hashing committed source

The first thing the sandbox caught was `skills.manifest.json` breaking its own
Category-B contract (a committed artifact must be a byte-identical function of
committed source — see the generated-artifact policy in AGENTS.md).

16 skill files carried CRLF in the local working tree while `.gitattributes`
pins `eol=lf`. Git reports such files as **CLEAN**, so nothing locally looked
wrong — but `bundleVersion` was hashing the working-tree bytes, which meant it
tracked local line endings. A fresh clone (LF on disk) therefore computed a
different hash and read **STALE**, and only the clean-checkout sandbox could
see it: the working tree never disagrees with itself.

> **Invariant.** A generator that hashes files to produce a *committed*
> artifact must canonicalise CRLF→LF first. Hash the bytes git stores, not the
> bytes your filesystem happens to hold.

## 3. The push range

The hook reads git's stdin (`<local_ref> <local_sha> <remote_ref> <remote_sha>`)
**exactly once**, at the top, and shares the captured copy. stdin is a stream:
whoever reads first consumes it, so a second reader would silently starve one
of them. (Before 2026-07-20 the DB-seam advisory read it directly.)

[`scripts/lib/push-range.mjs`](../../scripts/lib/push-range.mjs) is the single
resolver. Precedence:

1. `AUDIT_PUSH_RANGE_BASE` / `_HEAD` — from the hook. Authoritative, `trusted: true`.
2. `@{upstream}` — correct when a tracking branch exists.
3. fork-point vs `origin/main` — correct for an unpushed branch.
4. `HEAD~1` — last resort; scopes to one commit.

Every result carries `source` and `trusted`, and gate summaries print them:

```
on-conflict-lint: … drift vs @{upstream} (inferred: upstream) — clean
on-conflict-lint: … drift vs 4f2a91c — clean          ← explicit, trusted
```

An under-scoped run that announces itself is a bug report. One that reads as a
plain clean is a shipped defect — that asymmetry is why the labelling exists.

**An explicit-but-unresolvable base is a hard failure**, never a quiet demotion
to inference. The caller asked for a specific range; handing it a narrower one
while reporting success is the exact defect class this module was built to end.

## 4. Cost

`node_modules` is gitignored, so the sandbox provisions it:

- **linked** (default, ~instant) — a junction/symlink to the main checkout,
  used whenever `package-lock.json` is byte-identical.
- **installed** — `npm ci --ignore-scripts` when the lockfile differs, because
  testing new code against the old dependency tree proves nothing.

`--ignore-scripts` is load-bearing: the `prepare` lifecycle runs
`install-git-hooks.mjs`, which writes `core.hooksPath` — config shared with the
main checkout. A throwaway worktree must not be able to repoint the real repo's
hooks.

## 5. Escape hatches

| Situation | Command |
|---|---|
| Run checks in-tree (old behaviour) | `AUDIT_PREPUSH_SANDBOX=0 git push` |
| Skip the hook entirely | `git push --no-verify` |
| Run the sandbox by hand | `npm run prepush:check -- --base <sha> --head <sha>` |

A sandbox setup failure exits **1** and says *"The push was NOT verified."* It
is never reported as success — an unbuildable sandbox means nothing was checked,
which must block exactly as a failing check does.

## 6. Troubleshooting

**`sandbox is missing required local artifact(s)`** — a gitignored input listed
in `PROVISIONED_ARTIFACTS` is absent from the main checkout. Run
`npm run arch:render` (or `npm run dashboard:setup`) and retry.

**`could not create sandbox worktree`** — usually a leftover worktree from a
hard-killed run. `git worktree prune` clears it. The runner removes its own
worktree in a `finally` and on `SIGINT`/`SIGTERM`/`SIGHUP`, so leaks need a
`SIGKILL` to happen.

**A check passes in-tree but fails in the sandbox** — that is the feature
working. The commit is missing something your working tree has; most often a
file that was never staged. `git status` will show it.
