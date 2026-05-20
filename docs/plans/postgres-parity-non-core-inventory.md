# Postgres-Parity — Non-core Dependency Inventory (M0 #1)

- **Plan**: [`docs/plans/postgres-parity.md`](./postgres-parity.md) §0 prereq #2
- **Scope**: every Supabase-specific / non-stock-Postgres object the 31 live
  migrations reference. Drives the contents of
  `scripts/lib/db/compat-bootstrap.sql` (M2 deliverable).
- **Refresh trigger**: the CI lint
  [`scripts/postgres-parity/check-non-core-references.mjs`](../../scripts/postgres-parity/check-non-core-references.mjs)
  re-runs this scan on every PR. A new migration that introduces an
  un-inventoried non-core reference fails the build.

## Summary

| Class | Reference | Migrations | Compat-bootstrap action |
|---|---|---|---|
| schema | `auth` | `20260330063355_learning_store.sql`, `20260330065641_fix_rls_for_cli.sql` | `CREATE SCHEMA IF NOT EXISTS auth;` |
| table | `auth.users(id uuid)` | `20260330063355_learning_store.sql` (8 `REFERENCES auth.users(id)` cols, all dropped by the very next migration `20260330065641_fix_rls_for_cli.sql`) | `CREATE TABLE IF NOT EXISTS auth.users (id uuid PRIMARY KEY);` — the FKs are dropped immediately so no row is ever needed at runtime, but the table must exist while the create-table DDL parses |
| function | `auth.uid()` | `20260330063355_learning_store.sql` (9 RLS policies — all dropped by `20260330065641_fix_rls_for_cli.sql`) | `CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$ SELECT NULL::uuid $$;` — return `NULL`. No `DEFAULT auth.uid()` column survives post-migration (audit: none ever existed), so the sentinel-UUID + stub `auth.users` row path (plan R14/R17) is **not required** for the live schema. |
| role | `anon` | 8 migrations — REVOKE/GRANT/POLICY TO targets | `CREATE ROLE anon NOLOGIN;` (needs `CREATEROLE`) |
| role | `authenticated` | 8 migrations — same | `CREATE ROLE authenticated NOLOGIN;` |
| role | `service_role` | 7 migrations — same | `CREATE ROLE service_role NOLOGIN;` |
| extension | `pg_trgm` | `20260421163525_memory_health.sql` (already self-guards `IF NOT EXISTS`) | `CREATE EXTENSION IF NOT EXISTS pg_trgm;` — loud failure + install hint when the package is absent |
| extension | `vector` | `20260501120000_symbol_index.sql` (already self-guards) + columns/RPC sigs in `20260504120000_security_incidents.sql` | `CREATE EXTENSION IF NOT EXISTS vector;` — same |
| extension | `pgcrypto` (`gen_random_uuid()`) | 12 migrations (`20260330063355_learning_store.sql`, `20260403083640_learning_v2_stage1_tables.sql`, `20260405092206_add_debt_memory.sql`, `20260413224948_persona_test_sessions.sql`, `20260413230027_persona_registry.sql`, `20260419120000_cross_skill_data_loop.sql`, `20260419130000_plan_verify.sql`, `20260501120000_symbol_index.sql`, `20260503150000_domain_summaries.sql`, `20260504120000_security_incidents.sql`, `20260508120000_adaptive_learning_v1.sql`, `20260509120000_friction_log.sql`) | `CREATE EXTENSION IF NOT EXISTS pgcrypto;` — Postgres 13+ has `gen_random_uuid()` built-in (no extension), but pgcrypto is a no-op there and the extension provides the function on earlier Postgres |

## Grant-target invariant

Every `GRANT EXECUTE … TO anon, authenticated, service_role` and
`REVOKE EXECUTE … FROM anon, authenticated` succeeds **only after the three
stub roles exist**. The compat bootstrap creates the roles before
`supabase/migrations/*.sql` runs. On a Supabase-managed DB the roles
already exist (Supabase manages them); the bootstrap detects this and
skips role creation (idempotent via `IF NOT EXISTS` once Postgres ≥9.5 —
we use `DO $$ BEGIN CREATE ROLE … EXCEPTION WHEN duplicate_object THEN END $$`).

## `DEFAULT auth.uid()` audit (plan R14 / Gemini G2)

The plan flagged that any column declared `… NOT NULL DEFAULT auth.uid()`
would fail under a `NULL`-returning stub. **Audit result: zero such
columns exist** across all 31 migrations. The grep
`DEFAULT\s+auth\.` returns no matches. The compat stub can safely return
`NULL` without the sentinel-UUID + stub-row workaround (plan R17).

If a future migration introduces a `DEFAULT auth.uid()` column, the
CI lint flags it and we revisit:
- If the column is `NOT NULL` → switch the stub to a constant sentinel
  UUID + insert that row into stub `auth.users`.
- If the column is nullable → no change; `NULL` default is fine.

## RLS-policy lifecycle

`20260330063355_learning_store.sql` creates 9 RLS policies of the form
`USING (auth.uid() = user_id)`. Every one of them is dropped by the
**immediately following** `20260330065641_fix_rls_for_cli.sql`, which
also drops the FK constraints, makes `user_id` nullable, and replaces
the policies with permissive `"Allow all for anon"`. On a fresh
self-hosted apply the stubbed `auth.uid()` returning `NULL` is only
exercised during the brief window between those two migration files —
and even then only by the CREATE POLICY DDL parser, never by a real
query. Safe.

## Plan-driven action items locked by this inventory

- The compat-bootstrap **only needs `auth` schema + `auth.users` stub +
  `auth.uid()` returning NULL + the 3 stub roles + the 3 extensions**.
- The plan §0 #2 row "DEFAULT auth.uid() columns" mitigation
  (sentinel UUID + stub-row insert) is **conditionally needed only if a
  future migration introduces such a column**; the CI lint guards this.
- The "managed-PG-without-`CREATEROLE`" §10 Out-of-Scope item stays —
  the role-creation step is unavoidable on a fresh self-hosted DB.

## How to re-run

```bash
node scripts/postgres-parity/check-non-core-references.mjs
```

Output is JSON-printable (with `--json`). The CI workflow added in M4
runs `--strict` so any new un-allowlisted reference fails the build.
