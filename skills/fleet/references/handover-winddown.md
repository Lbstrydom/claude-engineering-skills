---
summary: Wind-down before handover prepare — the directive, measured readiness, context file and safe-to-archive list.
---

# Winding down before an account switch (`fleet handover winddown`)

Run BEFORE `handover prepare`, by the departing coordinator, from any repo with the bundle. It is read-only towards repos
(its one write is a context skeleton where none exists) and can be re-run: it is also the progress check. Exit 0 only when every
repo is READY; 3 when not.

It prints, per repo that needs a coordinator:

1. **The standard directive** — one text to paste into that repo's coordinator (one cross-session message each, inside the
   10-per-turn cap). It says: finish approved merges and start no new work; push WIP and claim unclaimed worktrees from INSIDE them;
   park every live claim with `touch --id <id> --waiting-on human:account-switch`; file each pending New-task card as a proposal
   (cards die with the account; the command depends on whether that repo's fleet has `propose`, and a repo without it files into the
   source repo's queue); fill in the context file; reply with ONE line. **Readiness is measured by the next run, never taken from
   the reply.**
2. **Readiness**, measured. R1: the context file is complete for THIS switch. R2: every live claim is parked on the switch, over a
   MEASURED live state (an unreadable registry is not "nothing unparked"). R3 (a registered consumer only): its bundle is current. Plus
   the blockers prepare already refuses on (blocking unregistered work, state that was not measured), read from the same facts.
3. **Safe to archive before the switch**, and the guard for doing it (below).
4. **Consumer bundles behind.** R3 asks the sync itself — `sync-to-repos --dry-run --target <name>`, run from the source repo's MAIN
   checkout (a stale linked worktree's sync can roll a consumer back) — and reads its `Would create: N  update: N` line. It does not
   run the sync (that opens a PR whose push runs the consumer's heavy hook; each consumer's coordinator takes a slot and merges
   its own PR): it prints `node scripts/sync-to-repos.mjs --target <name>` then `node scripts/sync-pr.mjs --target <name> --no-merge` (both run in the source repo). An unreadable answer is
   `unknown`, which is not current.
5. **Spent one-off scheduled tasks**, with `--scheduler-snapshot <file>` (the `list_scheduled_tasks` answer): one-offs past their time
   that ran or are disabled. Retire them in the scheduler (`delete_scheduled_task`, or `update_scheduled_task` to disable) so receive
   does not ask a human to confirm their files. Informational: the CLI cannot delete host schedules or verify a deletion. A one-off
   past its time that never ran is not spent: it fires at relaunch, and BEFORE YOU RELAUNCH covers it. Without a snapshot it says so.

## The context file

`<git-common-dir>/fleet/handover/context.md`, one per repo, written by the departing coordinator (never tracked). Required `##`
sections: Peer handovers · Waiting on the user · Decided this stint (do not re-ask) · In flight (repo state) · CI state at the switch ·
Leftovers on disk (do not lose) · In-session timers · Pending cards filed as proposals · Working-style notes. **Names, never key
values.** `none` is a valid body; an untouched placeholder, an empty body or a comment-only body is not. Over 64 KiB is refused.

- **Prepare embeds it** in the handover markdown, per repo, and in the manifest. **Receive prints it FIRST**, before the memory
  lines, so nothing already decided is re-asked. A repo whose context is absent says so; chat-only context did not travel.
- **One context per switch.** A context already handed over AND received, and unchanged since, is stale for the next switch: edit it
  (any change is the deliberate act). Receive records `handover-<id>.received.json` beside the manifest; a dry run records nothing.
- **Prepare refuses (exit 3) until R1 and R2 hold** (D1), artefacts written, naming each repo and what is missing. The override is
  `--winddown-waived "<reason>"`: the reason is recorded in the manifest and printed in the handover, so an emergency prepare at 2% of
  credits is one flag away and never silent. R3 is the winddown command's own (it runs the sync dry run, which prepare does not repeat).

## Archiving on the departing account IS allowed (D2) — only from the safe list, only after the guard

A worktree is on the **safe** list when no live claim covers it, it is not the main checkout, it is unlocked, it holds nothing the
scan lists (or only commits already LANDED), and **no other worktree is nested inside it** (`archive_session` left a worktree on disk
because one was; `nested worktree: <path>` says so). **Held remotely** worktrees are clean but not on base: removable without loss,
but confirm with the user. A scan that did not reach everything lists nothing as safe.

The desktop app places NEW sessions in OLD sessions' worktrees, and `archive_session` removes the worktree and cascades to the
session's finished side sessions, so a worktree that is safe by every git measure can still be another session's live checkout. The
CLI cannot see host sessions; before EACH `archive_session` (the printed guard):

1. `get_session` on the candidate, then `list_sessions` (paged): collect every non-archived session whose `worktreePath` equals it
   (case-insensitive on win32). Also collect its side sessions and any session sharing THEIR worktrees.
2. Another live session there, or an unfinished side session: do NOT archive; list it as `shared worktree: <path> (live: <title>)`.
3. The cascade is the unit of safety: every distinct worktree it reaches must itself be on the safe list.

After EACH archive, run `git worktree list` and check the path on disk: a worktree still listed or present was NOT removed, whatever
the host reported. Report `archived but worktree survives: <path>`; never count it as cleaned up.
