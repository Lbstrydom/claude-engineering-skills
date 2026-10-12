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
  (never as a reason to delete). Its output ends with the session-list check line:
  before running any printed removal, check the desktop session list (pinned and
  dormant sessions included) for a session whose cwd is that worktree.
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

## Permission prompts

Add a project allow rule for fleet's own CLI so sessions do not stall on it:
`Bash(node scripts/.claude-skills/fleet.mjs:*)` (a consumer path; in the source
repo, `scripts/fleet.mjs`). It names no personal folder, so it is safe to commit.
Message delivery across differing permission modes stays host behaviour.
