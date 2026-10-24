# Plan: An in-turn lease grant ends with the turn while another repo waits

- **Date**: 2026-10-24
- **Status**: In Progress — implemented on `fix/lease-in-turn-grant-cap`, pending audit and merge
- **Author**: Claude (fleet chip for CES: Coordinator; proposal 9729, HIGH)
- **Scope**: backend (fleet lease decision; no UI)

## 1. Problem
`decideAcquire` granted an IN-TURN acquire for its full `--for` even when that ran past the turn's end while other repos waited. 2026-10-24: storyline was granted 120 minutes at 09:17Z on a turn that ended 09:59Z and held the slot to 11:17Z; wine, waiting since 09:00Z with 105 refusals, was starved (also at 03:52Z). The turn rule decided WHETHER a repo may go, never HOW LONG the grant lasts.

## 2. Decision
After the turn rule says `in-turn` (a fresh grant, or a renewal judged on its projection) and at least one OTHER repo waits, the grant's expiry is the turn's `endsAt` when that is earlier than `now + --for`. The result carries `capped {requestedMin, grantedMin, turnEndsAt, waiting}`, the journal's `acquired` entry records `job.forMin` as granted and `capped {from,to,waiting}`, and `lease acquire` / `lease run` print a `CAPPED:` line. Capped rather than refused: the caller gets the time it is entitled to and asks again next turn; refusing would waste a turn for a repo whose job fits.

- **Served at turn end:** unchanged and now reachable — the capped lease expires at the turn end, `settleQueue` ends the turn (`expiry`) and offers the slot to the longest-waiting repo that fits (`settleOffers`, ordered by `since`); the capped repo's next acquire is told who goes first. Tests pin this, including longest-before-newest.
- **Solo repo unaffected:** no other waiter → full `--for`, no `capped`. A repo's own queued sibling job does not count. A grant under a named gap or backfill is not `in-turn` and is not capped.
- **Stated limit (cooperative lease):** a job whose recorded pid is alive after the lease expires still holds the slot (`expired-pid-alive`); the cap ends the LEASE with the turn, it cannot stop a running process. `lease run` says this in its CAPPED line.
- Two v12-era tests encoded the leak (a renewal at 20:22 "runs to 20:37" past a 20:23 turn end) and were updated; an offer to B now has to be taken within `claimMs`, which the old test's long lease had masked.

## 3. Rollout
Fleet tooling in this checkout; no consumer sync, no `hooks:install`.

## 4. Acceptance
`tests/fleet-lease-turns.test.mjs` §9729 (the incident shape, served-at-turn-end, longest waiter, solo control, renewal, gap not capped), red without the cap (7 failures) and green with it.
