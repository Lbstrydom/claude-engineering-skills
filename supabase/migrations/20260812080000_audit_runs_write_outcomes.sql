-- audit_runs: carry the durable-write outcomes and the honest completion state.
--
-- Plan: docs/plans/audit-store-write-durability.md, decision 3 ("Outcomes reach
-- the run record, not just stderr") and Phase 3.
--
-- WHY A COLUMN AND NOT A LOG LINE. The defect this plan exists for is a
-- believable false zero: four audit-store writes were fire-and-forget, so a
-- dropped batch of findings left a run row that looks healthy and under-reports.
-- Counting the failures fixes nothing if the count only ever appears on stderr
-- of a process that has since exited — the store would still answer "that run
-- recorded 0 findings" with no way to distinguish "found none" from "could not
-- write them". These two columns are what makes that question answerable.
--
--   write_outcomes  {written, spilled, lost} per run, plus the per-writer
--                   breakdown. jsonb because the writer set is a registry that
--                   grows by `registerWriter` — a column per writer would need a
--                   migration for every new one, which is exactly the coupling
--                   the registry removed.
--
--   run_status      'complete' | 'incomplete' | … — the same closed domain
--                   AuditRunResultSchema already enforces on the returned
--                   object (scripts/lib/schemas.mjs). A run with a non-zero
--                   `lost` is `incomplete`, and that verdict has to be queryable.
--
-- BOTH ARE ADDITIVE AND NULLABLE. Every row written before this migration keeps
-- NULL, which reads as "this run predates the contract" — deliberately distinct
-- from `{written:0,spilled:0,lost:0}`, which would claim a measurement nobody
-- took. The readers probe-guard the columns (`columnExists`), so a store that
-- has not run this migration skips these two fields rather than failing the
-- whole run-completion UPDATE.
--
-- The CHECK is expressed DROP-then-ADD because Postgres has no idempotent
-- `ADD CONSTRAINT IF NOT EXISTS` — the same shape 20260729140000 uses. It admits
-- NULL, so it validates cleanly against every existing row.

BEGIN;

ALTER TABLE audit_runs
  ADD COLUMN IF NOT EXISTS write_outcomes jsonb;

ALTER TABLE audit_runs
  ADD COLUMN IF NOT EXISTS run_status text;

ALTER TABLE audit_runs
  DROP CONSTRAINT IF EXISTS audit_runs_run_status_check;

ALTER TABLE audit_runs
  ADD CONSTRAINT audit_runs_run_status_check
  CHECK (run_status IS NULL OR run_status = ANY (ARRAY[
    'complete',
    'incomplete',
    'fallback_legacy',
    'skipped_no_eligible_files',
    'failed_invalid_diff_input'
  ]));

COMMENT ON COLUMN audit_runs.write_outcomes IS
  'Durable-write outcomes for this run: {written, spilled, lost, byWriter:{…}}. '
  'NULL = the run predates the durability contract, which is NOT the same as all-zero. '
  'Written by recordRunComplete; see scripts/lib/durable-write.mjs.';

COMMENT ON COLUMN audit_runs.run_status IS
  'Completion state, same domain as AuditRunResultSchema.runStatus. '
  '''incomplete'' means the audit finished but could not durably record at least one write.';

COMMIT;
