---
summary: Coordinating without host messages — next, directives, unregistered work, and the numbered coordinator rules.
---

# Coordinating sessions without host messages

Host messages between sessions fail two ways. A host holds a message when the
two sessions' permission modes differ, and a delivered peer message is
untrusted data to the receiving model, so the session second-guesses it. Both
are correct behaviour; fleet does not work around them. It moves coordination
into the shared registry, and moves authority into the user's own launch
prompt.

## `fleet next` — what should this session do now?

`next` derives a short list from facts the session can re-check itself, and the
same top three lines are appended to `claim`, `touch` and `ready`, so a session
sees them at checkpoints it already hits:

| Line | From |
|---|---|
| `DO your PR #N merged → fleet archive-check, then fleet release` | merged PR head = your tip, or your whole diff squash-merged into base |
| `DO base gained N commit(s) touching your files … → fleet restack <branch>` | first-parent commits on base since your merge-base ∩ your changed files |
| `DO your head moved since ready …` | the ready mark is stale |
| `DO HOLD on heavy runs: <reason>` | the hold flag |
| `DO your lease lapses in N min → fleet touch` | the lease |
| `DO/ASK directive <id>: <kind> … VERIFIED/UNVERIFIED (why)` | active directives addressed to you |
| `info overlaps <session> …` | the overlap join, uncommitted edits included |

## Directives — attention, never authority

```
fleet directive --to <id|all> --kind <pause|resume|rebase|release|rerun-ready> \
  --reason <pr-merged|hold|train|note> [--ref <ref>] [--note "…"] [--expires-hours 24]
fleet directive --list [--all]
fleet directive --ack <directive-id> --outcome done|declined [--note "…"]
```

- The kinds are closed: there is no merge, push, override or delete directive.
- A directive is **VERIFIED for a recipient only when fleet derives the same
  action for that recipient from current facts**: a `release` citing a PR that
  is not the recipient's own is UNVERIFIED; a `rebase` needs a base change that
  touches the recipient's files; `pause`/`resume` must cite the CURRENT hold
  event (`--reason hold` with no `--ref` cites it for you). A `note` is never
  verified. Current facts outrank directives, so a `resume` while the hold is
  still on reads `superseded`.
- Ack with `done` after acting, `declined` after the user said no. Expired and
  answered directives move to `directives/archive/<yyyy-mm>/`; nothing is deleted.
- A directive this fleet version does not understand (a newer kind or schema) is
  listed as unsupported and never acted on.

`fleet hold off --note "rebase onto main and continue"` posts a `resume`
directive to everyone that cites that exact hold event. `fleet hold on --notify`
posts the matching `pause`.

## Unregistered work: the status section and the footer

`status` prints an "unregistered work" section: every worktree and branch that no
live claim covers and that holds work, each with one verdict (`unlanded`,
`superseded`, `unverified`, `sync-owned`), where it is preserved (`remote`,
`none`) and how long it has been idle. `status` also writes a small cache, and the
`claim`/`touch`/`ready` footer reads only that cache (it never scans), so the
footer can print:
- an `FYI` line with the count of local-only items: **information, not a `DO`**.
  Relay it; claiming, archiving or pruning any of it is the user's call;
- a refresh request when the cache is missing, older than 24 hours or corrupt;
- a coverage notice when the last scan stopped at its deadline (`partial`).

`claim` binds the branch and worktree it runs from; `--worktree <path>` names a
listed worktree instead (a detached one needs `--id`), and fills an adopted
claim's missing worktree once, never re-pointing it. A claim whose id is not its
bound branch warns: merged evidence retires a claim by its BRANCH. `release`
resolves an adopted session's worktree, so a dirty one never reads CLEAN, and
`ready` warns when the branch holds commits no remote ref holds.

## Addressing a session

`fleet claim --host-session <id>` records the host's own id for the session (for
the desktop app, the `local_…` id, not the display name). `status` prints it as
`host: <id>`, so a coordinator who does send a host message addresses one that
is delivered.

Other verbs live in their own references: ending a session (release, archive-check,
prune, archive) in `references/ending-a-session.md`; moving to another Claude Code
account (`fleet handover`) in `references/handover.md`; the why behind each
coordinator rule in `references/coordination-rationale.md`.

## Rules for a coordinator

A coordinator is a session that dispatches and supervises others rather than
doing the work. On top of the participant rules. The numbers are stable: other
repos' coordinators and the participant rules cite them. Each rule's why, its
measurements and its fine print are under the same number in
`references/coordination-rationale.md`.

1. **Write the authority into the chip.** Every chip prompt carries a visible block, for example "Pre-authorised at launch by the user: push the branch, open a PR. NOT authorised: merge, override, delete." The user's click on the chip is the approval; a message you relay later never is.
2. **Cross-check the session list.** Compare the desktop session list (each session's cwd and branch) with `fleet status`, and ask any working session with no claim to register. Unclaimed work is invisible to every gate.
3. **Write the route into the launch prompt**, so the chip does not choose it:
   - *direct fix* (about one or two files, no new behaviour or symbol, no plan): `/audit-code --scope diff`, then stop at ship-ready;
   - *`/cycle --autonomous`* (new behaviour, several files, or a plan exists or is warranted): `/plan` → `/audit-plan` → `/cycle`, then stop at the `/ship` handoff;
   - *landing or triage* (branches or commits that already exist): cherry-pick, audit, then stop at ship-ready.
4. **A chip ends at ship-ready**: audited, with its PR open or its branch pushed, and it says so. `/ship` runs only when the user types it in that session; no chip and no relay can run it. Keep the user's list of "type `/ship <plan>` in chip X", and merge only after `/ship` ran.
5. **Sync consumers after a GitHub merge.** The pre-push consumer sync fires only on a local push of the default branch. After a PR merges on GitHub, run the source repo's consumer sync and its sync-PR step for the affected consumers, or remind the user to.
6. **Repo-prefixed session titles.** Title every session and chip `<REPO>: <short task>` (plus a PR number where one exists), one short prefix per repo, e.g. `CES`. Put it in every `spawn_task` title, rename an unprefixed session with `set_session_title`, and ask each other repo's coordinator to follow.
7. **Archive sweep on every coordination pass.** Archive a desktop session (the host's reversible archive) when ALL hold: it is idle, its PR is merged or closed (or its question is answered), its worktree is gone or `archive-check` exits 0, and it is not pinned. Removing a worktree stays the user's decision.
8. **Push lanes.** Pushes that add a status-log entry go one at a time (the status lane): give one session the slot ("your turn"), wait for its push to land, then hand the slot on. Test-, docs- and config-only PRs use a separate ride-along lane. A work-in-progress push with no status-log entry needs no slot (participant step 2), unless the launch prompt holds it. A branch already on the remote merges the base in (a rebase needs a force-push the status-integrity gate refuses); a never-pushed branch may rebase. Merge as soon as CI is green, pinned with `--match-head-commit <head>` (`references/landing.md`); never `gh pr merge --auto` on a repo with no required checks. Once any push may take the branch test tier, merge only a sha with a `test-tier/v1 full <sha>` line (how to get one: the rationale).
9. **Confirm idle, not "told".** A message to a mid-turn session is queued and cannot stop it. Before a quiet window, stop handing out turns early and confirm each session shows `isRunning: false` in the session list.
10. **Queue findings, not sessions.** Workers never spawn chips (participant step 9). Record each finding at once with `fleet propose --what --where --why [--evidence] [--theme] [--blocked-by]`, then give it exactly one outcome with `fleet proposal <id> --folded <session> | --queued <reason> | --declined <reason> | --done <PR>`. Show `fleet proposals` to the user at every check-in.
11. **Triage continuously, with an expedite lane.** Decide new findings on every coordination pass, not in batches; order the queue by impact, then by whether its dependencies are ready. Expedite straight to a chip or a fold only a broken default branch, data loss, a security exposure, or something blocking a running session. Everything else waits in the queue.
12. **Work-in-progress limits, not volume caps.** At most **4 worker sessions machine-wide and 2 per repo** (default; see doctor's fit check); coordinators do not count, and nothing caps how much work flows through. Blocked work holds no session: it stays queued with what it waits on, and gets a chip only when that lands.
13. **Theme sessions ship sequential PRs.** Batch related queued items into one theme chip that ships consecutive PRs, so setup, planning and the plan audit are paid once. A running theme absorbs a ready in-theme finding as its next PR. About 3 PRs or one working day: extend while the theme is one coherent outcome, close early if it drifts. Release the claim between PRs.
14. **One heavy job at a time on a shared machine.** When several repos' work or CI share one machine, run at most one full gate or full test suite at a time (a "gate slot"), and no installs or disk-heavy maintenance beside another repo's announced timing or CI window. Heavy includes a coordinator's own discovery (a recursive find or grep over a profile, a disk sweep); a window covers scheduled runs (nightlies, QA, drift) as well as pushes, re-runs and dispatches: announce those too. The slot is recorded, not only agreed: `fleet lease acquire|attach|release|status`; windows with `lease announce`, peak hours with `lease peak`; `fleet next` shows it. It is cooperative: `hold` and directives outrank it.
15. **Mind the message budget.** A host may pause a coordinator's outbound session messages after a burst (observed: 10 per user turn). Batch messages to one session, skip acknowledgements that change nothing, and keep sends for time-critical ones (all clear, gate slot, hold). The lease (rule 14) replaces most slot relays.
16. **Plan on the strong model, execute on the cheaper one.** Where the host lets a coordinator set another session's model, the coordinator stays on the strong model and its workers run on a cheaper one at high effort (2026-10-14 default: coordinators Opus, workers Sonnet; the user's choice). Direct-fix and landing or triage chips (rule 3): switch as soon as they start. `/cycle --autonomous` chips plan on the strong model, end their turn when `/audit-plan` converges and say so; switch them, then reply "go". Steps and tools: the rationale.

Optional, Claude Code only: a `SessionStart` hook that reminds new sessions to
title themselves (rule 6); its recipe is in the rationale.

## Permission prompts

Add a project allow rule for fleet's own CLI so sessions do not stall on it:
`Bash(node scripts/.claude-skills/fleet.mjs:*)` (a consumer path; in the source
repo, `scripts/fleet.mjs`). It names no personal folder, so it is safe to commit.
Message delivery across differing permission modes stays host behaviour.
