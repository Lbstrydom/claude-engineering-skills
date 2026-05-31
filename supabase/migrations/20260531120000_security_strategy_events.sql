-- ╔═══════════════════════════════════════════════════════════════════════════╗
-- ║  Security-strategy audit trail — security_strategy_events                  ║
-- ║  Back-port: docs/plans/security/PLAN.md §4.2 (corporate hardening kit).    ║
-- ║                                                                           ║
-- ║  Append-only audit trail for every write the security-memory refresh      ║
-- ║  performs against security_incidents: incidents inserted/updated, swept    ║
-- ║  to historical, and — the security-substantive part — secrets the         ║
-- ║  pre-write gate REFUSED (high-confidence key shapes) or REDACTED (PII).   ║
-- ║  Gives /plan + the dashboard a tamper-evident record of what the skill    ║
-- ║  did and what it kept out of the index.                                   ║
-- ║                                                                           ║
-- ║  AUTHORIZATION: same posture as security_incidents (20260504120000) —     ║
-- ║  RLS ENABLED with NO policy → deny-all for anon/authenticated; the         ║
-- ║  runtime owner role (postgres via AUDIT_DB_URL) bypasses RLS. This is the  ║
-- ║  same lockdown applied across the store (see status.md 2026-05-30 RLS).   ║
-- ╚═══════════════════════════════════════════════════════════════════════════╝

-- 1. Event-kind enum (closed set — application maps gate/sweep outcomes to it).
DO $$ BEGIN
  CREATE TYPE security_event_kind_t AS ENUM (
    'inserted',
    'updated',
    'marked_historical',
    'refused_secret',
    'redacted_secret'
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- 2. Table. `incident_id` is a soft reference (TEXT, not FK) — a refused_secret
--    event exists precisely because the incident was NOT written, so a hard FK
--    to security_incidents would be wrong. `detail` is JSONB, redacted by the
--    application (only masked samples — first 6 chars + ellipsis — ever land here).
CREATE TABLE IF NOT EXISTS security_strategy_events (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  repo_id       UUID NOT NULL REFERENCES audit_repos(id) ON DELETE CASCADE,
  incident_id   TEXT NOT NULL,
  event_kind    security_event_kind_t NOT NULL,
  who           TEXT,
  branch        TEXT NOT NULL,
  commit_sha    TEXT,
  detail        JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 3. Index — the dashboard + any "recent events" reader pages by repo, newest first.
CREATE INDEX IF NOT EXISTS idx_security_strategy_events_repo
  ON security_strategy_events(repo_id, created_at DESC);

-- 4. RLS — ENABLE but NO policy (explicit absence is the boundary; owner bypasses).
ALTER TABLE security_strategy_events ENABLE ROW LEVEL SECURITY;
