-- Model swap-in evaluation harness — adjudicator ground-truth support.
--
-- Plan: docs/plans/model-swap-eval-harness.md (File-Level Plan Phase 4).
--
-- CORRECTED from the plan's original text (which proposed indexing
-- `model_ab_finding_scores`): that name is a plain `CREATE OR REPLACE VIEW`
-- (supabase/migrations/20260701140000_model_ab_v2.sql), not a table or a
-- materialized view — Postgres cannot create an index directly on a plain
-- view. Verified directly: the view's own SELECT list doesn't even expose
-- `decided_at`/`finding_id`/`repo_id` (only run_id, commit_sha,
-- assignment_id, stage_type, phase, prompt_variant, arm, stage,
-- source_model, finding_fingerprint, canonical_id, severity, outcome,
-- remediation_state, is_quick_fix). `getAdjudicatorGroundTruth()`
-- (store/model-ab.mjs) therefore queries `audit_findings JOIN audit_runs`
-- directly — the view's own underlying source, same repo-scoping join
-- (`r.repo_id = $1`) already established by runs-findings.mjs's
-- `getRecentFindingsByRepo`/`getFinalReviewStats`.
--
-- A second, genuine gap this migration also closes: `audit_findings` has NO
-- adjudication-timestamp column at all (verified directly across every
-- migration that touches the table) — `created_at` is when the finding was
-- RAISED, not when it was adjudicated. `decided_at` is added here and
-- populated by the two adjudication write paths
-- (runs-findings.mjs::setFindingOutcome/recordAdjudicationEvent,
-- model-ab.mjs::applyModelAbAdjudication) so `sinceDecidedAt`-windowed
-- ground-truth queries have a real column to filter/sort on. Nullable +
-- additive — existing un-adjudicated and already-adjudicated-before-this-
-- migration rows are unaffected (their decided_at stays NULL until they are
-- next adjudicated, or are naturally excluded by the ground-truth query's
-- own `adjudication_outcome IN ('accepted','dismissed')` filter combined
-- with the window; a historical row with a real outcome but no decided_at
-- simply won't appear in a windowed query — acceptable since ground truth
-- is defined as "recent, real accuracy," Sustainability Notes).
--
-- Idempotent; safe to re-run.

ALTER TABLE audit_findings ADD COLUMN IF NOT EXISTS decided_at timestamptz;

-- Partial index on the REAL table (not the view) — leads with
-- finding_fingerprint to serve getAdjudicatorGroundTruth's DISTINCT ON
-- dedup subquery directly (round-4 audit M4's design intent, unchanged);
-- excludes non-terminal (NULL adjudication_outcome) rows, matching the
-- query's own exclusion.
CREATE INDEX IF NOT EXISTS idx_audit_findings_adjudicator_gt
  ON audit_findings (finding_fingerprint, decided_at DESC, id)
  WHERE adjudication_outcome IN ('accepted', 'dismissed');
