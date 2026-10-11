# Plan: fleet — catch abandoned worktree work regularly, and remove account-switch friction
- **Date**: 2026-10-11
- **Status**: Draft — BRIEF ONLY. Run `/plan` on it after the account switch, then `/audit-plan`.
- **Author**: Claude + Louis
- **Scope**: backend (fleet CLI + skill prose) · stack `js-ts`
- **Target domain(s)**: `fleet`

> **Who picks this up**: the CEE coordinator in the NEW Claude Code account. It arrives as a fleet
> claim (`claude/fleet-unclaimed-work-plan`, waiting on `human:account switch`) in the handover's
> "Sessions to resume". **Until the switch is done, do nothing but read.** First, check what is in
> place: `scripts/lib/fleet/handover.mjs` (`unregisteredWork`, `claimCommand`), `fleet status`,
> `fleet prune`, `fleet archive-check`, `fleet add`. Then turn this brief into a full plan.

## 1. Why: what the 2026-10-11 account switch exposed

The first real `fleet handover prepare` with unregistered-work detection (PR "prepare lists unregistered
worktree work") flagged 17 worktrees holding work that no claim covered. Checked one by one:
- **5 were superseded**: wine `claude/gpt-6-sol` (#656 merged), wine
  `fix/a11y-badge-opacity-and-touch-target` (#757), a CEE adjudication worktree whose 4 dispositions
  were already on main, a dirty generated `architecture-map.md` in ai-organiser, and a transient
  pre-push sandbox.
- **4 storyline worktrees were superseded** (#289/#294, #291, #191, #234/#235), but confirming each
  took a coordinator round trip.
- **8 CEE Agent-tool worktrees (27 Sep to 3 Oct) held work that never landed.** For example,
  `agent-a17ae…` had a store write-boundary fix with regression tests, and its new
  `scripts/lib/store/column-probes.mjs` is not on main. These were abandoned mid-flight, and nobody
  knew. They are preserved as local tags `archive/worktree-agent-*` (`git tag -l 'archive/*'`).
  **Triaging those 8 tags (land or drop) is its own task: add it to this plan's close-out or spin it
  out.**

Every one of these was found only because an account switch forced a full sweep. That sweep needs to
happen continuously instead.

## 2. Part 1: catch abandoned work regularly

1. **`fleet status` gets an "Unclaimed work" section.** It reuses `unregisteredWork`, moved out of
   `handover.mjs` into a shared module so there is ONE predicate.
   - Each item shows its idle age: the newer of the HEAD commit time and the newest dirty-file mtime.
   - Items idle longer than `staleWorktreeDays` (config, default 3) are marked as possibly abandoned.
     Fresh, unclaimed desktop-session worktrees are normal and must not alarm.
   - Each item is classified as **superseded** (PR merged, or a squash patch-id on base, via the
     existing `merged-facts.mjs` evidence) or **unlanded**. This is the manual check done on
     2026-10-11.
   - Cost: one git status plus one rev-list per uncovered worktree. Measure it on wine (~25 worktrees)
     before deciding whether it needs a budget like `CLEAN_PROBE`.
2. **The checkpoint footer** (on `claim`, `touch` and `ready`) gets one line when the count of
   possibly-abandoned items is non-zero: `N worktree(s) idle >3d hold unclaimed work — fleet status`.
   Cache it, or bound it, so `claim` stays fast.
3. **`fleet archive <worktree|branch> --apply`**: commit any uncommitted state as a WIP commit, tag
   `archive/<branch>`, then remove the worktree. Reuse the `archive-check` verdict. Refuse anything it
   cannot preserve: ignored-only content needs an explicit flag. Report a directory left behind by a
   file lock (seen on a storyline proof-run worktree) as a leftover, not as success.

## 3. Part 2: session-switching friction found on 2026-10-11

| # | Friction | Proposed fix |
|---|---|---|
| a | `fleet add` records `worktree: null`, so adopted branches show no worktree. Handover now resolves it by branch; `status` and `claim` do not. | `add` records the worktree where the branch is checked out |
| b | A coordinator registering work it coordinates had claims bound to ITS worktree, then hand-edited registry records | `claim --worktree <path>` (validated: a worktree of this repo, branch checked out there) |
| c | A coordinator worktree's hydrated tooling was stale, so `release` was missing | fleet compares its own bundle stamp with the main checkout's `scripts/.sync-manifest.json` and warns, naming `npm run skills:hydrate` |
| d | Cross-session messages between sessions in different permission modes were held, then expired undelivered | The coordination prompt and handover doc say to put coordinators in the same permission mode first. Prepare could also list sessions whose mode differs, if the host exposes it |
| e | `gh` could not see storyline's repo (it belongs to a different account), so PR state was unknown | Prepare records per-repo `gh` reachability and lists the account to sign in to as a step for the new account |
| f | Checkpointing coordinators was a hand-pasted message | Mostly solved: prepare now detects unregistered work itself. Optionally, prepare posts a fleet directive to each repo's live sessions |

## 4. Out of scope (for now)

- Moving session transcripts, chips or messages between accounts: impossible by design.
- Auto-removing worktrees: never without `--apply` and a preserved tag.
