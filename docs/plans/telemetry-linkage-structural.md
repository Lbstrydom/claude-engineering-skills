# Telemetry linkage as a structural contract

- **Status**: In Progress

Implemented 2026-11-23; awaiting coordinator merge and store migration.

## Problem

`audit_runs.audit_session_id` / `audit_round` sat at 0% on code runs for weeks (#488): `buildAuditRunContext`
dropped one field and the row was written with NULL. Linkage held only because each writer remembered a column.

## Inventory (task step 1)

The **run row is the linkage root**. A pass, finding or call reaches its session through `run_id`, and its round
through its own round column where one exists. Machine-readable copy: `LINKAGE_REGISTRY`
([linkage.mjs](../../scripts/lib/telemetry/linkage.mjs)), test-pinned to the registered writers.

| Writer | Table | Keys it must carry | How the key reaches it | Missing → | Durable-write outcome |
|---|---|---|---|---|---|
| (run insert) | `audit_runs` | session id, round | `ctx.auditIdentity` → `runStartIdentity` → `recordRunStart` → `captureIdentityColumns` | explicit `linkage_state='unlinked'` (or `standalone` + declared reason) | `written` — refusing would be `lost` for the whole audit |
| `audit.passStats` | `audit_pass_stats` | run id, `round` | `payload.runId`, `payload.round` | no run id: not written | `lost`-only (append-only INSERT, no rowKey) |
| `audit.findings` | `audit_findings` | run id, `round_raised` | `payload.runId`, `payload.round` | no run id: not written | keyed; `skipped` (`no-run-id`) |
| `audit.llmCalls` | `llm_call_provenance` | run id | `bindAuditCallLog` → `log.run_id` | declined `no-run-id` | `skipped`; dropped counts ride the summary row |
| `audit.reviewerEvents` | `finding_adjudication_events` | finding, reviewing run | payload | derived through finding → run | keyed |

**Known limit, stated not hidden:** `llm_call_provenance` has no round column. A call reaches a round only via its
run, and a unified run (`--run-id`, `audit_round` NULL) spans rounds. The query reports those calls as
`unresolvedRound`, never guesses a round. Adding a round to the call log is a separate follow-up.

## Enforcement (step 2)

* `resolveLinkage` is the one decision. No session and no declaration → `unlinked` (reason `undeclared`), never a
  bare NULL. A declaration must be a key of `STANDALONE_REASONS` (closed set); the resolver THROWS on an unknown reason or a reason plus a session (an illegal pair), and the STORE BOUNDARY
  (`captureIdentityColumns`) catches it: a real session still links (the declaration is ignored), a run with no session
  is recorded `unlinked` with `invalid-declaration: …` — never thrown to the caller, never lost.
* Migration `20261123150000` adds `linkage_state`/`linkage_reason` with CHECKs that refuse the same pairs and a
  BEFORE INSERT OR UPDATE trigger that derives the state for a writer that supplies none (a consumer not yet synced)
  and refuses to erase a stamped state, so no new row carries a bare NULL.
* **Reuse** (`--run-id`): a reused run adopts a now-known session if it had none; a run linked to a DIFFERENT session
  is refused (`recordRunStart` returns null, like the repo-mismatch refusal).
* Refuse vs explicit-unlinked per writer: the run row records `unlinked` (a refusal would drop the whole audit's
  record); children without a run id are refused as `skipped`/declined because nothing can attribute them.
* **Migration required.** Un-migrated stores keep today's behaviour (the column probe skips the new columns); the
  coordinator migrates every store before ff.

## Query (step 4)

`node scripts/own-model-coverage.mjs linkage --session <id> [--round <n>]` — read-only. Reports runs, passes,
findings and calls for the session/round, what it could not place (`unresolved`, `unresolvedRound`), and the
store-wide unlinked/standalone/legacy-unstated runs with their children. Exit 0 only when the session is known and
fully placed; an unknown session is exit 1 with the unlinked report, never an empty success.

## Tests (step 3)

`tests/telemetry-linkage.test.mjs` (pure) and the `telemetry linkage chain` block in
`tests/audit-capture-db.test.mjs` (real Postgres; already enrolled): retry, resume (round 2+ unified), coordinator →
worker (separate process handed only the `--out` path), CHECK negative control, unknown-session query.
