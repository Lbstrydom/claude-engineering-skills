-- unlocked_fixes: include severity_adjusted findings (fix-lifecycle plan, Gemini final-gate).
--
-- The fix-lifecycle predicate (computeFixLifecycleUpdates A1) marks BOTH
-- `accepted` AND `severity_adjusted` findings `fixed` — a severity_adjusted
-- finding is a real, human-sustained defect (only its severity was re-rated),
-- so when it is remediated it is a genuine fix. But this view still filtered
-- `adjudication_outcome = 'accepted'`, so a severity_adjusted HIGH fix could
-- never surface here — the A1 branch was functionally dead downstream.
--
-- Widen the predicate to `IN ('accepted','severity_adjusted')` so the "recent
-- HIGH fix lacking a regression spec" nudge covers escalated-to-HIGH fixes too.
-- Body otherwise identical to the 20260520120000 version.

CREATE OR REPLACE VIEW unlocked_fixes AS
SELECT
  f.id                           AS audit_finding_id,
  f.run_id                       AS audit_run_id,
  r.repo_id,
  f.severity,
  f.category,
  f.primary_file,
  f.detail_snapshot,
  r.created_at                   AS fixed_at,
  (
    SELECT COUNT(*) FROM regression_specs rs
    WHERE rs.source_finding_type = 'audit'
      AND rs.source_finding_id   = f.id
      AND rs.source_kind         NOT IN ('persona-consistency-candidate')
  ) AS lock_spec_count
FROM audit_findings f
JOIN audit_runs r ON r.id = f.run_id
WHERE f.severity = 'HIGH'
  AND f.adjudication_outcome IN ('accepted', 'severity_adjusted')
  AND f.remediation_state IN ('fixed', 'verified')
  AND r.created_at > now() - interval '14 days'
  AND NOT EXISTS (
    SELECT 1 FROM regression_specs rs
    WHERE rs.source_finding_type = 'audit'
      AND rs.source_finding_id   = f.id
      AND rs.source_kind         NOT IN ('persona-consistency-candidate')
  );
