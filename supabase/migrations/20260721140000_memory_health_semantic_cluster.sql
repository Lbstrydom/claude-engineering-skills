-- ============================================================================
-- memory_health_semantic_cluster — migrate cluster density from trigram to
-- semantic cosine (pgvector), so the gate MEASURES what the semantic
-- suppression ACTS ON.
--
-- Why (2026-07-21): the trigram cluster-density metric (memory_health_metrics
-- metric 2) counts pg_trgm pairs > 0.5 over ANY file, ANY run — a broad signal
-- that stays AMBER on topically-similar-but-distinct findings the semantic
-- suppression was never meant to touch. Now that suppression is live, the gate
-- should track the churn suppression targets: the SAME finding re-raised across
-- audits — i.e. SAME-FILE, CROSS-RUN, high-cosine pairs. Cross-file high-cosine
-- pairs are usually different problems; same-run pairs are within-audit. This
-- RPC measures exactly the re-raise shape.
--
-- Calibrated on real data (2026-07-21, capped at 200 recent/repo):
--   same-file cross-run pairs @ cos 0.92 (the suppression threshold): 1 / 0
--     → suppression works at its own threshold.
--   @ 0.85 (this metric's default): 10 / 18 → the residual the CONSERVATIVE
--     0.92 suppression misses (re-raises reworded past cos 0.92). That residual
--     is the honest, actionable churn the gate should show.
--
-- COVERAGE HONESTY (load-bearing). Only findings WITH an embedding can be
-- scored, and coverage is ~65% today (older findings predate finding_embeddings;
-- new ones are embedded by the record-time hook). So this RPC ALWAYS reports the
-- embedded fraction per repo. A caller must treat a low-coverage GREEN as
-- `unknown`, never authoritative — the unscored findings could harbor churn the
-- metric cannot see. This mirrors the arch-coverage-gate's "absent reads
-- unknown, never clean" rule.
--
-- Kept SEPARATE from memory_health_metrics (not a rewrite of that 300-line
-- function) so the trigram metric survives as a transition companion and this
-- focused function is independently testable. per_repo_cap bounds compute.
-- ============================================================================

CREATE OR REPLACE FUNCTION memory_health_semantic_cluster(
  window_days       INT     DEFAULT 30,
  cosine_threshold  NUMERIC DEFAULT 0.85,
  per_repo_cap      INT     DEFAULT 200,
  control_marker_prefixes TEXT[] DEFAULT ARRAY['ADJACENCY_INCOMPLETE']
) RETURNS JSONB
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
SET statement_timeout = '120s'
AS $$
DECLARE
  result JSONB;
  window_start TIMESTAMPTZ := now() - (window_days || ' days')::INTERVAL;
  per_repo JSONB;
  median_pairs NUMERIC;
  total_open INT;
  total_embedded INT;
BEGIN
  WITH open_base AS (
    -- The SAME population memory_health_metrics counts (window, length,
    -- control-marker exclusion, not dismissed/fixed), LEFT-joined to embeddings
    -- so unembedded rows are still counted for coverage.
    SELECT f.id, f.finding_fingerprint AS fp, f.primary_file, f.run_id,
           r.repo_id, ar.name AS repo_name, f.created_at,
           e.embedding,
           (e.embedding IS NOT NULL) AS has_emb,
           ROW_NUMBER() OVER (PARTITION BY r.repo_id ORDER BY f.created_at DESC) AS rn
    FROM audit_findings f
    JOIN audit_runs r ON r.id = f.run_id
    LEFT JOIN audit_repos ar ON ar.id = r.repo_id
    LEFT JOIN finding_embeddings e ON e.finding_id = f.id
    WHERE f.created_at >= window_start
      AND f.detail_snapshot IS NOT NULL
      AND length(f.detail_snapshot) >= 30
      AND NOT EXISTS (SELECT 1 FROM unnest(control_marker_prefixes) p
                      WHERE starts_with(f.detail_snapshot, p))
      AND NOT EXISTS (SELECT 1 FROM finding_adjudication_events ev
                      WHERE ev.finding_id = f.id
                        AND (ev.adjudication_outcome = 'dismissed'
                             OR ev.remediation_state IN ('fixed', 'verified')))
  ),
  capped AS (SELECT * FROM open_base WHERE rn <= per_repo_cap),
  -- Coverage denominator: every considered finding, embedded or not.
  per_repo_population AS (
    SELECT repo_id, MAX(repo_name) AS repo_name,
           COUNT(*) AS open_findings,
           COUNT(*) FILTER (WHERE has_emb) AS embedded_findings
    FROM capped
    GROUP BY repo_id
  ),
  -- The re-raise shape: same-file, cross-run, cross-fingerprint, cosine > τ.
  -- Only embedded rows participate; the coverage number qualifies the result.
  per_repo_pairs AS (
    SELECT a.repo_id,
           COUNT(*) FILTER (
             WHERE a.id < b.id
               AND a.fp <> b.fp
               AND a.primary_file = b.primary_file
               AND a.run_id <> b.run_id
               AND (1 - (a.embedding <=> b.embedding)) > cosine_threshold
           ) AS similar_pairs
    FROM capped a
    JOIN capped b ON a.repo_id = b.repo_id AND a.id < b.id
    WHERE a.has_emb AND b.has_emb
    GROUP BY a.repo_id
  ),
  -- LEFT JOIN from the population so a clean repo contributes a 0 to the median.
  merged AS (
    SELECT pop.repo_id, pop.repo_name, pop.open_findings, pop.embedded_findings,
           CASE WHEN pop.open_findings > 0
                THEN round(100.0 * pop.embedded_findings / pop.open_findings)
                ELSE 0 END AS coverage_pct,
           COALESCE(pr.similar_pairs, 0) AS similar_pairs
    FROM per_repo_population pop
    LEFT JOIN per_repo_pairs pr ON pr.repo_id = pop.repo_id
  )
  SELECT
    COALESCE(jsonb_agg(row_to_json(m.*) ORDER BY m.similar_pairs DESC), '[]'::jsonb),
    COALESCE(percentile_cont(0.5) WITHIN GROUP (ORDER BY m.similar_pairs), 0),
    COALESCE(SUM(m.open_findings), 0),
    COALESCE(SUM(m.embedded_findings), 0)
  INTO per_repo, median_pairs, total_open, total_embedded
  FROM merged m;

  result := jsonb_build_object(
    'generated_at', now(),
    'window_days', window_days,
    'cosine_threshold', cosine_threshold,
    'similarity', 'semantic-cosine-samefile-xrun',
    'median_similar_pairs', median_pairs,
    'coverage', jsonb_build_object(
      'open_total', total_open,
      'embedded', total_embedded,
      'pct', CASE WHEN total_open > 0 THEN round(100.0 * total_embedded / total_open) ELSE 0 END
    ),
    'per_repo', per_repo
  );
  RETURN result;
END;
$$;

GRANT EXECUTE ON FUNCTION memory_health_semantic_cluster(INT, NUMERIC, INT, TEXT[]) TO anon, authenticated;
