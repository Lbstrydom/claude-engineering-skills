# Plan: fleet — defects from two work consumers' November feedback
- **Date**: 2026-11-15
- **Status**: In progress — implemented on branch `claude/nostalgic-nobel-101150`, PR pending
- **Author**: Claude + Louis
- **Scope**: backend (fleet CLI + skill prose; no UI) · stack `js-ts`
- **Target domain(s)**: `fleet`

Two consumers on the Azure work profile (Windows 11) reported fleet feedback on 2026-11-15. The first (11 concurrent chip
sessions over 3 days) sent eleven items: this plan covers its six fleet-tooling ones; its audit-route and setup items are
another session's, and its playbook item shipped in #366. The second amended item 2 and added two small items (§7, §8);
its larger items (a `fullSuite: train` mode, a fast-tier dry-run train, stacked-base overlap, a user-decision directive,
stale ready marks, test-kind leases) are out of scope here and go to a follow-up.

**Reproduced against current main, not the consumers' bundle.** Both consumers run a bundle from 2026-11-11/12 (main was
`0cd064d1` / `1e701a66`). `git log 0cd064d1..origin/main` touches fleet only in #366 (the coordinator playbook) and #359
(sync), neither on these paths, and every red test below was run against main (`f1740a3e`) first. Nothing here was already
fixed.

**Do not regress** (the first consumer's "what worked"): `lease run` plus "a free slot is not a turn", durable
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

## 2. A stuck lease (revised by the second consumer's report)

**Verified cause**: `lease run` never renewed, so any job longer than `--for` read EXPIRED with a live pid, and admission
refuses `expired-pid-alive` forever; nothing showed whether that process was working.

**Why not reclaim on CPU** (the first version of this fix, replaced): the second consumer's recorded pid was a node
launcher at 0.41 s CPU while a python grandchild did the work, and a second session "proved" pid reuse by comparing a
local-time start time with a UTC expiry. Both nearly forced a live 2-hour suite. Reclaim stays a human action.

**Fix**:
- `lease run` heartbeats (`decideHeartbeat`, token-fenced, every minute while the job runs): the lease is renewed to now +
  10 min, never past `--timeout` (else a 12 h ceiling), and each beat records the job's process-TREE CPU. A tree idle for
  30 min stops renewing, so only a lost or hung run ever expires.
- `lease status` samples the holder's tree live (`lease-cpu.mjs:sampleTree`): launcher then descendants, each start time
  UTC at the source, and `busy: X s CPU / Y s` (or `no CPU in the last Y s`); the slot line says when renewal stopped.
- Waiters are still refused. `release --force` is suggested (status, and `next`/footer past 20 refusals) ONLY for a tree its
  heartbeats measured idle past 30 min; otherwise the line names the holder and points at `lease status`.
- A slot note shows when it was written: `(note from HH:MMZ)`.

**Declined**: the optional default `--for` from the tier's median journal duration — the heartbeat already removes the
failure it addressed (a too-short `--for` reading EXPIRED).

**Acceptance**: a 2-hour run with no `--for` is HELD at every minute; a launcher-flat tree with a busy grandchild is busy;
a tree idle 30 min stops renewing, expires, is still refused to waiters, and status shows "idle" with the suggested action.
`tests/fleet-lease-idle.test.mjs`.

## 3. The chip preamble contradicted itself on pushing

**Fix**: TURN and AUTHORITY now say pushing your own branch never waits; opening a PR and taking the heavy slot do.
Where a repo's pre-push hook runs the full gate, that push is heavy work and runs as `fleet lease run -- git push`
(queues; never skip the hook). Participant rule 2 says the same. `tests/fleet-chip-notes-and-push.test.mjs`.

## 4. "dubious ownership" was mislabelled

**Verified cause**: `runGit` keeps only stderr's first line; git puts the `safe.directory` remedy on a later one, and
`fleetDir` wrapped the rest as "cannot locate the git common dir".

**Fix**: `gitCommonDir` recognises the refusal (`dubiousOwnership`) and returns git's message under code
`DUBIOUS_OWNERSHIP`, naming both causes (another account owns the folder; this process runs under a different sandboxed or
elevated token) and both remedies (git's exact `safe.directory` command; `takeown`). Fleet changes no security setting.
Tested against git's real refusal (`GIT_TEST_ASSUME_DIFFERENT_OWNER=1`). `tests/fleet-dubious-ownership.test.mjs`.

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

## 7. A red train hid its failure (second consumer)

**Verified cause**: a red tier printed only `tier X: red (exit N) log <path>`, and `land` exited 3 — the code for
blocked/refused — so "ran and red" could not be told from "never ran".

**Fix**: a built or resumed train whose tiers ran red prints each red tier's failure summary (`tier-failure.mjs`: pytest's
`short test summary info` block, else the last FAILED / ERROR / `not ok` lines, else the log tail; bounded tail read) and
exits **4**. `--approve` of a red train is still refused (3). SKILL.md and `references/landing.md` document exit 4.
`tests/fleet-tier-failure.test.mjs`, `tests/fleet-cli-land.test.mjs`, `tests/fleet-cli-tiers.test.mjs`.

## 8. Per-verb help and missing tooling (second consumer)

**Fix**: `fleet <verb> --help` / `-h` prints the verb's line and every flag from the same spec the parser enforces
(`lease <sub> --help` names that sub-command's flags; an argument after `--` is never fleet's). In a consumer layout, a
claim bound to a worktree without `scripts/.claude-skills` warns with the exact `npm run skills:hydrate` command.
`tests/fleet-help-and-tooling.test.mjs`.

**Chosen: warn, not refuse.** The claim is the coordination record the fleet needs whatever the tooling state, and
hydrating writes into the worktree, which is the session's to do. `start`'s rendered chip prompt already opens with the
hydrate step.
