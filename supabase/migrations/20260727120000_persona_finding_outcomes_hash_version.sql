-- docs/plans/persona-finding-hash-versioning.md: personaFindingHash now
-- includes route/expected context (v2), so the durable identity
-- persona_finding_outcomes is keyed on changed shape. hash_version lets
-- the backfill (and future operators) query "which rows are still on the
-- old scheme" without re-deriving that from timestamps.
--
-- 1. persona_finding_outcomes.hash_version — 1 = pre-context-inclusion
--    scheme (element/code/observed only), 2 = route+expected included.
--    DEFAULT 1: every row that exists before this migration runs was
--    necessarily written under the v1 formula (there is no other formula
--    that has ever existed for this table).
-- 2. persona_finding_outcomes.migrated_at — NULL for every row created
--    directly by the `label` command (never migrated); set to the
--    backfill's run time for any row the backfill creates. Distinct from
--    created_at/updated_at, which the backfill preserves AS-IS from the
--    v1 source row (they record when the human's judgement was made).
-- 3. Composite index on persona_test_sessions(repo_id, created_at, id) —
--    the backfill keyset-pages this exact predicate; without it, pagination
--    forces a sequential scan + in-memory sort per page.
--    Plain CREATE INDEX (not CONCURRENTLY) is deliberate, same precedent
--    as 20260717190000_fp_pattern_read_index.sql: CONCURRENTLY cannot run
--    inside a transaction block, which is how this repo's migration runner
--    applies migrations. persona_test_sessions is one row per persona-test
--    RUN (not a machine-generated event stream), so a brief SHARE lock
--    during index build is a non-event at today's volume. If this is ever
--    applied to a deployment where the table has grown large enough that a
--    write-blocking build is unacceptable, split this index into its own
--    non-transactional operational step using CREATE INDEX CONCURRENTLY
--    before applying the rest of this migration (code-audit R1 finding M12).
-- 4. persona_audit_correlations.hash_version — that table's
--    persona_finding_hash is keyed by the SAME personaFindingHash this
--    migration's sibling change affects (decideCorrelations computes it),
--    so it needs the same era marker. DEFAULT 1 for the same reason as (1).
--    NOT the same concern as matcher_version (that column tracks the
--    correlation/matching ALGORITHM, nullable for pre-existing/manual rows
--    per 20260713150000_correlations_missed_unique.sql — a different axis
--    that stays independently versioned, see audit-correlator.mjs).
-- 5. Both hash_version columns' DEFAULT stays at 1 PERMANENTLY — a code-
--    audit R2 finding proposed advancing it to 2 once all writers are
--    "confirmed compatible," but a code-audit R3 finding (H1) correctly
--    identified that as actively unsafe in THIS repo's actual deployment
--    topology: `AUDIT_DB_URL` is one SHARED Postgres instance used by
--    MULTIPLE consumer repos, each on its OWN sync-bundle cadence (see
--    AGENTS.md's consumer/sync model) — so a moment where this migration
--    has run (schema advanced) while an UN-SYNCED consumer's still-old
--    code (computing v1 hashes) does a bare INSERT is a real, not merely
--    hypothetical, possibility. Every writer THIS plan ships
--    (upsertPersonaFindingOutcome, recordPersonaAuditCorrelation, the
--    backfill's own INSERT) already stamps hash_version explicitly, so the
--    DEFAULT only ever fires for a writer that doesn't know the column
--    exists — and for exactly that writer, `1` is the SAFE direction (an
--    over-conservative row is harmlessly re-examined by a later backfill
--    run and falls into `targetAlreadyExists`), while `2` would be a LIE
--    that permanently hides a genuinely-v1 row from ever being backfilled.

ALTER TABLE persona_finding_outcomes
  ADD COLUMN IF NOT EXISTS hash_version integer NOT NULL DEFAULT 1;

ALTER TABLE persona_finding_outcomes
  ADD COLUMN IF NOT EXISTS migrated_at timestamptz;

CREATE INDEX IF NOT EXISTS idx_persona_test_sessions_repo_created_id
  ON persona_test_sessions (repo_id, created_at, id);

ALTER TABLE persona_audit_correlations
  ADD COLUMN IF NOT EXISTS hash_version integer NOT NULL DEFAULT 1;
