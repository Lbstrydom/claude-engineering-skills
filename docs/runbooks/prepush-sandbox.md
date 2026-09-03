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

Use **`canonicalizeEol` from [`lib/file-io.mjs`](../../scripts/lib/file-io.mjs)** —
the one byte-level fold. It leaves a lone `CR` alone and never decodes, so it
cannot corrupt non-UTF-8 bytes while hashing them.

**It bit a SECOND generator on 2026-08-08.** `regenerate-skill-copies.mjs`
compared raw bytes, so a worktree whose `.claude/skills/**` landed CRLF while
`skills/**` landed LF reported all 67 destinations as differing — sending the
operator to regenerate, which commits an EOL flip as if it were content. The tell
is a diff where **git says clean and your tool says changed: git is right, the
tool is comparing the wrong thing.**

> **Do NOT canonicalise where the exact bytes ARE the contract** (transfer-corruption
> checks) — that masks the corruption being looked for.

### 2.2 A worktree has no `node_modules`, and tools must RESOLVE that

Everything in a nested worktree works because Node walks *up* and finds the main
checkout's copy — so any tool that hard-codes `<repoRoot>/node_modules` breaks
there and nowhere else.

Two tools provision it into an isolated copy. `check-gate-poison-pills.mjs`
hard-coded the path — and on Windows **a junction to a missing target succeeds
and leaves a dangling link** (verified 2026-08-08), so its `try`/`catch` never
fired and the only symptom was the CONTROL run dying on `Cannot find package
'zod'`: a message pointing at the gate under test rather than at the harness. It
now resolves upward like Node does, and asserts the link **RESOLVES**, not
merely that creating it threw nothing.

**`prepush-check.mjs` had the same bug, and "safe" is why it survived three days
longer (2026-08-11).** It guarded with `existsSync` and fell back to `npm ci`, so
this section originally recorded it as *already correct — deliberately left
alone*. The fallback is indeed safe; what it is not is **reachable**. `existsSync`
was false in every worktree, so the link branch was dead code exactly where this
repo's sessions run, and every worktree push paid a full `npm ci` — the cost was
read as an inherent property of worktrees (§4 said so in as many words) rather
than as a bug, because a slow correct answer never files a bug report.

The generalisable form: **a fallback that is safe can hide that the primary path
never executes.** "It degrades gracefully" answers the correctness question and
says nothing about whether the fast path is alive; ask *when did this branch last
run* separately. Both tools now share one upward walk
([`lib/node-modules-resolver.mjs`](../../scripts/lib/node-modules-resolver.mjs))
— a second sighting is what turns a private helper into a shared one.

Resolving upward has a consequence worth stating: the linked `node_modules` may
belong to a **different checkout** than `repoRoot`. So `provisionNodeModules`
compares the manifest of the directory that *owns* those modules, not
`repoRoot`'s — comparing one checkout's `package.json` while linking another's
tree would decide "unchanged" about something it never read.

> **Do not "fix" a worktree by hand-linking `node_modules` into it.** That hides
> the tool bug from the next person, and is the ritual this removes.

## 2.3 `npm test` refuses a green it did not earn

Node reports a suite that throws while being **constructed** — in the `describe`
body, e.g. calling an unimported `test` — as `not ok`, but counts it in neither
`# fail` nor the exit code. `dd83e1f8` shipped `# pass 15  # fail 0`, exit 0, with
**three suites that never ran**, and `check` was green over it.

The guard is [`run-tests.mjs`](../../scripts/run-tests.mjs)'s `adjudicateRun` plus
[`test-guard-reporter.mjs`](../../scripts/lib/test-guard-reporter.mjs). It fails the
run on **any non-todo `test:fail` reported alongside exit 0**.

Two properties are deliberate:

- **It is keyed on the CONSEQUENCE** — a failure the exit code dropped — not on the
  cause. Future variants of "node lost a failure" are caught without anyone having
  to predict them. A failing `{todo: true}` is the one legitimate exit-0 failure and
  is exempt.
- **It fails CLOSED when its own report is missing.** A guard that cannot see the
  run must not pass it.

Same class, same file: an ambient `NODE_TEST_CONTEXT` is scrubbed from the child
env, because its presence makes `node --test` skip every file and exit 0.

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

- **linked** (~instant — **1 ms measured**) — a junction/symlink to the resolved
  `node_modules` (§2.2). Used when `package-lock.json` is byte-identical between
  that checkout and the sandbox **and** their **dependency-relevant**
  `package.json` fields agree.
- **installed** — `npm ci --ignore-scripts --no-audit --no-fund` otherwise
  (**10.7 s measured**, warm npm cache; more when cold), because testing new
  code against the old dependency tree proves nothing.

`package.json` is compared as well as the lockfile because a pushed commit can
hand-edit a dependency declaration without regenerating the lock; a
lockfile-only comparison would then link a stale tree and silently check the
commit against dependencies it does not declare.

**But only the fields that decide the tree** —
[`lib/dependency-identity.mjs`](../../scripts/lib/dependency-identity.mjs):
`dependencies`, `devDependencies`, `optionalDependencies`, `peerDependencies`,
`peerDependenciesMeta`, `bundledDependencies`, `bundleDependencies` (npm honours
both spellings), `overrides`, `engines`. It compared the **whole file** until
2026-08-11, which answered a far broader question than the concern it was written
for: commit `e7e182ea` added one `scripts` entry, touched no lockfile, and paid a
full 410-package install. The sandbox's copy is compared against a checkout that
is routinely on a different commit, so `scripts`/`version`/formatting churn alone
made the fast path unreachable. Comparing parsed values also means CRLF-vs-LF and
key-order churn stop reading as dependency changes (§2.1's rule, one file over).

Anything that cannot be *proved* identical counts as changed — an unreadable or
unparseable file on either side, a non-object root, a dependency field of an
unexpected shape, no `node_modules` found anywhere up the chain, or a failed
`symlinkSync` all fall through to the install path. The bias is deliberate: a
needless install costs seconds, a wrong link costs a false green. Reading
`"dependencies": "oops"` as *no dependencies* is the fail-open version, and is
refused explicitly rather than left to `typeof`.

**Manifest identity between the two checkouts is not proof the MAIN checkout's
own `node_modules` still reflects its OWN lockfile** (finding 2ec7f704,
2026-08-20) — e.g. a developer edited `package-lock.json` locally and never
re-ran `npm install`. `provisionNodeModules` answers that with
[`lib/installed-tree-identity.mjs`](../../scripts/lib/installed-tree-identity.mjs),
which compares the root lockfile against **npm's own hidden lockfile**,
`node_modules/.package-lock.json` — the record npm writes at the end of every
install describing the tree that is actually on disk. Both directions are
checked (nothing installed that the lockfile does not pin; nothing required by
the lockfile that is not installed), optional deps npm skipped for this platform
are not staleness, and every ambiguous input installs. ~1ms for this repo's
455/410-entry pair.

> **It replaced an mtime heuristic that was wrong in the healthy case**
> (2026-08-30). The old rule was "`package-lock.json` newer than the
> `node_modules` directory ⇒ possible stale install". But `npm install` writes
> the lockfile **last**, and a directory's mtime only moves when a *top-level*
> entry is added or removed — so on a tree `npm install` had just called *"up to
> date in 6s"* the lockfile was 2 minutes newer and the oracle read STALE.
> Measured: lockfile 13:24:07, `node_modules/` 13:22:07, verdict STALE. It then
> read FRESH on the same tree with the lockfile **18 days older**, because
> something unrelated created `node_modules/.cache` and bumped the directory.
> Same tree, opposite verdicts, decided by an unrelated event. On 2026-08-30 it
> landed on STALE, forced an `npm ci` that then failed, and blocked a push.
> Pinned in [`tests/prepush-installed-tree-identity.test.mjs`](../../tests/prepush-installed-tree-identity.test.mjs).

**A failed `npm ci` keeps its evidence.** Its output is captured rather than
inherited: on failure the last 30 lines print next to the `✗`, the full
transcript is written to `<sandbox>/.prepush-npm-ci.log`, and **the sandbox is
not deleted** (a later push sweeps it once it is 6h old; `git worktree remove
--force <path>` removes it now). A failing `npm run check` — the ordinary red
push — does *not* preserve anything. Inheriting stdio looked more transparent
and was the opposite: on 2026-08-30 the operator saw no npm error at all, and
npm's own debug log had already been rotated out by `logs-max` (default 10) by
the time anyone looked.

**npm exiting 0 is not evidence the install finished.** The same rule the
cleanup module encodes for `git worktree remove`. npm writes `.bin/` and the
hidden lockfile last; the 2026-08-30 sandbox held 234 of the expected 236
top-level entries and was missing exactly those two — which is how we know it
died at finalisation rather than being externally killed. `provisionNodeModules`
now stats the hidden lockfile after `npm ci` and fails if it is absent.

> **A worktree push now links, like any other.** Until 2026-08-11 this section
> said to *expect `installed` every time* in a worktree and called it "not a bug
> — just why a push from a worktree is slower". It was a bug, twice over (§2.2),
> and each cause alone was sufficient. The sandbox log names the reason for every
> install, so a silent 40-second pause is no longer indistinguishable from a hang.

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
| Run the poison pills serially (debugging) | `GATES_POISON_CONCURRENCY=1 npm run gates:poison` |
| Force a refresh of the DB test image | `AUDIT_LOOP_DB_IMAGE_PULL=always npm run db:suites:gate` |

`db:suites:gate` reuses a locally-tagged test image for a week rather than
re-pulling a mutable tag on every push (~1.9s each time, measured). The window is
bounded on purpose — that pull is the ONLY thing that ever refreshes the image,
since the `postgres-parity` CI job uses an Actions service container and never
reaches that code. Every state where the local image's provenance can't be
established (absent, no timestamp, clock skew) pulls. The gate and the container
runner now both report their own elapsed time, so its cost is read off a run
rather than trusted from a comment — which is how the old "~10s" claim came to
stand at a real 24s for three weeks.

`gates:poison` runs its pills across `min(cpus-2, pillCount)` forked workers
(49.3 s → 20.7 s measured, 2026-08-11 — see `status.md`). Output stays in
contract order regardless of completion order, and a worker that dies without
reporting fails the gate rather than vanishing from it. Set
`GATES_POISON_CONCURRENCY=1` to remove interleaving from the picture when one
pill misbehaves; it reproduces the pre-change timing (52.4 s) as well as the
pre-change ordering.

A sandbox setup failure exits **1** and says *"The push was NOT verified."* It
is never reported as success — an unbuildable sandbox means nothing was checked,
which must block exactly as a failing check does.

## 6. Troubleshooting

**`sandbox is missing required local artifact(s)`** — a gitignored input listed
in `PROVISIONED_ARTIFACTS` is absent from the main checkout. Run
`npm run arch:render` (or `npm run dashboard:setup`) and retry.

**`could not create sandbox worktree`** — usually a leftover worktree from a
hard-killed run. `git worktree prune` clears it. The runner removes its own
worktree in a `finally` and on `SIGINT`/`SIGTERM`/`SIGHUP`.

**`pre-push sandbox could not be removed: <path>`** — the husk named on that
line is still on disk. A later push sweeps husks older than 6h automatically
(`swept N stale sandbox husk(s)`), so this is informational; delete it by hand
only if you want the space back now.

### Why husks leaked silently before 2026-08-01

`git worktree remove --force` **exits 0 while leaving the directory standing**
when the worktree holds an entry it declines to delete — and the sandbox always
holds one, because `provisionNodeModules()` puts `node_modules` there on every
run. The runner's fallback `rmSync` sat in that call's `catch`, so it never
ran: 21 husks accumulated in `%TEMP%` in three days, each containing exactly
`node_modules`, with no warning at any point. The only thing that ever looked
was git's exit code.

The fix is the repo's own doctrine turned on its own tooling: **a subprocess's
success signal is not evidence of the postcondition — `stat` is.**
`removeSandboxDir()` ([`scripts/lib/prepush-sandbox-cleanup.mjs`](../../scripts/lib/prepush-sandbox-cleanup.mjs))
re-checks the path afterwards and warns with it when it survives, and a
startup sweep removes what an earlier run could not. Two ordering rules go
with it:

- **Prune metadata *after* removing the directory, never before.** The reverse
  turns a visible husk into an invisible one — `git worktree list`, the one
  command that would have surfaced it, then reads clean.
- **Age, not liveness, gates the sweep.** Two sessions share this working tree,
  so a concurrent push can have a live sandbox on disk right now; a live
  sandbox is always young, and 6h clears a minutes-long `npm run check` by
  orders of magnitude.

A failed sweep or removal **warns and never blocks** — temp-directory state is
machine state, not repo state.

**A check passes in-tree but fails in the sandbox** — that is the feature
working. The commit is missing something your working tree has; most often a
file that was never staged. `git status` will show it.
