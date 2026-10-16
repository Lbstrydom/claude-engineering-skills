---
summary: Moving to another Claude Code account — handover prepare and receive, the scheduler step, exit codes, follow-ups.
---

# Moving to another Claude Code account (`fleet handover`)

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
- **Tasks travel in full.** Prepare copies each task's `SKILL.md` into
  `<git-common-dir>/fleet/handover/handover-<id>-tasks/` with the sha256 of the
  bytes written, and receive re-hashes the copies. The cron, `fireAt`, `enabled`
  and `lastRunAt` are not on disk: save the `list_scheduled_tasks` answer (JSON)
  to a file and pass `--scheduler-snapshot <file>`. A malformed snapshot, a
  duplicate id, or an id with no task on disk fails prepare, and so does a task
  that cannot be copied; nothing is published. Without the snapshot each task
  says `schedule: unknown (no --scheduler-snapshot)`.
- **Recorded at prepare:** the machine lease (holder, waiters, windows, turn, or
  why it could not be read), and a memory-backup reminder: your own command when
  `FLEET_MEMORY_BACKUP_CMD` is set, else a generic line. Memory is never copied
  into a repo.
- **New account, first:** the prompt opens with a fixed order: the CI queue
  (`gh run list` in progress and queued, `fleet lease status`), then a lease
  window for anything running, and only then discovery. Session ids die with the
  account, so peers are named by title (`<REPO>: Coordinator`) and resolved with
  `list_sessions`.
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
  Receive lists each such claim with a `fleet touch --id <id> --unwait human:<ref>`
  command that drops exactly the switch wait inside the registry transaction (no
  snapshot of the others, so a wait added since cannot be lost); any other `human`
  wait gets a one-line note, so a differently worded one is still shown.
- Unregistered work is RE-PROBED at receive, so claiming or pushing it since
  prepare clears it. Commit WIP in sessions you own before preparing; prepare
  flags uncommitted work, it never commits it.
