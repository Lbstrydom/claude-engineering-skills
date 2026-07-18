-- Reconcile the plans.status CHECK to the canonical vocabulary.
--
-- Third instance of the denormalization this plan (reference-integrity-gate)
-- exists to kill: one status vocabulary, three definitions with no source of
-- truth —
--   • skills/plan/SKILL.md      instructs `Draft | Approved | In Progress | Complete`
--   • docs/README.md            documents `Complete / Superseded`
--   • plans.status CHECK        allowed only ('draft','in_progress','complete','abandoned')
--
-- So `Approved` and `Superseded` are instructed by our own docs but REJECTED by
-- the store. Reproduced live 2026-07-17:
--   upsert-plan --status approved → violates check constraint "plans_status_check"
--
-- scripts/lib/plan-status.mjs is now the single source of truth
-- (PLAN_STATUS_VOCABULARY). This migration aligns the store to it.
--
-- Widen, don't replace: ADD `approved` + `superseded` (the canonical terminal/
-- active values the docs already use), and KEEP `abandoned` — it is
-- already-persisted data, so dropping it from the CHECK would fail existing
-- rows on the next write. (`abandoned` maps to no doc status but is harmless as
-- an accepted stored value; the plan-status lint governs the MARKDOWN
-- vocabulary, not the DB enum.)
--
-- Idempotent: drop-if-exists then re-add, matching the append-only migration
-- convention (the constraint name is stable, so re-running is safe).

ALTER TABLE plans DROP CONSTRAINT IF EXISTS plans_status_check;
ALTER TABLE plans ADD CONSTRAINT plans_status_check
  CHECK (status IN ('draft', 'in_progress', 'complete', 'abandoned', 'approved', 'superseded'));
