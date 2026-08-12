-- audit_findings: make (run_id, finding_fingerprint) an upsert target.
--
-- Plan: docs/plans/audit-store-write-durability.md, decision 2b (Phase 1).
--
-- The durability work replays a spilled `audit.findings` batch by upserting on
-- (run_id, finding_fingerprint). A LOGICAL key is not enough for that: Postgres
-- requires a unique or exclusion constraint for ON CONFLICT, and the plan's
-- first draft asserted the key without checking one existed.
--
-- Measured on the live store 2026-08-11, which is why this migration exists:
--   * audit_findings carried audit_findings_pkey on (id), plus NON-unique
--     idx_audit_findings_fingerprint (finding_fingerprint) and
--     idx_audit_findings_run (run_id). No unique constraint on the pair — the
--     planned ON CONFLICT would have failed at runtime with "no unique or
--     exclusion constraint matching the ON CONFLICT specification".
--   * 1 duplicate (run_id, finding_fingerprint) group / 1 excess row across
--     4,222 rows. So the constraint is addable, but only after a dedup.
--
-- Order is load-bearing: dedup first, then the index. Reversed, the CREATE
-- fails on the duplicate and leaves the migration half-applied.

BEGIN;

-- 1. Dedup. Keep the OLDEST row of each group — it is the one earlier findings
--    and adjudication events already reference, so keeping it avoids orphaning
--    anything that joined on the id. `ctid` breaks a tie where created_at is
--    identical, which is possible for rows inserted in one batch.
DELETE FROM audit_findings a
      USING audit_findings b
      WHERE a.run_id = b.run_id
        AND a.finding_fingerprint = b.finding_fingerprint
        AND a.finding_fingerprint IS NOT NULL
        AND (a.created_at, a.ctid) > (b.created_at, b.ctid);

-- 2. The upsert target.
--
--    Partial on `finding_fingerprint IS NOT NULL`: the column is nullable and
--    NULLs are DISTINCT in a unique index, so including them would neither
--    constrain anything nor serve as an ON CONFLICT target — it would only make
--    the index bigger. Being explicit also documents that a null-fingerprint
--    finding is deliberately NOT idempotent and therefore never spill-eligible.
CREATE UNIQUE INDEX IF NOT EXISTS audit_findings_run_fingerprint_uniq
    ON audit_findings (run_id, finding_fingerprint)
 WHERE finding_fingerprint IS NOT NULL;

COMMIT;
