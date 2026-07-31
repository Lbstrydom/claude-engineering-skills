-- ============================================================================
-- upstream_issues — structured consumer → source bug reports.
-- Plan: docs/plans/upstream-issue-reports.md (Cluster A, Phase 2).
--
-- A consumer repo hits a bug in upstream-owned synced tooling
-- (`scripts/.claude-skills/**`). Before this table those arrived as pasted
-- prose: wrong paths, no bundle version, and no way to tell whether the bug
-- was already fixed upstream. `reported_bundle_sha` is the field that makes
-- "already fixed?" answerable — populated from the consumer's
-- `scripts/.sync-manifest.json`, which only started carrying a real sha in
-- Phase 1 (commit d9879e26; it was hardcoded NULL before that).
--
-- Deliberately NOT folded into `memory_friction`: that table mirrors
-- harness-memory `type: friction` files for cross-repo RECURRENCE
-- aggregation of "how is it to work in THIS repo". An upstream issue is a
-- different object — it is about ANOTHER repo's code, carries a bundle
-- version, and has a triage lifecycle with an owner. Sharing the table would
-- put two unrelated lifecycles in one place and corrupt the recurrence metric
-- memory_friction exists to serve.
--
-- Single-tenant: the runtime pg pool owns `public` and bypasses RLS; the RLS
-- policy (enabled, no anon policy) is defence-in-depth, mirroring
-- memory_friction / security_incidents. Every repo sharing one AUDIT_DB_URL is
-- ONE trust domain — a report body must be written on the assumption that any
-- holder of that DSN can read it (see the plan §3).
-- ============================================================================

CREATE TABLE IF NOT EXISTS upstream_issues (
  id                           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  repo_id                      UUID NOT NULL REFERENCES audit_repos(id) ON DELETE CASCADE,
  -- Bounds are enforced HERE, not only in the CLI: the store is the durable
  -- boundary and the CLI is one of several possible callers. 64 KiB on the body
  -- because it also lands in a plaintext on-disk outbox.
  title                        TEXT NOT NULL CHECK (char_length(title) BETWEEN 1 AND 200),
  body                         TEXT NOT NULL CHECK (char_length(body) BETWEEN 1 AND 65536),
  -- NOT NULL is load-bearing on every CHECK'd column, not boilerplate: a
  -- Postgres CHECK evaluates to NULL — and therefore PASSES — when its operand
  -- is NULL, so both the enum checks and the fixed/commit equivalence below are
  -- inert without it.
  severity                     TEXT NOT NULL CHECK (severity IN ('BLOCKER', 'HIGH', 'MEDIUM', 'LOW')),
  affected_path                TEXT NOT NULL CHECK (char_length(affected_path) BETWEEN 1 AND 512),
  -- NULL = the consumer's manifest carried no stamp (pre-Phase-1 bundle, or a
  -- tarball install with no git). Triage MUST read that as "version unknown",
  -- never as "current" — inferring freshness from absence is the failure class
  -- this whole feature exists to remove.
  reported_bundle_sha          TEXT,
  reported_bundle_generated_at TIMESTAMPTZ,
  -- Did `affected_path` match a key in the consumer manifest's file map?
  -- NULL = not checked (no manifest on disk). FALSE is a warning, never a
  -- block: the path may be genuinely upstream-but-unsynced (e.g. install.mjs).
  path_recognised              BOOLEAN,
  state                        TEXT NOT NULL DEFAULT 'open'
    CHECK (state IN ('open', 'acknowledged', 'fixed', 'wont_fix')),
  fixed_in_commit              TEXT,
  fingerprint                  TEXT NOT NULL UNIQUE,
  created_at                   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at                   TIMESTAMPTZ NOT NULL DEFAULT now(),

  -- A `fixed` row always names its commit, and a non-`fixed` row never retains
  -- a stale one. Equivalence, not implication, so both directions hold.
  CONSTRAINT chk_upstream_fixed_has_commit
    CHECK ((state = 'fixed') = (fixed_in_commit IS NOT NULL)),

  -- NOT NULL alone would accept '' or '   ' — and this value is the basis for
  -- the downstream ancestry check, so a non-commit string here produces a
  -- confidently wrong freshness answer rather than a loud failure. Shape-check
  -- it (abbreviated or full hex sha); the CLI additionally verifies the commit
  -- actually resolves via `git rev-parse --verify`.
  CONSTRAINT chk_upstream_fixed_commit_shape
    CHECK (fixed_in_commit IS NULL OR fixed_in_commit ~ '^[0-9a-f]{7,40}$')
);

-- The default worksheet query (`state='open'` ordered newest-first). The `id`
-- tiebreaker is what makes the keyset cursor UNIQUE: `created_at` alone is not,
-- so same-timestamp rows would be skipped or repeated across pages.
CREATE INDEX IF NOT EXISTS upstream_issues_state_created_idx
  ON upstream_issues (state, created_at DESC, id DESC);

-- The candidate-prior-fix join. Deliberately NOT led by repo_id: the fixed code
-- lives in the SOURCE repo, so a fix prompted by one consumer's report is
-- equally relevant to another consumer's report about the same file. Leading
-- with repo_id would isolate universally-relevant upstream fixes per consumer.
CREATE INDEX IF NOT EXISTS upstream_issues_path_state_idx
  ON upstream_issues (affected_path, state);

CREATE INDEX IF NOT EXISTS upstream_issues_repo_created_idx
  ON upstream_issues (repo_id, created_at DESC);

-- ── Append-only lifecycle log ───────────────────────────────────────────────
-- Written in the SAME transaction as the row transition it records, so the log
-- can never diverge from the row's state.
CREATE TABLE IF NOT EXISTS upstream_issue_events (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  issue_id   UUID NOT NULL REFERENCES upstream_issues(id) ON DELETE CASCADE,
  event      TEXT NOT NULL CHECK (event IN ('reported', 'acknowledged', 'fixed', 'wont_fix')),
  note       TEXT,
  actor      TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS upstream_issue_events_issue_idx
  ON upstream_issue_events (issue_id, created_at);

-- No-in-place-rewrite, ENFORCED rather than asserted in a comment.
--
-- A plain table is mutable and the runtime pool bypasses RLS, so without this
-- any caller that can INSERT an event can equally rewrite one — and the log's
-- value as an audit trail would be a claim rather than a property. A trail that
-- can be silently altered is worse than no trail, because it is trusted.
--
-- UPDATE only, deliberately — and this is the honest scope, verified against a
-- live Postgres rather than assumed. A `BEFORE DELETE` row trigger DOES fire
-- for rows removed by a referential action, so adding one made
-- `DELETE FROM upstream_issues` (and by extension removing an `audit_repos`
-- row) fail outright: the FK cascade hit the trigger and aborted. Blocking
-- UPDATE gives the property that matters — history cannot be edited to say
-- something it never said — while leaving the cascade functional.
--
-- Residual, stated plainly: a direct `DELETE FROM upstream_issue_events` is
-- still possible for a DSN holder. That is the same single-trust-domain caveat
-- that applies to every table in this store, not a gap specific to this one.
CREATE OR REPLACE FUNCTION upstream_issue_events_append_only()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION
    'upstream_issue_events is append-only: % is not permitted', TG_OP
    USING ERRCODE = 'restrict_violation';
END;
$$;

DROP TRIGGER IF EXISTS upstream_issue_events_no_update ON upstream_issue_events;
CREATE TRIGGER upstream_issue_events_no_update
  BEFORE UPDATE ON upstream_issue_events
  FOR EACH ROW EXECUTE FUNCTION upstream_issue_events_append_only();

ALTER TABLE upstream_issues       ENABLE ROW LEVEL SECURITY;
ALTER TABLE upstream_issue_events ENABLE ROW LEVEL SECURITY;
-- No policies → service-role only (same posture as memory_friction).
