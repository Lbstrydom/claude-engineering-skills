---
summary: The machine lease - slot, windows, waiting and the journal.
---

# The machine lease

One file, `~/.claude-fleet/lease.json` (or `FLEET_MACHINE_DIR`), shared by every repo's fleet on this machine. It
records the heavy slot (rule 14: one full gate or test suite at a time), the quiet/CI windows repos announce, the
peak-cost hours, a journal of what happened, which repos are waiting, and whose turn it is. It is cooperative: nothing
enforces it, and `hold` and directives outrank it. Exit codes: 0 ok, 3 refused, 1 error (lock contention, unreadable
file), 2 argv.

## Verbs

| Verb | What it does |
|---|---|
| `lease acquire [--kind] [--for 1-180] [--pid] [--token] [--note]` | Take the slot. Prints a `token`; pass it to `attach`/`release`/a renewing `acquire` so a stale caller is refused. A refusal queues your repo. |
| `lease attach --pid <n>` | Record the job's pid so a later session can verify it stopped. |
| `lease release [--token] [--end-turn] [--force --reason]` | Give the slot back. `--end-turn` says this repo has nothing further ready, so the queue moves at once. `--force` is for an EXPIRED slot a person has judged gone. |
| `lease announce --kind quiet\|ci --until <iso\|+Nm> [--from] [--note] [--over-held] [--over-turn]` | Tell other repos not to run heavy work in a window. |
| `lease announce --clear-window <id>` | Clear a window. Any session may; a clear of another repo's window is recorded. |
| `lease grant --window <id> --until <iso\|+Nm> [--from] [--to <repo>]` | The window's owner lets a repo (or anyone) take the slot inside it. |
| `lease wait [--for <min>] [--note]` / `--cancel` | Say this repo wants the slot (a refused `acquire` says it too). |
| `lease turn --minutes <15-240>` / `--clear` | This machine's turn length (default 60). |
| `lease status` / `lease log [--limit n]` | Read the slot, windows, waiters, turn, peak hours / the journal, oldest first. |
| `lease peak --hours "09:00-12:00,14:00-17:00"` / `--clear` | Peak-cost hours (machine-local time). |

## Announce and acquire refuse each other

`acquire` is refused when another repo has a window over the requested minutes. `announce` is refused the other way
round: a window over a slot ANOTHER repo holds is refused with the holder, its job kind and its expiry, so the two
orders of the 2026-10-14 08:06Z race (CES acquired, storyline announced seconds later, both said OK) cannot both
succeed. An expired slot whose job may still run (pid alive, or no pid recorded) still counts, with no end.

- Announce `--from <the holder's expiry>` to start after the job, or
- pass `--over-held` when the window is ALREADY running (a dispatched CI cannot be un-dispatched). It is recorded with
  `overHeld: {holder, repo, until}` and `lease status`/`lease log` say so. Use it to record reality, never to skip a wait.

## Granted gaps

A window refuses every other repo, including one its owner meant to let in. `lease grant --window <id> --until +30m
--to o/b` records a gap inside that window: the named repo (no `--to` = anyone) may take the slot during the gap, and
the window no longer refuses it. Only the window's owner grants, the gap must lie inside the window, and a window
carries at most 5. A request that runs past the gap's end is still refused, and says when the gap ends. `--to` names a
repo the lease has already seen (it held the slot, announced, or waited); a label two checkouts share is ambiguous and
refused, never guessed. A gap is not a turn: an open gap lets everyone past the window, and the queue still orders them.

## Turns

When two or more repos want the machine, they take turns (the user's 2026-10-14 policy, rule 14): about 60 minutes of
heavy time (`lease turn`), the repo that has waited longest next, a repo's own CI windows and scheduled runs counting as
its time. A FREE slot is not a turn.

- **Waiting.** A refused `acquire` puts the REPO on the waiter list (one entry per repo, 20 at most, 12 hours): `since`,
  the minutes it wants, a refusal count. Further refusals only bump the count. It ends when the repo is granted the slot
  or announces a window starting now (`served`), on `wait --cancel`, after 12 hours, or when it lapses (below).
- **A turn** starts when a repo is granted the slot and lasts until its length runs out. A job running past the end is
  never cut; its next release hands over. After a release the repo keeps the turn for **10 minutes** so it can start its
  next batched job; **pass `--end-turn` when nothing further is ready**, or the next repo waits out the gap.
- **The rule for a fresh grant.** A gap named for the repo; else its own active turn (`in-turn`); else, if another repo's
  turn is active and anyone waits, refused (`turn`: the incumbent goes first); else if nobody else waits, granted; else
  the repo goes if it is the head, or if every repo that has waited longer cannot take the slot right now (`backfill`,
  so a head that cannot fit before a window does not block a shorter job that can). Renewing the running job is never
  a new job and skips the rule. The journal's `acquired` entry records the `basis`.
- **Announcing a window** that starts within the turn length answers to the same queue; `--over-turn` records a window
  that is already running, naming the repo it overrode. A window further ahead is a commitment, not checked.
- **A waiter cannot block the machine.** The head is offered the slot when it could take it. After 15 minutes of
  continuously being able to and not coming, it goes to the back with a new episode (`lapsed`). An offer is withdrawn the
  moment a window or a job makes the head unable to go.

## The journal

`journal[]` is a ring of the newest 200 transitions: `acquired` (mode granted/renewed/rotated/taken-over, and why),
`released`, `announced`, `window-cleared` (**same-repo clears too**), `refused`, `waiting`, `wait-ended`, `offered`,
`gap-granted`, `turn-started`, `turn-ended`. `kind` is only ever the transition; the resource is nested (`job.kind`,
`window.kind`). It answers "who had the slot, when, and why was X refused". A lease written before the journal existed
has no history, and `lease log` says so rather than printing nothing. `measureSlotWaits(journal)` (exported) turns it
into slot-wait time for doctor's fit check; an empty journal is `measured: false`, never "nobody waited".

## Older checkouts share this file

Everything above lives in NEW optional keys (`journal`, `waiters`, `turn`, `slotFreedAt`, `turnMin`, a window's `gaps` and
`overHeld`); the exceptional `events[]` ring keeps its original kinds, because an older checkout rejects an unknown event
kind as a corrupt file. An older checkout therefore reads and rewrites the file normally, but it ignores the new rules:
it can still announce over a held slot or acquire out of turn, and journals nothing. The rules take effect per repo once
it runs this version.
