-- Round-4 audit M14: chk_upstream_disposition_shape (migration 20260822000000)
-- required `^(probe|test|exempt):.+$`, which `.+` happily satisfies with pure
-- whitespace (e.g. 'exempt:   ') — a value that carries no actual reason.
-- Tightened to require at least one non-whitespace character in the value,
-- mirroring the CLI-side contract (validateLedgerEntryShape's
-- `disposition.value.trim()` check) at the DB boundary too.
ALTER TABLE upstream_issues
  DROP CONSTRAINT IF EXISTS chk_upstream_disposition_shape;
ALTER TABLE upstream_issues
  ADD CONSTRAINT chk_upstream_disposition_shape
    CHECK (disposition IS NULL OR disposition ~ '^(probe|test|exempt):.*\S.*$');

COMMENT ON CONSTRAINT chk_upstream_disposition_shape ON upstream_issues IS
  'A non-null disposition must be <kind>:<value> with kind in probe|test|exempt and value containing at least one non-whitespace character — the same shape upstreamTransition/validateLedgerEntryShape enforce at the CLI layer, now also enforced at the DB boundary so a direct write cannot bypass it.';
