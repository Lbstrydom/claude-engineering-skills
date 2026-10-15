---
summary: Why each coordinator rule exists, with the measurements, incidents and command detail the terse rules omit.
---

# Coordinator rules — rationale and detail

`references/coordination.md` ("Rules for a coordinator") lists rules 1–16 as terse
actions. This file keeps each rule's number and adds what did not fit a line: why it
exists, what was measured, and the exact commands. Rules 1–5 are fully stated in the
list and carry nothing further.

## Rules 1 and 4 — the chip prompt and where a chip stops

Chip prompts each re-wrote ~40 lines of authority, route, turn and stop point; the one that omitted the turn rule let a worker take
another repo's turn (2026-10-14). `references/chip-preamble.md` is that block once. `/ship` is typed only when the chip is idle:
mid-turn the host refuses it as a programmatic call and Louis had to type it again (#250).

**A pre-authorised ship is a coded check, not a chip's reading of a list.** `ship-commit.mjs --preauthorised` refuses (exit 2, every
refused condition named) unless: the effective gate is `passed`/`converged` (`--no-tests` is refused outright, it caps the gate);
the store's audit run converged and its evidence is for THIS branch; the final review APPROVED this audited tree and round
(`.audit/last-final-review.json`: `gemini_verdict` is one column per run with no target, so it cannot tell tree A's approval from
tree B's). `gemini-review.mjs` does not write that marker yet (its file is under another chip's PR); until the follow-up lands this
condition always refuses and a pre-authorised ship hands back to `/ship`; and the branch (merge base to the commit's tree, `--no-renames`) touches no sensitive path,
no `migrations/` directory and no policy file (`.github/`, `CODEOWNERS`, `docs/CODEOWNERS`, `.test-tiers.json`). Unknown facts refuse; an
empty change set refuses. The commit carries `AI-Ship-Authority: launch-prompt`. `--check-preauthorised` is the read-only early look.

## Rule 6 — Repo-prefixed session titles

With several repos' sessions in one sidebar, unprefixed titles made it impossible to
tell which repo a session belonged to. The app generates worktree directory names, so
the title is the only place the prefix can go.

**Optional: a title reminder hook (Claude Code only).** A repo can remind new
sessions to title themselves with a project-level `SessionStart` hook in its
committed `.claude/settings.json`, matcher `startup|clear`. The hook prints JSON whose
`hookSpecificOutput.additionalContext` says "this session's title must start with
`<PREFIX>: `; set it with `set_session_title`". Make it fail-open: on any error it
prints nothing and exits 0. It is opt-in per repo, and it is Claude-Code-only
acceleration, not cross-agent enforcement; other hosts rely on rule 6 and the
participant block. Do not install it machine-wide in `~/.claude`: skills install
repo-scoped, and one prefix cannot be right for every repo on the machine.

## Rule 7 — Archive sweep on every coordination pass

This is not removing a worktree, which stays the user's decision (see `fleet archive`
in `references/ending-a-session.md`). Measured 2026-10-12: the first sweep found 16
sessions idle since August whose worktrees were already gone; nothing had swept them,
because sessions were archived only when a PR merged. Where the host offers a setting
to archive a session when its PR closes, it is the automatic complement.

## Rule 8 — Push lanes

Every `/ship` appends to the shared status log, which is why pushes that touch it
need one slot at a time. Do not use `gh pr merge --auto` on a repo with no required
checks: it merges at once, before CI finishes (observed 2026-10, #202). When
path-filtered CI does not run, the local pre-push gate is the evidence.

**Getting a `test-tier/v1 full <sha>` line.** Once any push may take the branch test
tier (`AUDIT_PREPUSH_TIER=branch`), merge only a sha whose output carries that line.
Either push the candidate with `AUDIT_PREPUSH_TIER=full`, or verify it without a push
with `node scripts/prepush-check.mjs --tier full --head <sha> --base <merge-base>`
(Source-repo-gated: that script is this repo's own gate, so a consumer uses the push
form). Then merge pinned to that sha. A `branch` line, or `tier NOT reported`, is not
that verdict.

**The CI verdict (repos whose `.test-tiers.json` declares `ciVerdict`).** Such a repo
runs its full suite in GitHub Actions (CES: `full-suite.yml`, `ubuntu-latest`), and its
local push is the light branch tier by default. The verdict is then read, not produced:
`node scripts/test-tier.mjs ci-verdict --pr <n>` prints `test-tier/v1 full <sha> ... reason=ci:<run>`
(Source-repo-gated: a consumer has neither the CLI nor a `ciVerdict`.) It prints the line only when the trusted workflow succeeded on exactly that PR head, for that PR, into the
default branch. Exit 3 is "not yet": `pending` waits; `unverified` (no run, a run for
another PR or base, a PR that edits the workflow, `gh` or the network down) is **not** a
verdict and never reads as green. Exit 4 is `failed`. Merge pinned with
`--match-head-commit <sha>`; if the reader printed a stale-base note, the PR was tested
against an older base (accepted risk, plan §2.3). The CI job runs the test suite only; the
static gates stay in the local gate, in both tiers. **Two modes:** with the required-check
ruleset on, a local verdict cannot substitute for the check, so on `unverified` wait (only
the user may disable the ruleset); without it, fall back to the local full tier above. A PR
that edits the workflow needs its own green run AND a local full verdict. Consumers declare
no `ciVerdict`, so their recipe is the push form above, unchanged.

## Rule 9 — Confirm idle, not "told"

A message to a session that is mid-turn is queued; it cannot stop what that session is
doing. Before a quiet window (for example handing the machine to another repo's
coordinator), stop handing out turns early and confirm each session reports not
running. A sent hold message is not compliance.

## Rule 10 — Queue findings, not sessions

A chip is admission for ready work, not a record of every finding. A worker may record
its own adjacent finding the same way. The record lives in the git common dir, so it
outlives the session, its worktree and its archive; it replaces any private list a
coordinator kept in memory. The history only grows, and each outcome needs a reason or
ref:
- **folded** (`--folded <session>`): into a named running session, only when that
  session's current PR's acceptance needs it;
- **queued** (`--queued <reason>`): grouped under a theme, waiting for a worker slot
  or a dependency;
- **declined** (`--declined <reason>`): with the reason written down;
- **done** (`--done <PR>`): with the PR that resolved it.

`fleet proposals` is the open queue, grouped by theme. `fleet status` and `fleet next`
print how many proposals are pending and how old the oldest is, and flag any pending
more than 3 days; an unreadable store reads `unmeasured`, not zero. `--blocked-by`
records a PR or branch the item waits on; the listing rechecks it against the PR and
git state and labels it, and nothing is scheduled from it. Before archiving a session,
`archive-check` lists the proposals that session recorded and nobody has triaged yet,
and its final report's Findings should all be recorded.

## Rule 12 — Work-in-progress limits

Measured 2026-10-12/13: about 4 full gates an hour fitted machine-wide, so more
workers only added waiting. The 4 assumes a ~15-minute local gate; `doctor`'s `operating/wip-limit` re-derives it from
this machine's measured suite run.

## Rule 13 — Theme sessions

Batching related items into one theme chip pays setup, planning and the plan audit
once instead of per item.

## Rule 14 — One heavy job at a time

Measured 2026-10-12/13: two parallel gates plus maintenance pushed another repo's CI
past its time cap twice. On 2026-10-14 a profile-wide find ran during a nightly that
had not been announced in the lease, which is why discovery and scheduled runs are
named in the rule.

**The lease file.** `fleet lease acquire|attach|release|status` keeps one file for the
whole machine: the heavy slot with its holder, repo, pid and expiry; the quiet and CI
windows each repo announces with `lease announce`; and the peak-cost hours with
`lease peak`. `fleet next` shows it. An expired lease is not proof its job stopped: a
takeover needs a recorded pid that is dead on this machine, and anything unverifiable
is forced only by a person (`lease release --force --reason`, never on a live lease).
The file lives in `~/.claude-fleet` unless `FLEET_MACHINE_DIR` says otherwise; set that
variable to one shared path when two OS users, or WSL beside Windows, run the same
machine's work. It is cooperative like the rest of fleet: it answers "is the slot
free", while you still decide who goes next (`hold` and directives outrank it).

**Turns when several repos wait (the user's policy, 2026-10-14).** First-come is
right only when nobody else is waiting. Measured that day: one repo's back-to-back
CI windows held the machine for most of 05:57-10:50Z while another repo's pushes
waited one to two hours each, and gaps were negotiated by message four times. So
when two or more repos wait, they take turns:
- A turn is up to about 60 minutes of heavy time. The repo batches as many of its
  ready jobs as fit and never cuts a job mid-run.
- The repo that has waited longest goes next. A repo's waiting clock restarts when
  its turn ends.
- A repo's own CI windows and scheduled runs count as its heavy time.
- A worker acquires when the lease says it may, and a FREE lease is not a turn: a
  refused `acquire` queues the repo, and `acquire` refuses a repo whose turn it is not
  (`turn`, naming who goes first). The lease records the order itself (`lease wait`,
  the queue head, the turn, a 10-minute between-jobs gap, `release --end-turn`);
  coordinators still decide what each repo runs. A repo grants another a slot inside
  its own window with `lease grant`, so its window no longer refuses the grantee.
  Detail: `references/lease.md`. Scripts take the slot with `lease run -- <cmd>`, not a hand-rolled acquire/release.
- 60 minutes is a default measured on one machine (`lease turn --minutes`). Doctor's
  fit check recommends a value per machine.

**Peak hours.** `lease peak --hours "14:00-20:00"` records the user's
expensive-token window. During it, ship built work only (pushes, `/ship`, merges,
CI); new planning, coding and chips wait until after.

## Rule 15 — Message budget

Observed: a host paused a coordinator's outbound messages after 10 in one user turn.
The lease (rule 14) replaces most slot relays: a session reads it instead of asking
you.

## Rule 16 — Plan on the strong model, execute on the cheaper one

A session usually cannot switch its own model, so the coordinator does it, and the
change applies from that session's next turn:
- *direct fix* and *landing or triage* routes (rule 3): switch the chip as soon as it
  starts;
- *`/cycle --autonomous`* routes: the chip plans on the strong model. Its launch
  prompt says "after `/audit-plan` converges, end your turn and tell the coordinator
  the plan is audited". Switch it, then reply "go", so the implementation starts in a
  fresh turn on the cheaper model.

The external auditors are unchanged, so a cheaper worker does not weaken the review.
In Claude Code, the "user started your suggested task" notice is the trigger: find the
chip with `list_sessions`, then use `set_session_model` and `set_session_effort`. A
switch to a cheaper model, on a chip you started, needs no prompt.
