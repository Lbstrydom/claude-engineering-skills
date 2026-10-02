-- model_eval_runs.status gains 'stopped_budget' (D6 per-arm budget).
--
-- Plan: docs/plans/role-agnostic-comparison-core.md D5a, D6.
--
-- A per-arm budget stops an auditor arm BETWEEN corpus cases once its recorded
-- spend (across every attempt) reaches `budgetUsdPerArm`. That run is neither
-- of the two existing statuses it could be written as:
--   * 'completed' counts as a live success, so the manifest driver's resume
--     (D5a) would skip the arm forever, even after the operator raised the
--     budget — which is the one thing an analysis-time ceiling must allow;
--   * 'failed_provider' names a cause that did not happen.
-- So it gets its own terminal status. It carries the partial `cost` the run
-- actually spent (spend reads every attempt) and never a verdict — the store's
-- refineVerdictPair already forbids a verdict on any non-'completed' status.
--
-- The base CHECK (20260711120000) is the column-level, auto-named
-- `model_eval_runs_status_check`. Replaced, not altered — Postgres cannot
-- alter a CHECK in place. Idempotent: DROP IF EXISTS + ADD re-creates the same
-- constraint on a re-run. Mirrors scripts/lib/model-eval/contracts.mjs
-- RUN_STATUSES.

ALTER TABLE model_eval_runs
  DROP CONSTRAINT IF EXISTS model_eval_runs_status_check;

ALTER TABLE model_eval_runs
  ADD CONSTRAINT model_eval_runs_status_check CHECK (status IN (
    'completed', 'failed_preflight', 'failed_egress', 'failed_provider', 'stopped_budget',
    'running', 'pending_shadow'
  ));
