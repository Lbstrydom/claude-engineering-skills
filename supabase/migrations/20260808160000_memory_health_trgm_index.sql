-- ============================================================================
-- memory_health_metrics — the trigram prefilter was never indexed (2026-08-08).
--
-- SYMPTOM. The weekly memory-health gate had been silently degraded for
-- months. Against Supabase `npm run memory:health` died at 121s with
-- "canceling statement due to statement timeout"; against the self-hosted NAS
-- Postgres (no server-side cap) `select * from memory_health_metrics(30)` ran
-- past 15 minutes without completing, so the local maintenance replica's
-- 5-minute per-check spawn budget (scripts/maintenance-checks.mjs) reported
-- `spawn ETIMEDOUT`. A gate that never returns measures nothing.
--
-- ROOT CAUSE. The 2026-04-21 perf patch (20260421163657) added a `%` trigram
-- operator to metrics 1, 2 and 3, commented `-- indexed trigram filter`, and
-- in the SAME edit truncated both operands to `LEFT(detail_snapshot, 500)`.
-- The truncation disabled the index the operator was added to use:
-- `audit_findings_detail_trgm_idx` is a GIN index on the BARE
-- `detail_snapshot` column, and it cannot serve
-- `left(detail_snapshot,500) % left(...,500)` — that is a different
-- expression. With no index to probe, the planner hash-joins on `repo_id`
-- alone and evaluates `%` (and then `similarity()` again) as a Join Filter
-- over every surviving pair.
--
-- MEASURED on the NAS store (3,609 findings / 585 runs / 4 repos, 2026-08-08):
--
--   metric              candidate pairs   plan                        time
--   ------------------  ---------------   -------------------------   -------
--   1 fuzzy re-raise      3,695,111       hash join, `%` in filter    >15 min
--   2 cluster density        79,924       hash join, `%` in filter     10.8 s
--   3 recurrence            709,852       hash join, `%` in filter    208.8 s
--
--   ~135 microseconds per candidate pair — TWO full trigram similarity
--   computations over ~350-char strings (`%` then `similarity()`).
--
-- The asymmetry is the tell: metric 2 survived only because the same perf
-- patch capped it at `per_repo_cap = 200` most-recent findings per repo.
-- Metrics 1 and 3 have no cap, so they are the ones that ran away. The 30-day
-- window prunes nothing either — the whole table currently falls inside it.
--
-- THE FIX, in three parts. Each was kept only because a measurement showed
-- the other two were not enough — the planner picked a different wrong plan
-- at every step, so each part is load-bearing:
--
--   1. Index the expression that is actually compared. A GIN index on
--      `left(detail_snapshot, 500)` makes the `%` prefilter genuinely
--      indexed — which is what the 2026-04-21 patch intended and documented.
--      Truncation semantics are PRESERVED exactly; 25% of rows exceed 500
--      chars, so simply dropping `LEFT(...)` to reuse the bare-column index
--      would have quietly changed a quarter of the measurements. A perf fix
--      must not move the numbers.
--
--   2. Rewrite metrics 1 and 3 as LATERAL best-match probes, with the trigram
--      lookup fenced behind `OFFSET 0`. The index alone is NOT enough, and
--      the LATERAL alone is not either. Measured, 200 driving rows:
--
--        plain join,   no index          `%` in Join Filter        3.7M pairs
--        LATERAL,      index available   planner picked the
--                                        created_at btree instead,
--                                        `%` back in the filter    477 ms/probe
--        LATERAL + `OFFSET 0` fence      Bitmap Index Scan on
--                                        the trgm index             55 ms/probe
--
--      The planner keeps choosing badly because it costs `%` at 1 unit when
--      it measures ~65us. The `OFFSET 0` optimisation fence removes the
--      choice: the inner subquery carries ONLY the `%` predicate, so the trgm
--      index is its only access path, and the selective-but-cheap filters are
--      applied to its ~5-29 surviving rows instead of to 1,785 heap rows.
--      The inner `LIMIT 1` also subsumes the old
--      `DISTINCT ON (finding_id) ... ORDER BY sim DESC` best-match step.
--
--   3. Bound the DRIVING set of metrics 1 and 3 by the same `per_repo_cap`
--      metric 2 has had since 2026-04-21. Parts 1+2 remove the quadratic but
--      leave a linear term the gate cannot afford: a GIN `%` probe costs
--      ~55ms here almost independently of the threshold (raising it from 0.5
--      to the metric's own 0.6 cutoff cut candidates 29 -> 5 but the index
--      scan only 56.5ms -> 55.4ms), because the cost is dominated by merging
--      posting lists for the ~350 trigrams of the search key. At 3,589
--      probes that is ~200s for metric 1 alone — inside the 5-minute budget
--      only barely, and growing with every finding recorded.
--
--      WHICH side is capped is the whole correctness question. The cap is on
--      the DRIVING set (the findings being asked about), never on the set
--      being SEARCHED. Capping the search set would drop real matches and
--      bias `fuzzy_matched` down — a false GREEN, the one failure this gate
--      exists to prevent. Capping the driving set instead takes the N most
--      recent findings per repo and shrinks numerator and denominator
--      together, so the published RATE stays an unbiased estimate over recent
--      findings. That is exactly the shape metric 2's cap already had.
--
--      NOT SILENT. `new_fingerprints_total` / `fixed_findings_total` and
--      `per_repo_cap` are now published alongside the considered counts, so a
--      truncated population can never read as full coverage.
--
-- EQUIVALENCE, measured not assumed. Both formulations were run over an
-- identical 400-row sample of new-fingerprint findings, with the exhaustive
-- side carrying NO `%` prefilter at all (pure ground truth, 298s):
--
--   matched count            22 vs 22          identical
--   set of matched findings  identical
--   best similarity per hit  identical to 9dp
--   matched_finding_id       differs on some rows
--
-- The last row is exact-tie-breaking, not divergence: 7 of the 22 hits have
-- MORE THAN ONE prior tied at the maximum similarity (widest tie: 37 rows), and
-- `DISTINCT ON (finding_id) ORDER BY finding_id, sim DESC` picked among them
-- arbitrarily too. Every published number — `fuzzy_matched`, `new_fingerprints`,
-- `rate` — is unaffected; only the `samples` array could name a different
-- partner run to run. Since that churn was never wanted, the LATERAL ORDER BY
-- now carries `, cand.id` as a deterministic final tiebreak, so the samples
-- are stable across runs. That is strictly more determinism than the old code
-- had, not a change to any metric.
--
-- The same test incidentally confirms the `%` prefilter is loss-free here: it
-- fires at `pg_trgm.similarity_threshold` = LEAST(0.6, 0.5) = 0.5, so no pair
-- above the 0.6 reporting cutoff can be pruned by it. The exhaustive
-- no-prefilter run found no match the prefiltered run missed.
--
-- Metric 2 is left alone: it is already bounded by `per_repo_cap` and runs in
-- ~11s. Its self-join is between two CTE row-sets rather than the base table,
-- so no index applies to it; a rewrite would be churn, not a fix.
--
-- NOT FIXED HERE, and deliberately so: `SET statement_timeout = '120s'` on
-- these functions is DECORATIVE. Postgres arms the statement timer when the
-- top-level statement starts; a `SET` taking effect inside the function body
-- does not re-arm it. Verified on this server with a negative control — a
-- function declaring `SET statement_timeout='2s'` slept 5s and returned
-- normally, while the identical sleep under a session-level 2s timeout was
-- cancelled. The Supabase 121s cancellation came from the server-side/role
-- default, never from this clause. The honest bound belongs at the caller
-- (see scripts/lib/db/rpc.mjs), so the clause is retained here only to keep
-- this definition byte-comparable with its predecessors.
-- ============================================================================

-- The index the `%` prefilter has always needed. Non-CONCURRENTLY on purpose:
-- setup-postgres.mjs applies each migration as a single multi-statement
-- pool.query(), which is an implicit transaction, and CREATE INDEX
-- CONCURRENTLY cannot run inside one. Build time on the current store: 2.6s.
CREATE INDEX IF NOT EXISTS audit_findings_detail500_trgm_idx
  ON audit_findings USING gin (left(detail_snapshot, 500) gin_trgm_ops);

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
  new_fp_total INT;
  fuzzy_matched_count INT;
  fuzzy_samples JSONB;
  cluster_per_repo JSONB;
  median_pairs NUMERIC;
  fixed_count INT;
  fixed_total INT;
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
  --
  -- One LATERAL best-match probe per new-fingerprint finding. The
  -- `left(prior.detail_snapshot,500) % nf.snap` predicate is served by
  -- audit_findings_detail500_trgm_idx, so this is ~N index probes rather
  -- than the 3.7M-pair Join Filter the hash plan produced.
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
  -- Cap the DRIVING set only (see part 3 of the header) — never the priors
  -- being searched, which stay the full 90-day set.
  nf_capped AS (
    SELECT id, finding_fingerprint, snap, created_at, repo_id
    FROM (
      SELECT nfx.*,
             ROW_NUMBER() OVER (PARTITION BY repo_id ORDER BY created_at DESC) AS rn
      FROM new_fingerprints nfx
    ) ranked
    WHERE rn <= per_repo_cap
  ),
  -- Replaces the old `priors` CTE + `fuzzy_matches` join + `best_match`
  -- DISTINCT ON. `LIMIT 1` after `ORDER BY sim DESC` is exactly the row
  -- DISTINCT ON (finding_id) ORDER BY finding_id, sim DESC used to pick.
  best_match AS (
    SELECT nf.id AS finding_id, m.matched_finding_id, m.sim
    FROM nf_capped nf
    CROSS JOIN LATERAL (
      SELECT cand.id AS matched_finding_id, cand.sim
      FROM (
        -- OFFSET 0 is an optimisation fence, not decoration. This subquery
        -- carries ONLY the `%` predicate, so audit_findings_detail500_trgm_idx
        -- is its sole access path and the planner cannot fall back to the
        -- created_at btree (which it did, at 477ms/probe, before the fence).
        SELECT p2.id, p2.run_id, p2.created_at, p2.finding_fingerprint,
               similarity(nf.snap, LEFT(p2.detail_snapshot, 500)) AS sim
        FROM audit_findings p2
        WHERE LEFT(p2.detail_snapshot, 500) % nf.snap    -- indexed trigram filter
        OFFSET 0
      ) cand
      JOIN audit_runs pr ON pr.id = cand.run_id AND pr.repo_id = nf.repo_id
      WHERE cand.finding_fingerprint != nf.finding_fingerprint
        AND cand.id != nf.id
        AND cand.created_at < nf.created_at
        AND cand.created_at >= window_start - INTERVAL '60 days'
        AND cand.sim > similarity_reraise
      -- `, cand.id` is the deterministic tiebreak (see EQUIVALENCE in the
      -- header): ties at max similarity are common and were resolved by heap
      -- order before, which made the `samples` array churn between runs.
      ORDER BY cand.sim DESC, cand.id
      LIMIT 1
    ) m
  )
  SELECT
    (SELECT COUNT(*) FROM nf_capped),
    (SELECT COUNT(*) FROM best_match),
    COALESCE(
      (SELECT jsonb_agg(row_to_json(s.*)) FROM (
        SELECT finding_id, matched_finding_id, ROUND(sim::numeric, 3) AS similarity
        FROM best_match
        ORDER BY sim DESC
        LIMIT 5
      ) s),
      '[]'::jsonb
    ),
    (SELECT COUNT(*) FROM new_fingerprints)
  INTO new_fp_count, fuzzy_matched_count, fuzzy_samples, new_fp_total;

  -- -------------------------------------------------------------------
  -- Metric 2: Cluster density (capped at `per_repo_cap` most recent open
  -- findings per repo to bound compute). Unchanged — the cap already bounds
  -- it to ~80K pairs / ~11s, and its self-join is between two CTE row-sets
  -- rather than the base table, so no index applies.
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
      -- Control-state markers are not findings (see 20260720210000).
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
  -- The honest per-repo denominator — every considered finding, computed
  -- BEFORE any pair matching (see 20260720210000, defect 2).
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
     AND a.snap % b.snap
    GROUP BY a.repo_id
  ),
  -- LEFT JOIN from the POPULATION, not the pair set — a repo with zero
  -- similar pairs contributes a 0 to the median (see 20260720210000, defect 3).
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
  -- Metric 3: Fixed-finding recurrence — same LATERAL best-match shape as
  -- metric 1. The old `laters` CTE + join + `best_recur` DISTINCT ON
  -- produced 709,852 filter-evaluated pairs (208.8s measured).
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
  -- Cap the DRIVING set only (see part 3 of the header).
  fixed_capped AS (
    SELECT id, snap, finding_fingerprint, repo_id, fixed_at
    FROM (
      SELECT fx.*, ROW_NUMBER() OVER (PARTITION BY repo_id ORDER BY fixed_at DESC) AS rn
      FROM fixed fx
    ) ranked
    WHERE rn <= per_repo_cap
  ),
  best_recur AS (
    SELECT fx.id AS fixed_id, m.recurred_id, m.sim
    FROM fixed_capped fx
    CROSS JOIN LATERAL (
      SELECT cand.id AS recurred_id, cand.sim
      FROM (
        -- Same OFFSET 0 fence as metric 1 — `%` alone, so the trgm index is
        -- the only access path.
        SELECT l2.id, l2.run_id, l2.created_at, l2.finding_fingerprint,
               similarity(fx.snap, LEFT(l2.detail_snapshot, 500)) AS sim
        FROM audit_findings l2
        WHERE LEFT(l2.detail_snapshot, 500) % fx.snap    -- indexed trigram filter
        OFFSET 0
      ) cand
      JOIN audit_runs lr ON lr.id = cand.run_id AND lr.repo_id = fx.repo_id
      WHERE cand.id != fx.id
        AND cand.finding_fingerprint != fx.finding_fingerprint
        AND cand.created_at > fx.fixed_at
        AND cand.created_at <= fx.fixed_at + INTERVAL '30 days'
        AND cand.created_at >= window_start - INTERVAL '30 days'
        AND cand.sim > similarity_reraise
      ORDER BY cand.sim DESC, cand.id
      LIMIT 1
    ) m
  )
  SELECT
    (SELECT COUNT(*) FROM fixed_capped),
    (SELECT COUNT(*) FROM best_recur),
    COALESCE(
      (SELECT jsonb_agg(row_to_json(s.*)) FROM (
        SELECT fixed_id, recurred_id, ROUND(sim::numeric, 3) AS similarity
        FROM best_recur
        ORDER BY sim DESC
        LIMIT 5
      ) s),
      '[]'::jsonb
    ),
    (SELECT COUNT(*) FROM fixed)
  INTO fixed_count, recurred_count, recurrence_samples, fixed_total;

  result := jsonb_build_object(
    'generated_at', NOW(),
    'window_days', window_days,
    'total_findings_in_window', total_in_window,
    'per_repo_cap', per_repo_cap,
    'fuzzy_reraise', jsonb_build_object(
      -- `new_fingerprints` is the CONSIDERED denominator (post-cap); the
      -- `_total` companion is what existed before the cap, so a truncated
      -- population can never read as full coverage.
      'new_fingerprints', new_fp_count,
      'new_fingerprints_total', new_fp_total,
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
      'fixed_findings_total', fixed_total,
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

-- ---------------------------------------------------------------------------
-- RE-APPLY THE 2026-07-21 HARDENING. `CREATE OR REPLACE FUNCTION` REPLACES the
-- whole proconfig array and RESETS the ACL to the owner default, so every
-- redefinition of this function silently reverts migration
-- 20260721130000_advisor_security_hardening.sql unless it re-states both.
-- The first draft of THIS migration did exactly that — it carried the
-- `GRANT ... TO anon, authenticated` tail copied from the 2026-07-20 version
-- and dropped the search_path pin, which put the mutable-search_path lint
-- (CLASS 2: an object planted in an earlier-searched schema executing with
-- SECURITY DEFINER rights) and the anon/authenticated EXECUTE grant back. It
-- was caught by diffing the live catalog, not by review.
--
-- Anything that redefines memory_health_metrics must end with these two
-- statements. Both are idempotent.
ALTER FUNCTION memory_health_metrics(window_days integer, similarity_reraise numeric, similarity_cluster numeric, max_pairs_per_repo integer)
  SET search_path = public, pg_temp;
REVOKE EXECUTE ON FUNCTION memory_health_metrics(window_days integer, similarity_reraise numeric, similarity_cluster numeric, max_pairs_per_repo integer)
  FROM PUBLIC, anon, authenticated;
