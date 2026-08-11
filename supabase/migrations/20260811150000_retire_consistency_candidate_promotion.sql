-- Retire the persona-consistency candidate/promotion path.
--
-- The path captured a DOM-vs-engine contradiction as a `regression_specs` row
-- (`source_kind='persona-consistency-candidate'`), which `/ship` Step 5.6 then
-- materialised into a generated Playwright spec
-- (`source_kind='persona-consistency-locked'`). Both kinds are removed here
-- along with the four evidence columns only they ever populated.
--
-- Evidence gathered before dropping (2026-08-11, against the live store):
--   * `SELECT source_kind, count(*) FROM regression_specs GROUP BY 1` returns
--     exactly one row: `unit-test`, 100. **Zero candidate rows and zero locked
--     rows have ever existed.**
--   * `count(candidate_fingerprint)` is 0 across the whole table.
--   * The writer had been broken since the day the feature shipped: the
--     consistency runner passed a repo DESCRIPTOR where a uuid was expected,
--     so every emission raised 22P02 into a swallowed catch (fixed in
--     ef86ef92; this migration removes the feature the fix restored).
--   * `/ux-lock` never populates witness_snapshot / contradiction_payload /
--     journey_context — it writes only spec_path, description, commit_sha and
--     assertion_count. Those columns are exclusively the consistency shape.
--
-- WHY REMOVED RATHER THAN REPAIRED — and the caveat that goes with it.
-- A promoted spec asserts a DOM contract through a browser. The durable fix
-- for a DOM-vs-engine contradiction is a declaration (what the surface claims)
-- or a renderer contract test (what the renderer must emit): the sole adopting
-- consumer produced 106 contract tests in the same 12 weeks, and every defect
-- in its recent consistency-surface push was fixed by a manifest fragment or a
-- contract test. None wanted a generated spec.
--
-- **The max ratchet is now the only journey-level lock, and it is loosenable.**
-- This is the real cost of the removal, stated rather than hidden. A canary's
-- `expectedContradictions` gates on a COUNT (`min`/`max`) plus assert-PRESENT
-- `shapes[]`; it cannot express "this specific contradiction must be absent".
-- So after fixing a defect you lock it by setting `max: 0` — and anyone can
-- unlock every past defect on that journey by editing one integer to unblock
-- CI, with no diff that reads as a regression. A named per-defect spec resisted
-- that; nothing in the remaining design does. A renderer contract test resists
-- it equally well, but only if somebody writes one. Treat a `max` increase as a
-- change that needs the same scrutiny as deleting a test.
--
-- NOT DROPPED, deliberately: `unlocked_fixes_all` still carries
-- `rs.source_kind <> 'persona-consistency-candidate'` in two predicates. It
-- references only the VALUE, never the dropped columns, so it keeps working
-- untouched; the predicate is now trivially true and left as a defensive
-- no-op rather than recreating a large view for cosmetics.

-- 1. Indexes that exist only to arbitrate candidate rows.
DROP INDEX IF EXISTS idx_regression_specs_candidate_fingerprint;
DROP INDEX IF EXISTS idx_regression_specs_pending_candidates;

-- 2. Constraints must go BEFORE the columns they reference.
ALTER TABLE regression_specs DROP CONSTRAINT IF EXISTS regression_specs_row_shape_check;
ALTER TABLE regression_specs DROP CONSTRAINT IF EXISTS regression_specs_source_kind_check;

-- 3. The evidence columns. Only the two retired kinds ever wrote them, and the
--    row-shape CHECK required them to be NULL for every surviving kind — so
--    this cannot lose data on any row that remains legal.
ALTER TABLE regression_specs DROP COLUMN IF EXISTS candidate_fingerprint;
ALTER TABLE regression_specs DROP COLUMN IF EXISTS witness_snapshot;
ALTER TABLE regression_specs DROP COLUMN IF EXISTS contradiction_payload;
ALTER TABLE regression_specs DROP COLUMN IF EXISTS journey_context;
ALTER TABLE regression_specs DROP COLUMN IF EXISTS promoted_at;
ALTER TABLE regression_specs DROP COLUMN IF EXISTS promoted_by;
ALTER TABLE regression_specs DROP COLUMN IF EXISTS redaction_count;

-- 4. Re-add the narrowed constraints. source_kind loses the two consistency
--    kinds; the row shape collapses to "spec_path is always required", which
--    is what every surviving kind already asserted.
ALTER TABLE regression_specs
  ADD CONSTRAINT regression_specs_source_kind_check
  CHECK (source_kind = ANY (ARRAY[
    'audit-loop-fix', 'persona-test-p0', 'persona-test-p1',
    'plan-frontend-verify', 'plan-backend-verify',
    'unit-test', 'manual', 'other'
  ]));

ALTER TABLE regression_specs
  ADD CONSTRAINT regression_specs_row_shape_check
  CHECK (spec_path IS NOT NULL);

COMMENT ON TABLE regression_specs IS
  'Regression specs registered by /ux-lock and by lock-with-test. Every row '
  'names a spec_path. The persona-consistency candidate/promotion path was '
  'retired 2026-08-11 (migration 20260811150000) having never written a row.';
