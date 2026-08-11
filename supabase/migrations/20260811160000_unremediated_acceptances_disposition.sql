-- Honour the disposition that already exists: exclude `accepted-permanent`
-- from the /ship nudge, and keep its count auditable.
--
-- `user_action = 'accepted-permanent'` is this repo's "declined on the merits"
-- disposition — it is in `audit_findings`'s CHECK constraint, written by
-- `adjudicateFinalReviewFinding` alongside `adjudication_outcome` and
-- `decided_at`. No view consulted it, so a decision that was properly recorded
-- still reported as an open obligation forever. Measured 2026-08-11 for
-- claude-engineering-skills: 36 of 231 rows in `unremediated_acceptances_all`
-- (15.6%) were already decided and still being nagged about.
--
-- Design: the base view gains ONE derived column and the nag view consumes it.
-- The predicate is therefore defined once; a future policy change edits one
-- relation rather than every reader.
--
-- `IS DISTINCT FROM`, never `<>`: 190 of those 231 rows have
-- `user_action IS NULL`, and `NULL <> 'accepted-permanent'` evaluates to NULL,
-- not true — a bare `<>` would drop every one of them and silently empty the
-- nag. That is the single most likely slip here, and
-- tests/unremediated-acceptance-disposition.test.mjs asserts against it
-- specifically.
--
-- The `unlocked_fixes` sibling deliberately does NOT change. This file family's
-- standing lesson is that fixing one half is itself the failure mode, so the
-- exemption is stated rather than assumed: `unlocked_fixes` asks "this was
-- FIXED — is the fix locked?" and keys on fixed_at/lock_spec_count. A finding
-- marked `accepted-permanent` was not fixed, so it cannot appear there. The
-- disposition is meaningless for that view, not merely unhandled.
--
-- Both statements are `CREATE OR REPLACE VIEW` and idempotent. Order matters:
-- `_all` is the dependency and must be replaced first. Appending columns at the
-- END is the only projection change CREATE OR REPLACE permits — that constraint
-- is a feature, because an accidental drop or reorder fails loudly instead of
-- silently changing what every reader sees.

-- 1. Base view: reproduce the live definition verbatim, appending
--    `user_action` and the derived `is_open_disposition` at the end.
CREATE OR REPLACE VIEW unremediated_acceptances_all AS
 SELECT f.id AS audit_finding_id,
    f.run_id AS audit_run_id,
    r.repo_id,
    f.severity,
    f.category,
    f.primary_file,
    f.detail_snapshot,
    f.adjudication_outcome,
    f.remediation_state,
    r.commit_sha AS accepted_at_commit,
    r.created_at AS accepted_at,
    EXTRACT(day FROM now() - r.created_at)::integer AS days_open,
    r.mode AS audit_mode,
    f.finding_fingerprint,
    r.created_at < (now() - '7 days'::interval) AS is_mature,
    r.created_at > (now() - '30 days'::interval) AS is_recent,
    f.user_action,
    (f.user_action IS DISTINCT FROM 'accepted-permanent') AS is_open_disposition
   FROM audit_findings f
     JOIN audit_runs r ON r.id = f.run_id
  WHERE (f.adjudication_outcome = ANY (ARRAY['accepted'::text, 'severity_adjusted'::text]))
    AND (f.remediation_state IS NULL OR (f.remediation_state = ANY (ARRAY['pending'::text, 'planned'::text])))
    AND (f.severity = ANY (ARRAY['HIGH'::text, 'MEDIUM'::text]));

-- 2. Nag view: identical 14-column projection and ORDER BY; the WHERE gains
--    the disposition filter. The column list is unchanged, so no dependent
--    reader sees a shape change.
CREATE OR REPLACE VIEW unremediated_acceptances AS
 SELECT audit_finding_id,
    audit_run_id,
    repo_id,
    severity,
    category,
    primary_file,
    detail_snapshot,
    adjudication_outcome,
    remediation_state,
    accepted_at_commit,
    accepted_at,
    days_open,
    audit_mode,
    finding_fingerprint
   FROM unremediated_acceptances_all
  WHERE is_mature AND is_recent AND is_open_disposition
  ORDER BY (
        CASE severity
            WHEN 'HIGH'::text THEN 0
            ELSE 1
        END), accepted_at;
