-- unremediated_acceptances: project `finding_fingerprint`, the key its writer
-- requires. Closes upstream reports 23544fca (HIGH) and da67a8c1 (MEDIUM),
-- both filed from a consumer on 2026-08-04.
--
-- THE DEFECT. /ship Step 0.5e reads this view and nudges you to close the
-- obligations it lists. The only command that can close one is
-- `cross-skill.mjs final-review-record-fix`, which hard-requires
-- `--run-id <id> --fingerprint <hash>` (`cmdFinalReviewRecordFix`). The view
-- projected `audit_finding_id` and no fingerprint, so the read handed you a key
-- its writer cannot accept: every row was reported as an open obligation and
-- none of them was closable from what the read gave you. Verified against the
-- LIVE view, not this file — `information_schema.columns` for
-- `unremediated_acceptances` listed 13 columns with no `finding_fingerprint`.
--
-- The consumer's second report (da67a8c1) is the same defect seen from the
-- other end: "an accepted finding fixed in a LATER session is unclosable, so
-- 0.5e nags forever". Its stated mechanism was that `final-review-record-fix`
-- is shadow-only and does not apply — that part is wrong (it takes run-id +
-- fingerprint with an OPTIONAL bucket, so it is generic), but its conclusion
-- was right for the reason this migration fixes: the fingerprint was
-- unreachable. Two reports, one root cause, one column.
--
-- APPENDED LAST, deliberately. `CREATE OR REPLACE VIEW` can only add columns at
-- the END of the select list; slotting `finding_fingerprint` beside
-- `audit_finding_id` where it reads better fails with `cannot change name of
-- view column`. Same constraint the 20260727190000 header records for
-- `audit_mode`, and the same resolution — a column-ordering preference is not
-- worth a DROP + recreate that takes ACCESS EXCLUSIVE and breaks dependents.
--
-- Amends in a NEW migration rather than editing 20260727190000: that file has
-- already run against the shared store and the ledger records a sha256 per
-- file, so an edit reads as drift.

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
  r.mode              AS audit_mode,
  f.finding_fingerprint
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
