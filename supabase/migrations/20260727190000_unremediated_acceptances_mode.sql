-- unremediated_acceptances: expose audit_runs.mode so callers can tell a
-- stale CODE obligation from a stale PLAN one.
--
-- The 20260727180000 version returned both without distinction, and the two
-- read very differently in a /ship nudge: a code finding's `primary_file` is a
-- real path, while a plan finding's is a section reference ("§7 ws-a
-- migration; close-out"), which looks like garbage next to the others. Both
-- are legitimate open obligations — a plan finding accepted and never folded
-- back into the plan is exactly as forgotten — so this exposes the
-- discriminator rather than dropping half the population.
--
-- Amends the prior view in a NEW migration rather than editing the applied
-- one: 20260727180000 has already run against the shared store (the ledger
-- records a sha256 per file, so an edit would read as drift), and rewriting an
-- applied migration is the silent-drift class the ledger exists to prevent.
-- Same pattern as 20260721140000_unlocked_fixes_severity_adjusted.sql amending
-- 20260520120000.
--
-- `audit_mode` is APPENDED LAST, not slotted in beside `repo_id` where it reads
-- better. CREATE OR REPLACE VIEW can only add columns at the END of the select
-- list — inserting one mid-list fails with `cannot change name of view column
-- "severity" to "audit_mode"` (observed 2026-07-27). Dropping and recreating
-- would work but takes an ACCESS EXCLUSIVE lock and breaks any dependent view,
-- which is not worth a column-ordering preference.

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
  (EXTRACT(day FROM (now() - r.created_at)))::integer AS days_open,
  r.mode              AS audit_mode
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
