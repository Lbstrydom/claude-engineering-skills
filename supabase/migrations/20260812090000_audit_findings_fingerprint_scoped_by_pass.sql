-- audit_findings: scope the fingerprint-uniqueness key by pass_name.
--
-- Plan: docs/plans/audit-store-write-durability.md. Fixes a defect the
-- durability plan's own migration introduced one level down: the previous
-- unique index, `audit_findings_run_fingerprint_uniq_full` on
-- `(run_id, finding_fingerprint)`, was scoped too broadly.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- THE DEFECT, measured against the live store (2026-08-12), not argued:
--
--   INSERT ... (run_id, finding_fingerprint, pass_name, ..., bucket)
--     VALUES ($run, 'fpboth00', 'final-review', ..., NULL)          -- primary
--   -- succeeds
--   INSERT ... VALUES ($run, 'fpboth00', 'final-review', ..., 'shadow-only')
--   -- 23505 duplicate key value violates unique constraint
--   --   "audit_findings_run_fingerprint_uniq_full"
--
-- `recordFinalReviewFindings` (scripts/lib/store/runs-findings.mjs) writes
-- primary findings under pass_name='final-review' and shadow findings under
-- pass_name='final-review-shadow' — genuinely two different pass_names in the
-- normal case. But BOTH route through the same generic `recordFindings`
-- function the durability plan's Phase 3 changed to upsert on
-- `(run_id, finding_fingerprint)`, with no pass_name in the conflict target —
-- so the constraint governed EVERY pass_name that ever writes to this table,
-- not just the one ('merged') that actually needed replay-safe idempotency.
-- The bucket-resolution system (`resolveFindingBucket`) exists specifically
-- because the SAME fingerprint can legitimately appear more than once per run
-- — primary and shadow independently flagging the same underlying issue is
-- the exact case its own test suite names and exercises. The prior migration
-- made that combination physically unrepresentable, which is a LIVE bug, not
-- just a test failure: the next real run where both reviewers agree on a
-- finding would hit this exact 23505.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- WHY `pass_name`, NOT `bucket`, IS THE RIGHT KEY. `bucket` was the first
-- candidate considered and rejected: it is NULLABLE (NULL for every
-- 'merged'-pass row, which is ALL of them), and Postgres treats NULL as
-- DISTINCT within a unique index — so a raw `(run_id, finding_fingerprint,
-- bucket)` index would never actually deduplicate 'merged'-pass findings at
-- all, silently reopening the exact defect this plan's Phase 1 migration
-- existed to close (verified live then: 706 duplicate-fingerprint rows before
-- the fix). `pass_name` has no such footgun — verified against the live store
-- before writing this migration: 0 rows with `pass_name IS NULL`, and the new
-- 3-column key produces 0 duplicate groups over the existing data (expected,
-- since it is a strict superset of the key that was already enforced —
-- widening a unique constraint can only ADMIT more distinct combinations,
-- never collide on data that was already unique under the narrower one).
--
-- Idempotency semantics per pass_name:
--   'merged'              — the ONLY pass_name the durability plan's replay
--                            path (`durableWrite('audit.findings', ...)`)
--                            ever writes. (run_id, fingerprint, 'merged') is
--                            exactly as unique as (run_id, fingerprint) was
--                            intended to be within this pass — a replayed
--                            spill artifact still upserts cleanly.
--   'final-review'         — primary reviewer findings. Independent of every
--   'final-review-shadow'    other pass_name's fingerprint space; a shared
--                             fingerprint with a DIFFERENT pass_name is now
--                             representable, which is what the bucket system
--                             requires.
--   (audit passes: 'structure', 'wiring', etc.) — each already scoped by its
--                             own pass_name; unaffected by this change.
--
-- `recordFindings`'s own UPSERT (ON CONFLICT target) is updated in the same
-- commit as this migration to match — an ON CONFLICT target that does not
-- correspond to an existing constraint fails outright (42P10), the same
-- defect class the plan's H2/H11 findings already caught once.

BEGIN;

CREATE UNIQUE INDEX IF NOT EXISTS audit_findings_run_fingerprint_pass_uniq
    ON audit_findings (run_id, finding_fingerprint, pass_name);

DROP INDEX IF EXISTS audit_findings_run_fingerprint_uniq_full;

COMMIT;
