-- An arm-run's snapshot must belong to the arm-run's OWN cohort.
--
-- Plan: docs/plans/model-comparison-campaigns.md §7a (shadow/S3).
--
-- `campaign_arm_runs` carries both `cohort_id` and `snapshot_row_id`, and each
-- was an INDEPENDENT foreign key — one to `campaign_cohorts(id)`, one to
-- `campaign_snapshots(id)`. Nothing required the referenced snapshot to be a
-- snapshot OF that cohort, so a row could attribute one cohort's arm-run to
-- another cohort's snapshot. Every downstream number would then be wrong in a
-- way no reader could see: the completion matrix would count an arm-run against
-- a snapshot it did not observe, and adjudication would verify against that
-- snapshot's `audited_sha` — a revision the arm never ran on.
--
-- This is the SAME defect shadow/S3 fixed one level up, and its own words are
-- the argument: "the constraint now IS the invariant, rather than restating it
-- in prose next to a schema that permits the violation." The prose was correct
-- and the schema still permitted the violation.
--
-- A composite foreign key is the fix. It needs a matching unique key on the
-- parent — `(id, cohort_id)` — which is redundant with the primary key by
-- construction (`id` alone is already unique, so adding `cohort_id` cannot
-- weaken it) and exists purely to give the composite FK something to reference.
--
-- Safe to apply: `recordArmRun` has always passed a `snapshotRowId` returned by
-- `upsertSnapshot` for the same cohort, so no existing row can violate this.
-- A tightening migration that ABORTS on violating data is the intended
-- behaviour, not a hazard — silently repairing rows would hide the very
-- corruption this constraint exists to make impossible.

ALTER TABLE campaign_snapshots DROP CONSTRAINT IF EXISTS campaign_snapshots_id_cohort_key;
ALTER TABLE campaign_snapshots ADD  CONSTRAINT campaign_snapshots_id_cohort_key UNIQUE (id, cohort_id);

ALTER TABLE campaign_arm_runs DROP CONSTRAINT IF EXISTS campaign_arm_runs_snapshot_row_id_fkey;
ALTER TABLE campaign_arm_runs DROP CONSTRAINT IF EXISTS campaign_arm_runs_snapshot_in_cohort_fk;
ALTER TABLE campaign_arm_runs ADD  CONSTRAINT campaign_arm_runs_snapshot_in_cohort_fk
  FOREIGN KEY (snapshot_row_id, cohort_id)
  REFERENCES campaign_snapshots (id, cohort_id) ON DELETE CASCADE;
