-- Final-Review Shadow Reviewer — A/B test final-gate effectiveness
--
-- Plan: docs/plans/final-review-shadow-reviewer.md
--
-- Purely additive: every column is NULLABLE with no default that changes
-- existing behaviour. No new tables, no view (the read verb queries base
-- tables directly to avoid the view/RLS-bypass question on a single-tenant
-- owner store — see plan §7 item 1). Re-runs byte-identically (ADD COLUMN
-- IF NOT EXISTS / CREATE INDEX IF NOT EXISTS only; no clocks/network).

-- ── 1. audit_runs — final-review model attribution + shadow cost telemetry ──

-- The resolved CONCRETE model id of each reviewer (not the sentinel, not the
-- provider label) so the A/B groups by exactly what ran — defeats latest-*
-- sentinel drift mid-experiment (plan D3).
ALTER TABLE audit_runs ADD COLUMN IF NOT EXISTS final_review_model               text;
ALTER TABLE audit_runs ADD COLUMN IF NOT EXISTS final_review_shadow_model        text;

-- Shadow cost data path (plan R3 H3 / Gemini R2 G1): token + time cost, the
-- operator-computed overlay on the keep/drop decision. Populated from
-- _shadow.usage; primary cost already lives in total_cost_estimate.
ALTER TABLE audit_runs ADD COLUMN IF NOT EXISTS final_review_shadow_input_tokens  integer;
ALTER TABLE audit_runs ADD COLUMN IF NOT EXISTS final_review_shadow_output_tokens integer;
ALTER TABLE audit_runs ADD COLUMN IF NOT EXISTS final_review_shadow_latency_ms    integer;

-- ── 2. audit_findings — per-finding source attribution + diff bucket ────────

-- source_model = resolved concrete model id of the reviewer that raised the
-- finding (plan D2/H3). bucket = diff classification both|primary-only|
-- shadow-only (plan H2). No CHECK on bucket: the single writer
-- (diffFindingBuckets) controls the literals; app-layer validation keeps the
-- migration cleanly idempotent (plan R2 M1 / R3 M5).
ALTER TABLE audit_findings ADD COLUMN IF NOT EXISTS source_model  text;
ALTER TABLE audit_findings ADD COLUMN IF NOT EXISTS bucket        text;

-- Partial index for the final-review-stats predicates (run_id + source_model);
-- covers only final-review rows so it stays small (plan R1 M7).
CREATE INDEX IF NOT EXISTS audit_findings_source_model_idx
  ON audit_findings (run_id, source_model) WHERE source_model IS NOT NULL;

-- NOTE: audit_findings.user_action (the human-adjudication target, plan D6)
-- already exists from 20260508120000_adaptive_learning_v1.sql with CHECK
-- (user_action IN ('fix-now','deferred','dismissed','needs_triage',
-- 'accepted-permanent')). The adjudication writeback reuses it, mapping
-- accepted -> 'accepted-permanent', dismissed -> 'dismissed'. No new column.
