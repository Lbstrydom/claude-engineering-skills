-- ============================================================================
-- Advisor hardening — unindexed foreign keys + missing primary key
-- (2026-07-24), found while investigating a Supabase Disk IO Budget warning
-- on the Audit-loop store (project uahjjdelnnpfmaqjrwoz). These are INFO-
-- level `unindexed_foreign_keys` / `no_primary_key` lints, not the IO
-- incident's root cause (that was the symbol_embeddings per-row write loop,
-- fixed in code — see scripts/lib/store/arch/symbols.mjs
-- recordSymbolEmbeddings), but real gaps surfaced by the same investigation.
--
-- CLASS 1 — 9 foreign keys with no covering index. Every FK/JOIN and every
--   `ON DELETE CASCADE`/`SET NULL` cleanup on these columns currently forces
--   a sequential scan of the child table to find dependent rows. Plain
--   CREATE INDEX (not CONCURRENTLY), matching this dir's established
--   precedent (20260717190000_fp_pattern_read_index.sql): CONCURRENTLY
--   cannot run inside a transaction block, which is how this repo's
--   migration runner applies every file. symbol_index is the one table here
--   large enough (388k rows) for the brief SHARE lock to be worth naming —
--   a single-column uuid btree build over that many rows is still a
--   sub-second, write-blocking-only (not read-blocking) event.
--
-- CLASS 2 — symbol_file_imports has no PRIMARY KEY, only a UNIQUE constraint
--   on (refresh_id, importer_path, imported_path). All three columns are
--   already NOT NULL. `ADD ... PRIMARY KEY USING INDEX <name>` (metadata-
--   only reuse) only works on a bare unique INDEX — this one is already
--   constraint-backed (contype='u'), so Postgres refuses to re-associate it
--   ("index is already associated with a constraint", confirmed live against
--   this project). Drop + re-add as PRIMARY KEY instead: same columns, so
--   this rebuilds one index over ~200k rows (seconds, not a rewrite of the
--   table itself) rather than reusing the old one.
--
-- ROLLBACK (no colocated *_rollback.sql — this dir's runner applies EVERY
--   .sql file, so a rollback file would run right after and undo this. To
--   reverse, run by hand:
--     ALTER TABLE symbol_file_imports
--       DROP CONSTRAINT symbol_file_imports_pkey,
--       ADD CONSTRAINT symbol_file_imports_refresh_id_importer_path_imported_path_key
--       UNIQUE (refresh_id, importer_path, imported_path);
--     DROP INDEX IF EXISTS friction_log_audit_run_id_idx;
--     DROP INDEX IF EXISTS learning_decisions_audit_run_id_idx;
--     DROP INDEX IF EXISTS learning_decisions_repo_id_idx;
--     DROP INDEX IF EXISTS persona_finding_outcomes_last_seen_session_id_idx;
--     DROP INDEX IF EXISTS plan_verification_runs_spec_id_idx;
--     DROP INDEX IF EXISTS prompt_variants_repo_id_idx;
--     DROP INDEX IF EXISTS recurring_finding_clusters_latest_finding_id_idx;
--     DROP INDEX IF EXISTS symbol_index_definition_id_idx;
--     DROP INDEX IF EXISTS symbol_layering_violations_repo_id_idx;
--
-- VERIFY (expect 0 rows — Supabase's own unindexed-FK/no-PK advisors):
--   see get_advisors(type: performance) for project uahjjdelnnpfmaqjrwoz.
-- ============================================================================

BEGIN;

-- Class 1 — covering indexes for the 9 unindexed foreign keys.
CREATE INDEX IF NOT EXISTS friction_log_audit_run_id_idx
  ON friction_log (audit_run_id);
CREATE INDEX IF NOT EXISTS learning_decisions_audit_run_id_idx
  ON learning_decisions (audit_run_id);
CREATE INDEX IF NOT EXISTS learning_decisions_repo_id_idx
  ON learning_decisions (repo_id);
CREATE INDEX IF NOT EXISTS persona_finding_outcomes_last_seen_session_id_idx
  ON persona_finding_outcomes (last_seen_session_id);
CREATE INDEX IF NOT EXISTS plan_verification_runs_spec_id_idx
  ON plan_verification_runs (spec_id);
CREATE INDEX IF NOT EXISTS prompt_variants_repo_id_idx
  ON prompt_variants (repo_id);
CREATE INDEX IF NOT EXISTS recurring_finding_clusters_latest_finding_id_idx
  ON recurring_finding_clusters (latest_finding_id);
CREATE INDEX IF NOT EXISTS symbol_index_definition_id_idx
  ON symbol_index (definition_id);
CREATE INDEX IF NOT EXISTS symbol_layering_violations_repo_id_idx
  ON symbol_layering_violations (repo_id);

-- Class 2 — replace symbol_file_imports' unique constraint with an
-- equivalent primary key (same columns; all already NOT NULL).
ALTER TABLE symbol_file_imports
  DROP CONSTRAINT symbol_file_imports_refresh_id_importer_path_imported_path_key,
  ADD CONSTRAINT symbol_file_imports_pkey
  PRIMARY KEY (refresh_id, importer_path, imported_path);

COMMIT;
