-- persona_test_sessions: align the denormalized `repo_name` with the canonical
-- `audit_repos.name` its own row already points at.
--
-- THE DEFECT. `audit_effectiveness` joins
--   LEFT JOIN persona_test_sessions s ON s.repo_name = r.name
-- so the denormalized text column — not the `repo_id` FK — is what decides
-- whether a session contributes to precision/recall. The two identity systems
-- spell repositories differently: the arch path writes `owner/repo` from the git
-- origin, the older audit path wrote the bare directory name. A session recorded
-- with the bare form therefore carries a correct `repo_id` and a name that joins
-- to nothing.
--
-- Measured 2026-08-11 on this store: 7 of 7 sessions mismatched — 6 with the bare
-- `wine-cellar-app` and 1 with a NULL name, every one of them pointing at an
-- `audit_repos` row named `Lbstrydom/wine-cellar-app`. Because the join is a LEFT
-- JOIN, `audit_effectiveness` did not fail or shrink; it reported those repos as
-- having no persona data at all. A silent zero, which is the shape this repo
-- keeps finding and keeps deciding is worse than an error.
--
-- WHY THIS IS SAFE TO DO AUTOMATICALLY, unlike the sibling case. `repo_id` is a
-- FK to `audit_repos`, so for any row that HAS one the canonical name is not a
-- guess — it is a lookup. `scripts/reconcile-repo-identity.mjs` refuses to merge
-- rows on name evidence without operator sign-off, and that rule is untouched
-- here: this migration never matches on name, only ever copies FROM the id.
--   * Rows with `repo_id IS NULL` are left alone — there is nothing to derive a
--     canonical name from, and inventing one would be exactly the automatic
--     name-merge that reconciler exists to prevent.
--   * `persona_test_candidates` carries a `repo_name` with NO `repo_id` column
--     (2 bare-name rows here), so it is deliberately NOT touched for the same
--     reason. Fixing it needs an operator decision, not a migration.
--
-- Idempotent: `IS DISTINCT FROM` makes a re-run a no-op, and it is NULL-safe, so
-- the one NULL-named row is repaired too rather than skipped by a `<>` that
-- would silently evaluate to NULL.
--
-- The WRITER is fixed in the same change set (`reconcileRepoIdentity` now
-- compares by `repoBaseName` and adopts the canonical spelling), so this is a
-- one-time repair of existing rows, not a recurring patch over a live leak.

UPDATE persona_test_sessions s
   SET repo_name = r.name
  FROM audit_repos r
 WHERE s.repo_id = r.id
   AND s.repo_name IS DISTINCT FROM r.name;
