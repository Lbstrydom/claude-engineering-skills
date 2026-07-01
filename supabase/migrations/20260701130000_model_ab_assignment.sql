-- Model-A/B/C — expose the ASSIGNMENT key in the scorer view.
--
-- Consolidated Gemini gate (round 2): the decision rule's MIN_ASSIGNMENTS gate
-- must count DISTINCT assignments (distinct code under audit), not distinct
-- run_ids — else 2 repeated runs of the SAME assignment satisfy the diversity
-- floor. The view now carries `commit_sha` (the assignment key, from audit_runs)
-- so aggregateCells can count DISTINCT assignments. CREATE OR REPLACE VIEW is
-- idempotent; this supersedes the view definition in 20260701120000.

CREATE OR REPLACE VIEW model_ab_effectiveness AS
WITH canon AS (
  SELECT
    f.run_id,
    r.commit_sha,
    f.stage,
    f.source_model,
    f.severity,
    COALESCE(f.adjudication_outcome, 'pending') AS outcome,
    COALESCE(fe.canonical_finding_id, f.finding_fingerprint) AS canonical_id,
    CASE
      WHEN f.stage IS NULL                        THEN ARRAY['A']
      WHEN f.stage IN ('oss-gen', 'gpt-round')    THEN ARRAY['B', 'C']
      WHEN f.stage = 'gemini'                     THEN ARRAY['C']
      ELSE ARRAY[]::text[]
    END AS arms
  FROM audit_findings f
  JOIN audit_runs r ON r.id = f.run_id
  LEFT JOIN finding_equivalence fe
    ON fe.duplicate_finding_id = f.finding_fingerprint
),
expanded AS (
  SELECT run_id, commit_sha, unnest(arms) AS arm, stage, source_model, severity, outcome, canonical_id
  FROM canon
),
pass_cost AS (
  SELECT run_id, stage, source_model,
         SUM(cost_usd)                                   AS cost_usd,
         COUNT(*)                                        AS pass_executions,
         COUNT(*) FILTER (WHERE structured_output_ok)    AS conformant_passes,
         BOOL_OR(usage_unmeterable)                      AS any_unmeterable
  FROM audit_pass_stats
  WHERE stage IS NOT NULL
  GROUP BY run_id, stage, source_model
)
-- Column ORDER preserves the prior view (run_id, arm, stage, source_model, …,
-- any_unmeterable) and APPENDS commit_sha LAST — CREATE OR REPLACE VIEW can only
-- add trailing columns, never reorder existing ones. The reader keys by name.
SELECT
  e.run_id,
  e.arm,
  e.stage,
  e.source_model,
  COUNT(DISTINCT e.canonical_id) FILTER (WHERE e.outcome = 'accepted')          AS accepted_uniques,
  COUNT(DISTINCT e.canonical_id) FILTER (WHERE e.outcome = 'dismissed')         AS dismissed_uniques,
  COUNT(DISTINCT e.canonical_id) FILTER (WHERE e.outcome = 'pending')           AS pending_uniques,
  COUNT(DISTINCT e.canonical_id)                                                AS total_uniques,
  COUNT(DISTINCT e.canonical_id) FILTER (WHERE e.severity = 'HIGH' AND e.outcome = 'accepted') AS accepted_high,
  pc.cost_usd,
  pc.pass_executions,
  pc.conformant_passes,
  CASE WHEN pc.pass_executions > 0
       THEN round(pc.conformant_passes::numeric / pc.pass_executions, 4)
       ELSE NULL END                                                            AS conformance_rate,
  pc.any_unmeterable,
  e.commit_sha
FROM expanded e
LEFT JOIN pass_cost pc
  ON pc.run_id = e.run_id AND pc.stage = e.stage
     AND COALESCE(pc.source_model, '') = COALESCE(e.source_model, '')
GROUP BY e.run_id, e.arm, e.stage, e.source_model, e.commit_sha,
         pc.cost_usd, pc.pass_executions, pc.conformant_passes, pc.any_unmeterable;

COMMENT ON VIEW model_ab_effectiveness IS
  'Model-A/B/C scorer: per run × arm × stage × source_model, accepted/dismissed/pending unique CANONICAL findings joined to human adjudication_outcome + per-arm cost/conformance. Carries commit_sha (the ASSIGNMENT key) so the decision rule counts DISTINCT assignments, not run_ids. Arm membership DERIVED from stage (no per-finding arm_id → no B/C double-count).';
