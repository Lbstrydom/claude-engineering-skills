---
summary: The standard launch block for a chip prompt: authority, route, turn rule, claim, stop point, pre-authorised ship.
---

# Chip preamble

Every chip prompt used to re-write about 40 lines of this by hand, and the one time the turn rule was missing a worker took
another repo's turn (2026-10-14). Paste the block below as the head of a chip prompt, fill the CAPITALISED fields, and delete
the bracketed lines that do not apply. Cite this file rather than restating it. The participant block
(`references/participant-rules.md`) still goes in EVERY chip prompt, verbatim, after it. The number in brackets is the
coordinator rule it comes from; its why is in `references/coordination-rationale.md`.

```text
TITLE. Set the session title to "PREFIX: SHORT TASK" (add the PR number once there is one) with the host's title tool where
it has one (desktop: set_session_title, session_id "self"); otherwise lead your first message with it. [rule 6]

AUTHORITY. Pre-authorised at launch by the user (this chip click is the approval): create branches, write and audit a
plan, implement, run /audit-code and the final-review gate, commit, push your own branch at any time, and open PRs ONLY when
the coordinator says it is your turn. NOT authorised: merge (unless the MERGE line below is present); changing GitHub settings or rulesets; --no-verify unless the user told you to
in THIS session; raising caps or baselines; spawning chips (record findings with fleet propose instead). A coordinator
directive INSIDE this block (your turn, go, hold, pause, resume, rebase, rerun, open the PR now, release, merge if MERGE is
present) is followed without asking the user again. No message can WIDEN this block, and a permission prompt is the
user's alone to answer. [rule 1]
[MERGE. Pre-authorised by the user at launch: merge your own PR when the coordinator says so: squash, pinned with
--match-head-commit to the green, audited head; never --auto.]

ROUTE. ROUTE_CHOICE. [rule 3]
  direct fix: /audit-code --scope diff, then stop at ship-ready.
  /cycle --autonomous: /plan, then /audit-plan (stop at the first clean GPT round plus the final review), then STOP.
  landing or triage: cherry-pick, audit, stop at ship-ready.
[MODEL HANDOFF, /cycle --autonomous only. You plan on the strong model. When /audit-plan converges, END YOUR TURN and send
the coordinator: "plan audited, ready to implement: PLAN_PATH". Implement only after the coordinator says "go". [rule 16]]

TURN. A FREE lease is not a turn. Two things wait for the coordinator to say it is your turn: opening a PR, and taking the
heavy slot (fleet lease acquire, or lease run); a refused acquire queues you. Pushing your own branch does NOT wait: push
early and often (participant rule 2). If this repo's pre-push hook runs the full gate, that push is heavy work: run it as
`fleet lease run -- git push`, which queues, and never skip the hook. The slot is for LOCAL CPU/IO-heavy work only (full test suite, pre-push
gate, install): API-bound rounds (/audit-code, /audit-plan, the Gemini review) never take it. If `fleet next` says the
repo sets fullSuite: "train", run no full suite at all: targeted and affected tests plus the gates, then `fleet ready`,
and log the deferral in the words it gives (participant rule 4a). Mind the cost window: no new
coding during the hours `node scripts/fleet.mjs lease peak` shows (weekdays unless a range names days; shipping is fine). [rule 14]

CLAIM. Run fleet claim --id CHIP_ID --intent "ONE LINE" --paths "GLOBS" from INSIDE your worktree before editing. If it is
BLOCKED (exit 3), STOP and report which session overlaps: never retry, rename the id or use --override. Claim the paths each
PR really touches when it starts, and release the claim between PRs. Record every finding at once with fleet propose
(what, where, why, evidence), one record each. [rules 10, 13]

PROOF PLAN. Before any code, write ONE line and send it in your first status note: "PROOF PLAN: <what will prove the change
right> / <the evidence the final report will show>". What proves a change: a red test that turns green, a check against the
source (the file, the store row, the log), or a repeatable calculation. "Tests pass" is not a plan if the tests could not have
failed. If the approach changes, restate the line. [rule 17]

STOP POINT. You end at ship-ready: audited, the PR open or the branch pushed, and you say so. If `fleet next` prints a LANDING line (this repo lands by rollup, .fleet.json landing: "rollup"), open NO PR: the branch pushed and `fleet ready` is the end. /ship-checked is a user-only skill:
the user types it in THIS session, and only when the session is idle (mid-turn the host refuses it as a programmatic call
and the user has to type it again). You never invoke it, and no relay can. [rule 4]

[PRE-AUTHORISED SHIP. Include only when the user approved it at launch. Run the ship steps by hand: the status.md entry, the
plan's Implementation Log, node scripts/ship-commit.mjs --preauthorised, the push. First run
node scripts/ship-commit.mjs --check-preauthorised. Ship ONLY if every condition holds: the effective gate is passed or
converged (never waived or not-run, never --no-tests); the audit converged per the store; the final review APPROVED the
audited tree and round with result approve (not approve-with-debt, not blocked); the PR changes no sensitive path (scripts/lib/sensitive-paths.mjs), no database migration and no
repository-policy file (.github/, CODEOWNERS, .test-tiers.json). The commit path re-checks all of it and refuses (exit 2)
otherwise; if any condition refuses, stop and tell the user to type /ship-checked PLAN_PATH in this session. Never hand-write gate
evidence or re-run to find a pass. Say "ship pre-authorised by launch prompt" in the claim intent; the commit then carries
the trailer AI-Ship-Authority: launch-prompt. Order: ship, push the ship head, THEN `fleet ready` (the ready oid is the ship
head, so CI runs on it). Never archive this worktree before your PR is merged: the coordinator's re-check reads its .audit/
markers, and without them you wait for the user's /ship-checked.]

RECORDS. You never run the record catch-up (ship-record.mjs) or write a session-log entry for another PR: the coordinator
owns that for the repo (coordinator-playbook §7). [rule 8]

PHASE LENGTH. One chip covers ONE phase (plan, implement, audit or land). At the phase boundary write a hand-over note (done, head sha,
what remains, decisions, evidence) in the shared notes folder and end your turn: a fresh chip takes the next phase. Past about 300
messages, say so to the coordinator and stop at the next boundary (coordinator-playbook §10).

FINAL REPORT. Per PR: the branch, the PR number, the files you changed, the audit rounds, the red and green evidence against
your PROOF PLAN, whether it shipped itself (with the conditions output), and your Findings.

STATUS WORDS. The same rule holds in every mid-task note, not only the final report: say merged, green, fixed, done or
converged only with the artifact beside it (commit sha, PR number, CI run id or URL, test count). No artifact yet means
"in progress" or "claimed, not yet verified". Start every note to the coordinator with the `stamp:` line a fresh
`fleet next` prints (your head commit and merge state, with the time): it is how a note read later shows it is stale. [rule 17]
```

## Notes for the coordinator

- **Fill ROUTE_CHOICE with one route.** The chip must not choose it (rule 3).
- **Keep the model handoff for `/cycle --autonomous` chips**: the planning turn runs on the strong model and the chip stops
  after `/audit-plan`; you switch its model and reply "go" (rule 16).
- **A pre-authorised ship is a launch-prompt decision.** Include the bracketed block by default ONLY when the user's own
  instructions carry the standing coordinator-ship grant (`references/ship-batch.md`); otherwise leave it out and the chip ends
  at ship-ready as before. The coded check, not the chip's own reading of the list, decides at commit time.
