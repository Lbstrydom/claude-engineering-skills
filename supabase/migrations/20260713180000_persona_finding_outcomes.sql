-- WS4 (persona-nav-feedback-recovery, Cluster 3): durable persona-finding
-- outcome labels (fixed/dismissed/wont_fix/stale). REPO-scoped, not
-- session-scoped (Gemini gate finding) — a label must survive across
-- sessions or a persistent false positive gets re-asked every run, which
-- is the exact "don't ask the user the same thing twice" failure this
-- workstream exists to prevent.

CREATE TABLE IF NOT EXISTS persona_finding_outcomes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  repo_id uuid NOT NULL REFERENCES audit_repos(id) ON DELETE CASCADE,
  persona_finding_hash text NOT NULL,
  outcome text NOT NULL CHECK (outcome IN ('fixed', 'dismissed', 'wont_fix', 'stale')),
  -- Informational audit trail ("most recently labeled from this session"),
  -- NOT part of the identity key — the ledger row survives the session
  -- being deleted (ON DELETE SET NULL, not CASCADE).
  last_seen_session_id uuid REFERENCES persona_test_sessions(id) ON DELETE SET NULL,
  labeled_by text NOT NULL,
  rationale text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  -- Rationale is REQUIRED for dismissive outcomes — enforced at the table
  -- level so no future store consumer or direct write can bypass it (the
  -- CLI also validates first, for a friendly error message).
  CONSTRAINT rationale_required_for_dismissal CHECK (
    outcome NOT IN ('dismissed', 'wont_fix')
    OR (rationale IS NOT NULL AND length(btrim(rationale)) > 0)
  ),
  -- One durable adjudication per finding per repo, independent of which
  -- session first or most recently observed it.
  UNIQUE (repo_id, persona_finding_hash)
);

CREATE INDEX IF NOT EXISTS idx_persona_finding_outcomes_repo
  ON persona_finding_outcomes (repo_id, updated_at DESC);

DO $$
BEGIN
  ALTER TABLE persona_finding_outcomes ENABLE ROW LEVEL SECURITY;
END $$;
