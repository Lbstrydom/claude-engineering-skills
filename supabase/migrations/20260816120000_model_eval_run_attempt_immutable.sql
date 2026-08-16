-- Closes the other half of the attempt-sequence gap the previous migration
-- (20260816110000) only guarded from one side: that migration's trigger
-- fires BEFORE INSERT and validates a NEW row's attempt is exactly the prior
-- max + 1, but nothing stopped `attempt` (or `comparison_id`/`arm_id`) on an
-- EXISTING row from being changed afterward, silently invalidating the
-- sequence the INSERT-time check already established. Found by the same
-- Cluster B fix-gate round that shipped the trigger being extended — the
-- "retagging changes edges from BOTH directions" shape this repo's own
-- domain-map discipline warns about, one layer down (see
-- 20260816100000's own comment for the sibling instance on
-- model_eval_comparisons.repo_id).
--
-- No current write path in this codebase ever updates attempt/comparison_id/
-- arm_id on an existing model_eval_runs row (updateEvalRunTerminal's SET
-- clause touches only status/verdict/next_action/metrics/cost/evidence,
-- verified directly) — but as with the repo_id-immutable migration, the
-- database is the last line of defence a convention cannot be, and these
-- three columns are exactly the kind of value that must not move once the
-- sequence trigger has validated them, for the same reason repo_id must not
-- move once other rows depend on it.
--
-- DELETE is deliberately OUT OF SCOPE here, not an oversight: no code path
-- in this repo deletes a model_eval_runs row (rows are superseded, never
-- removed — the append-only evidence posture this whole table is built on),
-- and retrofitting delete-time re-validation would require inventing a
-- renumbering policy for the resulting gap that nothing in this plan asked
-- for — exactly the over-built side of the fix this repo's own design-
-- right-sizing rule warns against. If a real DELETE path is ever added,
-- that is the point to design this deliberately, not retrofit it here.

CREATE OR REPLACE FUNCTION check_model_eval_run_attempt_sequence()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  max_prior int;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW.comparison_id IS DISTINCT FROM OLD.comparison_id
      OR NEW.arm_id IS DISTINCT FROM OLD.arm_id
      OR NEW.attempt IS DISTINCT FROM OLD.attempt THEN
      RAISE EXCEPTION 'model_eval_runs.comparison_id/arm_id/attempt are immutable once created (run %): comparison_id % -> %, arm_id % -> %, attempt % -> %',
        OLD.run_id, OLD.comparison_id, NEW.comparison_id, OLD.arm_id, NEW.arm_id, OLD.attempt, NEW.attempt;
    END IF;
    RETURN NEW;
  END IF;

  -- TG_OP = 'INSERT', unchanged from 20260816110000.
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
  BEFORE INSERT OR UPDATE ON model_eval_runs
  FOR EACH ROW
  EXECUTE FUNCTION check_model_eval_run_attempt_sequence();
