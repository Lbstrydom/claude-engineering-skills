-- upstream_issues.reported_source_dirty — qualify the bundle sha.
--
-- `reported_bundle_sha` is the source repo's HEAD at sync time, but
-- `sync-to-repos.mjs` ships bytes read from the WORKING TREE. When the two
-- disagree the consumer holds code NEWER than its own stamp, and every distance
-- computed from that sha is wrong in the direction that invites "you're behind,
-- re-sync".
--
-- Measured 2026-08-01: a consumer report was stamped 10 commits behind while
-- running code from a commit that did not yet exist (another session's
-- uncommitted work had been synced 30 minutes earlier). The freshness verdict
-- read `stale/behind-head`, the prior-fix list looked like the bug was already
-- handled, and a real report was nearly dismissed on that basis.
--
-- Tri-state, and the NULL arm is the important one:
--   TRUE  — a source file this bundle ships was uncommitted at sync time; the
--           sha is a LOWER BOUND, so no freshness verdict is assertable.
--   FALSE — determined clean; the sha identifies the shipped bytes.
--   NULL  — not determined (no git at sync time, or a manifest published before
--           the field existed). MUST read as unknown, never as clean — the same
--           rule `reported_bundle_sha IS NULL` already carries.
--
-- Deliberately nullable with no DEFAULT: a `DEFAULT FALSE` would silently
-- assert "clean" for every pre-existing row, which is precisely the false
-- confidence this column exists to remove.
ALTER TABLE upstream_issues
  ADD COLUMN IF NOT EXISTS reported_source_dirty BOOLEAN;

COMMENT ON COLUMN upstream_issues.reported_source_dirty IS
  'Was any source file in this bundle uncommitted when it was synced? TRUE => reported_bundle_sha is a lower bound and freshness is unknowable. NULL => not determined; never read as clean.';
