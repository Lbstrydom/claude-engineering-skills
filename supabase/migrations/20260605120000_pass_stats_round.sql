-- Add `round` to audit_pass_stats so per-round pass telemetry survives
-- run-unification (one audit_runs.id spanning all rounds of a single audit).
--
-- Plan: docs/plans/determinism-follow-ups.md (WS1 §1.3a).
--
-- Forward-only + additive. The table has NO UNIQUE(run_id, pass_name)
-- constraint (only idx_pass_stats_run + PK on id) and recordPassStats does a
-- plain INSERT, so this is a pure column add — no constraint swap. Existing
-- rows default to round=1. Shipped code is column-probe-tolerant
-- (recordPassStats / updatePassStatsPostDeliberation degrade to the columnless
-- path when this migration has not yet been applied), so code and migration
-- ship/apply independently.
ALTER TABLE audit_pass_stats ADD COLUMN IF NOT EXISTS round INTEGER NOT NULL DEFAULT 1;

-- Composite index so the post-deliberation "latest round per pass" lookup and
-- per-round reads stay cheap under the shared run_id.
CREATE INDEX IF NOT EXISTS idx_pass_stats_run_pass_round
  ON audit_pass_stats (run_id, pass_name, round);
