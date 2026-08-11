-- unremediated_acceptances: make what the age bounds EXCLUDE queryable.
--
-- The sibling treatment to 20260811040000, and deliberately deferred from it
-- because this view's window does TWO different jobs and only one of them is a
-- forgetting mechanism:
--
--   * `created_at < now() - interval '7 days'` is a MATURITY FLOOR. A finding
--     accepted three days ago is in flight, not forgotten, and it becomes
--     visible on its own once it ages past the floor. Nothing is lost.
--   * `created_at > now() - interval '30 days'` is a CEILING, and it is the
--     same defect 20260811040000 fixed on the other view: an obligation that
--     crosses it leaves the backlog permanently, with no trace but a smaller
--     number.
--
-- Conflating the two would be the real error here. A row under the floor and a
-- row over the ceiling are both "not shown", and they are opposite states: one
-- is not due yet, the other will never be mentioned again.
--
-- Measured 2026-08-11, before this landed:
--   * 0 rows had aged out — the oldest unremediated acceptance was 25 days old;
--   * 201 were live (50 HIGH / 151 MEDIUM), and the first 31 of them (8 HIGH)
--     were due to expire on 2026-08-16, five days later, with 146 gone inside
--     a fortnight;
--   * 60 more sat under the floor, not yet due.
-- So unlike `unlocked_fixes` — where the leak was found after 94 rows had
-- already gone — this one is caught before the first row is lost. There is also
-- no pre-practice escape here: this repo has recorded remediations since
-- 2026-07-17 (702 findings), which predates every currently-live row, so every
-- one of those 201 would count as a genuine `agedOut`.
--
-- Structure mirrors the sibling: the predicate moves to
-- `unremediated_acceptances_all`, which carries BOTH bounds as columns
-- (`is_mature`, `is_recent`) rather than filters, and
-- `unremediated_acceptances` becomes the projection over it. Each bound
-- therefore appears in exactly one expression, and a reader asking "what is not
-- yet due?" cannot drift from the reader asking "what expired?".
--
-- The projection keeps the exact column list, order, AND the inner ORDER BY, so
-- every existing reader is untouched. That sort is load-bearing: /ship Step 0.5e
-- prints "at most 5 rows, HIGH first", and until 2026-08-10 that instruction was
-- resting on this view's inner sort surviving into a capped outer query, which
-- Postgres does not guarantee. The readers now assert their own order; this one
-- is retained so removing it stays a deliberate act rather than a side effect of
-- restructuring.

CREATE OR REPLACE VIEW unremediated_acceptances_all AS
SELECT
  f.id                           AS audit_finding_id,
  f.run_id                       AS audit_run_id,
  r.repo_id,
  f.severity,
  f.category,
  f.primary_file,
  f.detail_snapshot,
  f.adjudication_outcome,
  f.remediation_state,
  r.commit_sha                   AS accepted_at_commit,
  r.created_at                   AS accepted_at,
  EXTRACT(day FROM now() - r.created_at)::integer AS days_open,
  r.mode                         AS audit_mode,
  f.finding_fingerprint,
  -- The two bounds, as values rather than filters. These are the ONLY places
  -- the 7-day and 30-day figures appear.
  (r.created_at < now() - interval '7 days')  AS is_mature,
  (r.created_at > now() - interval '30 days') AS is_recent
FROM audit_findings f
JOIN audit_runs r ON r.id = f.run_id
WHERE f.adjudication_outcome IN ('accepted', 'severity_adjusted')
  AND (f.remediation_state IS NULL OR f.remediation_state IN ('pending', 'planned'))
  AND f.severity IN ('HIGH', 'MEDIUM');

COMMENT ON VIEW unremediated_acceptances_all IS
  'Every accepted-but-unremediated HIGH/MEDIUM finding regardless of age. '
  '`is_mature` carries the 7-day maturity floor (below it: not yet due, will '
  'appear later); `is_recent` carries the 30-day ceiling (above it: aged out, '
  'never shown again). unremediated_acceptances is this view filtered to both.';

-- Same columns, same order, same inner sort as before — a pure narrowing.
CREATE OR REPLACE VIEW unremediated_acceptances AS
SELECT
  audit_finding_id,
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
WHERE is_mature AND is_recent
ORDER BY (CASE severity WHEN 'HIGH' THEN 0 ELSE 1 END), accepted_at;

COMMENT ON VIEW unremediated_acceptances IS
  'Mature (>=7d) and not-yet-expired (<=30d) accepted findings with no '
  'remediation — the /ship Step 0.5e nudge. What the ceiling excludes is not '
  'gone: read unremediated_acceptances_all WHERE NOT is_recent.';
