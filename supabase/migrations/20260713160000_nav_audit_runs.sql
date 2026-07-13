-- WS2 (persona-nav-feedback-recovery, Cluster 2): nav-audit v2 run
-- persistence — the deferred migration `record-nav-audit-run` has been a
-- no-op stub for, giving drift aging (the >14-day governance smell) no
-- cloud data source at all.
--
-- `scope` is NOT NULL (writer normalizes an absent scope to 'full'; an
-- unknown scope is rejected by the CLI, never silently folded in — see
-- scripts/cross-skill.mjs cmdRecordNavAuditRun) so the UNIQUE constraint
-- has no Postgres NULLs-are-distinct hole (same class of gap WS1 closed
-- for persona_audit_correlations).

CREATE TABLE IF NOT EXISTS nav_audit_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  repo_id uuid NOT NULL,
  head_sha text NOT NULL,
  scope text NOT NULL DEFAULT 'full',
  drift_keys jsonb NOT NULL DEFAULT '[]',
  finding_counts jsonb,
  verify_summary jsonb,
  tool_version text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (repo_id, head_sha, scope)
);

CREATE INDEX IF NOT EXISTS idx_nav_audit_runs_repo_created
  ON nav_audit_runs (repo_id, created_at DESC);

DO $$
BEGIN
  ALTER TABLE nav_audit_runs ENABLE ROW LEVEL SECURITY;
END $$;
