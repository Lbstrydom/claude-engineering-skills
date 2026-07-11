-- Model swap-in evaluation harness — model_eval_runs.
--
-- Plan: docs/plans/model-swap-eval-harness.md (File-Level Plan Phase 1).
-- One row per evaluation run (auditor or adjudicator candidate swap-in
-- decision). `status` is process-state-only; `running`/`pending_shadow` are
-- the two non-terminal states for checkpointed runs (round-6 audit H2),
-- entered by createEvalRun and exited exclusively via updateEvalRunTerminal's
-- compare-and-set. `verdict`/`next_action` are decision-outcome fields,
-- independent of `status` (round-5 audit M1) — a completed-but-inconclusive
-- run is `status='completed', verdict='inconclusive'`, never a distinct
-- status value. Idempotent; safe to re-run.

CREATE TABLE IF NOT EXISTS model_eval_runs (
  run_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  repo_id uuid NOT NULL,
  role text NOT NULL CHECK (role IN ('auditor', 'adjudicator')),
  tier text NOT NULL CHECK (tier IN ('screen', 'promotion')),
  candidate_ref jsonb NOT NULL,
  baseline_ref jsonb,
  judge_tier text CHECK (judge_tier IN ('A', 'B', 'C')),
  status text NOT NULL CHECK (status IN ('completed', 'failed_preflight', 'failed_egress', 'failed_provider', 'running', 'pending_shadow')),
  verdict text,
  next_action text,
  metrics jsonb,
  thresholds_version int,
  cost jsonb,
  evidence jsonb,
  harness_sha text,
  corpus_version text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_model_eval_runs_repo_role_created
  ON model_eval_runs (repo_id, role, created_at DESC, run_id DESC);

-- At most one pending_shadow run per (repo_id, role) — createEvalRun surfaces
-- the resulting unique-violation as EvalRunAlreadyActiveError.
CREATE UNIQUE INDEX IF NOT EXISTS idx_model_eval_runs_active_pending_shadow
  ON model_eval_runs (repo_id, role)
  WHERE status = 'pending_shadow';

DO $$
BEGIN
  ALTER TABLE model_eval_runs ENABLE ROW LEVEL SECURITY;
END $$;
