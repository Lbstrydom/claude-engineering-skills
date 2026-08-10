# Memory-health gate — how the three metrics are computed, and what they lie about

Moved out of `AGENTS.md` (2026-08-10) under its progressive-disclosure rule.
AGENTS.md keeps the trigger table, the decision rule, and the two obligations
that bind anyone changing this subsystem (add a control-state sentinel when a
wave starts emitting one; bound an RPC at the caller). Everything below is the
elaboration.

`scripts/memory-health.mjs` runs three trigger metrics against the audit store to
decide whether our flat `audit_findings` + fingerprint-dedup design is starting to
leak signal that a graph-shaped memory (pgvector + community clustering) would
recover.

Runtime is the `memory_health_metrics(window_days)` Postgres RPC added by
`supabase/migrations/20260421163525_memory_health.sql` (uses `pg_trgm`).
Thresholds are the `MEMORY_HEALTH_*` env vars —
[`environment-variables.md`](environment-variables.md) §Memory-health gate.

## Metrics 1 and 3 are SAMPLED, and two Postgres traps live here (2026-08-08)

The gate had measured nothing for months. The 2026-04-21 perf patch added a `%`
prefilter **and** truncated both operands to `LEFT(detail_snapshot,500)` in one
edit, which disabled the bare-column GIN index `%` was added to use — 3.7M
filter-evaluated pairs, >15 min, killed by the runner's 5-min spawn budget as a
bare `spawn ETIMEDOUT`.

Fixed by `20260808160000_memory_health_trgm_index.sql`:

- a GIN index on `left(detail_snapshot,500)`;
- LATERAL probes behind an **`OFFSET 0` fence** — without it the planner still
  picks the `created_at` btree, because it costs `%` at 1 unit against a measured
  ~65us;
- a `per_repo_cap` on the **driving** set.

**Cap the driving set, NEVER the searched set** — the latter drops real matches
and biases the rate down into a false GREEN.

So `fuzzy_reraise.rate` / `recurrence.rate` are **sample estimates** over the N
most recent per repo; read `new_fingerprints_total` / `fixed_findings_total` /
`per_repo_cap` beside them.

### Trap 1 — `SET statement_timeout` on a function is DECORATIVE

Postgres arms the timer at statement start and a `SET` inside the body never
re-arms it (negative-controlled). Bound these RPCs **at the caller**, as
`db/rpc.mjs` now does via `withTx` + `SET LOCAL`.

### Trap 2 — `CREATE OR REPLACE FUNCTION` resets proconfig and the ACL

It replaces the whole `proconfig` array and resets the ACL, so any redefinition
silently reverts `20260721130000`'s `search_path` pin + EXECUTE revoke unless it
re-states both. Verify with `pg_proc.proconfig` / `proacl`, **not** review.

## Cluster density counts FINDINGS, never a wave's own control state

A wave that prints a machine-generated notice about its own execution (coverage
cap hit, aborted enumeration) emits byte-identical text every time, so those rows
pair at similarity 1.00 with each other and inflate the metric by construction —
44% of the raw signal on 2026-07-20.

Sentinels are listed in `control_marker_prefixes` (migration `20260720210000`) and
matched on the **detail-snapshot prefix, not the category**: the adjacency wave
emits both `ADJACENCY_INCOMPLETE` control state AND real `[Adjacency]` findings,
so excluding the category would drop genuine signal.

**Add a sentinel there when a new wave starts emitting control state**, or this
gate will read AMBER forever on its own logging.

Two companion fixes in the same migration: `open_findings` now means the
considered population (it previously counted only findings that already had a
match), and a repo with zero similar pairs contributes a 0 to the median instead
of vanishing from it via an INNER JOIN.

## Scheduling

Auto-scheduled via `.github/workflows/memory-health.yml` — runs every Monday
09:00 UTC, silent when all metrics green, opens/updates a sticky GH issue (label
`memory-health`) when any trigger fires. Auto-closes when metrics return to green.
Run locally: `npm run memory:health` or `npm run memory:health:json`.

## pgvector prototyped + promoted (2026-07-21)

Trigram UNDER-counts churn; semantic cosine catches reworded re-raises.
`scripts/semantic-suppress.mjs` reconciler (dry-run default) + a record-time hook
in `recordFindings` (merged pass) are **default-ON**, fail-open, kill switch
`AUDIT_SEMANTIC_SUPPRESS_ENABLED=false`. It dedups the store row, **NEVER** the
audit report; core `semantic-suppression.mjs` / `semanticSuppressConfig`.
Write-up:
[`pgvector-clustering-prototype.md`](../research/pgvector-clustering-prototype.md).
