-- unlocked_fixes: expose audit_runs.mode so a caller can tell a CODE fix that
-- genuinely lacks a regression spec from a PLAN finding that can never have one.
--
-- Measured 2026-07-29: the view returns 232 rows, of which 113 (49%) come from
-- `mode = 'plan'` runs. A plan finding's `primary_file` is a section reference
-- ("§9 testing strategy and security considerations"), not a path, and the
-- thing the view counts — a `regression_specs` row, authored by /ux-lock as a
-- Playwright spec — has no meaning for it. There is no code artifact to lock,
-- so those 113 are a permanent, unactionable half of the population and the
-- /ship nudge reads as noise.
--
-- EXPOSES the discriminator rather than dropping the plan rows, deliberately
-- mirroring 20260727190000_unremediated_acceptances_mode.sql, which made the
-- same call for the sibling view one day earlier. Dropping them here would be
-- defensible on the "can never be locked" argument, but it would (a) diverge
-- from the sibling's shape for no reason a caller can see, and (b) destroy the
-- evidence that half this backlog is structurally unactionable — which is the
-- most useful thing the view currently knows. A caller that wants only code
-- obligations filters on `audit_mode = 'code'`; the count of what it filtered
-- out stays visible.
--
-- Amends the prior view in a NEW migration rather than editing an applied one:
-- 20260520120000 / 20260721140000 have already run against the shared store and
-- the ledger records a sha256 per file, so an edit reads as drift. Same reason
-- the sibling migration gives.
--
-- `audit_mode` is APPENDED LAST, not slotted beside `repo_id` where it reads
-- better: CREATE OR REPLACE VIEW can only add columns at the END of the select
-- list — inserting one mid-list fails with `cannot change name of view column`
-- (observed 2026-07-27 on the sibling). Dropping and recreating would take an
-- ACCESS EXCLUSIVE lock and break dependents, which is not worth column order.

CREATE OR REPLACE VIEW unlocked_fixes AS
SELECT
  f.id       AS audit_finding_id,
  f.run_id   AS audit_run_id,
  r.repo_id,
  f.severity,
  f.category,
  f.primary_file,
  f.detail_snapshot,
  r.created_at AS fixed_at,
  (SELECT count(*)
     FROM regression_specs rs
    WHERE rs.source_finding_type = 'audit'
      AND rs.source_finding_id = f.id
      AND rs.source_kind <> 'persona-consistency-candidate') AS lock_spec_count,
  r.mode     AS audit_mode
FROM audit_findings f
JOIN audit_runs r ON r.id = f.run_id
WHERE f.severity = 'HIGH'
  AND f.adjudication_outcome IN ('accepted', 'severity_adjusted')
  AND f.remediation_state IN ('fixed', 'verified')
  AND r.created_at > now() - interval '14 days'
  AND NOT EXISTS (
    SELECT 1
      FROM regression_specs rs
     WHERE rs.source_finding_type = 'audit'
       AND rs.source_finding_id = f.id
       AND rs.source_kind <> 'persona-consistency-candidate'
  );
