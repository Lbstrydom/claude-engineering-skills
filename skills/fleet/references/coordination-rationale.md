---
summary: Why each coordinator rule exists, with the measurements, incidents and command detail the terse rules omit.
---

# Coordinator rules — rationale and detail

`references/coordination.md` ("Rules for a coordinator") lists rules 1–16 as terse
actions. This file keeps each rule's number and adds what did not fit a line: why it
exists, what was measured, and the exact commands. Rules 1–5 are fully stated in the
list and carry nothing further.

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
workers only added waiting.

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
