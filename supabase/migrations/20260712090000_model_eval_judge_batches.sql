-- Model swap-in evaluation harness — model_eval_judge_batches.
--
-- Plan: docs/plans/model-swap-eval-harness.md (File-Level Plan Phase 2).
-- One row per blind-judge grading call within a run (runBlindJudgeProtocol,
-- scripts/lib/model-eval/blind-judge.mjs — the sole owner of this table).
-- `repo_id` is denormalized from the parent run (not derived via a join at
-- query time) so a caller can never accidentally cross-repo-scan this table
-- by run_id alone — mirrors the repo-scoping paranoia already established
-- for model_eval_runs (round-5 audit H2: "never an ambient assumption on a
-- shared database"). `gradings` stores the FULL GradingSchema-shaped
-- response (including the blind-to-real bucket/sourceRef re-attachment) so
-- a resumed run can reconstruct its prior verdict without re-calling the
-- judge. Idempotent; safe to re-run.

CREATE TABLE IF NOT EXISTS model_eval_judge_batches (
  batch_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  repo_id uuid NOT NULL,
  run_id uuid NOT NULL REFERENCES model_eval_runs (run_id) ON DELETE CASCADE,
  commit_sha text,
  unit text NOT NULL CHECK (unit IN ('findings-vs-diff', 'verdict-vs-finding')),
  gradings jsonb NOT NULL,
  judge_route jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_model_eval_judge_batches_run_created
  ON model_eval_judge_batches (run_id, created_at);

-- Resume support: a commit already graded for this run must not be graded
-- twice. NULL commit_sha (non-diff units) is exempt from this constraint —
-- Postgres treats each NULL as distinct, which is the correct semantics
-- here (a non-diff batch has no natural resume key).
CREATE UNIQUE INDEX IF NOT EXISTS idx_model_eval_judge_batches_run_commit
  ON model_eval_judge_batches (run_id, commit_sha)
  WHERE commit_sha IS NOT NULL;

DO $$
BEGIN
  ALTER TABLE model_eval_judge_batches ENABLE ROW LEVEL SECURITY;
END $$;
