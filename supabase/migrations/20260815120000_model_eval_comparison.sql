-- Cohort persistence for the auditor role's declarative arm manifest (D3a).
--
-- Plan: docs/plans/role-agnostic-comparison-core.md D3a §"comparisonId needs
-- persistence, and that is three edits (R2/H3)". A cohort that exists only in
-- a CLI variable cannot be reconstructed by a later verdict or history query,
-- so it gets its own table rather than a bare column on model_eval_runs —
-- cohort-level facts (config digest, lock schema version) have nowhere to
-- live on a per-arm run row.
--
-- `lock_schema_version` is IN the unique key deliberately (Gemini/G5): D2a's
-- whole point is that a version bump leaves config_digest byte-identical, so
-- excluding it from the key would make an intentional bump collide with the
-- legacy cohort and crash the insert on the one operation the column exists
-- to enable. Including it lets a bump create a distinct parallel cohort,
-- which is what "prior evidence is incomparable" should mean.
--
-- `model_eval_runs.comparison_id`/`arm_id` are nullable with NO backfill: an
-- existing single-candidate run legitimately has no cohort, and NULL reads as
-- "pre-comparison" — which is true.
--
-- The SAME attempt reducer as the campaign role (D5a), not re-derived
-- (Gemini/G1): config_digest is deterministic, so re-running a manifest after
-- a partial failure REUSES the existing cohort via the unique constraint
-- below, and without a reducer the driver would then blindly insert a second
-- successful row for every arm that already succeeded — double-counting the
-- cohort and double-charging the operator. That is the third instance in this
-- plan of fixing one sibling (the campaign) and not the other (the auditor);
-- this migration is why it is not just two nullable columns.

CREATE TABLE IF NOT EXISTS model_eval_comparisons (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  repo_id uuid NOT NULL,
  comparison_key text NOT NULL,
  config_digest text NOT NULL,
  lock_schema_version int NOT NULL DEFAULT 1,
  role text NOT NULL CHECK (role IN ('auditor', 'adjudicator')),
  subject_ref jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (repo_id, comparison_key, config_digest, lock_schema_version)
);

CREATE INDEX IF NOT EXISTS idx_model_eval_comparisons_repo_key
  ON model_eval_comparisons (repo_id, comparison_key, created_at DESC);

ALTER TABLE model_eval_runs
  ADD COLUMN IF NOT EXISTS comparison_id uuid,
  ADD COLUMN IF NOT EXISTS arm_id text,
  -- D5a's reducer, verbatim: the highest LIVE attempt is authoritative; a
  -- retry supersedes the failed attempt in the SAME transaction that claims
  -- N+1; a successful arm is never re-run.
  ADD COLUMN IF NOT EXISTS attempt int NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS superseded_at timestamptz;

CREATE INDEX IF NOT EXISTS idx_model_eval_runs_comparison_id
  ON model_eval_runs (comparison_id);

-- Every attempt for one (comparison, arm) is a distinct row — armSpend-style
-- all-attempts accounting depends on this NOT collapsing retries.
CREATE UNIQUE INDEX IF NOT EXISTS idx_model_eval_runs_comparison_arm_attempt
  ON model_eval_runs (comparison_id, arm_id, attempt)
  WHERE comparison_id IS NOT NULL;

-- At most one LIVE (non-superseded) attempt per (comparison, arm) — the
-- resume-safety constraint: a re-run of the same manifest can never insert a
-- second live row for an arm that already succeeded, which is exactly the
-- double-charge D5a exists to prevent.
CREATE UNIQUE INDEX IF NOT EXISTS idx_model_eval_runs_comparison_arm_live
  ON model_eval_runs (comparison_id, arm_id)
  WHERE comparison_id IS NOT NULL AND superseded_at IS NULL;

DO $$
BEGIN
  ALTER TABLE model_eval_comparisons ENABLE ROW LEVEL SECURITY;
END $$;
