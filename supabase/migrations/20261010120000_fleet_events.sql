-- ============================================================================
-- fleet_events — one row per /fleet CLI invocation (docs/plans/fleet-telemetry.md).
--
-- /fleet wrote nothing to the store: the skill census could only proxy it from
-- `AI-Skill: fleet` commit trailers, which fleet never writes, so its usage,
-- latency and failure modes were unmeasured. fleet now spools one event per
-- invocation locally and a detached drain (`cross-skill.mjs fleet-telemetry
-- flush`) inserts them here.
--
-- Events only; every metric (golden signals per verb, session lead time,
-- refusal/error classes, saturation, per-version regressions) is derived at read
-- time by scripts/lib/store/fleet-events.mjs, so metrics can change without a
-- migration.
--
-- event_id is minted by the client; UNIQUE makes a re-drained event a no-op
-- (the drain is at-least-once). created_at is when the event HAPPENED (client
-- clock) — the census windows read it — and recorded_at is when it arrived.
-- detail holds counts / booleans / closed-vocabulary strings only, never paths
-- or prose (the capture side enforces that; the drain schema-checks it).
-- ============================================================================

CREATE TABLE IF NOT EXISTS fleet_events (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id      UUID NOT NULL,
  repo_id       UUID REFERENCES audit_repos(id) ON DELETE CASCADE,
  repo_name     TEXT,
  verb          TEXT NOT NULL,
  mode          TEXT,
  outcome       TEXT NOT NULL,
  exit_code     INTEGER,
  duration_ms   INTEGER NOT NULL,
  session_id    TEXT,
  reason_class  TEXT,
  tool_sha      TEXT,
  detail        JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  recorded_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT fleet_events_event_id_uniq UNIQUE (event_id),
  CONSTRAINT fleet_events_outcome_chk CHECK (outcome IN ('ok', 'refused', 'pending', 'error', 'argv')),
  CONSTRAINT fleet_events_duration_chk CHECK (duration_ms >= 0)
);

CREATE INDEX IF NOT EXISTS idx_fleet_events_repo_created
  ON fleet_events (repo_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_fleet_events_repo_session
  ON fleet_events (repo_id, session_id)
  WHERE session_id IS NOT NULL;

-- Same posture as every cross-skill table: RLS on, no anon policy — reads and
-- writes go through scripts/cross-skill.mjs on the owner connection.
ALTER TABLE fleet_events ENABLE ROW LEVEL SECURITY;
