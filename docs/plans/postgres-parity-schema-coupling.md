# Postgres-Parity — Migration Schema-Coupling Audit (M0 #2)

- **Plan**: [`docs/plans/postgres-parity.md`](./postgres-parity.md) §0 prereq #3, §2 "Schema scope" (R3/H2)
- **Question this audit answers**: are the 31 live migrations portable to a
  non-`public` schema, or are they hard-wired to `public`?
- **Verdict**: **hard-wired to `public`** — confirms the plan's
  v1-targets-`public`-only scope. Arbitrary `AUDIT_DB_SCHEMA` support
  remains §10 Out of Scope.

## Findings

### 1. Hardcoded `public.` qualifications

`20260501120000_symbol_index.sql` qualifies four references to live
tables with `public.` inside the `publish_refresh_run` function body:

| File:line | Reference |
|---|---|
| `20260501120000_symbol_index.sql:184` | `FROM public.refresh_runs WHERE id = p_refresh_id;` |
| `20260501120000_symbol_index.sql:196` | `UPDATE public.refresh_runs` |
| `20260501120000_symbol_index.sql:201` | `UPDATE public.refresh_runs` |
| `20260501120000_symbol_index.sql:211` | `UPDATE public.audit_repos` |

A non-`public` deployment would have the table at e.g. `audit_loop.refresh_runs`,
but the function body would still target `public.refresh_runs` → error.

> **Addendum 2026-07-17 — the baseline is now seven, not four.** Three more
> `public.` qualifications reached main in June and are now in
> `SCHEMA_COUPLING_BASELINE`:
>
> | File:line | Reference |
> |---|---|
> | `20260603120000_unify_repo_identity.sql:29` | `FROM public.audit_repos` |
> | `20260603120000_unify_repo_identity.sql:44` | `ALTER TABLE public.audit_repos DROP CONSTRAINT …` |
> | `20260605130000_audit_repos_fingerprint_nullable.sql:17` | `ALTER TABLE public.audit_repos ALTER COLUMN fingerprint DROP NOT NULL;` |
>
> **They are accepted debt, not a revised verdict** — §1's conclusion is
> unchanged and in fact reinforced: the migrations are hard-wired to `public`.
>
> **Why they were not refactored**: both migrations are applied, and the ledger
> pins a per-file sha256 — `setup-postgres.mjs` throws `migration <f> sha256
> mismatch — refusing to re-apply` on any edit, in every environment that has
> already run them. Refactoring is unavailable; baselining is the only route.
>
> **Why they got in**: `--schema-coupling` existed and was correct, but was
> wired to nothing — no workflow, no hook, absent from `npm run check` — so it
> never ran. Baselining them is what lets the check go live and block the NEXT
> one. That is the trade being made here: three accepted historical couplings in
> exchange for a gate that is no longer dead. Both `--strict` forms now run in
> the pre-push chain.

### 2. `SECURITY DEFINER` + `SET search_path = pg_catalog, public`

11 stored procedures pin `search_path = pg_catalog, public` to harden
against search-path-hijack attacks (Postgres `SECURITY DEFINER` guideline):

| File | Function |
|---|---|
| `20260421163657_memory_health_perf.sql` | `memory_health_metrics` |
| `20260501120000_symbol_index.sql` | `publish_refresh_run`, `symbol_neighbourhood`, `drift_score` (v1) |
| `20260503120000_drift_score_ann.sql` | `drift_score` (v2) |
| `20260503130000_drift_score_signature.sql` | `drift_score` (v3 — current) |
| `20260503140000_top_duplicate_clusters.sql` | `top_duplicate_clusters` |
| `20260504120000_security_incidents.sql` | `incident_neighbourhood` |
| `20260508120000_adaptive_learning_v1.sql` | `defer_finding`, `mark_finding_needs_triage` |

Every one of these refers to its target tables unqualified inside the
function body (`audit_findings`, `symbol_index`, etc.) — which only
resolves correctly because the function-scoped `search_path` lists
`public`. Re-pointing the deployment at `audit_loop` would silently
break them: the body would look up `audit_loop.audit_findings` first,
fail to find it, fall back to `public.audit_findings`, find nothing,
and either error or return empty results depending on the query shape.

### 3. RLS policy targets

All `CREATE POLICY` and `REVOKE`/`GRANT` statements are unqualified
(`ON audit_repos`, `ON audit_findings`, etc.). These bind to the
current `search_path` at DDL-execution time. On a fresh apply with
`search_path = public, …` (the Postgres default), they bind to
`public.<table>`. If the operator runs the migration with a different
`search_path`, the policies bind to a different table — that's
ambient-state-coupled and exactly what the §2 "Schema scope" rule
prohibits.

### 4. No qualified `<other-schema>.<object>` references

The audit confirms **no migration references any non-`public`
non-`auth` schema**. The only cross-schema references are to `auth.*`
(handled by the compat bootstrap — see the [non-core inventory](./postgres-parity-non-core-inventory.md))
and to `pg_catalog` (always present).

### 5. View definitions

`scripts/lib/store/*.mjs` (M3) will SELECT from 12 views the migrations
create (`pending_triage_findings`, `no_brainer_recommendations`,
`recurring_finding_clusters`, `audit_effectiveness`, `unlocked_fixes`,
`regression_saves`, `ship_gate_effectiveness`, `plan_satisfaction`,
`persistent_plan_failures`, …). Each view's source SQL references
target tables unqualified, so the same `search_path`-coupling rule
applies — these are also `public`-only.

## What this means for v1 scope

- **`public` is hard-wired** in 4 function-body qualifications + 11
  `search_path` settings + every policy/grant statement + every view
  definition.
- **Schema portability is a non-trivial migration-rewriting effort**
  (substitute every unqualified table reference with the configured
  schema name, or set `search_path` per-function to the chosen schema).
- **For v1, `setup-postgres.mjs` asserts the target is `public`** and
  refuses otherwise with a clear message (plan §2 "Schema scope" +
  §7 P2). v1 ships `public`-only.
- **Test isolation uses ephemeral databases per CI run** (plan §9
  "Harness specifics") — never a non-default schema in the same DB.

## When this audit needs re-running

- A new migration is added that hardcodes a `<schema>.<table>`
  reference.
- A `SECURITY DEFINER` function is added without `SET search_path =
  pg_catalog, public` (harden-on-add reminder).
- The decision-to-revisit fires for arbitrary-schema support — that's
  a separate dedicated audit pass, not a v1 scope change.

## How to re-run

```bash
node scripts/postgres-parity/check-non-core-references.mjs --schema-coupling
```

The same lint script that verifies the non-core inventory also flags
hard-coded `public.` qualifications added by future migrations. The
v1 baseline is the 4 lines listed in §1 — any new hit fails the build.
