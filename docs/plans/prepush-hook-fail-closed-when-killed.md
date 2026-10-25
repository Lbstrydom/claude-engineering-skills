# Plan: Pre-push hook fails closed when killed
- **Date**: 2026-10-12
- **Status**: Complete — shipped in #225 (status reconciled against merged PRs 2026-10-25)
- **Author**: Claude + Louis
- **Scope**: backend (git hooks, CLI scripts) — stack `js-ts` + POSIX shell

## 1. Context Summary

**Incident (2026-10-12, measured by the #220 session).** During `git push` of PR #220
the pre-push hook's process tree was hard-terminated mid-`npm test` (very likely by the
Git for Windows updater; Windows logged a Restart Manager session at 14:24:20Z). The TAP
stream stops at top-level test 1954 of ~5,400 with no summary; neither `✓ checks passed`
nor `✗ … FAILED` printed; the sandbox `%TEMP%/ces-prepush-d9b30553-90492` survived with a
dead owner. **Git transferred the push anyway** — it read the killed hook as success.

### Root cause (measured, not inferred)

Two facts compose into the defect:

1. **Git for Windows discards everything but the low byte of a hook's exit code, and never
   reports a signal.** `compat/mingw-posix.h` (git-for-windows/git `main`, read 2026-10-12):
   `#define WIFEXITED(x) 1`, `#define WIFSIGNALED(x) 0`, `#define WEXITSTATUS(x) ((x) & 0xff)`;
   `compat/mingw.c` `waitpid()` stores the raw `GetExitCodeProcess` value in `*status`,
   unshifted. So `run-command.c`'s `wait_or_whine` takes the `WIFEXITED` branch for every
   child and the hook's result is `exitcode & 0xff`.
2. **An MSYS (cygwin-runtime) process started by a native parent and killed by signal S
   exits with Windows code `S << 8`** — cygwin byte-swaps its internal wait status for a
   non-cygwin parent. Measured on this machine via `spawnSync(bash, ['-c', 'kill -SIG $$'])`
   from node — first on Git 2.54.0.windows.1, then re-measured after the 2026-10-12 machine
   update on **Git 2.56.0.windows.2 / GNU bash 5.3.15(2)-release (x86_64-pc-cygwin)**, the
   version this fix is tested against; both runs gave the identical table:

   | Signal | Windows exit code | `& 0xff` (what git sees) |
   |---|---|---|
   | HUP | 256 | **0** |
   | INT | 512 | **0** |
   | PIPE | 3328 | **0** |
   | TERM | 3840 | **0** |
   | KILL | 2304 | **0** |
   | USR1 | 7680 | **0** |
   | QUIT | 0 (bash ignores it, exits 0) | **0** |

   Command: `node sigprobe.mjs "$(cygpath -w "$(which bash)")"` (scratch script; reproduced in
   the regression test below).

**Therefore every signal-death of `.githooks/pre-push` (a `#!/bin/bash` script, which Git
for Windows runs through MSYS `bash.exe`) reads to git as exit 0, and the push proceeds.**
This is not specific to the updater: a closed console (CTRL_CLOSE → cygwin SIGHUP), Ctrl+C
(SIGINT), a `kill` from another MSYS shell, a TaskStop of a tool shell — all fail OPEN.

A second, sibling truncation sits one seam lower, inside the hook: **MSYS bash's `$?`
keeps only the low byte of a NATIVE child's exit code** (measured:
`node -e "process.exit(256)"; echo $?` → `0`; `cmd //c "exit 256"; echo $?` → `0`). The
hook reads `CHECK_EXIT=$?` from `node scripts/prepush-check.mjs`, which forwards its own
child's raw status (`return r.status ?? 1`), and `scripts/run-tests.mjs` forwards node's
raw status the same way. Any child status with a zero low byte (256, 512, …) would make the
hook print `✓ checks passed`. Not the 2026-10-12 path (no line printed), but the same
defect class on the same gate, so it is in scope by impact: the gate's verdict rides on it.

**What the suggested reproduction would NOT show.** `taskkill /F` on the node child alone
already fails closed today: `TerminateProcess` exits the child with code 1, the subshell
returns 1, and the hook prints `FAILED`. The fail-open needs the HOOK's bash to die by a
signal (or by `TerminateProcess` with a zero-low-byte code). The red/green repro below kills
the hook's bash, and also records the child-only kill as the existing green control.

### Code Trace (pinned to 44c4bbda; every cited file is unchanged at ccefb0fc, the branch base — `git diff --stat 44c4bbda ccefb0fc -- <files>` empty)

- `git push` → git-for-windows `run_hook` → `start_command` → mingw `waitpid` (raw code) →
  `wait_or_whine` → `WEXITSTATUS` (`& 0xff`).
- `.githooks/pre-push:1 (44c4bbda)` — `#!/bin/bash`, no `trap` anywhere in the file.
- `.githooks/pre-push:342 (44c4bbda)` — `( cd "$REPO_ROOT" && node scripts/prepush-check.mjs "${ARGS[@]}" )`,
  `CHECK_EXIT=$?`; `:344` blocks on non-zero; `:349` prints `✓ checks passed`; `:452` `exit 0`.
- `scripts/prepush-check.mjs:550 (44c4bbda)` — `SIGINT/SIGTERM/SIGHUP` handlers run `cleanup()` and
  `process.exit(130)`; `:686` `return r.status ?? 1` (raw npm status); `:698` `process.exit(main())`.
- `scripts/prepush-check.mjs:537 (44c4bbda)` — `cleanup()`, called from the `finally` and the signal
  handlers; a hard kill (TerminateProcess / SIGKILL) skips it, which is why the incident's
  sandbox survived.
- `scripts/lib/prepush-sandbox-cleanup.mjs:222 (44c4bbda)` `surveySandboxes` / `:270 retentionReason`
  / `:292 sweepStaleSandboxes` / `:324 describeSweep` — the next run already finds and sweeps a
  dead-owner husk, but says only "swept N … (owner process dead)": it never says that a GATE
  was interrupted, nor which commit it was gating.
- `scripts/run-tests.mjs:328 (44c4bbda)` — `if (status !== 0) return { exitCode: status, … }` (raw).
- `scripts/install-prepush-hook.mjs:126 (44c4bbda)` — consumer `HOOK_VERSION = 9`; `HOOK_BODY` is
  `#!/bin/sh` (MSYS `sh.exe` on Windows) with blocking paths (plan-status drift `exit 1`,
  `AUDIT_PREPUSH_BLOCK=1`, the consumer's `pre-push.local` via `finish`) and no `trap`: the
  identical fail-open, shipped to every consumer.

### Patterns reused vs new

- Reused: the dead-owner idea of `surveySandboxes` (an owner pid that is provably dead means
  the run was abandoned; a live one is a concurrent push and is left alone), the hook drift-test pattern
  (`tests/prepush-archive-lane-hook.test.mjs` compares a bash spelling to its oracle),
  `HOOK_VERSION` bump + `>= N` assertion pattern, `cli-io.mjs` as the home of exit helpers.
- New: two marked shell blocks (the trap; the in-flight record), one pure exit-code normaliser.

### Neighbourhood considered

- **Target domain(s)**: `scripts`, `shared-lib`
- ⚠ **Cross-domain work** — the CLIs (`scripts`) and their libraries (`shared-lib`); the
  crossing is the existing runner → library direction, nothing new.
- ⚠ **Untagged paths**: `.githooks/pre-push` — matches no rule in `.audit-loop/domain-map.json`
  (pre-existing; not this plan's to fix).

`get-neighbourhood` (run 2026-10-12 at ccefb0fc): one **precedent** —
`removeSandboxDir` in `scripts/lib/prepush-sandbox-cleanup.mjs` (`above-floor-cluster`) — and
`review` for `surveySandboxes`, `sweepStaleSandboxes`, `finishAndExit`, `emit`, `main`,
`removeWorktree`. Decision: **do not extend** the sweep module — after audit R1-H2 the
evidence must belong to the hook's bash (an MSYS pid the node sweep cannot probe, and a
lifetime the sandbox does not span), so L3 is a sibling in the hook that reuses the sweep's
dead-owner rule rather than its code; and put the exit normaliser
**beside** `finishAndExit` in `cli-io.mjs`, the module that already owns exit semantics.

**Past incidents to verify against** (`get-incident-neighbourhood`, 2 shown):

| Incident | Status | Relevance |
|---|---|---|
| **INC-002** — destructive integration tests wiped the production store | `manual-verification-required` | The new integration test spawns git against temp repos. It touches no DB, and every spawned git gets a scrubbed env (`GIT_DIR`/`GIT_WORK_TREE`/… unset — the hook-exported-`GIT_DIR` fixture-leak class `sanitizeGitEnv` exists for), so a run under the pre-push sandbox can never write into this repo. |
| **INC-001** — symlink bypass of the sensitive-path classifier | `manual-verification-required` | Not touched: no path classification changes. |

## 2. Proposed Architecture

```mermaid
sequenceDiagram
    participant G as git.exe (native)
    participant H as pre-push (MSYS bash)
    participant P as prepush-check.mjs (node)
    participant N as npm run check
    G->>H: spawn hook, waitpid → status & 0xff
    Note over H: L1 trap HUP INT QUIT ABRT ALRM TERM PIPE USR1 USR2 → exit 1
    H->>H: L3 reconcile: in-flight record with a DEAD owner → ⚠ earlier gate on sha8 was killed
    H->>H: L3 write own record (git common dir); EXIT trap removes it
    H->>P: ( node prepush-check.mjs )
    P->>N: spawnSync (stdio inherit)
    N-->>P: raw status (may be 256)
    P-->>H: L2 toShellExitCode(status) — never a zero low byte for a failure
    H-->>G: 0 only on the "checks passed" path; a trapped signal → 1
```

Three layers, each closing a different way the gate reads green:

**L1 — the hook cannot read as success when a signal kills it** (`.githooks/pre-push`,
consumer `HOOK_BODY`). A marked block near the top of each hook:

```sh
# >>> fail-closed-on-signal (see docs/runbooks/prepush-sandbox.md §8) >>>
prepush_killed() {
  trap '' HUP INT QUIT ABRT ALRM TERM PIPE USR1 USR2
  echo "✗  pre-push hook interrupted by SIG$1 — push BLOCKED (a killed gate is not a pass)." >&2
  exit 1
}
for prepush_sig in HUP INT QUIT ABRT ALRM TERM PIPE USR1 USR2; do
  trap "prepush_killed $prepush_sig" "$prepush_sig"
done
# <<< fail-closed-on-signal <<<
```

**Signal set (audit R1-H1):** every signal whose default action terminates the process and
that has a POSIX `trap` name — HUP INT QUIT ABRT ALRM TERM PIPE USR1 USR2 (the measured
table includes USR1 → 7680 → 0). All nine names are in POSIX `trap`, so bash, MSYS `sh.exe`
and dash accept them without capability probing. Excluded, and why: **KILL / STOP** cannot be
trapped (the residual L3 covers); the XSI-only terminators (SYS, XCPU, XFSZ, VTALRM, PROF,
TRAP, BUS, FPE, ILL, SEGV) are core-dump/resource signals no external actor sends to a shell
script in this repo's threat model, and SEGV-class signals mean the shell itself is broken —
a trap could not run reliably anyway. Stated in the runbook.

POSIX `sh` syntax (works in bash, MSYS `sh.exe`, dash), so ONE block text serves both
hooks; a drift test asserts the two copies are byte-identical. `exit 1` has a non-zero low
byte, which is the whole point. `trap ''` first so a second signal (or SIGPIPE from the
`echo` itself on a dead stderr) cannot re-enter or turn the exit into a signal death.
Placed before any other command so no window exists in which the hook is unprotected.
(#15 error handling, #16 graceful degradation → fail closed)

*Shell semantics accepted, not engineered around:* a POSIX shell defers a trap until the
current foreground child returns. In the console-close / updater case every process on the
console gets the event, so the child dies and the trap fires at once; for a signal aimed at
the hook's bash alone, the trap fires when the child finishes and the push is still refused.
Running children as `& wait $!` to make the trap immediate would change stdin and job
semantics in a 450-line hook for a latency the gate does not care about — rejected.

**L2 — no forwarded child status can collapse to zero** (`toShellExitCode` in
`scripts/lib/cli-io.mjs`): `status === 0 → 0`; `null/undefined/non-integer → 1`;
otherwise `(status & 0xff) || 1`. Applied at the two places on the gate path that forward a
CHILD's status as their own exit code: `scripts/prepush-check.mjs:686` and
`scripts/run-tests.mjs:328`. Pure, Tier 1 unit-tested. (#5 single source of truth, #11)

**L3 — an untrappable kill is reported on the NEXT push** (hook-owned in-flight record).
SIGKILL and `TerminateProcess` with a zero-low-byte code cannot be caught by any code in the
dying process, and git reads only the code. **The evidence must be owned by the process git
waits on — the hook — not by the runner** (audit R1-H2): a SIGKILL aimed at the hook's bash
alone leaves `prepush-check.mjs` running to a normal finish and sandbox removal, and a kill
during §2 sync / §3 maintenance happens after the sandbox is gone, so no sandbox artifact can
witness either. (The first draft's sandbox-verdict design is dropped for this reason.)

A second marked block in `.githooks/pre-push`, placed **directly after the L1 block**, i.e.
before §-1 and before any substantive work (audit R2-M2), plus a one-line update after the §0
range loop:

```bash
# >>> prepush-inflight-record (see docs/runbooks/prepush-sandbox.md §8) >>>
PREPUSH_INFLIGHT_REC=""
prepush_inflight_write() {   # $1 = the gated sha, or "pending" before the range is known
  [ -n "$PREPUSH_INFLIGHT_REC" ] || return 0
  printf '%s %s %s %s
' "$$" "$1" "$PREPUSH_STARTED" "${PREPUSH_REMOTE:--}"     2>/dev/null > "$PREPUSH_INFLIGHT_REC.tmp" && mv -f "$PREPUSH_INFLIGHT_REC.tmp" "$PREPUSH_INFLIGHT_REC" 2>/dev/null
}
PREPUSH_REMOTE="$1"
PREPUSH_STARTED="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
PREPUSH_COMMON_DIR="$(git rev-parse --path-format=absolute --git-common-dir 2>/dev/null)"
case "$?:$PREPUSH_COMMON_DIR" in
  0:/*|0:[A-Za-z]:/*) PREPUSH_INFLIGHT_DIR="$PREPUSH_COMMON_DIR/prepush-inflight" ;;
  *) PREPUSH_INFLIGHT_DIR="" ;;   # unresolved: no record, no reconciliation — never a fallback path
esac
if [ -n "$PREPUSH_INFLIGHT_DIR" ] && mkdir -p "$PREPUSH_INFLIGHT_DIR" 2>/dev/null; then
  for rec in "$PREPUSH_INFLIGHT_DIR"/*.rec; do
    [ -f "$rec" ] || continue
    read -r rec_pid rec_sha rec_started rec_remote 2>/dev/null < "$rec"   # stderr first: a concurrent rm is silent
    case "$rec_pid" in ''|*[!0-9]*) rm -f "$rec"; continue ;; esac
    kill -0 "$rec_pid" 2>/dev/null && continue        # alive: a concurrent push, leave it
    echo "⚠ an earlier pre-push (pid $rec_pid, remote $rec_remote, started $rec_started) was KILLED before it" >&2
    echo "  finished. Git for Windows reads a killed hook as a PASS, so if that push reached the remote it went UNGATED." >&2
    case "$rec_sha" in ''|*[!0-9a-f]*) rec_sha="" ;; esac   # "pending", "unresolved", garbage
    [ "${#rec_sha}" -ge 7 ] || rec_sha=""
    if [ -n "$rec_sha" ]; then
      echo "  It was gating $rec_sha. Check: git branch -r --contains $rec_sha   (runbook §8)" >&2
    else
      echo "  It died before the gated commit was known. Find what it pushed: runbook §8 'unknown commit'." >&2
    fi
    rm -f "$rec"
  done
  PREPUSH_INFLIGHT_REC="$PREPUSH_INFLIGHT_DIR/$$.rec"
  trap 'rm -f "$PREPUSH_INFLIGHT_REC" "$PREPUSH_INFLIGHT_REC.tmp"' EXIT   # BEFORE the first write
  prepush_inflight_write pending
fi
# <<< prepush-inflight-record <<<
```

and, immediately after the §0 range loop: `prepush_inflight_write "${PUSH_HEAD:-unresolved}"`
(a no-op when no record exists).

Lifecycle, each property measured or argued:

- **Created before any substantive hook work** with sha `pending`, atomically rewritten with the
  gated sha once the range is known (R2-M2); a record still reading `pending` says the hook died
  during range resolution. **Removed by the EXIT trap** on every path that runs shell code at
  exit: every `exit 0`/`exit 1`, and the L1 trap (which `exit 1`s — that push was blocked, so no
  warning is owed). The EXIT trap is installed before the first write, so no handled exit can
  leave a record behind. Only a death that runs NO shell code — SIGKILL, TerminateProcess —
  leaves the record. That is exactly the residual.
- **Irreducible gaps, stated rather than hidden**: a kill before the record is published (the
  first few shell statements, including L1's own installation), and any run where the common
  dir cannot be resolved or written. In both the hook leaves no evidence; the runbook says so,
  and nothing here claims detection covers every residual kill.
- **Storage provenance (R2-M1)**: the common dir is resolved as its own step; only an exit-0
  result that is an absolute path (POSIX `/…`, or the forward-slash drive form `C:/…` that
  `rev-parse --path-format=absolute` prints under Git Bash — measured) is used. Anything else
  disables L3 for this run — no constructed fallback such as `/prepush-inflight`. `$?` is read
  in the same `case` word as the value so it is the assignment's status, not a later command's.
- **Subshells do not inherit the EXIT trap** — measured 2026-10-12 on bash 5.3.15 and MSYS
  `sh`: `trap … EXIT; ( true ); ( sleep 0 & )` fires the trap once, in the main shell. So the
  `( cd … && node … )` runner subshell and the backgrounded §3 maintenance cannot delete the
  record early.
- **Owner liveness is `kill -0` on the MSYS pid (`$$`)**, answered by the same MSYS runtime that
  issued it. A live owner is a concurrent push (two sessions share this repo) and is left alone.
  PID reuse can only turn a dead owner into "alive" — a missed warning, never a false one, and
  the record is re-examined on every later push.
- **Shared across worktrees**: the record lives in the git COMMON dir, so a push from any
  linked worktree sees a record left by any other. It is under `.git/`, so it is never tracked
  and never published.
- **Atomic publish** (`.tmp` + `mv`); a malformed record (non-numeric pid) is removed silently
  — it carries nothing actionable.
- **Advisory only, never blocks.** The push it describes has already happened; blocking the
  current push would punish the wrong commit. Machine state may warn, never block (existing
  doctrine in `prepush-sandbox-cleanup.mjs`).
- **Best-effort**: every step is guarded (`2>/dev/null`, `if mkdir`), so an unwritable common
  dir degrades to "no record", never to a failed push.
- **Unavoidable race, documented**: a kill landing between the last command and the EXIT trap's
  `rm` leaves a record for a run that DID finish (its verdict already printed). The warning
  wording says "killed before it finished", which is then wrong by one instruction; accepted,
  and the runbook says so.

L3 lives in `.githooks/pre-push` only. Consumer hooks get L1 (the fail-closed part); their
correctness does not depend on L3, which is detection of a residual, and adding it there is a
separate consumer-facing change (Out of Scope, below).

### Right-sizing

- **Band-aid**: wrap the one `node prepush-check.mjs` call in `|| exit 1` / a sentinel
  (the task's candidates (a)/(b)). Measured useless: the failure is the HOOK process dying,
  and nothing inside a dead process runs; a killed child already fails closed today.
- **Over-engineered**: rewrite the hook as a native node launcher (escapes MSYS's `S<<8`),
  plus a remote-side or post-push verifier that refuses ungated refs. The launcher is still
  killable with `TerminateProcess(h, 0)`; a remote verifier needs CI this repo deliberately
  does not run (AGENTS.md: local-first). Both are large and neither is total.
- **Chosen**: trap every catchable signal (L1) + normalise forwarded statuses (L2) + report
  the uncatchable remainder on the next run (L3). Each serves the current requirement "a
  killed or truncated gate must not read as a pass, and where that is impossible it must be
  visible"; nothing is configurable.

## 6. Sustainability Notes

- Assumption that could change: Git for Windows' `WEXITSTATUS` masking. If it ever honours
  signals, L1 becomes redundant but harmless. The protected-hook tests still hold; the
  fail-open characterisation skips itself on a repaired runtime (audit R1-M1).
- The trap block is shared text with a drift test, so a third hook can adopt it by copying
  the marked block and being added to the drift test.
- `toShellExitCode` is the seam for any future CLI that forwards a child's status.

## 7. File-Level Plan

- `.githooks/pre-push` (modify) — insert the marked L1 trap block above §-1, the marked L3
  in-flight-record block DIRECTLY after it (still above §-1), and the single
  `prepush_inflight_write "${PUSH_HEAD:-unresolved}"` call immediately after the §0 range loop; header comment gains one line pointing
  to runbook §8. No other behaviour change.
- `scripts/install-prepush-hook.mjs` (modify) — same marked block in `HOOK_BODY` right after
  the version marker / header comment (before the `AUDIT_PREPUSH_DISABLE` line);
  `HOOK_VERSION` 9 → 10 with a dated history comment, like v5–v9.
- `scripts/lib/cli-io.mjs` (modify) — export `toShellExitCode(status)` with the measured
  rationale in its JSDoc.
- `scripts/prepush-check.mjs` (modify) — `main()` returns `toShellExitCode(r.status)`.
- `scripts/run-tests.mjs` (modify) — `adjudicateRun`'s non-zero branch returns
  `toShellExitCode(status)`.
- `tests/prepush-hook-fail-closed-on-signal.test.mjs` (create) — L1 + L3, see §9.
- `tests/cli-io-shell-exit-code.test.mjs` (create) — `toShellExitCode` table, plus a
  runtime-characterised round-trip through MSYS bash on Windows.
- `scripts/lib/prepush-sandbox-cleanup.mjs`, `tests/prepush-sandbox-cleanup.test.mjs` —
  **no longer touched** (audit R1-H2 moved L3 out of the sandbox). Released from the fleet
  claim at the next `fleet touch`.
- `docs/runbooks/prepush-sandbox.md` (modify) — includes an 'unknown commit' subsection for a
  record that died before the range was known: the push's remote-tracking update is the
  evidence (`git reflog show --date=iso <remote>/<branch>` around the record's `started`
  time, then `git ls-remote <remote>` to confirm what the remote holds). New §8 "A killed hook reads as a pass on
  Git for Windows": the two truncations with the measured table, L1–L3, the residual, and how
  to read the interrupted-gate warning.
- `AGENTS.md` — **deliberately NOT touched** (fleet overlap with `claude/ship-trains-c`,
  coordinator decision 2026-10-12). The runbook carries the substance; a one-line pointer may
  be routed as a follow-up once that branch merges.

### 7b. Implementation Phases

**Phase 1 — Fail closed in the hooks**: the marked trap block in both hooks, `HOOK_VERSION`
10, and the red/green signal test (hook text extracted by marker, so the test exercises the
shipped bytes). Files: `.githooks/pre-push` (modify), `scripts/install-prepush-hook.mjs`
(modify), `tests/prepush-hook-fail-closed-on-signal.test.mjs` (create).

**Phase 2 — No forwarded status collapses to zero**: `toShellExitCode` and its two call
sites. Files: `scripts/lib/cli-io.mjs` (modify), `scripts/prepush-check.mjs` (modify),
`scripts/run-tests.mjs` (modify), `tests/cli-io-shell-exit-code.test.mjs` (create).

**Phase 3 — Report an untrappable kill on the next push**: the hook-owned in-flight record
block + its integration cases. Files: `.githooks/pre-push` (modify),
`tests/prepush-hook-fail-closed-on-signal.test.mjs` (modify).

**Phase 4 — Document**: runbook §8. Files: `docs/runbooks/prepush-sandbox.md` (modify).

**Close-out (not a phase)**: `npm run skills:check`, `npm run context:check`,
`npm test` (full suite — memory: run the whole suite before the first push), then the manual
red/green repro of §9 against a throwaway bare remote.

No §11: the four phases are one cohesive change (each closes one way the same gate reads
green) and are audited as one union diff.

## 8. Risk & Trade-off Register

- **Trap deferral** (above): a signal aimed only at the hook's bash blocks the push when the
  current child finishes, not instantly. Fail-closed either way; accepted.
- **A kill after the checks passed** (during sync/maintenance) now blocks a push that was
  verified. Accepted: re-pushing is cheap; telling a killed hook apart by phase is not worth
  the code.
- **Residual, uncatchable**: SIGKILL of the hook's bash (2304 → 0) and a native
  `TerminateProcess` with a zero-low-byte code still read as success. Nothing in the dying
  process can prevent it; L3 makes it visible on the next push. Stated in the runbook, not
  hidden.
- **`AUDIT_PREPUSH_SANDBOX=0`** (in-tree opt-out) calls `npm run check` straight from bash,
  so npm's own status is truncated by `$?` with no node in between. `run-tests.mjs` is
  normalised (L2), which covers the suite; other gates exit 0/1. Deferred with independence:
  the default sandbox path does not run through this branch.
- **Consumers** receive v10 only on re-install / sync (existing mechanism); until then their
  hooks fail open on Windows exactly as today. No worse.
- **L3 race**: a kill between the hook's last command and its EXIT-trap `rm` leaves a record for
  a run that finished; the next push then warns about a push that WAS gated. Advisory, rare,
  documented in the runbook.
- **L3 and PID reuse**: can only suppress a warning (dead owner read as alive), never invent one.

## Out of Scope (Future)

- **L3 in the consumer hook.** Independence: consumer pushes fail closed on every trappable
  signal via L1 regardless; L3 only *reports* the untrappable residual, and its record
  directory/wording would be a new consumer-facing contract worth its own change.
- **Hook-killed-by-SIGKILL prevention.** Not achievable from inside the process git waits on
  (see Right-sizing); L3 is the honest ceiling.

## 9. Testing Strategy

Tier 3 (consumer hook is the sync contract; the gate guards egress of every push) — tests
land in the same commit as the code.

- **`tests/prepush-hook-fail-closed-on-signal.test.mjs`**
  - *Integration, real git:* temp repo + `git init --bare` remote (never origin); every
    spawned git gets a scrubbed env (no `GIT_DIR`/`GIT_WORK_TREE`/`GIT_INDEX_FILE`… — INC-002 /
    `sanitizeGitEnv` class). The hook under test = the marked block(s) extracted from
    `.githooks/pre-push` (and, for L1, from `HOOK_BODY`) + a stub body that writes `$$` to a
    file, then polls in 0.1 s `sleep`s for a `release` file — **bounded at 15 s, after which it
    exits 3** — and `exit 0`s. The harness starts `git push` asynchronously, waits for the pid
    (deadline 15 s), sends the signal **through MSYS `kill`** (node's `process.kill` is
    `TerminateProcess(…,1)` on Windows and would not reproduce), awaits the push (deadline
    30 s), and asserts: push exit ≠ 0 AND `git -C remote rev-parse --verify <branch>` fails.
    Signal matrix: HUP, TERM, INT, USR1 (one per kill class: console close, polite kill,
    Ctrl+C, the R1-H1 gap).
  - *Teardown (R1-M2):* every case runs in `try/finally`: write `release`, MSYS `kill -KILL` the
    recorded pid if still alive, `taskkill /T /F` the `git push` process tree on Windows
    (`SIGKILL` elsewhere), await its exit, then remove the fixtures.
  - *Characterisation of the installed git, not a permanent contract (R1-M1, R2-H1):* the
    UNPROTECTED stub (same body, no L1 block) is pushed and signalled exactly like the protected
    one, and its outcome is classified from the COMPLETE spawn result plus the remote-ref check:
    `fail-open` (push exit 0 AND the remote has the ref), `blocked` (non-zero exit AND no ref),
    or `indeterminate` (spawn error, timeout, or exit/ref disagreeing — never classified as
    either). The classification is emitted with `t.diagnostic`. It is the instrument check — on
    today's Git for Windows it reads `fail-open`, i.e. the harness demonstrably SEES the defect,
    while the protected case beside it reads `blocked` — and it asserts only that it is not
    `indeterminate` (a harness that cannot classify proved nothing). It never requires
    `fail-open`, so a repaired git does not turn the suite red. The protected-hook assertions
    (`blocked`) are unconditional on every platform. The signal is delivered with MSYS `kill` on
    Windows and `process.kill` elsewhere; no probe ever reads `status & 0xff` of a `null` status.
  - *Direction it must NOT fire:* stub exits 0 normally → push succeeds with both blocks present.
  - *L3:* push 1 with the L3 block, `kill -KILL` the hook's bash after the range update (on an
    affected runtime the push lands — expected, that is the residual), then push 2 (any stub)
    → stderr contains `was KILLED before it` and the `--contains <sha>` advice naming the pushed
    sha; the record is removed afterwards. Same with the kill BEFORE the range update → the
    report says the commit is unknown, points at runbook §8, and contains NO `--contains`
    advice (R2-M2, R3-M1); a record with a malformed sha takes the same unknown branch. Normal completion leaves no record (EXIT trap). A record whose pid is alive (a
    second hook held at its release poll) is left alone and not reported.
  - *L3 storage (R2-M1):* run the block with a `git` stub on PATH that exits 128 → no
    `prepush-inflight` directory is created anywhere (assert a sentinel temp root stays empty)
    and the hook still exits 0; a repo path containing a space works; a push from a LINKED
    worktree writes its record into the main repository's common dir.
  - *Drift:* the two L1 blocks are byte-identical; each hook contains exactly one L1 block;
    `.githooks/pre-push` contains exactly one L3 block, directly after the L1 block, and the
    `prepush_inflight_write "${PUSH_HEAD:-unresolved}"` call after the range loop.
  - `HOOK_VERSION >= 10` assertion (existing pattern).
- **`tests/cli-io-shell-exit-code.test.mjs`** — table: 0→0, 1→1, 3→3, 130→130, 255→255,
  256→1, 512→1, 3840→1, 257→1 (low byte 1), null→1, undefined→1, NaN→1, -1 → 255. Plus a
  separate native-child truncation probe through the actual shell (R2-H1), Windows only (skip
  reason stated elsewhere): `bash -c 'node -e "process.exit(256)"; echo $?'` is CHARACTERISED
  (diagnostic: truncating or not), and `node -e "process.exit(toShellExitCode(256))"` must read
  non-zero in `$?` unconditionally — the normaliser's contract holds whatever the shell does.
- **Manual red/green repro (recorded in the Implementation Log and PR):** the REAL
  `.githooks/pre-push` against a throwaway bare remote: (red, on the pre-change hook) start
  the push, MSYS-`kill -HUP` the hook's bash mid-`npm test` → remote receives the ref;
  (green, post-change) same → push refused, `✗ pre-push hook interrupted by SIGHUP` printed;
  (control) `taskkill /F` on the node child only → refused both before and after.

## Audit Trail

- **/audit-plan** SID `audit-plan-1791818126813-60892`, 2026-10-12, at branch base ccefb0fc.
  - R1 H:2 M:2 — 4/4 accepted (signal set incl. USR1/USR2; L3 moved from runner sandbox to a
    hook-owned record; runtime characterisation instead of a permanent fail-open contract;
    bounded test lifecycle).
  - R2 H:1 M:2 — 3/3 accepted (null-status probe bug → characterise via the real push;
    validated common-dir resolution; record published before substantive work). A measured
    side-finding while fixing R2-M1: a `[/\]` bracket never matches in bash/MSYS sh, so the
    pattern uses `0:[A-Za-z]:/*`.
  - R3 H:0 M:1 L:1 — 2/2 accepted (no `--contains` advice for an unknown sha; §7 placement
    contradiction). **Stopped at the 3-round default**: acceptance stayed 100%, but R3's findings
    were wording/consistency-sized, i.e. converged.
  - **Final gate** (Gemini, round 1/2): **APPROVE**, gate `approve` (blocking 0, debt 1). The
    one LOW (G1, redirection order: `2>/dev/null` must precede `< "$rec"`) was folded in
    directly rather than carried as debt.

## Implementation Log

- **2026-10-12, implemented** at branch base ccefb0fc (`claude/prepush-fail-closed-when-killed`).
  Deviations from §2, each from `/audit-code`:
  - **L1 signal set widened (code-audit R3-H1)**: the nine POSIX signals stay unconditional, and
    the XSI terminators (TRAP BUS FPE ILL SEGV SYS XCPU XFSZ VTALRM PROF) are trapped wherever
    `kill -l NAME` succeeds. This is the capability check plan-audit R1-H1 suggested. The ignore
    list in `prepush_killed` is the installed set (`$PREPUSH_TRAPPED`), so `trap ''` never names a
    signal the shell doesn't know. SIGTRAP was proven fail-open without it (mutation: red).
  - **L3 reconciliation never treats `rec_pid == $` as a live owner (code-audit R2-H1)**: a
    record named for this hook's own pid is a dead predecessor whose pid was reused, and the
    hook's own write would otherwise overwrite it.
  - Marker lines carry no docs path (`# >>> fail-closed-on-signal >>>`), because the
    byte-identical consumer copy would otherwise cite a file that consumers don't have
    (consumer shape #5).
  - `tests/helpers/git-bash.mjs` (new): resolves Git's own bash beside `git --exec-path` (a bare
    `bash` can be WSL's), and provides a hermetic git env (no GIT_*, no system/global config).
- **Red/green, in-suite** (Git 2.56.0.windows.2): the unprotected hook killed by SIGHUP reads
  `fail-open` (exit 0, remote has the ref), and every protected case reads `blocked`. Each new
  guard was mutation-proven: trap `exit 256` → 4 protected cases red; raw-status forwarding in
  `toShellExitCode` → 8 red; the `$` guard reverted → reused-pid case red; XSI probe disabled
  → SIGTRAP red.
- **Manual red/green against the REAL hook** (2026-10-12 16:43–16:47Z, Git 2.56.0.windows.2,
  HEAD 8d862042). Each run pushed this worktree to a throwaway local bare remote under
  `C:/tmp/` (never origin), with `core.hooksPath` pointed at a copy of the real hook. The only
  instrumentation was one line after the shebang writing `$$` to a file. The kill landed about
  45 s into `npm run check`.

  | Hook | Kill | `git push` exit | Remote received the ref? | Hook printed |
  |---|---|---|---|---|
  | pre-fix (`ccefb0fc`) | SIGHUP to the hook shell, then `taskkill /T /F` on the prepush-check tree | **0** | **YES — fail-open** | nothing: neither `checks passed` nor `FAILED`; sandbox husk left behind. The incident's exact signature |
  | fixed (this branch) | same | 1 | no — blocked | `✗ pre-push hook interrupted by SIGHUP — push BLOCKED` (in-flight record removed by the EXIT trap) |
  | pre-fix (`ccefb0fc`) | `taskkill /T /F` on the prepush-check tree only (control) | 1 | no — blocked | `✗ pre-push checks FAILED (exit 1)`: killing the child alone was never the hole |

  Instrument note: the first RED attempt pushed HEAD == the merge-base, so
  `status:integrity:gate` failed closed within seconds, before the kill landed. That run
  measured nothing about signals and was discarded; the runs above push a real one-commit range.
  Operational note: `rm -rf` must not be used on a sandbox husk (its `node_modules` may be a
  junction into the main checkout). Leave husks to `removeSandboxDir` in the next push's sweep;
  the main checkout's `node_modules` was verified complete afterwards (228/228 top-level
  packages against `node_modules/.package-lock.json`).
