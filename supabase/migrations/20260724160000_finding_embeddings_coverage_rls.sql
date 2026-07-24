-- Enable RLS on finding_embeddings + symbol_refresh_coverage (2026-07-24).
--
-- Both flagged CRITICAL by Supabase's `rls_disabled_in_public` advisor,
-- found while investigating the Disk IO Budget incident (see migration
-- 20260724150000). Confirmed live via information_schema.role_table_grants
-- before writing this: neither table carries an anon/authenticated grant
-- today, so there is nothing to revoke — this is a pure enable, no
-- functional change for the owner-role tooling (AUDIT_DB_URL), which
-- bypasses RLS regardless of policies.
--
-- Deliberately NO policies, matching this repo's established pattern on 20+
-- other tables (see e.g. 20260530120000_audit_loop_migrations_rls.sql,
-- 20260507120000_persona_rls_hardening.sql, 20260715130000_model_ab_rls_hardening.sql):
-- deny-by-default for anon/authenticated. Both tables are internal pipeline
-- state, not application API resources — external consultation (openai
-- gpt-5.6-terra + gemini-pro-latest via /brainstorm, session 1784917778249,
-- unanimous) converged on the same answer for reasons specific to each
-- table:
--   * finding_embeddings — a vector-similarity prototype table
--     (20260721120000_finding_embeddings_prototype.sql). Exposing it to
--     PostgREST would (a) let anon-key holders run expensive ivfflat cosine
--     queries — a compute-exhaustion vector RLS alone can't rate-limit, and
--     (b) leak which audit_findings are currently open via row
--     existence/ON DELETE CASCADE, even without reading audit_findings
--     directly or reversing the vectors.
--   * symbol_refresh_coverage — pipeline observability state
--     (20260718210000_symbol_refresh_coverage.sql). Its jsonb payload
--     carries extraction failure/timeout detail — infrastructure health
--     information with no reason to be a public API surface.
--
-- Do NOT add FORCE ROW LEVEL SECURITY — the owner role already bypasses
-- RLS; forcing it buys no security benefit here and adds operational risk.
--
-- Not just closing today's advisory: RLS-enabled-with-no-policies also
-- converts "nobody's granted anon access yet" into "can't be granted by
-- accident" — a future copy-pasted `GRANT SELECT ... TO anon` on either
-- table is still denied by default instead of being instantly exploitable.
--
-- If a real public consumer ever needs this data: don't open these source
-- tables. Expose a purpose-built SECURITY DEFINER RPC returning exactly the
-- aggregated fields needed, or a narrow reviewed projection — never raw
-- vectors or raw pipeline telemetry.
--
-- Idempotent: ENABLE ROW LEVEL SECURITY is a no-op on a table that already
-- has it on.
--
-- ROLLBACK (no colocated *_rollback.sql — this dir's runner applies EVERY
--   .sql file, so a rollback file would run right after and undo this. To
--   reverse, run by hand:
--     ALTER TABLE finding_embeddings DISABLE ROW LEVEL SECURITY;
--     ALTER TABLE symbol_refresh_coverage DISABLE ROW LEVEL SECURITY;

BEGIN;

ALTER TABLE finding_embeddings ENABLE ROW LEVEL SECURITY;
ALTER TABLE symbol_refresh_coverage ENABLE ROW LEVEL SECURITY;

COMMIT;
