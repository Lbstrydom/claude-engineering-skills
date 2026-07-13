-- Tiered-recall audit pipeline — Close-out shadow validation persistence.
--
-- Plan: docs/completed/tiered-recall-audit-pipeline.md (Close-out).
-- One row per shadow-comparison observation: the tiered pipeline run
-- alongside a real (gating) legacy audit, observation-only. Written by
-- `runTieredShadowComparison` (scripts/lib/audit/tiered-shadow-compare.mjs)
-- via `appendTieredShadowObservation` (scripts/lib/store/tiered-shadow.mjs)
-- — best-effort, cloud-optional; the local `.audit/tiered-shadow-log.jsonl`
-- remains the always-available fallback (graceful degradation when cloud
-- is off, matching this repo's established local+cloud pattern).
--
-- `repo_id` has NO foreign key (mirrors model_eval_runs) — a bare
-- deterministic UUID from `resolveRepoIdentity`, since this DB is
-- single-tenant (the DSN password is the only secret; no cross-tenant
-- concern). This is what lets a single operator's `tiered-shadow-report.mjs`
-- aggregate across all of their local repos with one query, closing the
-- gap where the log was previously per-repo-local-only with no way to
-- count total shadow runs across a multi-repo validation window.
-- Idempotent; safe to re-run.

CREATE TABLE IF NOT EXISTS tiered_shadow_observations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  repo_id uuid NOT NULL,
  run_id text,
  legacy_ok boolean NOT NULL,
  shadow_ok boolean NOT NULL,
  shadow_error text,
  shadow_latency_ms int,
  comparison jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_tiered_shadow_observations_repo_created
  ON tiered_shadow_observations (repo_id, created_at DESC);

DO $$
BEGIN
  ALTER TABLE tiered_shadow_observations ENABLE ROW LEVEL SECURITY;
END $$;
