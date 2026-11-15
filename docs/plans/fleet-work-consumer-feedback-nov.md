# Plan: fleet — six defects from the work consumer's November feedback
- **Date**: 2026-11-15
- **Status**: In progress — implemented on branch `claude/nostalgic-nobel-101150`, PR pending
- **Author**: Claude + Louis
- **Scope**: backend (fleet CLI + skill prose; no UI) · stack `js-ts`
- **Target domain(s)**: `fleet`

A consumer on the Azure work profile (Windows 11, 11 concurrent chip sessions over 3 days) reported eleven items on
2026-11-15. This plan covers the six fleet-tooling ones; the audit-route and setup items are another session's, and the
playbook item shipped in #366. Each report was checked against the source before it was fixed, and each fix landed with a
test that failed without it.

**Do not regress** (the same consumer's "what worked"): `lease run` plus "a free slot is not a turn", durable
`fleet propose` findings, and chips that never used `--override`.

## 1. Merged claims kept blocking

**Verified cause**: `claim` gathers facts with `untracked:false`, so `gatherFacts` asks for no merged evidence; a session whose
PR merged stays "live" (lease or branch activity) and its paths still block. `status` shows it `[done]` because it does ask.

**Fix**: `othersFor` judges each holder with `mergedDone` — the predicate `status` uses — when merged evidence for its
branch is present: merged and proven clean ⇒ `live:false` plus a `finished` note; merged but dirty or uninspected ⇒ still
live, with `mergedNote`. `cmdClaim` asks for that evidence only for holders of a would-be-BLOCKING overlap
(`withMergedEvidence`), so the no-conflict path makes no `gh` call. BLOCKED text names a merged holder and
`release --id` as the remedy; an uncounted finished holder is disclosed with the same remedy.

**Acceptance**: a squash-merged, clean holder no longer blocks (OK + note); merged-with-uncommitted still blocks and says
"merged … release --id"; an unmerged holder blocks unchanged. `tests/fleet-claim-merged-holder.test.mjs`.

## 2. A stuck lease blocked the machine

**Verified cause**: `classifyHeavy` reads an expired lease whose pid is alive as `pid-alive`, which admission refuses
forever; nothing measured whether that process was doing anything.

**Fix**: waiters measure the CPU time of the recorded pid's **process tree** (`lease-cpu.mjs`: `Get-CimInstance
Win32_Process` on Windows, `ps` elsewhere). The tree, because the recorded pid is often a wrapper (`npm.cmd` → `cmd.exe`
→ `node`) whose own CPU is flat while a descendant works. `markIdle` (in `settleQueue`) keeps an idle watch on the lease;
`classifyHeavy` returns `pid-idle` only when the tree's CPU has not moved for `idleGraceMs` (10 min) of CONTINUOUS
watching (no gap over `idleObserveGapMs`, 3 min — a sleeping laptop restarts it). `pid-idle` is reclaimable like
`pid-dead`: `decideAcquire` takes over and journals `taken-over` with the reason. Moving or unreadable CPU, a probe
without `cpuOf`, or another process scope keep the conservative default. Past `stuckRefusals` (20) refusals of one
waiter on an expired slot, `fleet next` and the checkpoint footer name the holder, its pid and
`lease release --force --reason`.

**Declined**: a runner heartbeat. The recorded pid is the job child, not the runner, so a heartbeat proves only that the
runner is alive — not that the job is working — and a SIGKILLed runner leaves an orphaned child that may still be busy.
The tree's CPU measures the job directly.

**Acceptance**: flat CPU ⇒ refused until 10 min, then taken over with a journal entry; moving CPU ⇒ never; unreadable ⇒
never; an observation gap restarts the watch; stuck line at 20 refusals, silent below and when held.
`tests/fleet-lease-idle.test.mjs`.

## 3. The chip preamble contradicted itself on pushing

**Fix**: TURN and AUTHORITY now say pushing your own branch never waits; opening a PR and taking the heavy slot do.
Where a repo's pre-push hook runs the full gate, that push is heavy work and runs as `fleet lease run -- git push`
(queues; never skip the hook). Participant rule 2 says the same. `tests/fleet-chip-notes-and-push.test.mjs`.

## 4. "dubious ownership" was mislabelled

**Verified cause**: `runGit` keeps only stderr's first line; git puts the `safe.directory` remedy on a later one, and
`fleetDir` wrapped the rest as "cannot locate the git common dir".

**Fix**: `gitCommonDir` recognises the refusal (`dubiousOwnership`) and returns git's message plus its exact
`git config --global --add safe.directory …` command under code `DUBIOUS_OWNERSHIP`. Tested against git's real refusal
(`GIT_TEST_ASSUME_DIFFERENT_OWNER=1`). `tests/fleet-dubious-ownership.test.mjs`.

## 5. Shared additive files forced needless conflicts

**Fix (right-sized)**: `hotFiles` (a hot-only overlap never blocks) and `appendOnlyGlobs` (landing keeps both sides)
already ARE the co-owned mechanism. A BLOCKED path/file overlap in a repo that sets neither now names them as a hint for
the user/coordinator (a config change is a person's decision; never `--override`).

**Declined**: `claim --shared-additive <path>` — a second, per-session spelling of the hotFiles policy that every reader
would have to union with the repo's. "Only on the first such conflict" — the hint shows whenever both keys are unset and
a path/file overlap blocks; tracking "first" would be state no requirement needs.

## 6. Stale chip notes

**Fix (what fleet controls)**: `fleet next` ends with `stamp: <id> · head <sha12> · <merge state> · <state> · seen <time>`
(also `stamp` in `--json`); merge state comes from the same evidence `status` uses and never says "not merged" without
complete evidence. The preamble's STATUS WORDS tells chips to start every note with it.

**Host-only (recorded, not done)**: marking a delivered note stale when the PR it describes merges, and showing a note's
send time beside the session's current head, need the host app's message store; fleet cannot see sent messages.
