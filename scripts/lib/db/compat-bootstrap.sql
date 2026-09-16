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
-- GUARDED ON EXISTENCE (SELECT from pg_extension), not on `IF NOT EXISTS`
-- alone — same bug class as the stub roles below, and it is NOT hypothetical:
-- measured against a consumer's Azure store 2026-09-16. `runMigrate` in
-- setup-postgres.mjs only decides whether to run this WHOLE FILE (skipped
-- when `findMissingSurface` reports nothing absent); it does not know that a
-- run triggered by, say, a missing `auth` schema will still re-execute every
-- statement here, including these. On Azure Flexible Server, `vector` is not
-- a "trusted" extension, so `CREATE EXTENSION IF NOT EXISTS vector` demands
-- `azure_pg_admin` regardless of whether `vector` is already installed — the
-- platform's allowlist check fires ahead of the IF-NOT-EXISTS short-circuit,
-- exactly like `CREATE ROLE` firing `insufficient_privilege` before the
-- duplicate-object check. Existence-guarding each statement individually
-- means an already-installed extension is never re-asked for, no matter why
-- the rest of the file ran. On managed Postgres without the underlying
-- packages installed, an actually-missing extension still hard-fails inside
-- the DO block — the preflight in setup-postgres.mjs surfaces a precise
-- install hint before reaching here.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pgcrypto') THEN
    CREATE EXTENSION pgcrypto;   -- gen_random_uuid() on PG < 13
  END IF;
END
$$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_trgm') THEN
    CREATE EXTENSION pg_trgm;    -- memory_health_metrics()
  END IF;
END
$$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'vector') THEN
    CREATE EXTENSION vector;    -- pgvector — symbol_index, security_incidents
  END IF;
END
$$;

-- ── 2. `auth` schema ──────────────────────────────────────────────────────

CREATE SCHEMA IF NOT EXISTS auth;

-- ── 3. Stub `auth.users(id uuid)` ─────────────────────────────────────────
-- The 8 `REFERENCES auth.users(id)` columns in 20260330063355_learning_store.sql
-- are dropped immediately by the next migration. The table only needs to
-- EXIST at DDL-parse time of the create-table statements.

CREATE TABLE IF NOT EXISTS auth.users (
  id uuid PRIMARY KEY
);

-- Unlike a newly created FUNCTION (which grants EXECUTE to PUBLIC by
-- default), a newly created SCHEMA or TABLE grants nothing to PUBLIC — so
-- whoever runs THIS bootstrap becomes the only role that can see `auth` at
-- all. That is fine when the bootstrap runner is also the migration runner,
-- but this repo's own docs (docs/runbooks/postgres-parity.md,
-- references/migration-credentials.md) document a DELIBERATE split: an
-- admin role bootstraps once, a narrower runtime role runs `--migrate`
-- thereafter. Without these grants, `--migrate` under the runtime role
-- fails with "permission denied for schema auth" the moment a pending
-- migration references `auth.users`/`auth.uid()` — a real find (a
-- consumer's Azure store, 2026-09-16) that these are idempotent to re-run
-- and safe to grant broadly: `auth` here holds nothing but the inert
-- compat stubs this file creates, never real Supabase auth data.

GRANT USAGE ON SCHEMA auth TO PUBLIC;
GRANT SELECT ON auth.users TO PUBLIC;

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
--
-- GUARDED ON EXISTENCE, not on an exception handler (2026-08-30). These three
-- blocks used to read `CREATE ROLE x; EXCEPTION WHEN duplicate_object THEN
-- NULL` — the intent being "idempotent". It is not, on a role without
-- CREATEROLE: Postgres checks the PRIVILEGE before it checks for a duplicate,
-- so an already-existing role raises `insufficient_privilege` (42501), which
-- that handler does not catch, and the whole bootstrap aborts. On managed
-- Postgres (Azure, RDS) the app role is deliberately not granted CREATEROLE,
-- so `--migrate` failed there on every run after the one that bootstrapped it
-- — with nothing left to create. Measured in a consumer's Azure store: all
-- three roles present, 131 migrations applied, the next two unapplicable.
--
-- The `auth.uid()` block six lines above already had the correct idiom. These
-- now match it: ask whether the object EXISTS, and only then create it. The
-- `duplicate_object` handler is kept for the concurrent-creation race between
-- the check and the CREATE, which is the only thing it was ever able to catch.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    CREATE ROLE anon NOLOGIN;
  END IF;
EXCEPTION WHEN duplicate_object THEN
  NULL;
END
$$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    CREATE ROLE authenticated NOLOGIN;
  END IF;
EXCEPTION WHEN duplicate_object THEN
  NULL;
END
$$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    CREATE ROLE service_role NOLOGIN;
  END IF;
EXCEPTION WHEN duplicate_object THEN
  NULL;
END
$$;
