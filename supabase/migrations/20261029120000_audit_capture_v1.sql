-- Audit telemetry capture v1 (docs/plans/audit-telemetry-capture.md).
--
-- Links the rounds of one audit (audit_session_id + audit_round), stamps the
-- capture contract a row was written under (capture_epoch), and widens the
-- adjudicator-kind CHECK with 'reviewer' (the final reviewer's per-finding
-- reversals). The capture_epoch column and the widened CHECK arrive in ONE
-- migration on purpose: the writers probe capture_epoch, so the probe also
-- proves the CHECK accepts 'reviewer'.
--
-- Rows written before this migration stay NULL on all three columns and are
-- ineligible for the capture-v1 queries. No backfill, no cutoff by date.
--
-- Idempotent: IF NOT EXISTS / DROP IF EXISTS. public-only, no schema-qualified
-- names (parity:check-coupling).

ALTER TABLE audit_runs ADD COLUMN IF NOT EXISTS audit_session_id text;
ALTER TABLE audit_runs ADD COLUMN IF NOT EXISTS audit_round integer;
ALTER TABLE audit_runs ADD COLUMN IF NOT EXISTS capture_epoch text;

CREATE INDEX IF NOT EXISTS idx_audit_runs_audit_session_id ON audit_runs (audit_session_id);

ALTER TABLE finding_adjudication_events DROP CONSTRAINT IF EXISTS fae_adjudicator_kind_chk;
ALTER TABLE finding_adjudication_events ADD  CONSTRAINT fae_adjudicator_kind_chk
  CHECK (adjudicator_kind IS NULL OR adjudicator_kind IN ('agent', 'human', 'pipeline', 'rule', 'reviewer'));
