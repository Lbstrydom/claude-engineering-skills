-- audit_findings: the fingerprint-uniqueness key ALSO needs bucket.
--
-- Plan: docs/plans/audit-store-write-durability.md. Supersedes 20260812090000,
-- applied minutes earlier the same day — that migration's key,
-- `(run_id, finding_fingerprint, pass_name)`, was still wrong. Not amended:
-- migrations are never edited after being applied (AGENTS.md), so this is a
-- second corrective migration, same as 060000 → 070000 earlier the same day.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- WHY 090000 WAS STILL WRONG, measured directly against
-- `tests/final-review-adjudicate.test.mjs`'s own fixture (not argued):
-- `recordFinalReviewFindings` writes primary under pass_name='final-review'
-- and shadow under pass_name='final-review-shadow' in the NORMAL case, which
-- is what 090000's reasoning rested on — but `resolveFindingBucket`
-- (scripts/lib/store/runs-findings.mjs), the function `adjudicateFinalReviewFinding`
-- and `recordFinalReviewFix` both depend on, resolves bucket ambiguity with:
--
--   SELECT DISTINCT bucket FROM audit_findings
--    WHERE run_id = $1 AND finding_fingerprint = $2
--
-- No `pass_name` in that WHERE clause. The contract these functions implement
-- is defined purely in terms of `(run_id, finding_fingerprint, bucket)` — and
-- the test's own fixture inserts BOTH a primary row and a shadow-bucket row
-- under the literal SAME pass_name ('final-review'), differing only in
-- `bucket`, to exercise exactly that contract. 090000's pass_name-only key
-- still collided on that pair: verified live, 23505 on the identical
-- `(run_id, finding_fingerprint, pass_name)` triple with only `bucket`
-- differing.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- THE FIX: `bucket` joins the key, COALESCE'd. `bucket` is nullable — NULL for
-- every 'merged'-pass row (all of them) and for every primary final-review
-- row — and Postgres treats NULL as DISTINCT within a unique index, so a raw
-- `(..., bucket)` index would not deduplicate 'merged'-pass findings at all,
-- reopening the exact defect 070000 fixed (measured then: 706 duplicate rows).
-- `COALESCE(bucket, '')` normalises the null case to a real, comparable value
-- so uniqueness is actually enforced where it must be, while still letting a
-- genuinely different bucket value ('shadow-only') coexist with it.
--
-- Verified live in a rolled-back transaction against the FINAL end-state
-- (090000's index dropped, this one created) before writing this migration:
--   • same pass_name, DIFFERENT bucket (the failing scenario)   → now succeeds
--   • same pass_name, SAME bucket, same fingerprint (a true dup) → still 23505
--   • two 'merged'-pass rows sharing a fingerprint (bucket both NULL) → still 23505
--   • `ON CONFLICT (run_id, finding_fingerprint, pass_name, (COALESCE(bucket, '')))`
--     resolves against the expression index (Postgres requires the conflict
--     target to match the index expression exactly, parenthesised)
--
-- `pass_name` stays in the key alongside bucket, not redundant with it: other
-- writers of this table (e.g. the model-A/B/C shadow's `model-ab-<stage>`
-- pass_names) get independent fingerprint spaces from it too, which bucket
-- alone would not give them — defence in depth for a case this migration did
-- not need to prove wrong to keep.

BEGIN;

CREATE UNIQUE INDEX IF NOT EXISTS audit_findings_run_fingerprint_pass_bucket_uniq
    ON audit_findings (run_id, finding_fingerprint, pass_name, (COALESCE(bucket, '')));

DROP INDEX IF EXISTS audit_findings_run_fingerprint_pass_uniq;

COMMIT;
