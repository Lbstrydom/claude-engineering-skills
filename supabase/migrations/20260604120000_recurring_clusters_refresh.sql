-- Recurring-finding-cluster aggregation (signal-recovery Cluster C, Phase 6).
--
-- B6: recurring_finding_clusters is a base table that NOTHING refreshes from
-- audit_findings (only the defer_finding RPC inserts on manual deferral), so
-- the weekly-review's recurring-finding digest is always empty. This adds a
-- full per-repo recompute that aggregates audit_findings into the EXISTING
-- schema — no new columns.
--
-- Design notes (plan Phase 6, R3-M5):
--  * `cluster_key` = a COARSE deterministic grouping (lower(category)|lower(file)),
--    computed in SQL. This is NOT a reimplementation of JS `semanticId()` — that
--    hash includes the finding DETAIL and is per-finding (it would never cluster).
--    Recurrence detection needs the coarser category+file key, which SQL computes
--    trivially. Stored in the existing `cluster_hash` column.
--  * "Recurring" = the same (category, file) seen across >= 2 distinct runs.
--  * UPSERT-only (no delete): clusters absent from the current recompute keep
--    their old `last_seen` and age out via the existing `readStaleClusters`
--    (last_seen-based) reader — so staleness is handled WITHOUT a delete that
--    would also wipe defer_finding-sourced clusters (R2-M3 "deactivation"
--    realised as aging, preserving other writers' rows).
--
-- SECURITY DEFINER + pinned search_path: matches the 11 existing definer fns
-- (AGENTS.md "Why the schema is public-only").

CREATE OR REPLACE FUNCTION refresh_recurring_clusters(p_repo_id uuid)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_upserted integer := 0;
BEGIN
  IF p_repo_id IS NULL THEN
    RETURN 0;
  END IF;

  WITH clustered AS (
    SELECT
      lower(coalesce(f.category, '(uncategorised)')) || '|'
        || lower(coalesce(f.primary_file, '(no-file)'))            AS cluster_hash,
      count(DISTINCT f.run_id)                                     AS occurrence_count,
      array_agg(f.severity ORDER BY f.created_at)                  AS severity_history,
      array_agg(DISTINCT f.primary_file)
        FILTER (WHERE f.primary_file IS NOT NULL)                  AS files_affected,
      min(f.created_at)                                            AS first_seen,
      max(f.created_at)                                            AS last_seen,
      (array_agg(f.id ORDER BY f.created_at DESC))[1]              AS latest_finding_id,
      (array_agg(f.category ORDER BY f.created_at DESC))[1]        AS cluster_label
    FROM audit_findings f
    JOIN audit_runs r ON r.id = f.run_id
    WHERE r.repo_id = p_repo_id
    GROUP BY 1
    HAVING count(DISTINCT f.run_id) >= 2          -- recurring across >=2 runs
  ),
  upserted AS (
    INSERT INTO recurring_finding_clusters
      (repo_id, cluster_hash, severity_history, files_affected,
       first_seen, last_seen, occurrence_count, latest_finding_id, cluster_label)
    SELECT
      p_repo_id, c.cluster_hash, c.severity_history,
      coalesce(c.files_affected, '{}'),
      c.first_seen, c.last_seen, c.occurrence_count, c.latest_finding_id, c.cluster_label
    FROM clustered c
    ON CONFLICT (repo_id, cluster_hash) DO UPDATE SET
      severity_history  = EXCLUDED.severity_history,
      files_affected    = EXCLUDED.files_affected,
      last_seen         = EXCLUDED.last_seen,
      occurrence_count  = EXCLUDED.occurrence_count,
      latest_finding_id = EXCLUDED.latest_finding_id,
      cluster_label     = EXCLUDED.cluster_label
      -- status is NOT touched: a human deferral (defer_finding) or a fix
      -- adjudication owns it; the refresh only maintains the recurrence stats.
    RETURNING 1
  )
  SELECT count(*) INTO v_upserted FROM upserted;

  RETURN v_upserted;
END;
$$;

-- Single-tenant store; grant EXECUTE to the runtime roles that the audit-loop
-- uses (mirrors the other RPC grants).
GRANT EXECUTE ON FUNCTION refresh_recurring_clusters(uuid) TO authenticated, service_role;
