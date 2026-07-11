-- Model swap-in evaluation harness — model_eval_shadow_observations.
--
-- Plan: docs/plans/model-swap-eval-harness.md (File-Level Plan Phase 4).
-- One row per live-shadow review observation collected while an adjudicator
-- Tier A/B evaluation run is `pending_shadow` (model_eval_runs, Phase 1).
-- Written by gemini-review.mjs's runShadowAndPersist (when a modelEvalRunId
-- is active) via appendModelEvalShadowObservation
-- (scripts/lib/model-eval/finalize-shadow-eval.mjs, Phase 4 — the sole owner
-- of this table's access). `observation` carries the primary/shadow finding-
-- bucket comparison for one review, including `findingRefs` — each
-- {auditRunId, findingFingerprint, passName, bucket} disambiguates the
-- UNDERLYING audit_runs.id (a finding was recorded against) from this
-- table's own model_eval_run_id FK, since finding_fingerprint is only
-- unique WITHIN one audit run (round-6 audit H5). idempotency_key is
-- derived from the underlying audit run's id + finding fingerprint so a
-- repeated write for the same underlying event upserts, never duplicates.
-- Idempotent; safe to re-run.

CREATE TABLE IF NOT EXISTS model_eval_shadow_observations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  model_eval_run_id uuid NOT NULL REFERENCES model_eval_runs (run_id) ON DELETE CASCADE,
  observation jsonb NOT NULL,
  idempotency_key text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_model_eval_shadow_observations_run_idempotency
  ON model_eval_shadow_observations (model_eval_run_id, idempotency_key);

CREATE INDEX IF NOT EXISTS idx_model_eval_shadow_observations_run_created
  ON model_eval_shadow_observations (model_eval_run_id, created_at);

DO $$
BEGIN
  ALTER TABLE model_eval_shadow_observations ENABLE ROW LEVEL SECURITY;
END $$;
