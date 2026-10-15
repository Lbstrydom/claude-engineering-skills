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
committed source — see the generated-artifact policy in AGENTS.md). The manifest
is Category A and untracked since 2026-10-15; the lesson below is unchanged, and
still governs every artifact that hashes files (`bundleVersion` is built the same
way at release time).

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
| Force the full gate for an archive push (a loosening: the full gate does not scan) | `AUDIT_PREPUSH_ARCHIVE_LANE=0 git push` |
| Publish an archive push whose findings you have read | the `AUDIT_ARCHIVE_LANE_ACK` value the block message prints |
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
line is still on disk. A later push sweeps husks older than 6h, and husks whose
owner process is dead, automatically (`swept N stale sandbox husk(s)`), so this
is informational; delete it by hand only if you want the space back now.

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
- **A sandbox that may still be live is never swept.** Two sessions share this
  working tree, so a concurrent push can have a live sandbox on disk right now.
  Wherever the sweep cannot establish that the owner is gone, age is the guard:
  a live sandbox is always young, and 6h clears a minutes-long `npm run check`
  by orders of magnitude.
- **A sandbox whose owner is provably dead is swept at once.** A push killed
  with TaskStop, `taskkill /F`, SIGKILL or a closed terminal runs no cleanup
  handler, so its worktree stays on disk *and registered* — measured 2026-10-11,
  two such husks sat in `git worktree list` for hours, far under the 6h age rule.
  The owner is the pid in `ces-prepush-<sha8>-<pid>` (the digits after the last
  `-`, a plain positive decimal); ESRCH from `process.kill(pid, 0)` is the only
  answer that licenses an early sweep. Everything else keeps the age rule: a
  live owner (a concurrent push; EPERM counts as alive), a probe that returns
  unknown or throws, a name with no usable pid, and a husk holding
  `.prepush-npm-ci.log` (preserved as evidence by a process that exited
  normally). Pid reuse can only make a dead owner read alive, so it fails safe
  to the age rule. The sweep line says which husks went for a dead owner and
  which for age, and what it left and why; a path it could not inspect is
  named, never read as "nothing there".

A failed sweep or removal **warns and never blocks** — temp-directory state is
machine state, not repo state.

**A check passes in-tree but fails in the sandbox** — that is the feature
working. The commit is missing something your working tree has; most often a
file that was never staged. `git status` will show it.

## 7. The archive lane (`archive/*` refs)

A push whose **every** ref lands under `refs/heads/archive/` or `refs/tags/archive/` is a
backup of work in flight. `npm run check` fails on such a commit for reasons that say nothing
about publishing it, which is how `--no-verify` became a habit. Those pushes take the **archive
lane** instead (`.githooks/pre-push` §0.97): a scan of exactly what the push publishes, and
nothing else. Plan, evidence and the full audit trail:
[`docs/plans/prepush-archive-lane.md`](../plans/prepush-archive-lane.md).

**What it checks.** The objects the destination lacks (secret-shaped content in blobs, commit
messages and tag messages) and every path a published commit adds or changes (sensitive
paths, including a blob the destination already holds). `npm run check` has **no** such scan
(measured; plan §1.2), so the lane adds it rather than keeping it. What the destination
holds comes from the destination itself (`git ls-remote` on the push URL), never from
remote-tracking refs.

**What it skips**, and why, step by step: plan §3 and
`ARCHIVE_LANE_CHECK_CLASSIFICATION` in `scripts/lib/prepush-archive-lane.mjs`. A test makes
that table executable: a new `check` step with no entry fails, and so does a class-P
(publication-safety) step that names no lane scanner.

**When it blocks.** A finding, or an eligible push that could not be scanned completely
(unreachable destination, a limit hit, git output that does not add up). An incomplete scan is
never clean. The message lists each finding (sensitive paths as `[redacted:<hash>].<ext>`,
matched text never) and a fingerprint of the set. To publish exactly that set, re-run the same
push with `AUDIT_ARCHIVE_LANE_ACK` set to the fingerprint; it covers only the findings it was
computed from. Expect to need it: this repo tests its own scanner, so fixtures shaped like
secrets are normal (13 findings, all synthetic, on `archive/queue-burndown-2026-10-02`), and
so are `.env.example` templates, which the shared path classifier calls sensitive.

**When it steps aside.** `not-applicable` (any other ref, a mixed push, a deletion of a
non-archive ref) runs the full gate exactly as before. If the lane yields no valid result at
all (script missing from the hook's checkout, a crash): an ordinary push still runs the full
gate, with a warning; a push that **looks archive-only** is refused, because the full gate
does not scan published content. `AUDIT_PREPUSH_ARCHIVE_LANE=0` is the explicit way past that.

**Acknowledgements are for sets you can read in full.** The block message lists every finding
up to 200 and offers the acknowledgement only then; above that it says to split the push, and
a matching fingerprint is not accepted. The scan also ignores `git replace` refs (they change
what `rev-list` shows while the push sends the originals) and runs every git call under one
120 s deadline.

**Where the lane's code comes from.** The checkout the hook itself lives in, found from
`$0`, not the pusher's cwd: `core.hooksPath` points at one checkout while pushes come from
any worktree. Until that checkout contains this change, pushes from any worktree run the old
hook.

## 8. A killed hook reads as a PASS on Git for Windows

**Incident (2026-10-12).** During the push of PR #220 the hook's process tree was killed
mid-`npm test` (most likely by the Git for Windows updater — a Restart Manager session was
logged at 14:24:20Z). The TAP stream stopped at test 1954 of ~5,400, neither `✓ checks passed`
nor `✗ … FAILED` printed, the sandbox survived with a dead owner — and **git transferred the
push**.

**Why — two truncations, both measured** (Git 2.56.0.windows.2, GNU bash 5.3.15, 2026-10-12):

1. **Git for Windows reads a hook's status as `code & 0xff` and never sees a signal.**
   `compat/mingw-posix.h`: `WIFEXITED(x) 1`, `WIFSIGNALED(x) 0`, `WEXITSTATUS(x) ((x) & 0xff)`;
   `compat/mingw.c` `waitpid()` stores the raw `GetExitCodeProcess` value.
2. **An MSYS process killed by signal S exits `S << 8`** when its parent is native:

   | Signal | Windows exit code | what git sees |
   |---|---|---|
   | HUP (console closed) | 256 | 0 |
   | INT (Ctrl+C) | 512 | 0 |
   | KILL | 2304 | 0 |
   | PIPE | 3328 | 0 |
   | TERM | 3840 | 0 |
   | USR1 | 7680 | 0 |

So **every signal death of the hook read as success.** The same truncation sits one seam lower:
MSYS bash's `$?` keeps only the low byte of a native child's code (`node -e "process.exit(256)";
echo $?` prints `0`), so a runner forwarding a raw 256 would make the hook print `✓ checks passed`.

`taskkill /F` on the node CHILD alone was never the hole: that exits the child with 1, the hook
sees 1, and blocks. The hole is the hook's own shell dying.

**The fix, three layers** (plan: `docs/plans/prepush-hook-fail-closed-when-killed.md`):

- **L1 — trap every catchable terminating signal** and `exit 1`, a code with a non-zero low byte:
  the nine POSIX ones (HUP INT QUIT ABRT ALRM TERM PIPE USR1 USR2) unconditionally, plus the XSI
  ones (TRAP BUS FPE ILL SEGV SYS XCPU XFSZ VTALRM PROF) wherever `kill -l NAME` says the shell
  knows them, so an unfamiliar `sh` never errors on `trap`. Only KILL and STOP are untrappable. The marked `fail-closed-on-signal` block, at the
  top of `.githooks/pre-push` and, byte-identical, of the consumer hook (`hook-version: 10`). A
  POSIX shell runs a trap only after the current foreground child returns: in the console-close /
  updater case the child dies too and the trap fires at once; for a signal aimed at the hook
  alone, the push is refused when the child finishes.
- **L2 — `toShellExitCode`** (`scripts/lib/cli-io.mjs`): every place on the gate path that
  forwards a child's status (`prepush-check.mjs`, `run-tests.mjs`) maps a zero-low-byte failure
  to 1. Use it for any new CLI that forwards a child's exit code.
- **L3 — report the untrappable remainder on the NEXT push.** SIGKILL, or a `TerminateProcess`
  with a zero-low-byte code, runs no shell code, so nothing can stop that push. The marked
  `prepush-inflight-record` block writes `<git-common-dir>/prepush-inflight/<pid>.rec`
  (`pid sha started remote`) before any real work, updates the sha once the range is known, and
  removes it from an EXIT trap. A record whose owner pid is dead was left by a hook that died
  without running any shell code, and the next push prints:

  ```
  ⚠ an earlier pre-push (pid 1234, remote origin, started 2026-10-12T14:19:03Z) was KILLED before it
    finished. Git for Windows reads a killed hook as a PASS, so if that push reached the remote it went UNGATED.
    It was gating <sha>. Check: git branch -r --contains <sha>   (runbook §8)
  ```

  It is advisory and never blocks: the push it describes has already happened. If the check
  shows the commit on a remote branch, run the gate on it now: `git switch --detach <sha> && npm
  run check`, or push a follow-up commit and let the hook run in full.

### Unknown commit

`It died before the gated commit was known` means the record still read `pending`: the hook was
killed during its first few statements, before the push range was parsed. The push's own
remote-tracking update is the evidence. Look for an update near the record's `started` time:

```bash
git reflog show --date=iso origin/main
git ls-remote origin
```

Then compare with what you expected to have pushed.

### What L3 cannot see (stated, not hidden)

- A kill before the record is published: the first few shell statements, including L1's own
  installation.
- Any run whose git common dir cannot be resolved or written. The block then skips itself; it
  never builds a fallback path.
- A kill between the hook's last command and the EXIT trap's `rm` leaves a record for a run that
  DID finish, so the next push warns about a gated push. This is rare, and the warning is
  advisory.
- PID reuse can make a dead owner look alive. That only suppresses a warning; it never invents one.

**Where the fix runs.** Like the archive lane (§7), the hook runs from the checkout that
`core.hooksPath` points at. Until that checkout contains this change, pushes from any worktree
still run the old, fail-open hook. Consumers get L1 on their next hook install (`hook-version: 10`).

Tests: `tests/prepush-hook-fail-closed-on-signal.test.mjs` runs real `git push` runs against a
throwaway bare remote, judged by what the remote received. It includes a characterisation of
the unprotected hook, which reads `fail-open` on today's Git for Windows.
`tests/cli-io-shell-exit-code.test.mjs` covers L2.
