-- WS1 (persona-nav-feedback-recovery, Cluster 1): deterministic
-- persona<->audit correlator support.
--
-- 1. matcher_version — queryable identity for the correlator's matching
--    contract (docs/plans/persona-nav-feedback-recovery.md WS1). NULL on
--    pre-existing/manual rows is the honest "unversioned" value.
-- 2. Partial unique index closing the Postgres NULLs-are-distinct gap:
--    the existing UNIQUE (persona_session_id, persona_finding_hash,
--    audit_finding_id) does NOT deduplicate rows where audit_finding_id
--    IS NULL (audit_missed rows) — Postgres treats every NULL as distinct
--    for uniqueness purposes. This index makes a re-run of the same
--    session idempotent for the missed-match shape too.

ALTER TABLE persona_audit_correlations
  ADD COLUMN IF NOT EXISTS matcher_version int;

CREATE UNIQUE INDEX IF NOT EXISTS uq_correlations_missed
  ON persona_audit_correlations (persona_session_id, persona_finding_hash)
  WHERE audit_finding_id IS NULL;
