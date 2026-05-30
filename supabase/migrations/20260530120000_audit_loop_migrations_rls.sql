-- Enable RLS on the migration-ledger table.
--
-- Background: `audit_loop_migrations` is created by
-- `scripts/setup-postgres.mjs::ensureLedger()` (outside the supabase/migrations/
-- flow) and historically shipped without RLS. On a Supabase project the
-- default grants give `anon` + `authenticated` full DML, so anyone with the
-- project's anon key could read or tamper with the ledger (e.g. insert a fake
-- "applied" row to make `--migrate` skip a real pending migration).
--
-- Fix: enable RLS with no policy. Deny-by-default for anon/authenticated;
-- the runtime role (postgres owner per AUDIT_DB_URL) bypasses RLS and the
-- audit-loop keeps working.
--
-- Idempotent: ALTER TABLE ... ENABLE ROW LEVEL SECURITY is a no-op on
-- a table that already has it on.

ALTER TABLE audit_loop_migrations ENABLE ROW LEVEL SECURITY;
