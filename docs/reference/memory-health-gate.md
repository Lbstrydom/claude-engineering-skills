# Memory-health gate — how the three metrics are computed, and what they lie about

Moved out of `AGENTS.md` (2026-08-10) under its progressive-disclosure rule,
and further condensed 2026-09-04: the trigger table and the decision rule moved
here too. AGENTS.md now keeps only the three obligations that bind anyone
CHANGING this subsystem (sampled metrics cap the driving set; add a
control-state sentinel when a wave starts emitting one; bound an RPC at the
caller). Everything below is the elaboration.

## The three triggers

| Metric | What it measures | Default trigger |
|---|---|---|
| Fuzzy re-raise rate | New-fingerprint findings whose text matches a prior finding (trigram sim > 0.6) | `> 15%` |
| Cluster density | Median per-repo count of open finding pairs that are **semantic same-file cross-run re-raises** (cosine > 0.85). Reports embedding **coverage** — a low-coverage reading is `unknown`, never green — and excludes control-state markers | `>= 5` |
| Recurrence rate | Fixed findings that reappear in the same repo within 30 days under a new fingerprint | `> 10%` |

**Decision rule**: 0 triggers for 4 weeks → the current design is fine. 1 trigger
for 2 consecutive weeks → prototype pgvector similarity. 2+ triggers → build the
full clustering pipeline.

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

### Trap 2 — `CREATE OR REPLACE FUNCTION` resets proconfig; the ACL trap is a DIFFERENT one

**Corrected 2026-09-05, measured** on `pgvector/pgvector:pg16`. The claim used to
read "resets proconfig **and the ACL**". Half of that is wrong, and the wrong
half pointed away from the real hazard.

| Operation | `proconfig` | `proacl` |
|---|---|---|
| `CREATE` + `REVOKE ... FROM PUBLIC, anon, authenticated` | `{search_path=public}` | `{postgres=X/postgres}` |
| **Same-signature** `CREATE OR REPLACE`, `SET` not restated | **NULL — RESET** | `{postgres=X/postgres}` — **preserved** |
| **Adding a parameter** (a new overload) | NULL | **NULL — default, i.e. `EXECUTE` to `PUBLIC`** |

So: **a same-signature replacement silently drops the `search_path` pin and must
restate `SET`, but it does NOT lose the EXECUTE revoke.** The privilege hazard is
the *other* shape — **changing the argument list creates a DIFFERENT function**,
and the existing `REVOKE` names the old signature, so it does not cover the new
one. Confirmed by privilege, not by reading `proacl`:

```
original(int)        anon can execute: false
overload(int,text)   anon can execute: true
overload(int,text)   PUBLIC can execute: true
```

**Consequence for `20260721130000`'s hardening**: re-run its `REVOKE` for any new
overload, and restate `SET search_path` on every replacement. Verify from
`pg_proc.proconfig` and `has_function_privilege(...)`, **not** from review — and
not from `proacl` alone, where the dangerous case shows up as an unremarkable
`NULL`.

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
