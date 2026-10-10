# Plan: /fleet telemetry — measure performance and find weaknesses, sustainably
- **Date**: 2026-10-10
- **Status**: Complete
- **Author**: Claude + Louis
- **Scope**: backend (CLI, store, migration) · stack `js-ts`
- **Target domain(s)**: `fleet`, `stores`, `cross-skill-bridge`

## 1. Context Summary

/fleet wrote nothing to the audit store. The skill census listed it as
trailer-only (`TRAILER_ONLY_SKILLS`, `scripts/lib/store/skill-census.mjs`
(b06f3749)), and fleet never writes an `AI-Skill` trailer, so its usage,
latency and failure modes were unmeasured. The only evidence of how fleet
performs was consumer field reports (wine-cellar-app, storyline, 2026-10-09):
useful, but anecdotal, late, and unable to show whether a fix helped.

**Code Trace (b06f3749).** `scripts/fleet.mjs` `main()` dispatches one verb
to `lib/fleet/*` and maps `result.code` to an exit code; every verb returns
`{ok, code, text, reason?, …counts}`. The registry lives at
`<git-common-dir>/fleet/` (`fleetDir`, `lib/fleet/registry.mjs:150`); its
readers enumerate only their own subdirectories (`sessions/`, `trains/`,
`directives/`, `hosts/`). The spool still lives OUTSIDE the registry, as a
sibling `<git-common-dir>/fleet-telemetry/`: `status` is pinned (`tests/fleet-cli.test.mjs`)
to never create `fleet/`, and recording usage must not change that. Store writes from CLIs go through `scripts/cross-skill.mjs` (registry:
`lib/cross-skill/registry.mjs`, port: `lib/cross-skill/store-port.mjs`).

## 2. What to measure — borrowed from established practice

| Frame | Question | fleet measure (derived at read time) |
|---|---|---|
| **Golden signals** (SRE) | Is the tool fast and reliable? | per verb+mode: traffic (n), latency p50/p95/max, errors (crash + mis-invocation), refusals, WAITs |
| **Flow / DORA-style** | Does fleet help work land? | per session: started (claim ok), released, abandoned; claim→release **lead time** p50/p90; refusals, restacks, readies per session |
| **Saturation** | Is coordination load rising? | board size seen by `status` (items p50/max), share of observations under a hold, invalid registry records seen |
| **Weakness signals** | Where is it failing its users? | top refusal / error / WAIT reason classes; mis-invocations (argv) by flag = docs or CLI-shape gaps; unexpected `TypeError`-class crashes |
| **Change impact** | Did a release help or hurt? | latency and error rate per synced tool commit (`tool_sha`), newest vs previous |

`fleet-telemetry stats` turns these into named findings
(`lib/fleet/telemetry-insights.mjs` `THRESHOLDS`): error rate > 5 %,
p95 over a per-verb budget (status 10 s, next 5 s, …), land WAIT share > 30 %,
abandon rate > 20 %, claim refusal rate > 25 %, > 1 refusal per lifecycle, a crash kind, invalid registry
records, newest-version status p95 > 1.5× the previous, and capture faults
(a spool undrained for > 24 h, dropped or rejected events). Every rate needs a
minimum sample (10 events / 5 sessions); a quiet week reads "not measured",
never clean.

The first event captured during development was itself a finding: `status` took
16 s on this repo (23 board items, 47 hidden branches), over the 10 s budget.

## 3. How it is captured — sustainability rules

1. **Off the hot path.** fleet writes one small file per invocation to
   `<git-common-dir>/fleet-telemetry/` (temp + rename), beside the registry. No network, no store import, no
   stdout. A detached `cross-skill.mjs fleet-telemetry flush` drains the spool,
   at most once a minute, one drainer per spool (O_EXCL lock, stale after 10 min).
2. **Events, not aggregates.** One row per invocation in `fleet_events`; every
   metric is a query, so metrics can be added or corrected over history already
   collected, without a migration.
3. **Counts, not content.** Array lengths, booleans and closed-vocabulary
   strings only; reasons are normalised into classes (every id the run was
   given, shas, paths, quoted text and numbers replaced) so they aggregate and
   carry no paths and none of the run's own names — a slash-free name the run
   was not given can survive, which is acceptable for the bundle's private store
   and stated rather than hidden;
   the session id (usually a branch name) is stored as a 16-hex sha256 handle.
4. **Idempotent and loss-visible.** `event_id` is minted client-side and UNIQUE,
   so a re-drain is a no-op. A failed write leaves the spool intact. Past 5,000
   pending events new ones are counted as dropped, and the drain reports the
   count as a synthetic event; a malformed file is set aside and counted.
5. **Versioned.** Spool events carry `v: 1`; the drain schema-checks them
   strictly.
6. **Never reaches a store from tests.** Under `node --test`
   (`NODE_TEST_CONTEXT`) no drain is spawned.
7. **One switch.** `FLEET_TELEMETRY=off` (or the bundle-wide
   `LEARNING_DISABLE=1`) disables capture and drain.
8. **Read where people already look.** The skill census now reads fleet from
   `fleet_events` (`signalQuality: caller-checked`, effective 2026-10-10), so
   the dashboard's Skill Census row shows it; `fleet-telemetry stats --format
   worksheet` gives the full picture.

## 4. Right-sizing

- **Band-aid**: log to stderr, or count verbs in a local file — no history
  across machines, nothing joins sessions.
- **Over-built**: an event bus or OTel collector, a metrics service, stored
  rollups, a new dashboard tab.
- **Chosen**: one append-only table + a file spool + query-time metrics. It
  serves the current requirement (see how fleet performs across three consumer
  repos and whether fixes help) with one migration and no new infrastructure.

## 5. Files

- `scripts/lib/fleet/telemetry.mjs` (create) — capture, spool, drain spawn.
- `scripts/lib/fleet/telemetry-drain.mjs` (create) — locked, idempotent drain.
- `scripts/lib/fleet/telemetry-insights.mjs` (create) — weakness rules.
- `scripts/lib/store/fleet-events.mjs` (create) — writer + derived reads.
- `scripts/lib/cross-skill/commands/fleet-telemetry.mjs` (create), `registry.mjs`, `store-port.mjs` (modify).
- `supabase/migrations/20261010120000_fleet_events.sql` (create).
- `scripts/fleet.mjs`, `scripts/lib/store/skill-census.mjs`, `scripts/cross-skill.mjs` (modify).
- Tests: `tests/fleet-telemetry.test.mjs`, `tests/cross-skill-fleet-telemetry.test.mjs`, `tests/fleet-events-db.test.mjs` (enrolled in `db-test-container.mjs` + `postgres-parity.yml`).

## 6. Out of scope (future)

- **Per-session state transitions** (e.g. the time a PR is first seen merged by
  `status`). Lead time is claim→release today; a merge-observed time would need
  status to remember prior derivations. Independent: nothing above depends on it.
- **Directive acknowledgement latency.** Derivable from the registry's own
  directive files; not needed for the current questions.
- **A dashboard Fleet panel.** The census row covers presence; add a panel only
  if the worksheet proves too slow to consult.
- **Threshold tuning.** The thresholds are starting points; revisit after ~2
  weeks of data across the three consumers.
