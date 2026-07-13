-- WS4 (persona-nav-feedback-recovery, Cluster 3): `updated_at` was being
-- set from the CLIENT's JS clock (`new Date().toISOString()` passed as a
-- bound parameter) while `created_at` uses the DB SERVER's `now()` default
-- — two different clock sources. An empirical smoke test caught the
-- symptom directly: after an insert-then-update round trip against the
-- remote Supabase instance, the displayed `updated_at` (client clock) was
-- EARLIER than `created_at` (server clock) despite the update happening
-- strictly after the insert in wall-clock time — clock skew between the
-- local machine and the DB server, not a logic bug, but the plan's own
-- correction-semantics design ("visible updated_at != created_at") is
-- fragile against comparing two different clock bases. Matches the
-- established `touch_*_updated_at` trigger pattern already used by
-- `security_incidents`/`memory_friction` — same clock (server `now()`)
-- for both columns going forward.

CREATE OR REPLACE FUNCTION touch_persona_finding_outcomes_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_persona_finding_outcomes_touch ON persona_finding_outcomes;
CREATE TRIGGER trg_persona_finding_outcomes_touch
  BEFORE UPDATE ON persona_finding_outcomes
  FOR EACH ROW
  EXECUTE FUNCTION touch_persona_finding_outcomes_updated_at();
