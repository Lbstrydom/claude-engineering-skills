---
summary: Usage telemetry — what each verb records, the weakness findings stats derives, and how to turn it off.
---

# Usage telemetry

## What is recorded

Each run of a fleet verb appends one event to `<git-common-dir>/fleet-telemetry/`
(beside the registry, never inside it):
the verb and its mode (`land approve-serial`, `directive ack`), the outcome
(`ok`, `refused`, `pending` = WAIT, `error`, `argv` = mis-invoked), the exit
code, wall time, a hash of the fleet session id (it groups a session's events
without naming the branch), a **reason class** and **counts** (array
lengths, booleans, closed-vocabulary values such as a claim verdict). A reason
class is fleet's own refusal or error message with every id the run was given
(session, train, branch, flag values), shas, paths, quoted text and numbers
replaced, so the same refusal from two sessions counts as one class. Paths and
the run's own branch or session name are never recorded; a slash-free name the
run was NOT given (another session's, say) can survive inside a reason class.

Writing the event is local and never changes a verb's output or exit code. A
detached `cross-skill.mjs fleet-telemetry flush` moves events into the audit
store's `fleet_events` table, at most once a minute. If the store is off or
unreachable the events wait in the spool (up to 5,000; further ones are counted
as dropped and the count is reported when the spool drains).

Turn it off with `FLEET_TELEMETRY=off` (or `LEARNING_DISABLE=1`, which turns off
all of the bundle's telemetry).

## Reading it

```bash
node scripts/cross-skill.mjs fleet-telemetry stats --format worksheet
```

`--days N` (1-90, default 14) sets the window. Without `--format worksheet` it
prints JSON. It shows:

- **Golden signals per verb**: runs, outcomes, p50/p95 latency.
- **Session flow**: sessions started, released and abandoned; claim-to-release
  lead time p50/p90; refusals, restacks and readies per session.
- **Saturation**: how large the status board gets and how often a hold is on.
- **Top reason classes** for refusals, errors and WAITs.
- **Per tool version**: status latency and error rate for each synced bundle
  commit, newest first.
- **This checkout's spool**: events still waiting to drain.

## Weakness findings

`stats` lists findings when a measure crosses a threshold. A rate is judged only
over enough data (10 runs of a verb, 5 sessions); with less, nothing is reported,
which means "not enough data", never "healthy".

| Signal | Fires when |
|---|---|
| errors | a verb errors or is mis-invoked in more than 5 % of runs; any `TypeError`-class crash |
| latency | p95 exceeds the verb's budget (status 10 s, next 5 s, claim 10 s, touch 5 s, ready 10 s, others 30 s) |
| flow | over 30 % of `land` runs end in WAIT; over 20 % of sessions are abandoned; more than one refusal per session after it claimed |
| collisions | over 25 % of claims are refused |
| usability | any mis-invocation: the reason class names the flag, which points at a docs or CLI gap |
| integrity | status saw an invalid registry record |
| regression | the newest tool version's status p95 is more than 1.5 × the previous version's |
| capture | events undrained for over 24 h, or dropped or rejected events |

A `capture` finding means the numbers above it are incomplete: fix the drain
(check the store configuration, then run the flush command it names) before
reading the rest.
