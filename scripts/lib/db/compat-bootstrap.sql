-- ╔══════════════════════════════════════════════════════════════════════════╗
-- ║  postgres-parity compat bootstrap — fresh self-hosted Postgres only.    ║
-- ║                                                                          ║
-- ║  Drives M2 setup-postgres.mjs (plan §0 prereq #2, §7 Phase 2).           ║
-- ║  Inventory: docs/plans/postgres-parity-non-core-inventory.md.            ║
-- ║                                                                          ║
-- ║  Provides the Supabase-specific surface the audit-loop migrations        ║
-- ║  reference but vanilla Postgres lacks:                                   ║
-- ║    - `auth` schema                                                       ║
-- ║    - stub `auth.users(id uuid)` table (only the FK target is needed —    ║
-- ║      the FKs themselves are dropped immediately by                       ║
-- ║      20260330065641_fix_rls_for_cli.sql)                                 ║
-- ║    - `auth.uid()` returning NULL (audit confirmed zero                   ║
-- ║      `DEFAULT auth.uid()` columns exist — plan R14/R17 not triggered)    ║
-- ║    - stub roles: `anon`, `authenticated`, `service_role`                 ║
-- ║    - extensions: `pgcrypto`, `pg_trgm`, `vector`                         ║
-- ║                                                                          ║
-- ║  Skipped on a Supabase-managed DB (plan §0 #2, R16): setup-postgres.mjs ║
-- ║  detects a real `auth` schema owned by `supabase_admin` and does not    ║
-- ║  apply this file. Even so, every statement here is existence-guarded —  ║
-- ║  `CREATE … IF NOT EXISTS`, `DO $$ BEGIN CREATE ROLE … EXCEPTION WHEN    ║
-- ║  duplicate_object THEN … END $$`, and `CREATE FUNCTION` only when       ║
-- ║  absent. **Never `CREATE OR REPLACE`** for `auth.uid()` so a managed    ║
-- ║  body cannot be clobbered.                                              ║
-- ║                                                                          ║
-- ║  Privileges required by the SETUP role:                                 ║
-- ║    - `CREATEROLE` (to create the three stub roles)                      ║
-- ║    - `CREATE EXTENSION` on `vector`, `pg_trgm`, `pgcrypto`              ║
-- ║  setup-postgres.mjs preflights these and aborts with a precise message  ║
-- ║  if absent (plan R10 / R3/H3).                                          ║
-- ╚══════════════════════════════════════════════════════════════════════════╝

-- ── 1. Extensions ─────────────────────────────────────────────────────────
-- `IF NOT EXISTS` is idempotent. On managed Postgres without the underlying
-- packages installed, these will hard-fail — the preflight in
-- setup-postgres.mjs surfaces a precise install hint before reaching here.

CREATE EXTENSION IF NOT EXISTS pgcrypto;   -- gen_random_uuid() on PG < 13
CREATE EXTENSION IF NOT EXISTS pg_trgm;    -- memory_health_metrics()
CREATE EXTENSION IF NOT EXISTS vector;     -- pgvector — symbol_index, security_incidents

-- ── 2. `auth` schema ──────────────────────────────────────────────────────

CREATE SCHEMA IF NOT EXISTS auth;

-- ── 3. Stub `auth.users(id uuid)` ─────────────────────────────────────────
-- The 8 `REFERENCES auth.users(id)` columns in 20260330063355_learning_store.sql
-- are dropped immediately by the next migration. The table only needs to
-- EXIST at DDL-parse time of the create-table statements.

CREATE TABLE IF NOT EXISTS auth.users (
  id uuid PRIMARY KEY
);

-- ── 4. Stub `auth.uid()` ──────────────────────────────────────────────────
-- Used in 9 RLS policies that are also dropped immediately by the next
-- migration. The stub returns NULL — audit confirmed no NOT NULL DEFAULT
-- auth.uid() column exists (plan R14: sentinel-UUID workaround not needed).
--
-- DO NOT use `CREATE OR REPLACE` — that would silently overwrite a
-- legitimate Supabase `auth.uid()` body if this file ever ran against a
-- managed DB by accident (plan R16).

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'auth' AND p.proname = 'uid'
  ) THEN
    EXECUTE $f$
      CREATE FUNCTION auth.uid() RETURNS uuid
      LANGUAGE sql STABLE
      AS 'SELECT NULL::uuid'
    $f$;
  END IF;
END
$$;

-- ── 5. Stub roles ─────────────────────────────────────────────────────────
-- NOLOGIN — these exist only as GRANT/REVOKE/POLICY targets. The CLI
-- connects as the runtime role (owns `public`); these stubs never log in.

DO $$
BEGIN
  CREATE ROLE anon NOLOGIN;
EXCEPTION WHEN duplicate_object THEN
  NULL;
END
$$;

DO $$
BEGIN
  CREATE ROLE authenticated NOLOGIN;
EXCEPTION WHEN duplicate_object THEN
  NULL;
END
$$;

DO $$
BEGIN
  CREATE ROLE service_role NOLOGIN;
EXCEPTION WHEN duplicate_object THEN
  NULL;
END
$$;
