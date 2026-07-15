-- ╔═══════════════════════════════════════════════════════════════════════════╗
-- ║  symbol_duplicate_justification — @duplicate-justification pragma reaches  ║
-- ║  the whole-repo drift score, not just /audit-code's diff-scoped pass       ║
-- ║                                                                            ║
-- ║  Plan: docs/plans/arch-drift-duplication-cleanup.md. Mirrors               ║
-- ║  symbol_layering_violations exactly: fully recomputed every refresh        ║
-- ║  (incremental or full), never incrementally patched — a removed pragma     ║
-- ║  must correctly un-flag its row on the very next refresh.                  ║
-- ║                                                                            ║
-- ║  Semantics: the pragma marks the DECLARATION IT SITS ABOVE as an           ║
-- ║  acknowledged duplicate. A symbol_index row belongs to exactly one         ║
-- ║  (signature_hash, kind) cluster by construction, so "exclude this row"     ║
-- ║  and "exclude what the pragma names as its target" are equivalent once     ║
-- ║  you account for that — target/source are persisted as audit-trail        ║
-- ║  fields (what a reviewer sees), not as a machine-verified pairwise link.   ║
-- ╚═══════════════════════════════════════════════════════════════════════════╝

ALTER TABLE symbol_index ADD COLUMN IF NOT EXISTS duplicate_justified BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE symbol_index ADD COLUMN IF NOT EXISTS duplicate_justification_reason TEXT;
ALTER TABLE symbol_index ADD COLUMN IF NOT EXISTS duplicate_justification_target TEXT;
ALTER TABLE symbol_index ADD COLUMN IF NOT EXISTS duplicate_justification_source TEXT;

-- ── top_duplicate_clusters: exclude justified rows from cluster membership ──

CREATE OR REPLACE FUNCTION top_duplicate_clusters(
  p_repo_id     UUID,
  p_refresh_id  UUID,
  p_limit       INTEGER DEFAULT 20
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
    GROUP BY si.signature_hash, sd.kind
    HAVING COUNT(DISTINCT si.file_path) > 1
  )
  SELECT signature_hash, kind, file_count, symbol_names, file_paths, example_purpose
    FROM bucket
    ORDER BY file_count DESC, signature_hash
    LIMIT p_limit;
$$;

GRANT EXECUTE ON FUNCTION top_duplicate_clusters(UUID, UUID, INTEGER)
  TO anon, authenticated, service_role;

-- ── drift_score: exclude justified rows from the duplication-pair count,    ──
-- ── report a row-level duplication_excluded_count alongside it             ──

CREATE OR REPLACE FUNCTION drift_score(
  p_repo_id     UUID,
  p_refresh_id  UUID,
  p_sim_dup     NUMERIC DEFAULT 0.85,   -- kept for backwards-compat; unused in v3
  p_sim_name    NUMERIC DEFAULT 0.90    -- kept for backwards-compat; unused in v3
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_dup_pairs    INTEGER;
  v_violations   INTEGER;
  v_naming_div   INTEGER;
  v_score        NUMERIC;
  v_total        INTEGER;
  v_with_hash    INTEGER;
  v_excluded     INTEGER;
BEGIN
  -- Lightweight snapshot stats so callers can see denominators
  SELECT COUNT(*) INTO v_total
  FROM symbol_index
  WHERE refresh_id = p_refresh_id;

  SELECT COUNT(*) INTO v_with_hash
  FROM symbol_index
  WHERE refresh_id = p_refresh_id
    AND signature_hash IS NOT NULL
    AND signature_hash <> '';

  -- Layering violations (cheap, no embedding work)
  SELECT COUNT(*) INTO v_violations
  FROM symbol_layering_violations
  WHERE refresh_id = p_refresh_id;

  -- Cross-file exact-duplicate pairs, excluding @duplicate-justification-
  -- marked rows from cluster membership (arch-drift-duplication-cleanup).
  WITH bucket_files AS (
    SELECT
      si.signature_hash,
      sd.kind,
      COUNT(DISTINCT si.file_path) AS file_count
    FROM symbol_index si
    JOIN symbol_definitions sd ON sd.id = si.definition_id
    WHERE si.refresh_id = p_refresh_id
      AND si.signature_hash IS NOT NULL
      AND si.signature_hash <> ''
      AND si.duplicate_justified = false
    GROUP BY si.signature_hash, sd.kind
    HAVING COUNT(DISTINCT si.file_path) > 1
  )
  SELECT COALESCE(SUM((file_count * (file_count - 1)) / 2)::INTEGER, 0)
    INTO v_dup_pairs
    FROM bucket_files;

  -- Row-level count of excluded DECLARATIONS (a distinct quantity from
  -- v_dup_pairs above, which counts cluster PAIRS post-exclusion): a
  -- justified row only counts here if it would otherwise have shared its
  -- (signature_hash, kind) cluster identity with >=1 other file — a pragma
  -- on a symbol with no real duplicate contributes 0, not a phantom count.
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

  -- Naming divergence: still a v2 placeholder (would need symbolName +
  -- purpose-similarity scoring across buckets — covered by /explain and
  -- plan-time getNeighbourhood today).
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

GRANT EXECUTE ON FUNCTION drift_score(UUID, UUID, NUMERIC, NUMERIC)
  TO anon, authenticated, service_role;
