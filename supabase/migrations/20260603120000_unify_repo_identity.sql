-- Unify repo identity: demote the volatile content `fingerprint` from an
-- identity key to a plain profile attribute, so the audit/plan/learning write
-- path can key on the stable `repo_uuid` (resolveRepoIdentity) like the
-- arch/symbol-index path already does.
--
-- Plan: docs/plans/learning-store-signal-recovery.md — Cluster A, Phase 2.
-- B1 root cause: upsertRepo() keyed on `fingerprint` (sha256 of package.json +
-- CLAUDE.md + file inventory), which changes on any file edit, so every audit of
-- an evolving repo minted a NEW audit_repos row (wine-cellar-app: 193 rows).
--
-- Deviation from the plan's literal DDL (documented): the plan proposed adding a
-- full UNIQUE(repo_uuid). Reality already has a PARTIAL unique index
-- `idx_audit_repos_repo_uuid ... WHERE repo_uuid IS NOT NULL`, and the db/query
-- upsert() helper cannot emit a partial-index ON CONFLICT predicate (Gemini-G2).
-- So `resolveRepoForStore()` uses select-by-uuid → update-or-insert against the
-- EXISTING partial index (the integrity guard) and this migration only DROPs the
-- fingerprint UNIQUE — the alternate identity that caused the fragmentation
-- (R2-H2). Minimal, idempotent, non-destructive to data.

-- Preflight (R1-H3): a duplicate non-null repo_uuid would mean two canonical
-- rows already exist for one logical repo — reconcile must run first. Abort
-- loudly rather than silently proceed.
DO $$
DECLARE
  dup_count integer;
BEGIN
  SELECT count(*) INTO dup_count FROM (
    SELECT repo_uuid
      FROM public.audit_repos
     WHERE repo_uuid IS NOT NULL
     GROUP BY repo_uuid
    HAVING count(*) > 1
  ) d;
  IF dup_count > 0 THEN
    RAISE EXCEPTION
      'unify_repo_identity: % duplicate non-null repo_uuid value(s) in audit_repos — run scripts/reconcile-repo-identity.mjs --apply before this migration',
      dup_count;
  END IF;
END $$;

-- Demote `fingerprint`: drop its UNIQUE constraint (keep the column as a plain
-- non-identity profile attribute). After this, `repo_uuid` (partial unique
-- index, already present) is the ONLY identity constraint. Idempotent.
ALTER TABLE public.audit_repos DROP CONSTRAINT IF EXISTS audit_repos_fingerprint_key;

-- The pre-existing partial unique index `idx_audit_repos_repo_uuid` is retained
-- as the repo_uuid integrity guard; resolveRepoForStore()'s select-then-insert
-- relies on it to prevent duplicate canonical rows under a race. No new
-- constraint is added (see deviation note above).
