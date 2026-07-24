-- Drop legacy "allow all for anon" RLS policies + close a missed
-- SECURITY DEFINER grant (2026-07-24).
--
-- Found while verifying the finding_embeddings/symbol_refresh_coverage RLS
-- fix (migration 20260724160000): the Supabase advisor's
-- `rls_policy_always_true` WARN flags 20 tables where RLS is nominally
-- enabled but a `USING (true) WITH CHECK (true)` "allow all" policy grants
-- unrestricted anon/authenticated CRUD — functionally equivalent to RLS
-- being off. Plus `anon_security_definer_function_executable` /
-- `authenticated_security_definer_function_executable` on
-- memory_health_semantic_cluster.
--
-- ORIGIN (confirmed via git history before touching this — these are not
-- speculative). 20260330065641_fix_rls_for_cli.sql created these policies
-- deliberately: "For personal CLI tools, we use a fixed user_id from a
-- config/env var rather than requiring Supabase Auth login flow... Simple
-- permissive policies — CLI tool is personal, single-user." At that point
-- the CLI genuinely talked to Postgres via `@supabase/supabase-js` +
-- PostgREST using the anon key, so "allow all for anon" was the load-
-- bearing access mechanism, not an oversight.
--
-- That access path no longer exists. The postgres-parity migration (M4,
-- see AGENTS.md) moved every runtime connection to the direct `pg` driver
-- as the table-owning role via AUDIT_DB_URL, which bypasses RLS entirely —
-- the same reasoning already applied when audit_loop_migrations got RLS
-- enabled with NO policy in 20260530120000, and to 8 other RPCs in
-- 20260721130000_advisor_security_hardening.sql. These 20 tables (created
-- earlier) were never swept.
--
-- SAFE TO APPLY — verified before writing, not assumed:
--   * `grep` across this repo's scripts/ + dashboard/ finds zero live use of
--     SUPABASE_AUDIT_ANON_KEY — the one hit (scripts/lib/db/client.mjs) is
--     an error-guard telling the CALLER to migrate to AUDIT_DB_URL, not a
--     credential ever put on the wire.
--   * Same grep against the synced tooling in both consumer repos
--     (wine-cellar-app, ai-organiser scripts/.claude-skills/) — zero hits.
--   * Zero `supabase.co/rest` / `/rest/v1/` references in any of the three
--     repos' .github/workflows/.
--   * `@supabase/supabase-js` is not in package.json — dropped in M4.
--   * The runtime role (postgres owner per AUDIT_DB_URL) always bypasses
--     RLS regardless of what policies exist on these tables, so dropping
--     the policies has zero effect on the tooling that actually runs.
--
-- memory_health_semantic_cluster (20260721140000) was created ONE HOUR
-- AFTER the 20260721130000 hardening sweep — simply too new to have been
-- included, not a deliberate exception. Same fix, same reasoning: it's
-- SECURITY DEFINER (runs with owner privilege) and was granted EXECUTE to
-- anon/authenticated, letting an anon-key holder pull cross-repo aggregated
-- finding/embedding stats. Revoking matches the 8 RPCs already locked down.
--
-- NOT touched here — a separate, lower-risk category: 7 tables
-- (domain_summaries, refresh_runs, symbol_definitions, symbol_embeddings,
-- symbol_file_imports, symbol_index, symbol_layering_violations) carry a
-- SELECT-only `USING (true)` anon-read policy. Supabase's own linter
-- deliberately excludes SELECT-true from rls_policy_always_true ("often
-- used deliberately for public read access") and these expose read-only
-- architecture-map data, not CRUD on operational tables — a different risk
-- profile that wasn't part of what was flagged. Left as-is.
--
-- ROLLBACK (no colocated *_rollback.sql — this dir's runner applies EVERY
--   .sql file, so a rollback file would run right after and undo this. To
--   reverse, re-run 20260330065641_fix_rls_for_cli.sql's CREATE POLICY
--   statements for the 9 tables it covers, plus the equivalent for the 11
--   added later, and re-add the GRANT EXECUTE line from
--   20260721140000_memory_health_semantic_cluster.sql.)
--
-- VERIFY (expect 0 rows — Supabase's own rls_policy_always_true /
--   *_security_definer_function_executable advisors):
--   see get_advisors(type: security) for project uahjjdelnnpfmaqjrwoz.

BEGIN;

DROP POLICY IF EXISTS "Allow all for anon" ON audit_findings;
DROP POLICY IF EXISTS "Allow all for anon" ON audit_pass_stats;
DROP POLICY IF EXISTS "Allow all for anon" ON audit_repos;
DROP POLICY IF EXISTS "Allow all for anon" ON audit_runs;
DROP POLICY IF EXISTS "Allow all for anon" ON bandit_arms;
DROP POLICY IF EXISTS "Allow all for anon" ON debt_entries;
DROP POLICY IF EXISTS "Allow all for anon" ON debt_events;
DROP POLICY IF EXISTS "Allow all for anon" ON false_positive_patterns;
DROP POLICY IF EXISTS "Allow all for anon" ON finding_adjudication_events;
DROP POLICY IF EXISTS "Allow all for anon" ON prompt_variants;
DROP POLICY IF EXISTS "Allow all for anon" ON suppression_events;

DROP POLICY IF EXISTS anon_all_persona_audit_correlations ON persona_audit_correlations;
DROP POLICY IF EXISTS anon_all_plan_verification_items ON plan_verification_items;
DROP POLICY IF EXISTS anon_all_plan_verification_runs ON plan_verification_runs;
DROP POLICY IF EXISTS anon_all_plans ON plans;
DROP POLICY IF EXISTS anon_all_prompt_experiments ON prompt_experiments;
DROP POLICY IF EXISTS anon_all_prompt_revisions ON prompt_revisions;
DROP POLICY IF EXISTS anon_all_regression_spec_runs ON regression_spec_runs;
DROP POLICY IF EXISTS anon_all_regression_specs ON regression_specs;
DROP POLICY IF EXISTS anon_all_ship_events ON ship_events;

REVOKE EXECUTE ON FUNCTION memory_health_semantic_cluster(INT, NUMERIC, INT, TEXT[]) FROM PUBLIC, anon, authenticated;

COMMIT;
