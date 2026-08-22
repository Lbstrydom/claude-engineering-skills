-- Round-3 audit M8: chk_upstream_terminal_has_disposition (migration
-- 20260820130000) only checks disposition IS NOT NULL for a terminal row — a
-- direct DB write could satisfy it with any non-null garbage string, bypassing
-- the CLI's own kind/value shape validation (validateLedgerEntryShape /
-- upstreamTransition). This constraint makes the DB the authority for
-- disposition SHAPE too, not just presence.
ALTER TABLE upstream_issues
  DROP CONSTRAINT IF EXISTS chk_upstream_disposition_shape;
ALTER TABLE upstream_issues
  ADD CONSTRAINT chk_upstream_disposition_shape
    CHECK (disposition IS NULL OR disposition ~ '^(probe|test|exempt):.+$');

COMMENT ON CONSTRAINT chk_upstream_disposition_shape ON upstream_issues IS
  'A non-null disposition must be <kind>:<value> with kind in probe|test|exempt — the same shape upstreamTransition/validateLedgerEntryShape enforce at the CLI layer, now also enforced at the DB boundary so a direct write cannot bypass it.';
