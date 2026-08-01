-- regression_specs: one test file may lock MANY findings.
--
-- THE BUG (reported from wine-cellar-app, 2026-08-01; reproduced here). The
-- table carried `UNIQUE (repo_id, spec_path)` from 20260419120000, and
-- `recordRegressionSpec` upserts non-candidate rows on exactly that target. So
-- locking a second finding to a test file that already held one did not insert
-- a row — it REASSIGNED the existing one. The previously-locked finding
-- silently returned to `unlocked_fixes` with `lock_spec_count` back to 0, while
-- both calls returned `{"ok":true,"locked":true}`. A batch sweep therefore
-- reports full success having locked exactly one finding per file.
--
-- Measured on the shared store before this migration: 16 `unit-test` rows in
-- wine-cellar-app across 16 distinct `spec_path`s — exactly one each, from ~31
-- lock invocations. Roughly half the sweep evicted the other half.
--
-- Why the constraint was right and is now wrong. Under /ux-lock the identity
-- held: one authored Playwright spec file pins one fix, so `(repo, path)` IS
-- the row identity and re-running /ux-lock on the same fix must update in
-- place. `source_kind = 'unit-test'` (20260729140000) broke that assumption —
-- a unit/integration test file routinely covers several related findings.
-- cellarSwitcher.test.js was in fact written to lock three of them.
--
-- The alternative — reject the second lock loudly — was rejected. It makes the
-- eviction visible but leaves the queue for any shared file undrainable, and
-- the only way to comply would be to fragment coherent suites into one file per
-- finding: reshaping the repo around the store's schema. The identity of a
-- unit-test lock is not the file, it is WHICH FINDING the file pins.
--
-- Scoped rather than global. The full unique index is replaced by two PARTIAL
-- ones so the /ux-lock and persona-consistency kinds keep the one-row-per-path
-- identity that is genuinely true for them:
--   * non-unit-test → UNIQUE (repo_id, spec_path)
--   * unit-test     → UNIQUE (repo_id, spec_path, source_finding_id)
-- Both keep the upsert idempotent: re-locking the same pair still updates.
--
-- CONSUMER-SYNC ORDERING (read before applying). A partial index can only be
-- inferred as an ON CONFLICT arbiter when the statement carries a matching
-- WHERE. Un-resynced consumer copies of `recordRegressionSpec` send a bare
-- `ON CONFLICT (repo_id, spec_path)` and will raise 42P10 for NON-unit-test
-- kinds after this runs — caught by the writer's try/catch, so it degrades to
-- "spec not recorded" with a stderr line rather than a crash. Blast radius is
-- currently nil (zero non-unit-test rows exist in any repo), but re-sync
-- consumers with `npm run sync` alongside this migration. The reverse order is
-- safe: the updated code sends `ON CONFLICT (...) WHERE ...`, and a total index
-- trivially satisfies any predicate, so it works against the OLD schema too.
--
-- A unit-test row without a finding is meaningless (nothing is locked and the
-- three-column index could not dedupe it), so that is now a CHECK. Verified
-- against the live store first: 0 violating rows, and 0 would-be duplicates
-- under the new three-column key.

-- 1. Identity precondition for the new unit-test key.
ALTER TABLE regression_specs
  DROP CONSTRAINT IF EXISTS regression_specs_unit_test_finding_check;

ALTER TABLE regression_specs
  ADD CONSTRAINT regression_specs_unit_test_finding_check
  CHECK (source_kind <> 'unit-test' OR source_finding_id IS NOT NULL);

-- 2. Replacements created BEFORE the drop, so no window exists in which
--    duplicate paths could land unprotected.
CREATE UNIQUE INDEX IF NOT EXISTS idx_regression_specs_path_nonunit
  ON regression_specs (repo_id, spec_path)
  WHERE source_kind <> 'unit-test' AND spec_path IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_regression_specs_unit_test_lock
  ON regression_specs (repo_id, spec_path, source_finding_id)
  WHERE source_kind = 'unit-test';

-- 3. The over-broad original.
ALTER TABLE regression_specs
  DROP CONSTRAINT IF EXISTS regression_specs_repo_id_spec_path_key;
