-- ╔═══════════════════════════════════════════════════════════════════════════╗
-- ║  duplicate_min_lines_floor — size floor for duplicate clusters AND score   ║
-- ║                                                                            ║
-- ║  Plan: docs/plans/duplicate-min-lines-floor.md. A 2-5 line test helper     ║
-- ║  (`sleep`, `sha256`) duplicated across test files is not refactor debt,    ║
-- ║  yet it formed clusters and inflated drift_score. p_min_lines (default 0 = ║
-- ║  off, byte-identical legacy behaviour) drops symbols whose line span       ║
-- ║  end_line - start_line + 1 is below the floor BEFORE grouping, in BOTH     ║
-- ║  RPCs, so the list and the score cannot disagree. Rows with a NULL span    ║
-- ║  are KEPT: unknown size is never silently suppressed.                      ║
-- ║                                                                            ║
-- ║  Adding an argument makes a DIFFERENT function (CREATE OR REPLACE would    ║
-- ║  leave the old overload beside it, with the default EXECUTE-to-PUBLIC ACL),║
-- ║  so each is DROPped and recreated, ACL restated. Old 3-/4-arg call shapes  ║
-- ║  keep resolving through the defaulted trailing argument. Forward-only.     ║
-- ╚═══════════════════════════════════════════════════════════════════════════╝

BEGIN;

DROP FUNCTION IF EXISTS top_duplicate_clusters(UUID, UUID, INTEGER);

CREATE FUNCTION top_duplicate_clusters(
  p_repo_id     UUID,
  p_refresh_id  UUID,
  p_limit       INTEGER DEFAULT 20,
  p_min_lines   INTEGER DEFAULT 0
)
RETURNS TABLE (
  signature_hash  TEXT,
  kind            TEXT,
  file_count      INTEGER,
  symbol_names    TEXT[],
  file_paths      TEXT[],
  example_purpose TEXT
)
LANGUAGE sql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  WITH bucket AS (
    SELECT
      si.signature_hash,
      sd.kind                                AS kind,
      ARRAY_AGG(DISTINCT sd.symbol_name)     AS symbol_names,
      ARRAY_AGG(DISTINCT si.file_path)       AS file_paths,
      COUNT(DISTINCT si.file_path)::INTEGER  AS file_count,
      (ARRAY_AGG(si.purpose_summary))[1]     AS example_purpose
    FROM symbol_index si
    JOIN symbol_definitions sd ON sd.id = si.definition_id
    WHERE si.refresh_id      = p_refresh_id
      AND sd.repo_id         = p_repo_id
      AND si.signature_hash IS NOT NULL
      AND si.signature_hash <> ''
      AND si.duplicate_justified = false
      AND (COALESCE(p_min_lines, 0) <= 0
           OR si.start_line IS NULL OR si.end_line IS NULL
           OR (si.end_line - si.start_line + 1) >= p_min_lines)
    GROUP BY si.signature_hash, sd.kind
    HAVING COUNT(DISTINCT si.file_path) > 1
  )
  SELECT signature_hash, kind, file_count, symbol_names, file_paths, example_purpose
    FROM bucket
    ORDER BY file_count DESC, signature_hash
    LIMIT p_limit;
$$;

REVOKE EXECUTE ON FUNCTION top_duplicate_clusters(UUID, UUID, INTEGER, INTEGER) FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION top_duplicate_clusters(UUID, UUID, INTEGER, INTEGER) TO service_role;

DROP FUNCTION IF EXISTS drift_score(UUID, UUID, NUMERIC, NUMERIC);

CREATE FUNCTION drift_score(
  p_repo_id     UUID,
  p_refresh_id  UUID,
  p_sim_dup     NUMERIC DEFAULT 0.85,   -- kept for backwards-compat; unused in v3
  p_sim_name    NUMERIC DEFAULT 0.90,   -- kept for backwards-compat; unused in v3
  p_min_lines   INTEGER DEFAULT 0
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_dup_pairs     INTEGER;
  v_violations    INTEGER;
  v_naming_div    INTEGER;
  v_score         NUMERIC;
  v_total         INTEGER;
  v_with_hash     INTEGER;
  v_excluded      INTEGER;
  v_min_lines     INTEGER := GREATEST(COALESCE(p_min_lines, 0), 0);
  v_clusters_before INTEGER;
  v_clusters_after  INTEGER;
  v_pairs_before    INTEGER;
  v_rows_suppressed INTEGER;
BEGIN
  SELECT COUNT(*) INTO v_total
  FROM symbol_index
  WHERE refresh_id = p_refresh_id;

  SELECT COUNT(*) INTO v_with_hash
  FROM symbol_index
  WHERE refresh_id = p_refresh_id
    AND signature_hash IS NOT NULL
    AND signature_hash <> '';

  SELECT COUNT(*) INTO v_violations
  FROM symbol_layering_violations
  WHERE refresh_id = p_refresh_id;

  -- One grouping, two populations: `all` ignores the floor, `kept` applies it.
  -- Same eligibility predicate as top_duplicate_clusters (refresh, repo-scoped
  -- by definition join, non-empty hash, not justified), so the list and these
  -- counts describe one population.
  WITH eligible AS (
    SELECT
      si.signature_hash,
      sd.kind,
      si.file_path,
      (v_min_lines <= 0
        OR si.start_line IS NULL OR si.end_line IS NULL
        OR (si.end_line - si.start_line + 1) >= v_min_lines) AS above_floor
    FROM symbol_index si
    JOIN symbol_definitions sd ON sd.id = si.definition_id
    WHERE si.refresh_id = p_refresh_id
      AND sd.repo_id    = p_repo_id
      AND si.signature_hash IS NOT NULL
      AND si.signature_hash <> ''
      AND si.duplicate_justified = false
  ),
  all_buckets AS (
    SELECT signature_hash, kind, COUNT(DISTINCT file_path) AS file_count
    FROM eligible
    GROUP BY signature_hash, kind
    HAVING COUNT(DISTINCT file_path) > 1
  ),
  kept_buckets AS (
    SELECT signature_hash, kind, COUNT(DISTINCT file_path) AS file_count
    FROM eligible
    WHERE above_floor
    GROUP BY signature_hash, kind
    HAVING COUNT(DISTINCT file_path) > 1
  )
  SELECT
    (SELECT COUNT(*) FROM all_buckets)::INTEGER,
    (SELECT COUNT(*) FROM kept_buckets)::INTEGER,
    COALESCE((SELECT SUM((file_count * (file_count - 1)) / 2) FROM all_buckets), 0)::INTEGER,
    COALESCE((SELECT SUM((file_count * (file_count - 1)) / 2) FROM kept_buckets), 0)::INTEGER,
    (SELECT COUNT(*) FROM eligible e
       WHERE NOT e.above_floor
         AND EXISTS (SELECT 1 FROM all_buckets ab
                      WHERE ab.signature_hash = e.signature_hash AND ab.kind = e.kind))::INTEGER
    INTO v_clusters_before, v_clusters_after, v_pairs_before, v_dup_pairs, v_rows_suppressed;

  SELECT COUNT(*) INTO v_excluded
  FROM symbol_index si
  JOIN symbol_definitions sd ON sd.id = si.definition_id
  WHERE si.refresh_id = p_refresh_id
    AND sd.repo_id = p_repo_id
    AND si.duplicate_justified = true
    AND EXISTS (
      SELECT 1
      FROM symbol_index si2
      JOIN symbol_definitions sd2 ON sd2.id = si2.definition_id
      WHERE si2.refresh_id = si.refresh_id
        AND si2.signature_hash = si.signature_hash
        AND sd2.kind = sd.kind
        AND si2.file_path <> si.file_path
    );

  v_naming_div := 0;

  v_score := COALESCE(v_dup_pairs, 0)::numeric
           + COALESCE(v_violations, 0)::numeric * 2
           + COALESCE(v_naming_div, 0)::numeric;

  RETURN jsonb_build_object(
    'generated_at',              now(),
    'repo_id',                   p_repo_id,
    'refresh_id',                p_refresh_id,
    'duplication_pairs',         v_dup_pairs,
    'duplication_excluded_count', v_excluded,
    'duplication_floor',         jsonb_build_object(
      'min_lines',            v_min_lines,
      'clusters_before',      v_clusters_before,
      'clusters_after',       v_clusters_after,
      'suppressed_clusters',  v_clusters_before - v_clusters_after,
      'pairs_before',         v_pairs_before,
      'pairs_after',          v_dup_pairs,
      'rows_suppressed',      v_rows_suppressed
    ),
    'layering_violations',       v_violations,
    'naming_divergences',        v_naming_div,
    'score',                     v_score,
    'algorithm',                 'signature-hash-exact-v3',
    'snapshot_stats',            jsonb_build_object(
      'total_symbols',     v_total,
      'with_signature',    v_with_hash
    )
  );
END;
$$;

REVOKE EXECUTE ON FUNCTION drift_score(UUID, UUID, NUMERIC, NUMERIC, INTEGER) FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION drift_score(UUID, UUID, NUMERIC, NUMERIC, INTEGER) TO service_role;

COMMIT;
