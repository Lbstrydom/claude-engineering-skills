-- Ownership-rule epoch on refresh_runs.
--
-- Plan: docs/plans/incremental-refresh-ownership-propagation.md (Cluster B).
-- Upstream report: edc0948e (Lbstrydom/wine-cellar-app).
--
-- WHY HERE AND NOT ON audit_repos. Embedding provenance lives on
-- `audit_repos.active_embedding_model`, published by the `publish_refresh_run`
-- RPC. Carrying an extra value through that RPC means ADDING A PARAMETER, and a
-- different argument list is a DIFFERENT function — created with the default
-- ACL (EXECUTE to PUBLIC), which the existing REVOKE in
-- 20260721130000_advisor_security_hardening.sql names by the old signature and
-- therefore does not cover. The hardening would read as applied while being
-- silently absent for the new overload. `openRefreshRun` is a plain INSERT, and
-- `getActiveSnapshot` already joins `refresh_runs`, so one column here costs one
-- migration and one SELECT field with no function signature in the blast radius.
--
-- WHAT IT RECORDS. The ownership rule in force when the snapshot was walked, as
-- a declared constant (`OWNERSHIP_RULE_EPOCH` in scripts/lib/disowned-paths.mjs)
-- rather than a hash of that module's source — a source hash would force a full
-- re-walk across every consumer on a comment edit.
--
-- NULL is the pre-adoption state and means UNVERIFIED, never "compatible": the
-- reader promotes an incremental to a full walk when the prior epoch is NULL or
-- differs. Every consumer is already in the stale-corpus state and owes one
-- authoritative walk, so making that self-executing is the point.
--
-- Idempotent, unqualified, and portable — no schema prefix (parity:check-coupling).

ALTER TABLE refresh_runs
  ADD COLUMN IF NOT EXISTS ownership_rule_epoch TEXT;

COMMENT ON COLUMN refresh_runs.ownership_rule_epoch IS
  'The ownership-rule epoch (OWNERSHIP_RULE_EPOCH) in force when this run walked the repo. NULL = pre-adoption, which reads as UNVERIFIED and promotes the next incremental to a full walk.';
