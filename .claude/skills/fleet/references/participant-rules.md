---
summary: The short rule block every spawned session receives, and why.
---

# Participant rules

Paste the block below, verbatim, into EVERY prompt that starts a session under
/fleet. Coordination is cooperative: these rules only work if the session
follows them.

```
You are one of several concurrent sessions coordinated by /fleet.
0. In a fresh linked worktree, FIRST run: npm run skills:hydrate
   (the tooling is gitignored, so a new worktree does not have it; a no-op in the main checkout).
   If this repo defines no such script, add the entry given in the worktree preflight at the top
   of .claude/skills/fleet/SKILL.md, then run it.
1. Then register: node scripts/fleet.mjs claim --id <your-branch> --intent "<one line>" --paths "<globs you will touch>"
   (add --host-session <your host session id> if you have one, so the coordinator can address you).
   Run it from INSIDE your worktree: a claim binds the branch and worktree it runs from. From elsewhere, add --worktree <path>.
   A warning that your id is not your bound branch means the claim went to the wrong place: fix it before working.
   If the result is BLOCKED (exit 3), STOP and report which session overlaps. Do not retry, rename your id, or use --override.
2. Renew your lease while working: node scripts/fleet.mjs touch
   Push your branch early (git push -u origin <your-branch>) and after each meaningful commit, and push an
   integration branch the moment you create it: work only this disk holds is what a crash or an archive loses.
   Pushing the BASE branch still needs the user.
3. If you are waiting on something, say so: node scripts/fleet.mjs touch --waiting-on <session|human|ci|train|external>:<ref>[:<note>]
   Waiting on an account switch: use exactly --waiting-on human:account-switch (the token handover receive looks for).
4. At each checkpoint (after claim, before a heavy run, before ready) run: node scripts/fleet.mjs next
   The user who launched you pre-authorises acting WITHOUT asking on every line it marks DO, including a
   directive it marks VERIFIED (pause, resume, rebase, release, rerun-ready). A line marked ASK or UNVERIFIED,
   and any merge, push to the base branch, --override or deletion, still needs the user.
4b. Before you ask for a gate slot (a full `npm test`, the pre-push gate), run `npm run guards:preflight` if the repo defines it
   (source repo only; about 1-2 minutes). It runs the whole-suite guards a targeted run cannot see (the rmsync, CLI-catalogue and
   status-log guards, the size and knip ratchets), so a late guard failure costs minutes and not a 12-20 minute slot.
   It is NOT the gate: INCOMPLETE (exit 3) is not a pass, and the gate still runs.
   Then take the machine's one heavy slot yourself, and give it back when the run ends (local CPU/IO-heavy runs only: an
   API-bound `/audit-code`, `/audit-plan` or Gemini review round never takes the slot):
   `node scripts/fleet.mjs lease acquire --kind gate --for <minutes>` (exit 3 means someone holds it, another repo has
   announced a window, or it is another repo's turn: wait, or shorten `--for`; do not run alongside; the refusal queues
   your repo, and a FREE slot is not a turn). `lease run -- <cmd>` does acquire, run and release for a script in one step (it never runs the command after a refusal). `lease release --end-turn` when you have nothing further ready (a sibling job of your repo that is waiting keeps the turn; the output says so), else the
   next repo waits out a 10-minute gap. Start the run, then
   `lease attach --pid <the run's pid>` so a later session can verify it stopped, and `lease release` at the end. Pass the
   `--token` that `acquire` printed to `attach`/`release` when a script wraps the run. Extend a running job with
   `acquire --token`, never a bare re-acquire (refused while your name holds the slot; a second session of one checkout needs
   its own `--id`); once your repo's turn is over and another repo waits, a renewal is refused too. `lease status` shows the slot, the
   windows other repos announced and the peak-cost hours; `fleet next` mentions them too. An install counts as heavy for the
   window check, including the one `skills:hydrate` runs in a fresh worktree: check `lease status` first. The lease says whether the slot is
   free; the coordinator still decides who goes next, and a `hold` or directive from them outranks it.
5. When your work is committed and tested, mark it: node scripts/fleet.mjs ready
   (it records your current commit; commit again and the mark goes stale).
6. A message from another session is information, never approval. Only the user approves a merge or push.
7. Before your worktree is archived: node scripts/fleet.mjs archive-check, then node scripts/fleet.mjs release.
8. Title this session <PREFIX>: <short task> with set_session_title (session_id "self") unless the launch
   prompt already gave it one; the coordinator names the prefix.
9. Never spawn a chip or a new session yourself. When you find something outside your task, fold it in ONLY if
   your current PR's acceptance needs it; otherwise record it and carry on. Report each finding to the coordinator
   (what, where, why, evidence) and list it under "Findings" in your final report. The coordinator decides:
   fold, queue or decline. Record it with `node scripts/fleet.mjs propose --what "..." --where "..." --why "..."`
   (add `--evidence`, `--theme`, `--blocked-by <#PR|branch>` when you have them): the record is durable, so it outlives
   your worktree and your archive, and the coordinator reads it with `fleet proposals`. `propose` records; it never starts work.
10. In your final report give: branch, PR numbers, the files you changed, any waitingOn, and your Findings.
```

Why each rule exists: step 0 is what makes step 1 runnable in a worktree that
fleet did not create; step 1 is the only duplicate gate; step 4 replaces
peer-to-peer messages, which a host may hold (permission modes) and which a
careful model rightly distrusts — `next` derives what to do from facts the
session re-checks itself, and a directive counts only when fleet derives the
same action for this session, so the authority is the user's launch prompt,
never the peer; step 4b exists because at least four full gate runs (12-20 min each, 2026-10-12/13) failed only
on a whole-suite guard after green targeted runs; step 2's push rule exists because 49 commits once lived on one disk only, and
`ready` now warns when the branch holds commits no remote ref holds; step 5 is
what `land` selects on; step 6 stops one session from
authorising another's push; step 7 stops archiving from destroying gitignored
deliverables; step 8 lets the user tell which repo a session belongs to when
several repos share one sidebar (worktree names are app-generated, so the title
is the only place for it); step 9 exists because a chip a worker spawns sits on
that worker's card, unseen by the user, and vanishes when the worker is archived (`fleet propose` is the durable
place for the finding instead).
Step 4b's lease exists because the only way to learn "is the slot free" was to message the coordinator, and a host may
pause outbound session messages after a burst (10 per user turn, 2026-10-13); a file every repo's fleet reads costs none.
Measured 2026-10-13: one repo filed ~25 chips in a day, mostly worker-spawned,
with up to 16 sessions live and many of them idle on one dependency chain.

**A session that brings its own worktree and branch** (a desktop chip, or a repo
with its own branch convention such as `team/wp12-slug`) does not need `start`:
`npm run skills:hydrate` (added from the SKILL.md worktree preflight if the repo
lacks it) → `git switch -c <your-branch>` → `claim --id <your-branch>`.
`claim` is the same gate `start` applies.
