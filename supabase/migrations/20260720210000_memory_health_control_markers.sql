-- ============================================================================
-- memory_health_metrics — cluster-density honesty patch (2026-07-20).
--
-- The gate read AMBER on cluster density (116 median pairs vs a threshold of
-- 5). Investigating the pairs rather than trusting the number found the metric
-- was measuring three things at once, two of which were defects.
--
--   1. CONTROL MARKERS COUNTED AS FINDINGS (44% of the raw signal).
--      The adjacency wave emits a machine-generated coverage notice —
--      `ADJACENCY_INCOMPLETE (enumeration-bound): maxContainers=20 reached …`
--      — verbatim, every time it hits its cap. 22 such rows in a 30-day
--      window, pairing at similarity 1.00 with each other. That is not
--      duplicated FINDINGS, it is one control-state message emitted by design,
--      and it would have kept this trigger firing forever.
--
--      The filter matches the detail SENTINEL, not the category prefix. The
--      same wave also emits `[Adjacency] Statement may be trapped inside a
--      conditional`, which is a real HIGH finding — excluding `[Adjacency]%`
--      wholesale would have dropped genuine signal to silence noise.
--
--   2. `open_findings` DID NOT MEAN OPEN FINDINGS.
--      It was `COUNT(DISTINCT a.id)` over the pair JOIN, so it counted only
--      findings that already had a trigram-matching partner. The report read
--      "116 pairs across 48 open findings" when 238 findings were considered
--      (671 open in the window). A denominator that only counts things which
--      matched makes any ratio built on it meaningless.
--
--   3. REPOS WITH ZERO PAIRS WERE EXCLUDED FROM THE MEDIAN.
--      `per_repo_pairs` INNER JOINs open findings to themselves, so a repo
--      with no similar pair produced no row, vanished before
--      `percentile_cont`, and the median was taken over "repos that have
--      duplication" only — structurally unable to report a healthy median
--      while any repo was unhealthy. Now LEFT JOINed from the per-repo
--      population, so a clean repo contributes its honest 0.
--
-- Net effect on the reading that prompted this: 89 raw pairs → 49 after
-- excluding control markers. Still ~10x the threshold, so the AMBER is REAL —
-- the remaining pairs are genuine near-duplicates that fingerprinting missed
-- (five different wordings of one brainstorm→requirements coupling finding,
-- and a symmetric duplication finding counted from both directions). The point
-- of this patch is that the decision to prototype pgvector should fire on the
-- 49, not on the 89.
--
-- Retains everything from the earlier perf patch:
--   * `%` trigram operator so pg_trgm's GIN index prunes before similarity()
--   * LEFT(detail_snapshot, 500)
--   * per-repo cap of 200 most recent
--   * raised statement_timeout
-- ============================================================================

CREATE OR REPLACE FUNCTION memory_health_metrics(
  window_days INT DEFAULT 30,
  similarity_reraise NUMERIC DEFAULT 0.6,
  similarity_cluster NUMERIC DEFAULT 0.5,
  max_pairs_per_repo INT DEFAULT 1000
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET statement_timeout = '120s'
AS $$
DECLARE
  result JSONB;
  window_start TIMESTAMPTZ := NOW() - (window_days || ' days')::INTERVAL;
  -- Machine-emitted CONTROL-STATE sentinels: messages a wave prints about its
  -- OWN execution (coverage caps, aborts), not defects in the audited code.
  -- They are byte-identical by construction, so they pair at similarity 1.00
  -- with every sibling and dominate cluster density.
  --
  -- Matched on the detail-snapshot PREFIX, deliberately not the category — the
  -- adjacency wave emits real findings under the same `[Adjacency]` prefix.
  -- Add a sentinel here when a new wave starts emitting control state.
  control_marker_prefixes TEXT[] := ARRAY['ADJACENCY_INCOMPLETE'];
  total_in_window INT;
  new_fp_count INT;
  fuzzy_matched_count INT;
  fuzzy_samples JSONB;
  cluster_per_repo JSONB;
  median_pairs NUMERIC;
  fixed_count INT;
  recurred_count INT;
  recurrence_samples JSONB;
  per_repo_cap INT := 200;
BEGIN
  -- Tune the `%` operator threshold to the lower of the two configured
  -- cutoffs so the GIN index prunes aggressively for both metrics 1 and 2.
  PERFORM set_limit(LEAST(similarity_reraise, similarity_cluster)::real);

  SELECT COUNT(*) INTO total_in_window
  FROM audit_findings
  WHERE created_at >= window_start;

  -- -------------------------------------------------------------------
  -- Metric 1: Fuzzy re-raise rate
  -- -------------------------------------------------------------------
  WITH recent AS (
    SELECT
      f.id,
      f.finding_fingerprint,
      LEFT(f.detail_snapshot, 500) AS snap,
      f.created_at,
      r.repo_id
    FROM audit_findings f
    JOIN audit_runs r ON r.id = f.run_id
    WHERE f.created_at >= window_start
      AND f.detail_snapshot IS NOT NULL
      AND length(f.detail_snapshot) >= 30
  ),
  new_fingerprints AS (
    SELECT rec.*
    FROM recent rec
    WHERE NOT EXISTS (
      SELECT 1 FROM audit_findings prior
      JOIN audit_runs pr ON pr.id = prior.run_id
      WHERE prior.finding_fingerprint = rec.finding_fingerprint
        AND prior.created_at < rec.created_at
        AND pr.repo_id = rec.repo_id
    )
  ),
  priors AS (
    SELECT
      prior.id AS prior_id,
      prior.finding_fingerprint AS prior_fp,
      LEFT(prior.detail_snapshot, 500) AS snap,
      prior.created_at AS prior_created,
      pr.repo_id
    FROM audit_findings prior
    JOIN audit_runs pr ON pr.id = prior.run_id
    WHERE prior.created_at >= window_start - INTERVAL '60 days'
      AND prior.detail_snapshot IS NOT NULL
      AND length(prior.detail_snapshot) >= 30
  ),
  fuzzy_matches AS (
    SELECT
      nf.id AS finding_id,
      p.prior_id AS matched_finding_id,
      similarity(nf.snap, p.snap) AS sim
    FROM new_fingerprints nf
    JOIN priors p
      ON p.repo_id = nf.repo_id
     AND p.prior_fp != nf.finding_fingerprint
     AND p.prior_id != nf.id
     AND p.prior_created < nf.created_at
     AND nf.snap % p.snap                        -- indexed trigram filter
    WHERE similarity(nf.snap, p.snap) > similarity_reraise
  ),
  best_match AS (
    SELECT DISTINCT ON (finding_id)
      finding_id, matched_finding_id, sim
    FROM fuzzy_matches
    ORDER BY finding_id, sim DESC
  )
  SELECT
    (SELECT COUNT(*) FROM new_fingerprints),
    (SELECT COUNT(*) FROM best_match),
    COALESCE(
      (SELECT jsonb_agg(row_to_json(s.*)) FROM (
        SELECT finding_id, matched_finding_id, ROUND(sim::numeric, 3) AS similarity
        FROM best_match
        ORDER BY sim DESC
        LIMIT 5
      ) s),
      '[]'::jsonb
    )
  INTO new_fp_count, fuzzy_matched_count, fuzzy_samples;

  -- -------------------------------------------------------------------
  -- Metric 2: Cluster density (capped at `per_repo_cap` most recent open
  -- findings per repo to bound compute).
  -- -------------------------------------------------------------------
  WITH open_base AS (
    SELECT
      f.id,
      f.finding_fingerprint,
      LEFT(f.detail_snapshot, 500) AS snap,
      r.repo_id,
      ar.name AS repo_name,
      f.created_at
    FROM audit_findings f
    JOIN audit_runs r ON r.id = f.run_id
    LEFT JOIN audit_repos ar ON ar.id = r.repo_id
    WHERE f.created_at >= window_start
      AND f.detail_snapshot IS NOT NULL
      AND length(f.detail_snapshot) >= 30
      -- Defect 1: control-state markers are not findings (see header).
      AND NOT EXISTS (
        SELECT 1 FROM unnest(control_marker_prefixes) p
        WHERE starts_with(f.detail_snapshot, p)
      )
      AND NOT EXISTS (
        SELECT 1 FROM finding_adjudication_events ev
        WHERE ev.finding_id = f.id
          AND (ev.adjudication_outcome = 'dismissed'
               OR ev.remediation_state IN ('fixed', 'verified'))
      )
  ),
  open_ranked AS (
    SELECT *,
      ROW_NUMBER() OVER (PARTITION BY repo_id ORDER BY created_at DESC) AS rn
    FROM open_base
  ),
  open_findings AS (
    SELECT id, finding_fingerprint, snap, repo_id, repo_name
    FROM open_ranked
    WHERE rn <= per_repo_cap
  ),
  -- Defect 2: the honest per-repo denominator — every considered finding,
  -- computed BEFORE any pair matching, so it does not silently mean
  -- "findings that already had a match".
  per_repo_population AS (
    SELECT repo_id, MAX(repo_name) AS repo_name, COUNT(*) AS open_findings
    FROM open_findings
    GROUP BY repo_id
  ),
  per_repo_pairs AS (
    SELECT
      a.repo_id,
      COUNT(DISTINCT a.id) FILTER (
        WHERE a.finding_fingerprint != b.finding_fingerprint
          AND similarity(a.snap, b.snap) > similarity_cluster
      ) AS findings_with_a_match,
      COUNT(*) FILTER (
        WHERE a.id < b.id
          AND a.finding_fingerprint != b.finding_fingerprint
          AND similarity(a.snap, b.snap) > similarity_cluster
      ) AS similar_pairs
    FROM open_findings a
    JOIN open_findings b
      ON a.repo_id = b.repo_id
     AND a.id < b.id
     AND a.snap % b.snap                        -- indexed trigram filter
    GROUP BY a.repo_id
  ),
  -- Defect 3: LEFT JOIN from the POPULATION, not the pair set — a repo with
  -- zero similar pairs must contribute a 0 to the median rather than vanish
  -- from it. The old INNER JOIN made a healthy median unreachable while any
  -- repo had duplication.
  capped AS (
    SELECT
      pop.repo_id,
      pop.repo_name,
      pop.open_findings,
      COALESCE(pr.findings_with_a_match, 0) AS findings_with_a_match,
      LEAST(COALESCE(pr.similar_pairs, 0), max_pairs_per_repo) AS similar_pairs
    FROM per_repo_population pop
    LEFT JOIN per_repo_pairs pr ON pr.repo_id = pop.repo_id
  )
  SELECT
    COALESCE(jsonb_agg(row_to_json(c.*) ORDER BY c.similar_pairs DESC), '[]'::jsonb),
    COALESCE(
      percentile_cont(0.5) WITHIN GROUP (ORDER BY c.similar_pairs),
      0
    )
  INTO cluster_per_repo, median_pairs
  FROM capped c;

  -- -------------------------------------------------------------------
  -- Metric 3: Fixed-finding recurrence
  -- -------------------------------------------------------------------
  WITH fixed AS (
    SELECT DISTINCT ON (f.id)
      f.id,
      LEFT(f.detail_snapshot, 500) AS snap,
      f.finding_fingerprint,
      r.repo_id,
      ev.created_at AS fixed_at
    FROM audit_findings f
    JOIN audit_runs r ON r.id = f.run_id
    JOIN finding_adjudication_events ev ON ev.finding_id = f.id
    WHERE ev.remediation_state IN ('fixed', 'verified')
      AND ev.created_at >= window_start - INTERVAL '30 days'
      AND f.detail_snapshot IS NOT NULL
      AND length(f.detail_snapshot) >= 30
    ORDER BY f.id, ev.created_at DESC
  ),
  laters AS (
    SELECT
      later.id,
      later.finding_fingerprint,
      LEFT(later.detail_snapshot, 500) AS snap,
      lr.repo_id,
      later.created_at
    FROM audit_findings later
    JOIN audit_runs lr ON lr.id = later.run_id
    WHERE later.detail_snapshot IS NOT NULL
      AND length(later.detail_snapshot) >= 30
      AND later.created_at >= window_start - INTERVAL '30 days'
  ),
  recurred AS (
    SELECT
      fx.id AS fixed_id,
      l.id AS recurred_id,
      similarity(fx.snap, l.snap) AS sim
    FROM fixed fx
    JOIN laters l
      ON l.repo_id = fx.repo_id
     AND l.id != fx.id
     AND l.finding_fingerprint != fx.finding_fingerprint
     AND l.created_at >  fx.fixed_at
     AND l.created_at <= fx.fixed_at + INTERVAL '30 days'
     AND fx.snap % l.snap                         -- indexed trigram filter
    WHERE similarity(fx.snap, l.snap) > similarity_reraise
  ),
  best_recur AS (
    SELECT DISTINCT ON (fixed_id)
      fixed_id, recurred_id, sim
    FROM recurred
    ORDER BY fixed_id, sim DESC
  )
  SELECT
    (SELECT COUNT(*) FROM fixed),
    (SELECT COUNT(*) FROM best_recur),
    COALESCE(
      (SELECT jsonb_agg(row_to_json(s.*)) FROM (
        SELECT fixed_id, recurred_id, ROUND(sim::numeric, 3) AS similarity
        FROM best_recur
        ORDER BY sim DESC
        LIMIT 5
      ) s),
      '[]'::jsonb
    )
  INTO fixed_count, recurred_count, recurrence_samples;

  result := jsonb_build_object(
    'generated_at', NOW(),
    'window_days', window_days,
    'total_findings_in_window', total_in_window,
    'fuzzy_reraise', jsonb_build_object(
      'new_fingerprints', new_fp_count,
      'fuzzy_matched', fuzzy_matched_count,
      'rate', CASE WHEN new_fp_count > 0
                   THEN ROUND((fuzzy_matched_count::numeric / new_fp_count), 4)
                   ELSE 0 END,
      'samples', fuzzy_samples
    ),
    'cluster_density', jsonb_build_object(
      'per_repo', cluster_per_repo,
      'median_similar_pairs', median_pairs
    ),
    'recurrence', jsonb_build_object(
      'fixed_findings', fixed_count,
      'recurred', recurred_count,
      'rate', CASE WHEN fixed_count > 0
                   THEN ROUND((recurred_count::numeric / fixed_count), 4)
                   ELSE 0 END,
      'samples', recurrence_samples
    )
  );

  RETURN result;
END;
$$;

GRANT EXECUTE ON FUNCTION memory_health_metrics(INT, NUMERIC, NUMERIC, INT) TO anon, authenticated;
