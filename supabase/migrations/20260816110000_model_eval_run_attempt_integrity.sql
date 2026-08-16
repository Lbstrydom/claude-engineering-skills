-- Closes two integrity gaps in `model_eval_runs.attempt` that a Cluster B
-- fix-gate audit round found in the base D3a migration
-- (20260815120000_model_eval_comparison.sql): the column was declared
-- `int NOT NULL DEFAULT 1` with no CHECK and no sequencing guarantee beyond
-- what the application (createEvalRun/maxComparisonArmAttempt) happens to
-- compute correctly today. Same "the database is the last line of defence a
-- Zod schema or an application-layer convention cannot be" reasoning already
-- applied one migration earlier (20260816090000/100000, repo-scope integrity)
-- — the application's z.number().int().positive() and its own
-- max-attempt-then-insert convention are real, but neither is a substitute
-- for a constraint a future writer (a bug, a manual fix, a different script)
-- cannot silently violate.
--
-- 1. `attempt <= 0` is nonsensical (attempts are 1-indexed; D5a's own comment
--    in the base migration calls it "the N+1 that claims" the next slot) and
--    was previously representable in the row despite the app boundary
--    rejecting it — a schema in ONE caller is not a guarantee about every
--    caller, present or future.
-- 2. Nothing tied a NEW row's attempt number to the (comparison_id, arm_id)
--    siblings already on the table — an insert could skip numbers, or leave
--    a LOWER attempt live than one already superseded, without violating
--    either of the base migration's two unique indexes (which constrain
--    uniqueness, not sequence). The trigger below requires attempt to be
--    EXACTLY one more than the current max for that arm — the "N+1" the base
--    migration's own comment already describes — matching what
--    createEvalRun's supersede-then-insert transaction already does by
--    convention.
--
-- Scoped to comparison-linked rows only (`comparison_id IS NOT NULL`): a
-- plain single-candidate run (no --manifest) has comparison_id/arm_id NULL
-- and attempt defaults to 1 without ever exercising this path, unaffected by
-- either check — same non-backfill posture the base migration documents for
-- the nullable cohort columns.

ALTER TABLE model_eval_runs
  ADD CONSTRAINT model_eval_runs_attempt_positive CHECK (attempt > 0);

CREATE OR REPLACE FUNCTION check_model_eval_run_attempt_sequence()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  max_prior int;
BEGIN
  IF NEW.comparison_id IS NULL THEN
    RETURN NEW;
  END IF;

  SELECT COALESCE(MAX(attempt), 0) INTO max_prior
    FROM model_eval_runs
   WHERE comparison_id = NEW.comparison_id AND arm_id = NEW.arm_id;

  IF NEW.attempt != max_prior + 1 THEN
    RAISE EXCEPTION 'model_eval_runs.attempt must be exactly one more than the prior max for (comparison_id=%, arm_id=%): expected %, got %',
      NEW.comparison_id, NEW.arm_id, max_prior + 1, NEW.attempt;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_model_eval_run_attempt_sequence ON model_eval_runs;
CREATE TRIGGER trg_model_eval_run_attempt_sequence
  BEFORE INSERT ON model_eval_runs
  FOR EACH ROW
  EXECUTE FUNCTION check_model_eval_run_attempt_sequence();
