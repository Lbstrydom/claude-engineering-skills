-- Telemetry linkage state (docs/plans/telemetry-linkage-structural.md).
--
-- A run row now says whether it is linked to an audit session, deliberately standalone (with a declared reason),
-- or unlinked (no session and nothing declared). Before this, "no session" was a bare NULL indistinguishable from
-- a dropped field: audit_session_id sat at 0% on code runs for weeks.
--
-- Rows written before this migration stay NULL on both columns; the linkage query reports them as
-- `legacy-unstated`, never as linked. No backfill.
--
-- NEW rows can never carry a bare NULL state, even from a writer that predates this migration (a consumer not yet
-- synced writes to a migrated store): the BEFORE INSERT trigger derives the state from the columns the writer did
-- supply. The CHECKs then refuse every contradictory pair. `linkage_state IS NULL` stays legal in the CHECK only so
-- legacy rows remain updatable (recordRunComplete UPDATEs them); the trigger is what keeps new rows out of it.
--
-- STANDALONE REASONS below must equal STANDALONE_REASONS in scripts/lib/telemetry/linkage.mjs
-- (tests/telemetry-linkage.test.mjs pins both directions).
--
-- Idempotent. public-only, no schema-qualified names (parity:check-coupling).

ALTER TABLE audit_runs ADD COLUMN IF NOT EXISTS linkage_state text;
ALTER TABLE audit_runs ADD COLUMN IF NOT EXISTS linkage_reason text;

CREATE OR REPLACE FUNCTION audit_runs_derive_linkage() RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  -- A blank session id is no session: it must not read as linked.
  IF NEW.audit_session_id IS NOT NULL AND NEW.audit_session_id ~ '^\s*$' THEN
    NEW.audit_session_id := NULL;
  END IF;
  IF TG_OP = 'UPDATE' THEN
    -- An UPDATE may not erase a state the row already carries (a legacy NULL row stays updatable).
    IF NEW.linkage_state IS NULL AND OLD.linkage_state IS NOT NULL THEN
      NEW.linkage_state := OLD.linkage_state;
      NEW.linkage_reason := OLD.linkage_reason;
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.linkage_state IS NULL THEN
    IF NEW.audit_session_id IS NOT NULL THEN
      NEW.linkage_state := 'linked';
      NEW.linkage_reason := NULL;
    ELSE
      NEW.linkage_state := 'unlinked';
      NEW.linkage_reason := COALESCE(NEW.linkage_reason, 'undeclared');
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_audit_runs_derive_linkage ON audit_runs;
CREATE TRIGGER trg_audit_runs_derive_linkage
  BEFORE INSERT OR UPDATE ON audit_runs
  FOR EACH ROW EXECUTE FUNCTION audit_runs_derive_linkage();

ALTER TABLE audit_runs DROP CONSTRAINT IF EXISTS audit_runs_linkage_state_chk;
ALTER TABLE audit_runs ADD CONSTRAINT audit_runs_linkage_state_chk
  CHECK (linkage_state IS NULL OR linkage_state IN ('linked', 'unlinked', 'standalone'));

-- linked: names a session, carries no reason. standalone: no session, a reason from the closed declared set.
-- unlinked: no session, a reason saying why (`undeclared`, or `invalid-declaration: ...`).
ALTER TABLE audit_runs DROP CONSTRAINT IF EXISTS audit_runs_linkage_pair_chk;
ALTER TABLE audit_runs ADD CONSTRAINT audit_runs_linkage_pair_chk
  CHECK (
    linkage_state IS NULL
    OR (linkage_state = 'linked' AND audit_session_id IS NOT NULL AND linkage_reason IS NULL)
    OR (linkage_state = 'standalone' AND audit_session_id IS NULL
        AND COALESCE(linkage_reason IN ('manual-single-shot', 'canary', 'model-eval'), false))
    OR (linkage_state = 'unlinked' AND audit_session_id IS NULL AND linkage_reason IS NOT NULL)
  );
