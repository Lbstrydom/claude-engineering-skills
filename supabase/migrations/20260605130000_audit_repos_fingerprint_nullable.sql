-- Complete the unify_repo_identity demotion of `audit_repos.fingerprint`.
--
-- 20260603120000_unify_repo_identity.sql dropped the fingerprint UNIQUE
-- constraint and demoted fingerprint to "a plain non-identity profile
-- attribute". The code path matches that intent — repo.mjs::upsertRepoByUuid
-- keys on repo_uuid and writes `fingerprint => null` when none is supplied.
-- But the column was still NOT NULL (from 20260330063355_learning_store.sql),
-- which the unify migration forgot to drop. On a freshly-migrated DB the
-- uuid-keyed insert (e.g. from `arch:refresh`) therefore failed with a
-- not-null violation.
--
-- Drop the leftover NOT NULL so fingerprint is the optional attribute the
-- unify migration intended. Idempotent — DROP NOT NULL on an already-nullable
-- column is a no-op, so this also reconciles cleanly with any DB an operator
-- already hand-patched to nullable.

ALTER TABLE public.audit_repos ALTER COLUMN fingerprint DROP NOT NULL;
