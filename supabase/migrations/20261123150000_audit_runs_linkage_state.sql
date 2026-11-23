-- Telemetry linkage state (docs/plans/telemetry-linkage-structural.md).
--
-- A run row now says whether it is linked to an audit session, deliberately standalone (with a declared reason),
-- or unlinked (no session and nothing declared). Before this, "no session" was a bare NULL indistinguishable from
-- a dropped field: audit_session_id sat at 0% on code runs for weeks.
--
-- Rows written before this migration stay NULL on both columns; the linkage query reports them as
-- `legacy-unstated`, never as linked. No backfill.
--
-- Idempotent. public-only, no schema-qualified names (parity:check-coupling).

ALTER TABLE audit_runs ADD COLUMN IF NOT EXISTS linkage_state text;
ALTER TABLE audit_runs ADD COLUMN IF NOT EXISTS linkage_reason text;

ALTER TABLE audit_runs DROP CONSTRAINT IF EXISTS audit_runs_linkage_state_chk;
ALTER TABLE audit_runs ADD CONSTRAINT audit_runs_linkage_state_chk
  CHECK (linkage_state IS NULL OR linkage_state IN ('linked', 'unlinked', 'standalone'));

-- A linked row must name its session; a standalone row must name its reason. The database refuses the pairs the
-- resolver refuses, so a writer that bypasses the resolver still cannot write a silent NULL as 'linked'.
ALTER TABLE audit_runs DROP CONSTRAINT IF EXISTS audit_runs_linkage_pair_chk;
ALTER TABLE audit_runs ADD CONSTRAINT audit_runs_linkage_pair_chk
  CHECK (
    linkage_state IS NULL
    OR (linkage_state = 'linked' AND audit_session_id IS NOT NULL)
    OR (linkage_state = 'standalone' AND audit_session_id IS NULL AND linkage_reason IS NOT NULL)
    OR (linkage_state = 'unlinked' AND audit_session_id IS NULL)
  );
