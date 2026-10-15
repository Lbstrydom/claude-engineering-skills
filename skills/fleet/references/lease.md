---
summary: The machine lease - slot, windows, waiting and the journal.
---

# The machine lease

One file, `~/.claude-fleet/lease.json` (or `FLEET_MACHINE_DIR`), shared by every repo's fleet on this machine. It
records the heavy slot (rule 14: one full gate or test suite at a time), the quiet/CI windows repos announce, the
peak-cost hours, a journal of what happened, and which repos are waiting. It is cooperative: nothing enforces it, and
`hold` and directives outrank it. Exit codes: 0 ok, 3 refused, 1 error (lock contention, unreadable file), 2 argv.

## Verbs

| Verb | What it does |
|---|---|
| `lease acquire [--kind] [--for 1-180] [--pid] [--token] [--note]` | Take the slot. Prints a `token`; pass it to `attach`/`release`/a renewing `acquire` so a stale caller is refused. |
| `lease attach --pid <n>` | Record the job's pid so a later session can verify it stopped. |
| `lease release [--token] [--force --reason]` | Give the slot back. `--force` is for an EXPIRED slot a person has judged gone. |
| `lease announce --kind quiet\|ci --until <iso\|+Nm> [--from] [--note] [--over-held]` | Tell other repos not to run heavy work in a window. |
| `lease announce --clear-window <id>` | Clear a window. Any session may; a clear of another repo's window is recorded. |
| `lease wait [--for <min>] [--note]` / `--cancel` | Say this repo wants the slot (a refused `acquire` says it too). |
| `lease status` / `lease log [--limit n]` | Read the slot, windows, waiters, peak hours / the journal, oldest first. |
| `lease peak --hours "09:00-12:00,14:00-17:00"` / `--clear` | Peak-cost hours (machine-local time). |

## Announce and acquire refuse each other

`acquire` is refused when another repo has a window over the requested minutes. `announce` is now refused the other
way round: a window over a slot ANOTHER repo holds is refused with the holder, its job kind and its expiry, so the
two orders of the 2026-10-14 08:06Z race (CES acquired, storyline announced seconds later, both said OK) cannot both
succeed. An expired slot whose job may still run (pid alive, or no pid recorded) still counts, with no end.

- Announce `--from <the holder's expiry>` to start after the job, or
- pass `--over-held` when the window is ALREADY running (a dispatched CI cannot be un-dispatched). It is recorded with
  `overHeld: {holder, repo, until}` and `lease status`/`lease log` say so. Use it to record reality, never to skip a wait.

## The journal

`journal[]` is a ring of the newest 200 transitions: `acquired` (mode granted/renewed/rotated/taken-over), `released`,
`announced`, `window-cleared` (**same-repo clears too**), `refused` (announce refusals, a full waiter list),
`waiting` and `wait-ended`. `kind` is only ever the transition; the resource is nested (`job.kind`, `window.kind`).
It answers "who had the slot, when, and why was X refused". A lease written before the journal existed has no
history, and `lease log` says so rather than printing nothing.

## Waiting

A refused `acquire` (held, a window, an expired slot that cannot be verified) puts the REPO on the waiter list: one
entry per repo, however many of its sessions ask, with `since`, the minutes it wants and a refusal count. Further
refusals only bump the count. The entry ends when the repo is granted the slot or announces a window starting now
(`served`), on `wait --cancel` (`cancelled`), or after 12 hours (`expired`). At most 20 repos wait; the 21st is told it
was NOT queued and nothing is evicted. In this release waiting is visible and measured, not binding: it does not
change who may take the slot. `measureSlotWaits(journal)` (exported) turns the journal into slot-wait time for doctor's
fit check; an empty journal is `measured: false`, never "nobody waited".

## Older checkouts share this file

Everything above lives in NEW optional keys (`journal`, `waiters`, a window's `overHeld`); the exceptional `events[]`
ring keeps its original kinds, because an older checkout rejects an unknown event kind as a corrupt file. An older
checkout therefore reads and rewrites the file normally, but it ignores the new rules: it can still announce over a
held slot and journals nothing. The rules take effect per repo once it runs this version.
