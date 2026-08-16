-- Closes the other half of the repo-scope integrity gap the previous
-- migration (20260816090000) only guarded from one side: that migration's
-- trigger fires when `model_eval_runs` is inserted or updated, checking the
-- run's repo_id against its comparison's repo_id — but nothing stopped
-- `model_eval_comparisons.repo_id` itself from being changed AFTER runs
-- already reference it, desyncing the relationship from the other direction.
-- Found by a Cluster B fix-gate audit round immediately after the first
-- trigger shipped — the same "retagging changes edges from BOTH directions"
-- shape this repo's own domain-map discipline warns about, one layer down.
--
-- No current write path in this codebase ever updates repo_id on an existing
-- comparison row (`ensureComparison`'s ON CONFLICT SET clause only touches
-- `subject_ref`; repo_id is part of the conflict target itself, so a
-- different repo_id can only ever create a NEW row, never mutate an
-- existing one) — but the database is the last line of defence a Zod schema
-- or an application-layer convention cannot be, and a comparison's identity
-- is exactly the kind of value that must not move once other rows depend on
-- it, for the same reason a primary key does not move.

CREATE OR REPLACE FUNCTION check_model_eval_comparison_repo_immutable()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND NEW.repo_id != OLD.repo_id THEN
    RAISE EXCEPTION 'model_eval_comparisons.repo_id is immutable once created (was %, attempted %) — a comparison''s repo_id may not change after runs can reference it',
      OLD.repo_id, NEW.repo_id;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_model_eval_comparison_repo_immutable ON model_eval_comparisons;
CREATE TRIGGER trg_model_eval_comparison_repo_immutable
  BEFORE UPDATE ON model_eval_comparisons
  FOR EACH ROW
  EXECUTE FUNCTION check_model_eval_comparison_repo_immutable();
