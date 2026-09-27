-- ============================================================================
-- persona_pair_sessions — the linkage /persona-test --pair has always asked for.
--
-- skills/persona-test/SKILL.md Step P7 told the agent to run
-- `cross-skill.mjs link-persona-pair` from the day pair mode shipped, and no
-- subcommand, handler or table ever existed — every pair run's linkage call
-- failed, and the two solo sessions were never joinable afterwards. This is
-- the table that call writes (field report 2026-09-26).
--
-- One row per ordered (session_a, session_b) pair. The counts are the Step P4
-- diff; overlap_rate is DERIVED from them by the writer (never taken from the
-- model), and the CHECKs below make an inconsistent row unrepresentable rather
-- than merely unlikely.
--
-- repo_id is copied from the sessions, which must agree (the writer refuses a
-- cross-repo pair); it is nullable because persona_test_sessions.repo_id is —
-- a pair run against a deployed URL from outside a resolvable repo still pairs.
-- ============================================================================

CREATE TABLE IF NOT EXISTS persona_pair_sessions (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  repo_id          UUID REFERENCES audit_repos(id) ON DELETE CASCADE,
  session_a        UUID NOT NULL REFERENCES persona_test_sessions(id) ON DELETE CASCADE,
  session_b        UUID NOT NULL REFERENCES persona_test_sessions(id) ON DELETE CASCADE,
  consensus_count  INTEGER NOT NULL CHECK (consensus_count >= 0),
  a_only_count     INTEGER NOT NULL CHECK (a_only_count >= 0),
  b_only_count     INTEGER NOT NULL CHECK (b_only_count >= 0),
  overlap_rate     NUMERIC(5,4) NOT NULL CHECK (overlap_rate >= 0 AND overlap_rate <= 1),
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT persona_pair_sessions_distinct_chk CHECK (session_a <> session_b),
  CONSTRAINT persona_pair_sessions_pair_uniq UNIQUE (session_a, session_b)
);

-- session_b is not the leading column of the UNIQUE index, so its FK cascade
-- needs its own.
CREATE INDEX IF NOT EXISTS idx_persona_pair_sessions_session_b
  ON persona_pair_sessions (session_b);

CREATE INDEX IF NOT EXISTS idx_persona_pair_sessions_repo
  ON persona_pair_sessions (repo_id, created_at DESC);

-- Same posture as persona_test_sessions (20260507130000): RLS on, no anon
-- policy — every read and write goes through scripts/cross-skill.mjs.
ALTER TABLE persona_pair_sessions ENABLE ROW LEVEL SECURITY;
