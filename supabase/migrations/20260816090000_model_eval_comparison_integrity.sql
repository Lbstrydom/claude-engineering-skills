-- Referential + pairing integrity for the D3a cohort columns
-- (20260815120000_model_eval_comparison.sql), closing two gaps a Cluster B
-- fix-gate audit found in the FIRST migration after it was already applied.
-- Migrations are immutable once live — this is an ADDITIVE fix, not an edit
-- to that file.
--
-- Gap 1 — no FK. `model_eval_runs.comparison_id` was indexed but not
-- constrained, so a row could reference a comparison_id that never existed in
-- `model_eval_comparisons` — a nonexistent-cohort row is unrecoverable by any
-- cohort read (`getComparisonCohort`) and would silently vanish from every
-- aggregate.
--
-- Gap 2 — no pairing CHECK. `comparison_id`/`arm_id` are independently
-- nullable, and the application layer (`CreateEvalRunBundleSchema`) refuses a
-- row where exactly one is set — but that refusal lives only in
-- `scripts/lib/store/model-eval.mjs`'s Zod schema, not in the database. Any
-- OTHER writer (a future script, a manual `INSERT`, a migration backfill)
-- bypasses it entirely, and Postgres unique indexes treat every NULL as
-- distinct from every other NULL — so a partially-identified row
-- (`comparison_id` set, `arm_id` NULL) is invisible to the
-- one-live-attempt-per-arm uniqueness the D3a migration exists to enforce.
-- The database is the last line of defence a Zod schema cannot be, so this
-- restates the same rule where it cannot be bypassed.

ALTER TABLE model_eval_runs
  ADD CONSTRAINT fk_model_eval_runs_comparison_id
  FOREIGN KEY (comparison_id) REFERENCES model_eval_comparisons(id);

ALTER TABLE model_eval_runs
  ADD CONSTRAINT chk_model_eval_runs_comparison_arm_pairing
  CHECK ((comparison_id IS NULL) = (arm_id IS NULL));

-- Repository-scope integrity: a run's repo_id must match its comparison's
-- repo_id, when a comparison is set. A CHECK constraint cannot reference
-- another table's column, so this needs a trigger — the standard Postgres
-- shape for a cross-table invariant. Deliberately BEFORE INSERT OR UPDATE
-- (not a deferred constraint trigger): a cohort row is never legitimately
-- inserted cross-repo even transiently, so there is no correct order in
-- which to relax the check.
CREATE OR REPLACE FUNCTION check_model_eval_run_comparison_repo_scope()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  comparison_repo_id uuid;
BEGIN
  IF NEW.comparison_id IS NULL THEN
    RETURN NEW;
  END IF;
  SELECT repo_id INTO comparison_repo_id FROM model_eval_comparisons WHERE id = NEW.comparison_id;
  -- A missing comparison_id is already caught by the FK above; this guards
  -- the case the FK cannot: a comparison that DOES exist, but for a
  -- DIFFERENT repo than the run claims.
  IF comparison_repo_id IS NOT NULL AND comparison_repo_id != NEW.repo_id THEN
    RAISE EXCEPTION 'model_eval_runs.repo_id (%) does not match comparison %''s repo_id (%) — a run may not attach to another repo''s cohort',
      NEW.repo_id, NEW.comparison_id, comparison_repo_id;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_model_eval_run_comparison_repo_scope ON model_eval_runs;
CREATE TRIGGER trg_model_eval_run_comparison_repo_scope
  BEFORE INSERT OR UPDATE ON model_eval_runs
  FOR EACH ROW
  EXECUTE FUNCTION check_model_eval_run_comparison_repo_scope();
