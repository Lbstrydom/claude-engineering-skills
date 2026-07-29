-- regression_specs: allow `source_kind = 'unit-test'`, so a fix guarded by a
-- unit/integration test can be recorded as LOCKED.
--
-- Why this is needed at all. `unlocked_fixes` counts a fix as unlocked unless a
-- `regression_specs` row exists, and every existing `source_kind` is authored
-- by /ux-lock or /persona-test — i.e. a Playwright spec driving a live URL.
-- That made the gate unsatisfiable for any fix without a browser surface: on
-- 2026-07-29 it held 119 code obligations in this repo, which has no frontend
-- at all, and 6 of the 7 distinct modules involved already had unit tests. The
-- guard existed; the schema had no way to say so.
--
-- This is NOT a CLI-repo special case. /ux-lock has a documented bad track
-- record on React surfaces (wine-cellar-app, 2026-07: generated specs proved
-- brittle and several had to be reverted; root cause still undiagnosed), so
-- the browser-spec path is unreliable even on its home turf. A unit test is
-- the primary regression lock for most fixes, not a consolation prize.
--
-- Row shape: `unit-test` reuses the FIRST branch of the row-shape check —
-- `spec_path` carries the test file path and every consistency-mode column
-- stays NULL. No new columns; the existing shape already fits.
--
-- HONESTY CONSTRAINT (the reason this migration is not just an ARRAY edit):
-- a row asserting "tests/foo.test.mjs locks finding X" is a CLAIM, and a
-- claim recorded without evidence is precisely the fake-check class the
-- gate-honesty suite exists to catch. Inserting 119 rows by matching
-- `primary_file` to a same-named test would have closed the number while
-- proving nothing — file existence is not coverage. So the writer
-- (`recordUnitTestLock`) refuses a path that does not exist on disk, and
-- `description` is NOT NULL, forcing the caller to state what the test
-- actually pins. The schema cannot verify semantic coverage; it can refuse
-- the cheapest way to fake it.
--
-- Amends via DROP + ADD CONSTRAINT rather than editing the applied migrations
-- (20260419120000, 20260520120000): the ledger records a sha256 per file, so
-- editing an applied one reads as drift. Same reason 20260729120000 gives.

ALTER TABLE regression_specs
  DROP CONSTRAINT IF EXISTS regression_specs_source_kind_check;

ALTER TABLE regression_specs
  ADD CONSTRAINT regression_specs_source_kind_check
  CHECK (source_kind = ANY (ARRAY[
    'audit-loop-fix', 'persona-test-p0', 'persona-test-p1',
    'plan-frontend-verify', 'plan-backend-verify',
    'persona-consistency-candidate', 'persona-consistency-locked',
    'unit-test',
    'manual', 'other'
  ]));

ALTER TABLE regression_specs
  DROP CONSTRAINT IF EXISTS regression_specs_row_shape_check;

ALTER TABLE regression_specs
  ADD CONSTRAINT regression_specs_row_shape_check
  CHECK (
    (
      source_kind = ANY (ARRAY[
        'audit-loop-fix', 'persona-test-p0', 'persona-test-p1',
        'plan-frontend-verify', 'plan-backend-verify',
        'unit-test',
        'manual', 'other'
      ])
      AND spec_path IS NOT NULL
      AND candidate_fingerprint IS NULL
      AND witness_snapshot IS NULL
      AND contradiction_payload IS NULL
      AND journey_context IS NULL
      AND promoted_at IS NULL
      AND promoted_by IS NULL
    )
    OR (
      source_kind = 'persona-consistency-candidate'
      AND spec_path IS NULL
      AND candidate_fingerprint IS NOT NULL
      AND witness_snapshot IS NOT NULL
      AND contradiction_payload IS NOT NULL
      AND journey_context IS NOT NULL
      AND promoted_at IS NULL
      AND promoted_by IS NULL
    )
    OR (
      source_kind = 'persona-consistency-locked'
      AND spec_path IS NOT NULL
      AND candidate_fingerprint IS NOT NULL
      AND witness_snapshot IS NOT NULL
      AND contradiction_payload IS NOT NULL
      AND journey_context IS NOT NULL
      AND promoted_at IS NOT NULL
    )
  );
