-- WS2 (persona-nav-feedback-recovery, Cluster 2): fixes a real data-loss
-- gap flagged across 3 code-audit rounds (H2/H6/M3) — the original
-- UNIQUE (repo_id, head_sha, scope) identity does not represent what a
-- `scope: 'diff'` run actually audits (the uncommitted working tree, which
-- `head_sha` alone cannot capture). Two distinct diff-scope runs at the
-- same HEAD collided and the DO-NOTHING conflict silently discarded the
-- second run's drift_keys.
--
-- `content_hash` is a stable hash of the sorted `drift_keys` produced by
-- THIS run (computed in scripts/lib/store/nav-audit.mjs, not the DB) and
-- becomes part of the conflict target: two runs with genuinely different
-- audited content now persist as distinct rows; an EXACT rerun (same
-- head_sha/scope/drift_keys) still dedupes as before. nav_audit_runs is
-- brand new (0 rows at migration time) so a NOT NULL backfill is not needed.

ALTER TABLE nav_audit_runs
  ADD COLUMN IF NOT EXISTS content_hash text NOT NULL DEFAULT '';

ALTER TABLE nav_audit_runs DROP CONSTRAINT IF EXISTS nav_audit_runs_repo_id_head_sha_scope_key;

CREATE UNIQUE INDEX IF NOT EXISTS uq_nav_audit_runs_identity
  ON nav_audit_runs (repo_id, head_sha, scope, content_hash);
