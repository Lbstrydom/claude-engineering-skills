-- unlocked_fixes: make what the age window DROPS queryable.
--
-- The view carried `r.created_at > now() - interval '14 days'` inside the same
-- predicate that defines the obligation, so "not shown" and "not owed" were one
-- state. An unlocked HIGH fix left the backlog by the passage of time, and
-- nothing recorded that it had happened: the count simply got smaller.
--
-- Measured on 2026-08-11 before this landed: 94 code findings had aged out
-- unlocked against 1 still visible. (All 94 predate 2026-07-29, the first
-- audit-sourced `regression_specs` row in this store — they are pre-practice
-- backlog, not leakage from a working process. That distinction is exactly what
-- the readers can now draw, and could not before.)
--
-- The window itself is KEPT and stays the default. An unbounded ship-time nudge
-- becomes noise and earns `--no-verify`; the defect was never the bound, it was
-- the silence. Same shape the row cap already fixed on the pagination axis —
-- `shown` vs `total` exists because `rows.length` once reported 20 against a
-- real 232 — applied to the time axis, which had the identical defect and no
-- such reporting.
--
-- Structure: the predicate moves to `unlocked_fixes_all`, which carries the age
-- test as a COLUMN (`is_recent`) rather than a filter. `unlocked_fixes` becomes
-- the windowed projection over it. The window therefore lives in exactly one
-- expression, so a reader asking "what did the window drop?" cannot drift from
-- the reader asking "what is in the window?" — a second hand-written copy of the
-- predicate in JS was the alternative, and that is the DRY defect this repo's
-- own audits flag.
--
-- `unlocked_fixes` keeps its exact column list and order, so every existing
-- reader (getUnlockedFixes, findUnlockedFixInRepo, countUnlockedFixes, the
-- dashboard) is untouched by this change.
--
-- The sibling `unremediated_acceptances` carries the same shape (a 30-day
-- window inside its predicate) and is deliberately NOT changed here — one view
-- at a time, and that one's window has a second job (a 7-day floor) that needs
-- its own thinking.

CREATE OR REPLACE VIEW unlocked_fixes_all AS
SELECT
  f.id                           AS audit_finding_id,
  f.run_id                       AS audit_run_id,
  r.repo_id,
  f.severity,
  f.category,
  f.primary_file,
  f.detail_snapshot,
  r.created_at                   AS fixed_at,
  (
    SELECT COUNT(*) FROM regression_specs rs
    WHERE rs.source_finding_type = 'audit'
      AND rs.source_finding_id   = f.id
      AND rs.source_kind        <> 'persona-consistency-candidate'
  )                              AS lock_spec_count,
  r.mode                         AS audit_mode,
  -- The age window, as a value rather than a filter. This is the ONLY place the
  -- 14-day figure appears.
  (r.created_at > now() - interval '14 days') AS is_recent
FROM audit_findings f
JOIN audit_runs r ON r.id = f.run_id
WHERE f.severity = 'HIGH'
  AND f.adjudication_outcome IN ('accepted', 'severity_adjusted')
  AND f.remediation_state IN ('fixed', 'verified')
  AND NOT EXISTS (
    SELECT 1 FROM regression_specs rs
    WHERE rs.source_finding_type = 'audit'
      AND rs.source_finding_id   = f.id
      AND rs.source_kind        <> 'persona-consistency-candidate'
  );

COMMENT ON VIEW unlocked_fixes_all IS
  'Every unlocked HIGH fix regardless of age; `is_recent` carries the 14-day '
  'ship-nudge window. `unlocked_fixes` is this view filtered to is_recent.';

-- Same columns, same order, same types as before — a pure narrowing.
CREATE OR REPLACE VIEW unlocked_fixes AS
SELECT
  audit_finding_id,
  audit_run_id,
  repo_id,
  severity,
  category,
  primary_file,
  detail_snapshot,
  fixed_at,
  lock_spec_count,
  audit_mode
FROM unlocked_fixes_all
WHERE is_recent;

COMMENT ON VIEW unlocked_fixes IS
  'Recent (<=14d) unlocked HIGH fixes — the /ship Step 0.5b nudge. What this '
  'window excludes is not gone: read unlocked_fixes_all WHERE NOT is_recent.';
