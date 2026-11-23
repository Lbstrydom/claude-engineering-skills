-- audit_effectiveness + persona_density_per_repo: join persona sessions to a repo by
-- ID, with the name kept only as a fallback for sessions that have no id.
--
-- WHY (docs/plans/wine-org-move.md §2.1, step 2S, D2 = structural). Both views joined
--   persona_test_sessions s ON s.repo_name = r.name
-- so the denormalised name copy decided whether a session counted. `audit_repos.name`
-- is re-derived from the git origin, so a repo transfer (Lbstrydom/ -> Creathyst/)
-- renames the row and every session still carrying the old slug silently drops out of
-- both views: precision/recall and persona density read EMPTY, which looks like "no
-- persona testing". `repo_id` is a FK to audit_repos(id) and survives a rename.
--
-- NEW PREDICATE
--   s.repo_id = r.id  OR  (s.repo_id IS NULL AND s.repo_name = r.name)
-- Same projected columns and aggregates as before; only the join changes.
--
-- THREE STEPS, ONE TRANSACTION (the runner applies a file atomically; a RAISE aborts all):
--   1. PREFLIGHT. Count the rows whose association WOULD change, or that cannot be
--      resolved. ANY non-zero count RAISES, so this store is not migrated until each
--      listed row is resolved by hand. Nothing is coerced.
--   2. BACKFILL. Every null-repo_id session whose repo_name matches exactly one
--      audit_repos row gets that row's id. Without it a legacy row would join by name
--      until its repo is renamed and then vanish: the failure this migration exists to
--      stop. After it the name arm matches nothing; it stays only as a guard.
--   3. VIEWS.
--
-- The preflight compares the EXACT join that exists today (s.repo_name = r.name) with
-- the join the new predicate gives, not basenames: a session named
-- `other-owner/wine-cellar-app` whose id points at wine's row is a stop, not a pass.
-- "No repo" counts as a value, so a session that joins nothing today and something
-- tomorrow is a change too.
--
-- Idempotent: a re-run finds nothing to backfill, the preflight is a pure read, and
-- CREATE OR REPLACE VIEW keeps the column list. Must not be edited after it has run
-- anywhere (the ledger hashes it).

-- Block concurrent writes (reads stay open) from the preflight until commit, so a session or repo
-- inserted between the checks and the backfill cannot slip past them.
LOCK TABLE persona_test_sessions, audit_repos IN SHARE ROW EXCLUSIVE MODE;

DO $preflight$
DECLARE
  n_dangling   bigint;
  n_changed    bigint;
  n_unresolved bigint;
  n_dup_names  bigint;
BEGIN
  -- Already migrated (the views join by id): a re-run must not compare the stale names that a
  -- legitimate rename leaves behind, so the preflight is a no-op and only the backfill below runs.
  IF pg_get_viewdef('audit_effectiveness'::regclass) LIKE '%s.repo_id = r.id%' THEN
    RETURN;
  END IF;

  -- (1) sessions whose repo_id matches no audit_repos row. The FK makes this
  --     unreachable today; the check stays so a dropped FK cannot hide one.
  SELECT count(*) INTO n_dangling
    FROM persona_test_sessions s
   WHERE s.repo_id IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM audit_repos r WHERE r.id = s.repo_id);

  -- (2) sessions with an id whose association changes: the set of repos they join
  --     today (exact name match) differs from the one repo the id names.
  SELECT count(*) INTO n_changed
    FROM persona_test_sessions s
   WHERE s.repo_id IS NOT NULL
     AND (SELECT coalesce(array_agg(r.id ORDER BY r.id), ARRAY[]::uuid[])
            FROM audit_repos r WHERE r.name = s.repo_name)
         IS DISTINCT FROM ARRAY[s.repo_id];

  -- (3) sessions with no id whose name matches no repo, or more than one.
  SELECT count(*) INTO n_unresolved
    FROM persona_test_sessions s
   WHERE s.repo_id IS NULL
     AND (SELECT count(*) FROM audit_repos r WHERE r.name = s.repo_name) <> 1;

  -- (4) audit_repos names held by more than one row AND carried by a persona session.
  --     A duplicate name no session carries cannot change any association (measured: the
  --     primary store holds three unreferenced fixture repos named `r`), so refusing on it
  --     would block the migration on a delete only the owner may decide. Checks (2) and
  --     (3) already stop on any session whose name matches more than one repo; this is
  --     the belt over those braces.
  SELECT count(*) INTO n_dup_names
    FROM (SELECT r.name FROM audit_repos r
           WHERE EXISTS (SELECT 1 FROM persona_test_sessions s WHERE s.repo_name = r.name)
           GROUP BY r.name HAVING count(*) > 1) d;

  IF n_dangling + n_changed + n_unresolved + n_dup_names > 0 THEN
    RAISE EXCEPTION
      'persona views repo-id join: preflight STOP (dangling repo_id=%, association changes=%, null repo_id unresolved=%, duplicate repo names=%). Resolve each row by hand and record it; nothing is coerced. See docs/plans/wine-org-move.md section 2.1.',
      n_dangling, n_changed, n_unresolved, n_dup_names;
  END IF;
END
$preflight$;

-- (2) BACKFILL: the preflight above proved every null-id session has exactly one name match.
UPDATE persona_test_sessions s
   SET repo_id = r.id
  FROM audit_repos r
 WHERE s.repo_id IS NULL
   AND s.repo_name = r.name
   -- exactly one match, always: a re-run (preflight skipped) must never pick an arbitrary repo for an ambiguous name
   AND (SELECT count(*) FROM audit_repos r2 WHERE r2.name = s.repo_name) = 1;

-- (3) VIEWS. Column lists and aggregates are unchanged.
CREATE OR REPLACE VIEW audit_effectiveness AS
SELECT
  r.id                                                  AS repo_id,
  r.name                                                AS repo_name,
  COUNT(*) FILTER (WHERE c.correlation_type = 'confirmed_hit')        AS confirmed_hits,
  COUNT(*) FILTER (WHERE c.correlation_type = 'audit_missed')         AS audit_misses,
  COUNT(*) FILTER (WHERE c.correlation_type = 'audit_false_positive') AS audit_false_positives,
  COUNT(*) FILTER (WHERE c.correlation_type = 'severity_understated') AS severity_understated,
  COUNT(*) FILTER (WHERE c.correlation_type = 'severity_overstated')  AS severity_overstated,
  ROUND(
    NULLIF(
      COUNT(*) FILTER (WHERE c.correlation_type = 'confirmed_hit')::numeric, 0
    ) / NULLIF(
      COUNT(*) FILTER (WHERE c.correlation_type IN ('confirmed_hit', 'audit_false_positive'))::numeric, 0
    ),
    3
  ) AS user_visible_precision,
  ROUND(
    NULLIF(
      COUNT(*) FILTER (WHERE c.correlation_type = 'confirmed_hit')::numeric, 0
    ) / NULLIF(
      COUNT(*) FILTER (WHERE c.correlation_type IN ('confirmed_hit', 'audit_missed'))::numeric, 0
    ),
    3
  ) AS user_visible_recall
FROM audit_repos r
LEFT JOIN persona_test_sessions s
       ON s.repo_id = r.id
       OR (s.repo_id IS NULL AND s.repo_name = r.name)
LEFT JOIN persona_audit_correlations c ON c.persona_session_id = s.id
GROUP BY r.id, r.name;

CREATE OR REPLACE VIEW persona_density_per_repo
  WITH (security_invoker = true) AS
  SELECT r.id AS repo_id, r.name AS repo_name,
    COALESCE(
      count(pts.id) FILTER (WHERE pts.created_at > now() - interval '30 days'),
      0
    )::integer AS density_30d
  FROM audit_repos r
  LEFT JOIN persona_test_sessions pts
         ON pts.repo_id = r.id
         OR (pts.repo_id IS NULL AND pts.repo_name = r.name)
  GROUP BY r.id, r.name;
