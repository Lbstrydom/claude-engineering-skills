-- Add repo_id to persona_test_sessions so persona sessions join natively to the
-- unified repo identity (audit_repos.id → audit_runs/audit_findings), instead of
-- only the free-text repo_name. Closes the persona↔audit cross-reference gap left
-- after the 20260603 unify_repo_identity work: audit_repos.name is the git-remote
-- `owner/repo` form while persona sessions carried only a bare repo_name, so a
-- name-string lookup missed even when both resolve to the same repo_uuid.
--
-- repo_id references audit_repos.id (the storage FK every other child table uses);
-- repo_uuid stays the dedupe key on audit_repos. New sessions get repo_id resolved
-- canonically (resolveRepoIdentity → repoRowId) by the writer; this migration also
-- best-effort backfills existing rows.

ALTER TABLE persona_test_sessions
  ADD COLUMN IF NOT EXISTS repo_id UUID REFERENCES audit_repos(id);

CREATE INDEX IF NOT EXISTS idx_persona_sessions_repo_id
  ON persona_test_sessions (repo_id);

-- Best-effort backfill: map each existing bare repo_name to the canonical
-- audit_repos row, matching either an exact name or an `owner/repo` suffix
-- (e.g. 'ai-organiser' → 'Lbstrydom/ai-organiser'). Only rows with EXACTLY ONE
-- unambiguous match are updated — never a blind link that could mis-attribute.
UPDATE persona_test_sessions s
   SET repo_id = cand.repo_id
  FROM (
    SELECT s2.id AS session_id,
           min(r.id::text)::uuid AS repo_id,
           count(*) AS matches
      FROM persona_test_sessions s2
      JOIN audit_repos r
        ON r.name = s2.repo_name
        OR r.name LIKE '%/' || s2.repo_name
     WHERE s2.repo_name IS NOT NULL
       AND s2.repo_id IS NULL
     GROUP BY s2.id
  ) cand
 WHERE s.id = cand.session_id
   AND cand.matches = 1;
