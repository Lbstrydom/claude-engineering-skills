-- Admit `parked` to the plans.status CHECK.
--
-- Follows 20260718120000_plans_status_vocabulary.sql, which made
-- scripts/lib/plan-status.mjs (PLAN_STATUS_VOCABULARY) the single source of
-- truth and aligned the store to it. This keeps that alignment as the
-- vocabulary gains a third KIND.
--
-- Why `Parked` exists (consumer report, 2026-07-20): a consciously shelved plan
-- — not abandoned, not superseded, not being worked on — had no conforming
-- value, and all three available spellings were wrong:
--   • `Draft`      — false; it is not being drafted
--   • `Superseded` — false; nothing replaced it
--   • non-conforming — makes the plan INVISIBLE to plan selection, so it can
--     never be audited: precisely the failure the status contract prevents
--
-- Note `parked` is a distinct KIND, not a member of `active`. An audit must not
-- chase parked work for progress, and `active` is the bucket that gets chased;
-- `terminal` would be wrong in the other direction, since parked work resumes.
-- DB_PLAN_STATUSES now derives from every kind rather than an enumerated
-- subset, so a future kind cannot be markdown-valid but store-rejected — which
-- is the exact three-definitions-one-vocabulary drift 20260718120000 killed.
--
-- Widen, don't replace: ADD `parked`, KEEP everything already accepted
-- (`abandoned` in particular is already-persisted data — dropping it would fail
-- existing rows on the next write).
--
-- Idempotent: drop-if-exists then re-add against a stable constraint name, so
-- re-running is safe, matching the append-only migration convention.

ALTER TABLE plans DROP CONSTRAINT IF EXISTS plans_status_check;
ALTER TABLE plans ADD CONSTRAINT plans_status_check
  CHECK (status IN ('draft', 'in_progress', 'complete', 'abandoned', 'approved', 'superseded', 'parked'));
