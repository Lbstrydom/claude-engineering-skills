-- ============================================================================
-- memory_health_semantic_cluster — scope cosine pairs to ONE vector space.
--
-- Why (2026-08-30): this was the last unscoped reader of `finding_embeddings`.
-- The table's `embedding_model` column was written by three writers and read by
-- NO query; the btree index on `(embedding_model, dimension)` served nothing.
-- Every similarity read compared cosine across whatever models the table
-- happened to hold, and a cosine between two embedding models is not a
-- similarity — it is a number. Commit 081cbbfc made the writers' provenance
-- truthful and scoped `nearestOpenReRaise`, the `semantic-suppress` reconciler,
-- the pgvector prototype and `getFindingEmbeddings`. This closes the metric.
--
-- Measured on a live consumer store the same day: 3145 rows, ALL labelled
-- `gemini-embedding-001`, on a repo whose `AZURE_OPENAI_ENDPOINT` is set — i.e.
-- an unknown share of those vectors were made by Azure `text-embedding-3-large`
-- and labelled as Gemini. Once those rows are re-embedded under their true
-- endpoint-qualified identity, a store legitimately holds two spaces at once,
-- and this function would have counted cross-space pairs as churn.
--
-- TWO changes, and the second is the non-obvious one:
--
-- 1. PAIR SCOPING. A pair must share `(embedding_model, dimension)`. Expressed
--    as a predicate between `a` and `b` rather than as a function parameter,
--    deliberately: this RPC is CROSS-REPO, and different repos legitimately sit
--    in different spaces (this source repo is on Gemini; a corporate consumer is
--    on Azure). A single global model filter would be wrong for every repo but
--    one. The pair predicate is correct for all of them and needs no argument,
--    so the function signature — and therefore every existing caller — is
--    unchanged.
--
-- 2. COVERAGE MUST FOLLOW, or fixing (1) INTRODUCES a false clean. Pairs can
--    only form within a space, so for a repo split across two, the population
--    that can actually be compared is the LARGEST space, not the total embedded
--    count. Leaving `coverage_pct` as embedded/open would report ~100% coverage
--    over a store where half the rows can never be compared to the other half —
--    a high-confidence GREEN derived from a halved population. That is precisely
--    the false-clean the coverage number exists to prevent.
--
--    So `coverage_pct` is now comparable/open. This deliberately reuses the
--    EXISTING `unknown` machinery instead of adding a field: memory-health.mjs
--    already degrades a below-floor `coverage.pct` to `unknown` rather than
--    green (`clusterMinCoverage`, default 0.5). A repo split 50/50 across two
--    spaces therefore reads `unknown` — correct, and with no new reader logic. A
--    new field that nothing read would have repeated the very defect this
--    migration closes.
--
--    `embedded_findings` keeps its old meaning (embedded in ANY space) and
--    `comparable_findings` + `embedding_spaces` are added beside it, so the
--    per-repo breakdown can say WHY coverage dropped rather than just that it
--    did. Both are consumed by scripts/memory-health.mjs.
--
-- `CREATE OR REPLACE FUNCTION` resets the whole `proconfig` array AND the ACL
-- (AGENTS.md, Memory-Health Gate §3), so both `SET` clauses and the GRANT are
-- re-stated below verbatim. Verified after applying with `pg_proc.proconfig`
-- and `pg_proc.proacl`, not by reading this file.
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
  total_comparable INT;
BEGIN
  WITH open_base AS (
    -- The SAME population memory_health_metrics counts (window, length,
    -- control-marker exclusion, not dismissed/fixed), LEFT-joined to embeddings
    -- so unembedded rows are still counted for coverage.
    SELECT f.id, f.finding_fingerprint AS fp, f.primary_file, f.run_id,
           r.repo_id, ar.name AS repo_name, f.created_at,
           e.embedding,
           -- The vector-space identity. NULL for an unembedded row, which is
           -- why `has_emb` still gates participation: NULL = NULL is not true
           -- in the pair predicate, so an unembedded row could never pair
           -- anyway, but the explicit flag keeps the coverage counts readable.
           e.embedding_model,
           e.dimension,
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
  -- Per-repo size of each vector space present. Feeds `comparable_findings`
  -- (the largest space — the only population whose members can all be compared
  -- to one another) and `embedding_spaces`.
  per_repo_space AS (
    SELECT repo_id, embedding_model, dimension, COUNT(*) AS space_findings
    FROM capped
    WHERE has_emb
    GROUP BY repo_id, embedding_model, dimension
  ),
  per_repo_space_rollup AS (
    SELECT repo_id,
           COUNT(*)                       AS embedding_spaces,
           COALESCE(MAX(space_findings), 0) AS comparable_findings
    FROM per_repo_space
    GROUP BY repo_id
  ),
  -- Coverage denominator: every considered finding, embedded or not.
  per_repo_population AS (
    SELECT repo_id, MAX(repo_name) AS repo_name,
           COUNT(*) AS open_findings,
           COUNT(*) FILTER (WHERE has_emb) AS embedded_findings
    FROM capped
    GROUP BY repo_id
  ),
  -- The re-raise shape: same-file, cross-run, cross-fingerprint, cosine > τ,
  -- WITHIN ONE VECTOR SPACE. Only embedded rows participate; the coverage
  -- number qualifies the result.
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
                 -- The space predicate. Also makes the `<=>` operator safe: a
                 -- dimension mismatch raises rather than returning a number.
                 AND a.embedding_model = b.embedding_model
                 AND a.dimension = b.dimension
    WHERE a.has_emb AND b.has_emb
    GROUP BY a.repo_id
  ),
  -- LEFT JOIN from the population so a clean repo contributes a 0 to the median.
  merged AS (
    SELECT pop.repo_id, pop.repo_name, pop.open_findings, pop.embedded_findings,
           COALESCE(sp.comparable_findings, 0) AS comparable_findings,
           COALESCE(sp.embedding_spaces, 0)    AS embedding_spaces,
           -- comparable/open, NOT embedded/open. See header note 2.
           CASE WHEN pop.open_findings > 0
                THEN round(100.0 * COALESCE(sp.comparable_findings, 0) / pop.open_findings)
                ELSE 0 END AS coverage_pct,
           COALESCE(pr.similar_pairs, 0) AS similar_pairs
    FROM per_repo_population pop
    LEFT JOIN per_repo_pairs pr ON pr.repo_id = pop.repo_id
    LEFT JOIN per_repo_space_rollup sp ON sp.repo_id = pop.repo_id
  )
  SELECT
    COALESCE(jsonb_agg(row_to_json(m.*) ORDER BY m.similar_pairs DESC), '[]'::jsonb),
    COALESCE(percentile_cont(0.5) WITHIN GROUP (ORDER BY m.similar_pairs), 0),
    COALESCE(SUM(m.open_findings), 0),
    COALESCE(SUM(m.embedded_findings), 0),
    COALESCE(SUM(m.comparable_findings), 0)
  INTO per_repo, median_pairs, total_open, total_embedded, total_comparable
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
      -- The population that can actually be compared. `pct` is derived from
      -- THIS, not from `embedded`, so a store holding two vector spaces reads
      -- as reduced coverage (→ `unknown`) instead of a false clean.
      'comparable', total_comparable,
      'pct', CASE WHEN total_open > 0 THEN round(100.0 * total_comparable / total_open) ELSE 0 END
    ),
    'per_repo', per_repo
  );

  RETURN result;
END;
$$;

-- `CREATE OR REPLACE` above dropped the ACL; re-state it (see header).
GRANT EXECUTE ON FUNCTION memory_health_semantic_cluster(INT, NUMERIC, INT, TEXT[]) TO anon, authenticated;
