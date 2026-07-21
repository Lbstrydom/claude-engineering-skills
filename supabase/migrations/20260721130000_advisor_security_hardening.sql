-- ============================================================================
-- Advisor security hardening (2026-07-21) — two WARN classes from the Supabase
-- database linter on the Audit-loop store (project uahjjdelnnpfmaqjrwoz).
--
-- CLASS 1 — SECURITY DEFINER functions executable by anon/authenticated.
--   Lints: anon_security_definer_function_executable
--          authenticated_security_definer_function_executable
--   Eight SECURITY DEFINER RPCs carry EXECUTE for the PostgREST roles. Because
--   the anon key ships publicly, anyone holding it could invoke these over
--   /rest/v1/rpc and read symbol / metrics / duplicate-cluster data. Five hold
--   a DIRECT grant to anon+authenticated; three (friction_neighbourhood,
--   friction_recurrence, symbol_neighbourhood) have a NULL ACL and are reachable
--   via the PUBLIC default — so we revoke from PUBLIC as well as the named roles.
--
--   SAFE TO APPLY — verified before writing:
--     * the store's runtime connects DIRECTLY via `pg` as the `postgres` owner
--       (AUDIT_DB_URL / scripts/lib/db/client.mjs), which can always execute its
--       own functions regardless of grants — REVOKE does not touch it;
--     * no runtime script imports `@supabase/supabase-js` or calls `.rpc()` with
--       an anon key (only tests/docs reference it — the supabase-js PostgREST
--       path was removed in postgres-parity M4; SUPABASE_AUDIT_ANON_KEY is a
--       stale .env leftover);
--     * service_role retains its explicit grants where present.
--   Companion to wine-cellar migration 154 (same class, on views).
--
-- CLASS 2 — mutable search_path on five functions.
--   Lint: function_search_path_mutable
--   Pins search_path so an object planted in an earlier-searched schema can't
--   shadow an unqualified reference. `public, pg_temp` keeps unqualified names
--   resolving while putting the temp schema last. memory_health_metrics is in
--   BOTH classes (SECURITY DEFINER + mutable) — the highest-value single fix.
--
-- ROLLBACK (no colocated *_rollback.sql — this dir's runner applies EVERY .sql
--   file, so a rollback file would run right after and undo this. To reverse,
--   run by hand: GRANT EXECUTE ... TO anon, authenticated on the 8 RPCs and
--   ALTER FUNCTION ... RESET search_path on the 5 functions.)
--
-- VERIFY (expect 0 rows):
--   SELECT p.proname, r.rolname FROM pg_proc p
--     JOIN pg_namespace n ON n.oid=p.pronamespace
--     JOIN LATERAL aclexplode(p.proacl) a ON true
--     JOIN pg_roles r ON r.oid=a.grantee
--    WHERE n.nspname='public' AND a.privilege_type='EXECUTE'
--      AND r.rolname IN ('anon','authenticated')
--      AND p.proname IN ('drift_score','friction_neighbourhood','friction_recurrence',
--        'memory_health_metrics','publish_refresh_run','refresh_recurring_clusters',
--        'symbol_neighbourhood','top_duplicate_clusters');
-- ============================================================================

-- Schema-portable per the postgres-parity schema-coupling lint: function names
-- are UNqualified and resolve through the migrate connection's search_path
-- (pinned to public by the db/ seam). Every function referenced below already
-- exists — created by an earlier migration — so a fresh provision + ordered
-- migrate reaches these ALTER/REVOKE statements after the functions exist.

BEGIN;

-- Class 1 — revoke PostgREST execute on the 8 SECURITY DEFINER RPCs.
REVOKE EXECUTE ON FUNCTION drift_score(p_repo_id uuid, p_refresh_id uuid, p_sim_dup numeric, p_sim_name numeric) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION friction_neighbourhood(p_repo_id uuid, p_prompt text, k integer, min_word_sim numeric) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION friction_recurrence(repo_id_filter uuid, window_days integer, min_similarity numeric, max_anchors integer) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION memory_health_metrics(window_days integer, similarity_reraise numeric, similarity_cluster numeric, max_pairs_per_repo integer) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION publish_refresh_run(p_repo_id uuid, p_refresh_id uuid, p_active_embedding_model text, p_active_embedding_dim integer) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION refresh_recurring_clusters(p_repo_id uuid) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION symbol_neighbourhood(p_repo_id uuid, p_refresh_id uuid, p_target_paths text[], p_intent_embedding vector, p_kind_filter text[], p_k integer) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION top_duplicate_clusters(p_repo_id uuid, p_refresh_id uuid, p_limit integer) FROM PUBLIC, anon, authenticated;

-- Class 2 — pin search_path on the 5 mutable-search_path functions.
ALTER FUNCTION memory_health_metrics(window_days integer, similarity_reraise numeric, similarity_cluster numeric, max_pairs_per_repo integer) SET search_path = public, pg_temp;
ALTER FUNCTION model_ab_attribute_arms(p_stage text, p_arm text) SET search_path = public, pg_temp;
ALTER FUNCTION touch_memory_friction_updated_at() SET search_path = public, pg_temp;
ALTER FUNCTION touch_persona_finding_outcomes_updated_at() SET search_path = public, pg_temp;
ALTER FUNCTION touch_security_incidents_updated_at() SET search_path = public, pg_temp;

COMMIT;
