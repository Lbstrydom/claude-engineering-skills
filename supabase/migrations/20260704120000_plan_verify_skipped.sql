-- ============================================================================
-- Migration: 20260704120000_plan_verify_skipped.sql
-- Plan: docs/completed/ux-lock-selector-policy.md §7 debt follow-up.
--
-- Purpose: distinguish an intentionally-SKIPPED verify criterion (author
-- marked it unverifiable — e.g. no semantic handle) from a genuine FAILURE.
-- Before this, /ux-lock verify encoded "skipped" only as
-- `error_message = 'skipped'` with `passed = FALSE`, so a Playwright-skipped
-- criterion was miscounted as a failure in `persistent_plan_failures`
-- (chronic-gap spotlight) and `plan_satisfaction.failing_p0/p1_criteria`
-- (which /ship can gate on) — a false regression / false ship-block.
--
-- Additive + idempotent: new column defaults FALSE so existing rows are
-- unaffected; views re-created via CREATE OR REPLACE with the same bodies
-- plus a `NOT skipped` guard on every failure predicate.
-- ============================================================================

ALTER TABLE plan_verification_items
  ADD COLUMN IF NOT EXISTS skipped BOOLEAN NOT NULL DEFAULT FALSE;

COMMENT ON COLUMN plan_verification_items.skipped IS
  'TRUE when every matching Playwright test for this criterion was skipped (author-marked unverifiable). Excluded from failure counts in plan_satisfaction + persistent_plan_failures so an intentional skip is not miscounted as a regression. A criterion with NO matching test is a coverage gap, NOT skipped — it stays a failure.';

-- ── plan_satisfaction: exclude skipped criteria from failing P0/P1 detail ────
CREATE OR REPLACE VIEW plan_satisfaction AS
SELECT
  p.id                                                  AS plan_id,
  p.path                                                AS plan_path,
  p.skill                                               AS plan_skill,
  p.status                                              AS plan_status,
  r.id                                                  AS latest_run_id,
  r.created_at                                          AS last_verified_at,
  r.commit_sha                                          AS verified_commit_sha,
  r.url                                                 AS verified_url,
  r.total_criteria,
  r.passed_count,
  r.failed_count,
  r.skipped_count,
  ROUND(
    NULLIF(100.0 * r.passed_count, 0)::numeric / NULLIF(r.total_criteria, 0),
    1
  )                                                     AS satisfaction_pct,
  (
    SELECT COALESCE(jsonb_agg(jsonb_build_object(
      'description', i.description,
      'category',    i.category,
      'error',       i.error_message,
      'hash',        i.criterion_hash
    )), '[]'::jsonb)
    FROM plan_verification_items i
    WHERE i.run_id = r.id AND i.passed = FALSE AND i.skipped = FALSE AND i.severity = 'P0'
  )                                                     AS failing_p0_criteria,
  (
    SELECT COALESCE(jsonb_agg(jsonb_build_object(
      'description', i.description,
      'category',    i.category,
      'error',       i.error_message,
      'hash',        i.criterion_hash
    )), '[]'::jsonb)
    FROM plan_verification_items i
    WHERE i.run_id = r.id AND i.passed = FALSE AND i.skipped = FALSE AND i.severity = 'P1'
  )                                                     AS failing_p1_criteria
FROM plans p
LEFT JOIN LATERAL (
  SELECT * FROM plan_verification_runs
  WHERE plan_id = p.id
  ORDER BY created_at DESC
  LIMIT 1
) r ON TRUE;

-- ── persistent_plan_failures: skipped criteria are not "failures" ────────────
CREATE OR REPLACE VIEW persistent_plan_failures AS
WITH ranked AS (
  SELECT
    i.plan_id,
    i.criterion_hash,
    i.description,
    i.severity,
    i.category,
    i.passed,
    i.skipped,
    i.created_at,
    ROW_NUMBER() OVER (PARTITION BY i.plan_id, i.criterion_hash ORDER BY i.created_at DESC) AS rn
  FROM plan_verification_items i
)
SELECT
  plan_id,
  criterion_hash,
  description,
  severity,
  category,
  COUNT(*) FILTER (WHERE NOT passed AND NOT skipped)   AS fail_count_last_5,
  MAX(created_at) FILTER (WHERE NOT passed AND NOT skipped) AS last_failure_at
FROM ranked
WHERE rn <= 5
GROUP BY plan_id, criterion_hash, description, severity, category
HAVING COUNT(*) FILTER (WHERE NOT passed AND NOT skipped) >= 2
ORDER BY severity, fail_count_last_5 DESC;
