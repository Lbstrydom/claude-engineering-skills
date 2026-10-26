---
summary: Own-model ledger — when to record a task, decision, correction or outcome.
---

# Decision ledger (own-model telemetry)

The ledger keeps what chat transcripts lose at an account switch: tasks, decisions,
corrections, outcomes and per-task cost. It is separate from `fleet_events`, which
stays counts-only. Everything goes through `node scripts/cross-skill.mjs ledger <verb>`
(never a hand-written insert); event JSON is passed on STDIN, never argv.

## When to call it

| Moment | Call |
|---|---|
| Chip launch | `ledger mint` → put `wi-<id>` in the branch name, `Work-Item: <id>` in the PR footer and the id in the brief; then `ledger task --coordinator CES` |
| Chip wrap-up | `ledger outcome` (PR, rounds) and `ledger usage` (tokens, cost; `source` is `chip` or `coordinator`, never audit) |
| Louis corrects a proposal | `ledger correction --decision <id> --proposal-file F --revision-file F --class safety\|scope\|style\|new-info` (no rationale needed) |
| Account switch | `ledger handover` with the open decisions; `ledger status` shows what is pending |
| Commit | `ship-commit --work-item <id>` adds the `AI-Work-Item` trailer |

fleet records a `decision` on every refusal or WAIT, and `ship-train land` records an
`outcome(merged)` per PR, both to the local spool (never the network). `ledger flush`
delivers the spool; run it at the end of a turn that captured anything.

## What is stored

- A repo whose `training_eligible` is `false`, or whose eligibility could not be
  confirmed, stores STRUCTURE only (ids, enums, counts, refs): no brief, rationale,
  option text or correction text. `true` and undecided keep content; only `true` is
  ever exportable.
- Secrets are redacted; a secret that survives redaction refuses the event.
- An absent outcome means unknown, never success. `ledger sweep-reverts` closes a
  merged event's 7-day window and appends `reverted` or `observed-clean` only when the
  remote default branch was freshly fetched and contains the merge.
- `ledger purge --work-item <id>` or `--repo <name>` removes rows, records a barrier
  so a spooled copy cannot come back, and deletes local copies.
- `ledger rollup` reads per-task cost; `ledger status` reports an empty ledger as
  UNMEASURED, never zero.
