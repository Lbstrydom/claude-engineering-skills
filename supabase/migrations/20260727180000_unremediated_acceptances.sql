-- unremediated_acceptances: accepted findings that never got a remediation transition.
--
-- WHY. The ledger's two-axis model (adjudicationOutcome × remediationState) is
-- sound and `suppressReRaises` already respects it — it suppresses only
-- `dismissed` or remediationState `fixed`/`verified`, so an accepted+pending
-- finding stays re-raisable as an open obligation. What was missing is that
-- nothing ever LOOKS at the open obligations, so "accepted" silently degraded
-- into "acknowledged and forgotten".
--
-- Measured 2026-07-27 on the 10 accepted final-review-shadow findings in this
-- repo: only 3 got a confirmed targeted code fix. One (the bare
-- `catch { result = null; }` in stage0-relevance-context.mjs) was accepted,
-- shipped, and is still in the code. That is the case this view surfaces.
--
-- SCOPE (deliberately narrow — this is a /ship nudge, not a backlog dump):
--   * HIGH + MEDIUM only. A LOW that nobody remediated is not worth a gate line.
--   * Aged > 7 days. Findings from the current work-in-flight are not stale yet;
--     without this the view would fire on every run's own output.
--   * Within 30 days. Older than that belongs to the debt ledger, not a ship nudge.
--   * remediation_state NULL is included ALONGSIDE 'pending'/'planned' — the
--     final-review-shadow adjudication path (`final-review-adjudicate`) writes
--     user_action + adjudication_outcome but NOT remediation_state, so its
--     accepted findings land NULL rather than 'pending'. Excluding NULL would
--     make this view blind to exactly the population that motivated it.
--
-- Re-runs byte-identically (CREATE OR REPLACE VIEW only; no clocks baked into
-- the DEFINITION — `now()` is evaluated per query, not at create time).

CREATE OR REPLACE VIEW unremediated_acceptances AS
SELECT
  f.id                AS audit_finding_id,
  f.run_id            AS audit_run_id,
  r.repo_id,
  f.severity,
  f.category,
  f.primary_file,
  f.detail_snapshot,
  f.adjudication_outcome,
  f.remediation_state,
  r.commit_sha        AS accepted_at_commit,
  r.created_at        AS accepted_at,
  (EXTRACT(day FROM (now() - r.created_at)))::integer AS days_open
FROM audit_findings f
JOIN audit_runs r ON r.id = f.run_id
WHERE f.adjudication_outcome IN ('accepted', 'severity_adjusted')
  AND (f.remediation_state IS NULL
       OR f.remediation_state IN ('pending', 'planned'))
  AND f.severity IN ('HIGH', 'MEDIUM')
  AND r.created_at < now() - interval '7 days'
  AND r.created_at > now() - interval '30 days'
ORDER BY
  CASE f.severity WHEN 'HIGH' THEN 0 ELSE 1 END,
  r.created_at ASC;
