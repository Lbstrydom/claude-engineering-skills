---
summary: Coordinating without host messages — next, directives, release, prune, archive, handover, coordinator rules.
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

## Ending a session

- `fleet release [--abandoned]` retires the claim now: the session stops blocking
  claims and leaves the landing order. It never refuses; it prints the
  archive verdict as advice.
- `fleet archive-check [<id|branch|path>]` is read-only. It exits 0 only when
  every probe ran and nothing would be lost. Exit 3 means `AT RISK` (staged or
  unstaged changes, untracked files, gitignored files outside `archiveIgnore`,
  commits no remote holds, including on a detached HEAD) or `UNVERIFIED` (a probe
  failed, or skip-worktree/assume-unchanged files hide edits from git). Run it
  before archiving a worktree: archiving can empty gitignored folders such as
  `.claude/tmp`.
- `fleet prune` is read-only by default. It lists the local branches (and their
  worktrees) that can be removed with nothing lost, with the exact commands, and
  runs none of them. `fleet prune --apply` runs exactly that list, nothing else:
  per branch, under the registry lock, it first re-checks that the branch tip is
  still the judged tip and that no session has registered the branch since, then
  removes the worktree and the branch with git's own refusals intact (never
  `--force`), stopping a branch at its first failure. It exits 1 if any removal
  failed, and a second run finds nothing left. `--apply --remote` also deletes
  the remote branch, leased on the judged tip (a remote that moved is refused,
  one already gone counts as done).
  A branch qualifies only when its tip is already in base (`git branch -d`) or
  merged evidence covers its exact tip (a merged PR head, or a squash that
  postdates the fork: `-D`, since git cannot see squash merges). No registered
  session, no open PR, a readable PR list, and a worktree that passes the
  archive-check evidence (its "unpushed" commits excepted, because their content
  is proven on base). Idle branches, locked worktrees, the main checkout and the
  current worktree are never listed. Nor is a worktree that another worktree's
  hooks directory (as `git rev-parse --git-path hooks` names it there, so
  `config.worktree`, the inherited repo-level value or the default) lies inside
  or passes through via a link: once it is gone git runs no hooks there and says
  nothing. The kept reason names the dependent worktree and the remedy, e.g.
  `git -C <wt> config --worktree core.hooksPath <the main checkout's hooks dir>`
  (never a rewrite of a global or system setting); a config git cannot read
  keeps it too, and `--apply` re-checks under the lock.
  Every kept branch says why. A worktree or
  branch active within `staleWorktreeDays` (default 7) is skipped unless
  `--include-fresh`. `prune` also lists directories under the worktree root that
  git no longer knows (`empty`, `ignored-only`, `holds N files`), printing a
  removal command only for the first two, and shows `upstream gone` as a hint
  (never as a reason to delete). A `review` section lists two classes that are
  never removable, so a person can decide quickly: a branch whose merged PR's
  head is behind its tip (post-merge commits), and a branch no PR covers. Each
  names its files and whether each file's committed content already equals base;
  uncommitted work in its worktree is not part of that comparison, and the line
  says so. Its output ends with the session-list check line:
  before running any printed removal, check the desktop session list (pinned and
  dormant sessions included) for a session whose cwd is that worktree.
- **The prune count reaches you without running prune.** `fleet status` plans a
  prune under a 30 s budget and prints one `prune:` line (removable, fresh,
  review classes, orphan directories). It writes the count to
  `<git-common-dir>/fleet-cache/prune.json`, as does a read-only `fleet prune`.
  `fleet next` reads it and prints an `FYI for the user/coordinator` line: relay
  it, never act on it. A count that could not be measured says `unmeasured`
  with the reason, never 0. A budget-cut count is a lower bound (`≥N`, with how
  many were not judged). A count over 24 h old, or missing, asks for a `status`
  run. `prune --apply`, or a status run that could not plan, replaces the count
  with an unmeasured one, never leaving the old number readable. Bring the list to the user on a cadence;
  removal stays their decision.
- `fleet archive <worktree|branch|id>` is a dry run by default: what it would
  snapshot, and every refusal. `--apply` snapshots the worktree's committed,
  staged, unstaged and untracked state into a local `archive/*` tag, verifies the
  tag holds it, re-checks everything under the registry lock, and only then
  removes the worktree; the branch is left alone. It refuses a live claim, a
  locked worktree, the main checkout, a partially staged or conflicted path, a
  sensitive file, ignored data without `--discard-ignored`, an oversize tree,
  a worktree another worktree's `core.hooksPath` points into (the same check and
  remedy as `prune`, repeated under the lock), and a worktree active within
  `staleWorktreeDays` without `--include-fresh`. It never
  pushes: the tag is local, and `status` reports archive tags as `local-only` or
  `remote`. **`--apply` deletes a worktree, so it runs only on the user's go-ahead**,
  after the session-list check above.
- **Stop the clutter at the source.** Squash merges rewrite commit ids, so every
  ancestry check (`git branch --merged`) misreports, and nothing runs `prune` on
  its own. Two settings by the repo owner remove most of it: GitHub, Settings,
  General, "Automatically delete head branches" (remote branches go on merge), and
  `git config fetch.prune true` (each fetch drops the stale `origin/*` refs). Then
  `fleet prune --apply` clears the LOCAL branches and worktrees those two do not.

## Moving to another Claude Code account (`fleet handover`)

Repos, worktrees, uncommitted files and this registry are on disk, so they carry
over on their own. What stays with the old ACCOUNT is everything under its
config root (`CLAUDE_CONFIG_DIR`, else `~/.claude`):
- the harness memory of EVERY repo (`projects/*/memory`);
- scheduled tasks;
- user settings.

Session transcripts, cross-session messages and task chips cannot move at all.
Put every coordinator session in the same permission mode before posting anything
to it: a host holds a message between sessions whose modes differ.

- **Old account:** `fleet handover prepare` is read-only towards every repo, and
  runs from ANY repo with the bundle. It records:
  - a hash manifest of all memory;
  - every live claim (worktree, branch, uncommitted files, ready, waiting-on)
    with a resume prompt; a claim whose work already landed is listed under
    "merged but not released" with its `release` command instead;
  - **unregistered work**, with the same verdicts `status` prints. Blocking items
    hold work that exists nowhere else, or could not be measured: claim each from
    INSIDE its worktree, push it, or settle it with the user. Prepare exits 3
    while any remain;
  - whether each repo's PR state could be read, naming the account needed when not;
  - open directives and trains, scheduled tasks and settings presence;
  - the account identity, by whitelist only: `oauthAccount`'s account id,
    address and organisation id, and the NAMES of MCP servers (never values;
    nothing else in `.claude.json`, which also holds tokens, is read);
  - folder anomalies (case-duplicate or worktree-slug memory dirs, a missing
    `MEMORY.md`).

  It covers the invoking repo, plus every registered consumer when the source
  repo resolves, plus each `--repo`; an unresolved source is a WARNING, never
  a silent narrower scope. Output goes to `<git-common-dir>/fleet/handover/`
  (a `.json` manifest and a `.md` with the coordination prompt).
- **BEFORE YOU RELAUNCH.** Relaunching the app runs every overdue one-off task at
  once, and one such catch-up run once left a production database read-only for
  about 50 minutes. When scheduled tasks are listed, prepare's text and markdown
  open with this step, done in the OLD account: call `list_scheduled_tasks`; for
  every enabled one-off whose `fireAt` has passed and whose `lastRunAt` is absent
  or earlier than `fireAt`, disable it (`update_scheduled_task`) or re-date it;
  then run prepare again with `--scheduler-checked`. Until then prepare exits 3
  ("not ready: scheduler step unconfirmed"), artefacts written. The CLI cannot
  read the scheduler, so the flag is the operator saying the step was done:
  **passing `--scheduler-checked` without having done it is a violation.**
- **New account:** paste the coordination prompt into ONE session, in any repo.
  It resumes that repo's sessions directly, and starts one coordinator chip per
  OTHER repo with work, inside that repo (spawn_task `cwd`). Each chip gets its
  own repo's section of the handover. Then run
  `fleet handover receive --from <json>`.
  - *Same config root:* it verifies every hash.
  - *Different config root:* it copies missing memory files additively (staged,
    hash-checked, published with a no-clobber hard link, under a lock) and never
    overwrites a differing file; that is a CONFLICT for you to decide.
  - It prints `memory <dir> → <path>` for every memory dir, in the spelling on
    disk: confirm each is where this account reads that repo's memory.
  - It refuses (exit 3) when a newer `handover-*.json` sits beside the given one,
    or when that check cannot run; `--allow-older` receives an older one on purpose.
- **Receive exit codes.** `1`: a memory file could not be decided, copied or
  verified; this outranks everything. `3`: a blocking step remains (a memory
  conflict, blocking unregistered work, memory not measured at prepare, live
  state unknown, the lock held). `0`: received. **Exit 0 may carry
  `followUps`**, printed as "follow-ups (not failures)": scheduled tasks to
  confirm or recreate, settings or MCP-server differences, a repo whose PR state
  cannot be read, an account change, and claims waiting on the switch. They are
  work to do, not failures; `--dry-run` classifies the same way.
- **Scheduled tasks after the switch.** Receive sees task FILES only ("files
  present; scheduler registration not checked here"). Call `list_scheduled_tasks`,
  diff its ids against the handover's list, skip a one-off whose `fireAt` has
  passed (spent), and recreate only what is still wanted. Then report every task
  whose `lastRunAt` is later than the handover's creation time: those fired
  because of the switch.
- **Claims waiting on the switch.** A session parked for the switch uses exactly
  `--waiting-on human:account-switch` (case, spaces, `_` and `-` are folded).
  Receive lists each such claim with a `fleet touch --id <id> --clear-waiting`
  command that re-adds the session's other waits in the same call, so only the
  switch wait goes (the re-added ones restart their `since`); any other `human`
  wait gets a one-line note, so a differently worded one is still shown.
- Unregistered work is RE-PROBED at receive, so claiming or pushing it since
  prepare clears it. Commit WIP in sessions you own before preparing; prepare
  flags uncommitted work, it never commits it.

## Rules for a coordinator

A coordinator is a session that dispatches and supervises others rather than
doing the work. On top of the participant rules:

1. **Write the authority into the chip.** Every chip prompt you spawn carries a
   visible block, for example "Pre-authorised at launch by the user: push the
   branch, open a PR. NOT authorised: merge, override, delete." The user's click
   on the chip is the approval. A message you relay later never is.
2. **Cross-check the session list.** Compare the desktop session list (each
   session's cwd and branch) with `fleet status`, and ask any working session
   with no claim to register. Unclaimed work is invisible to every gate.
3. **Write the route into the launch prompt**, so the chip does not choose it:
   - *direct fix* (about one or two files, no new behaviour or symbol, no plan):
     `/audit-code --scope diff`, then stop at ship-ready;
   - *`/cycle --autonomous`* (new behaviour, several files, or a plan exists or
     is warranted): `/plan` → `/audit-plan` → `/cycle`, then stop at the `/ship`
     handoff;
   - *landing or triage* (branches or commits that already exist): cherry-pick,
     audit, then stop at ship-ready.
4. **A chip ends at ship-ready**: audited, with its PR open or its branch pushed,
   and it says so. `/ship` runs only when the user types it in that session; no
   chip and no relay can run it. Keep the user's list of "type `/ship <plan>` in
   chip X", and merge only after `/ship` ran.
5. **Sync consumers after a GitHub merge.** The pre-push consumer sync fires only
   on a local push of the default branch. After a PR merges on GitHub, run the
   source repo's consumer sync and its sync-PR step for the affected consumers,
   or remind the user to.
6. **Repo-prefixed session titles.** Title every session and chip
   `<REPO>: <short task>`, with a PR number where one exists. Pick one short
   prefix per repo and use it every time (e.g. `CES` for
   claude-engineering-skills). Put the prefix in every `spawn_task` title, rename
   an unprefixed session with `set_session_title`, and ask each other repo's
   coordinator to follow the same convention. Why: with several repos' sessions
   in one sidebar, unprefixed titles made it impossible to tell which repo a
   session belonged to. The app generates worktree directory names, so the
   title is the only place the prefix can go.
7. **Archive sweep on every coordination pass.** Archive a desktop session (the
   host's archive, which is reversible) when ALL of these hold: it is idle, its
   PR is merged or closed (or its question is answered), its worktree is gone
   or `archive-check` exits 0, and it is not pinned. This is not removing a
   worktree, which stays the user's decision (see `fleet archive` above).
   Measured 2026-10-12: the first sweep found 16 sessions idle since August
   whose worktrees were already gone; nothing had swept them, because sessions
   were archived only when a PR merged. Where the host offers a setting to
   archive a session when its PR closes, it is the automatic complement.
8. **Push lanes.** Every `/ship` appends to the shared status log, so pushes
   that touch it go one at a time (the status lane): give one session the slot
   ("your turn"), wait for its push to land, then hand the slot on. Test-,
   docs- and config-only PRs run in a separate ride-along lane. A
   work-in-progress push that adds no status-log entry needs no slot
   (participant step 2), unless the launch prompt holds that session's pushes
   for one, which then overrides step 2 for it. A branch already
   on the remote merges the base in (a rebase needs a force-push, which the
   status-integrity gate refuses); a branch never pushed may rebase. Merge as
   soon as CI is green, pinned with `--match-head-commit <head>` (as
   `references/landing.md` does). Do not use `gh pr merge --auto` on a repo
   with no required checks: it merges at once, before CI finishes (observed
   2026-10, #202). When path-filtered CI does not run, the local pre-push gate
   is the evidence. Once any push may take the branch test tier
   (`AUDIT_PREPUSH_TIER=branch`), merge only a sha whose output carries a
   `test-tier/v1 full <sha>` line: push the candidate with
   `AUDIT_PREPUSH_TIER=full`, or verify it without a push with
   `node scripts/prepush-check.mjs --tier full --head <sha> --base <merge-base>`
   (Source-repo-gated: that script is this repo's own gate, so a consumer
   uses the push form),
   then merge pinned to that sha. A `branch` line, or `tier NOT reported`, is
   not that verdict.
9. **Confirm idle, not "told".** A message to a session that is mid-turn is
   queued; it cannot stop what that session is doing. Before a quiet window
   (e.g. handing the machine to another repo's coordinator), stop handing out
   turns early and confirm each session reports not running (`isRunning: false`
   in the session list). A sent hold message is not compliance.
10. **Queue findings, not sessions.** A chip is admission for ready work, not a
    record of every finding. Workers never spawn chips (participant step 9);
    they report findings, and each one is written down at once with
    `fleet propose --what --where --why [--evidence] [--theme] [--blocked-by]`
    (a worker may record its own adjacent finding the same way). The record
    lives in the git common dir, so it outlives the session, its worktree and
    its archive; it replaces any private list a coordinator kept in memory.
    Each finding then gets exactly one outcome, set with
    `fleet proposal <id> <flag>` and a required reason or ref, and the history
    only grows:
    - **folded** (`--folded <session>`): into a named running session, only
      when that session's current PR's acceptance needs it;
    - **queued** (`--queued <reason>`): grouped under a theme, waiting for a
      worker slot or a dependency;
    - **declined** (`--declined <reason>`): with the reason written down;
    - **done** (`--done <PR>`): with the PR that resolved it.

    Show `fleet proposals` (the open queue, grouped by theme) to the user at
    every check-in. `fleet status` and `fleet next` print how many proposals
    are pending and how old the oldest is, and flag any pending more than 3
    days; an unreadable store reads `unmeasured`, not zero. `--blocked-by`
    records a PR or branch the item waits on; the listing rechecks it against
    the PR and git state and labels it, and nothing is scheduled from it.
    Before archiving a session, `archive-check` lists the proposals that
    session recorded and nobody has triaged yet, and its final report's
    Findings should all be recorded.
11. **Triage continuously, with an expedite lane.** New findings arrive at any
    time; decide them on every coordination pass, not in batches. Order the
    queue by impact, then by whether its dependencies are ready. Expedite an
    item straight to a chip or a fold when it is a broken default branch, data
    loss, a security exposure, or something blocking a running session.
    Everything else waits in the queue, visible and costing nothing.
12. **Work-in-progress limits, not volume caps.** Run at most **4 worker
    sessions machine-wide and 2 per repo**; coordinators do not count. There
    is no cap on how much work flows through. Blocked work holds no session:
    it stays queued with what it waits on, and gets a chip only when that
    lands. Measured 2026-10-12/13: about 4 full gates an hour fitted
    machine-wide, so more workers only added waiting.
13. **Theme sessions ship sequential PRs.** Batch related queued items into one
    theme chip that ships them as consecutive PRs, so setup, planning and the
    plan audit are paid once. A running theme absorbs a ready in-theme finding
    as its next PR instead of a new chip. Default length is about 3 PRs or one
    working day: extend it while the theme is still one coherent outcome, say
    so, and close it early if it drifts. Release the claim between PRs.
14. **One heavy job at a time on a shared machine.** When several repos' work
    or CI share one machine, run at most one full gate or full test suite at a
    time (a "gate slot"), and no installs or disk-heavy maintenance alongside
    another repo's announced timing or CI window. Measured 2026-10-12/13: two
    parallel gates plus maintenance pushed another repo's CI past its time cap
    twice. The slot is recorded, not only agreed: `fleet lease acquire|attach|release|status` keeps one file for the
    whole machine (the heavy slot with its holder, repo, pid and expiry; the quiet and CI windows each repo announces
    with `lease announce`; the peak-cost hours with `lease peak`), and `fleet next` shows it. An expired lease is not
    proof its job stopped: a takeover needs a recorded pid that is dead on this machine, and anything unverifiable is
    forced only by a person (`lease release --force --reason`, never on a live lease). The file lives in
    `~/.claude-fleet` unless `FLEET_MACHINE_DIR` says otherwise; set that variable to one shared path when two OS
    users, or WSL beside Windows, run the same machine's work. It is cooperative like the rest of fleet: it answers
    "is the slot free", while you still decide who goes next (`hold` and directives outrank it).
15. **Mind the message budget.** A host may pause a coordinator's outbound
    session messages after a burst (observed: 10 per user turn). Batch messages
    to the same session, skip acknowledgements that change nothing, and keep
    sends in reserve for time-critical ones (all clear, gate slot, hold). The lease (rule 14) replaces most slot
    relays: a session reads it instead of asking you.

### Optional: a title reminder hook (Claude Code only)

A repo can remind new sessions to title themselves with a project-level
`SessionStart` hook in its committed `.claude/settings.json`, matcher
`startup|clear`. The hook prints JSON whose `hookSpecificOutput.additionalContext`
says "this session's title must start with `<PREFIX>: `; set it with
`set_session_title`". Make it fail-open: on any error it prints nothing and
exits 0. It is opt-in per repo, and it is Claude-Code-only acceleration, not
cross-agent enforcement; other hosts rely on rule 6 and the participant block.
Do not install it machine-wide in `~/.claude`: skills install repo-scoped, and
one prefix cannot be right for every repo on the machine.

## Permission prompts

Add a project allow rule for fleet's own CLI so sessions do not stall on it:
`Bash(node scripts/.claude-skills/fleet.mjs:*)` (a consumer path; in the source
repo, `scripts/fleet.mjs`). It names no personal folder, so it is safe to commit.
Message delivery across differing permission modes stays host behaviour.
