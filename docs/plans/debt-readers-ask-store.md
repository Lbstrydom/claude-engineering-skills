# Plan: The debt reporting CLIs read the private store, not the local cache

- **Date**: 2026-10-11
- **Status**: Complete — shipped in #193 (status reconciled against merged PRs 2026-10-25)
- **Author**: Claude + Louis
- **Scope**: backend (two CLIs + the debt read seam; no migration, no UI)

> **Target domain(s)**: `debt`. Completes a row of
> [`backlog-and-drift-reduction.md`](./backlog-and-drift-reduction.md) §6 that
> the plan's Complete status claims but the code never carried out.

## 1. Context Summary

**Measured 2026-10-11** (`node scripts/debt-reconcile.mjs --ledger <main checkout>/.audit/tech-debt.json`,
dry run): local cache 67 entries, private store 315; 248 store-only.

- `npm run debt:health` read only the local cache: it printed 67 in the main
  checkout and `UNVERIFIABLE — clean-checkout-sandbox` in every linked
  worktree, with the store reachable.
- `npm run debt:review` ranked the 67: `maintenance-checks.mjs` first. Ranked
  over the store's 315: `runs-findings.mjs` (65 entries) first.
- `loadAuthoritativeDebt` (`scripts/lib/debt-memory.mjs`) was added on
  2026-09-04 for exactly this, with a full availability contract
  (backlog-and-drift-reduction.md §2), and has **zero callers and zero tests**.
  §6 assigned `debt-health-check.mjs` to it ("so the count is the store's when
  cloud is on"); that row never landed.

Two further gaps in the oracle, found while wiring it:

1. `selectEventSource` turns "store configured, repo identity unresolved" into
   a LOCAL context, so `loadAuthoritativeDebt`'s `repo-identity-unresolved`
   branch is unreachable — the contract row "cloud on, repo identity
   unresolvable → unavailable, no count" cannot fire.
2. Store rows come back without the event-derived fields (`distinctRunCount`
   …), so a recurrence count over them would be silently 0.

## 2. Proposed Architecture

- `hydrateDebtEntries(entries, events)` — extracted from `readDebtLedger`
  (`scripts/lib/debt-ledger.mjs`); one hydration definition for both sources.
- `loadAuthoritativeDebt` hydrates store rows from the store's `debt_events`.
- `resolveDebtReadContext({noCloud})` (`debt-memory.mjs`) — the read context a
  reporting caller passes; keeps "store on, repo unresolved" as a CLOUD
  context with no repoId, so the oracle answers `unavailable`.
- `DEBT_SOURCE_LABELS` — the label every printed count carries.
- `debt-health-check.mjs` and `debt-review.mjs` read through the oracle; the
  local FILE is still read for budgets (and, in health, duplicate topicIds,
  which are a property of the file). A diverging cache is named, never
  substituted. `--no-cloud` reads the cache alone.
- `--fail-on-duplicates` (a CI check over the local file) never asks the store.

**Out of scope, named**: `debt-resolve.mjs` still requires the entry in the
local cache, so store-only entries cannot be closed with it (Lane A follow-up).
The other five §6 consumers (`debt-pr-comment`, `debt-budget-check`,
`debt-capture-trail-check`, `debt-ledger-claims-check`, `context-staleness`)
are unchanged. `readDebtEventsCloud` still returns `[]` on a query error —
pre-existing, and it makes a store-side recurrence count read 0 on that error.

## 3. Testing Strategy

- `tests/debt-authoritative-read-db.test.mjs` (DB-gated, enrolled in
  `db-test-container.mjs` ISOLATED and `postgres-parity.yml`): seeds real
  `debt_entries` + `debt_events`, spawns both CLIs with no local cache.
  Store count, store-event recurrence, divergence note, `--no-cloud` local
  label, debt-review source line. 5/5 green; 0/5 against 56eb0459.
- `tests/debt-health-check.test.mjs` pins the LOCAL contract; its harness now
  passes `AUDIT_DB_URL=''` (the air-gap signal) so it cannot read whichever
  store the machine points at.

## 4. Acceptance Criteria

- `npm run debt:health` in a linked worktree with the store configured prints
  the store's count, labelled `private store`.
- `npm run debt:review` ranks the store's entries and prints its source.
- No count is printed without a source label; `unavailable` prints no count.
