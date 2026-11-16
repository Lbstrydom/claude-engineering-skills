-- Harness retro — derived recurrence records (docs/plans/harness-retro.md §2 c14, §7).
--
-- Three tables, written ONLY by scripts/harness-retro.mjs `scan --persist`:
--   harness_retro_scans       — one row per persisted scan: the coverage evidence.
--   harness_retro_sessions    — one row per session: the effect metric's DENOMINATOR.
--   harness_retro_occurrences — per (session, fingerprint) counts: the NUMERATOR.
--
-- DERIVED ONLY. No transcript text, no label, no free-text column of any kind:
-- the egress table in the plan allows fingerprint, kind, normalised tool name,
-- counts, timestamps and hashed keys. Raw transcripts never leave local disk.
--
-- repo_uuid carries no FK to audit_repos ON PURPOSE: a session from a repo with
-- no audit_repos row in THIS store must still count in the denominator; the
-- identity is the stable uuidv5 from repo-identity.mjs, not a row.
--
-- observed_until on sessions is the snapshot-freshness guard: the writer's
-- upsert only replaces a session whose stored observed_until is <= the incoming
-- one, so a delayed replay of an older spilled snapshot cannot overwrite a newer.
--
-- Idempotent: IF NOT EXISTS throughout. public-only, no schema-qualified names
-- (parity:check-coupling). RLS enabled with no anon policy, mirroring
-- memory_friction (the runtime pool bypasses RLS; the policy absence is the boundary).

CREATE TABLE IF NOT EXISTS harness_retro_scans (
  scan_id             text PRIMARY KEY,
  account_key         text NOT NULL,
  repo_uuid           uuid NOT NULL,
  fingerprint_version integer NOT NULL,
  requested_since     timestamptz NOT NULL,
  requested_until     timestamptz NOT NULL,
  files_listed        integer NOT NULL,
  files_read          integer NOT NULL,
  read_errors         integer NOT NULL,
  completed           boolean NOT NULL,
  created_at          timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT harness_retro_scans_range_chk CHECK (requested_since < requested_until)
);

CREATE TABLE IF NOT EXISTS harness_retro_sessions (
  session_key         text PRIMARY KEY,
  repo_uuid           uuid NOT NULL,
  account_key         text NOT NULL,
  origin              text NOT NULL CONSTRAINT harness_retro_sessions_origin_chk CHECK (origin IN ('interactive', 'automated')),
  started_at          timestamptz NOT NULL,
  fingerprint_version integer NOT NULL,
  signal_count        integer NOT NULL,
  last_scan_id        text NOT NULL,
  observed_until      timestamptz NOT NULL,
  updated_at          timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS harness_retro_occurrences (
  session_key  text NOT NULL REFERENCES harness_retro_sessions (session_key) ON DELETE CASCADE,
  fingerprint  text NOT NULL,
  kind         text NOT NULL,
  tool         text NOT NULL DEFAULT '',
  occurrences  integer NOT NULL CONSTRAINT harness_retro_occurrences_count_chk CHECK (occurrences > 0),
  first_at     timestamptz,
  last_at      timestamptz,
  PRIMARY KEY (session_key, fingerprint)
);

CREATE INDEX IF NOT EXISTS idx_harness_retro_sessions_repo_started ON harness_retro_sessions (repo_uuid, started_at);
CREATE INDEX IF NOT EXISTS idx_harness_retro_occurrences_fingerprint ON harness_retro_occurrences (fingerprint);
CREATE INDEX IF NOT EXISTS idx_harness_retro_scans_repo_account ON harness_retro_scans (repo_uuid, account_key, completed);

ALTER TABLE harness_retro_scans ENABLE ROW LEVEL SECURITY;
ALTER TABLE harness_retro_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE harness_retro_occurrences ENABLE ROW LEVEL SECURITY;
