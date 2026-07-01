-- Model-A/B/C experiment harness v2 — composition arms + outcome-based scoring.
--
-- Plan: docs/plans/model-ab-harness-v2.md (Cluster A, Phase 2). A DELTA on the
-- v1 schema (20260701120000 + 20260701130000): re-points arm attribution to the
-- HYBRID fail-closed model, adds the assignment grain + finding quality inputs,
-- and rebuilds the scorer for two-level outcome-based ranking + recall + a cost
-- frontier. Additive + idempotent (ADD COLUMN IF NOT EXISTS / CREATE OR REPLACE
-- / DROP CONSTRAINT IF EXISTS + ADD … NOT VALID); no clocks/network → re-runs
-- byte-identically. Trailing-column adds only on existing tables.
--
-- v1→v2 attribution shift (plan H1 / §4 R2-H1): `gemini` now runs ONCE PER ARM
-- on DIFFERENT inputs (A reviews gpt-gen; B reviews oss-gen+gpt-round; C reviews
-- oss-gen), so a `gemini` finding is arm-SPECIFIC, not shared. v1 disambiguated
-- `gemini` by provenance (baseline vs shadow) — that no longer suffices. So:
--   SHARED stages  (oss-gen → {B,C}; gpt-gen → {A}) derive arm from stage.
--   ARM-SPECIFIC   (gpt-round, gemini) carry an EXPLICIT `arm` column; a null
--                  arm on those is a DATA ERROR (fail-closed CHECK + view
--                  __INVALID__ sentinel — never silently mapped to a real arm).

-- ── 1. audit_runs — the ASSIGNMENT grain (plan §4 R2-M2 / H5) ─────────────────
-- One audit_runs row per assignment; A's production findings + the shadow's B/C
-- findings share it via run_id. `assignment_id` groups an assignment's arm-runs;
-- MIN_ASSIGNMENTS counts DISTINCT (commit_sha × stage_type), NOT assignment_id
-- (which includes attempt/variant) — enforced in the decision module.
ALTER TABLE audit_runs ADD COLUMN IF NOT EXISTS assignment_id   text;
-- stage_type DEFAULT 'audit-code' backfills existing rows AND defaults new ones
-- (v2 scope is audit-code only — plan H6; plan/audit-plan hooks are v2.1).
ALTER TABLE audit_runs ADD COLUMN IF NOT EXISTS stage_type      text DEFAULT 'audit-code';
ALTER TABLE audit_runs ADD COLUMN IF NOT EXISTS phase           text;   -- calibration|prospective (null = not an experiment run)
ALTER TABLE audit_runs ADD COLUMN IF NOT EXISTS prompt_variant  text;   -- default|probe-A|probe-B
ALTER TABLE audit_runs ADD COLUMN IF NOT EXISTS attempt         integer DEFAULT 1;  -- rerun counter (grain, NOT diversity)
ALTER TABLE audit_runs ADD COLUMN IF NOT EXISTS arm_order_seed  bigint; -- randomized arm-order RNG seed (replay — M5)

-- stage_type domain (nullable-tolerant so a stray NULL never fails the migration).
ALTER TABLE audit_runs DROP CONSTRAINT IF EXISTS audit_runs_stage_type_chk;
ALTER TABLE audit_runs ADD CONSTRAINT audit_runs_stage_type_chk
  CHECK (stage_type IS NULL OR stage_type IN ('plan', 'audit-plan', 'audit-code')) NOT VALID;

CREATE INDEX IF NOT EXISTS audit_runs_assignment_idx
  ON audit_runs (assignment_id) WHERE assignment_id IS NOT NULL;

-- ── 2. audit_findings — arm tag (arm-specific stages) + quality input ────────
-- `arm` is set ONLY for arm-specific stages (gpt-round, gemini). Shared stages
-- (oss-gen, gpt-gen) and production/baseline findings leave it NULL — the view
-- derives their arm from `stage`. `is_quick_fix` is the finding-object flag
-- (schemas.mjs) persisted so the quality tier is a pure function of ledger state
-- (plan H4) with no new verifier.
ALTER TABLE audit_findings ADD COLUMN IF NOT EXISTS arm          text;
ALTER TABLE audit_findings ADD COLUMN IF NOT EXISTS is_quick_fix boolean;

-- Value domain (arm ∈ A|B|C or null). NOT VALID grandfathers historical rows
-- (Postgres ADD CONSTRAINT can't be idempotent otherwise; the write path also
-- validates). No real experiment rows exist yet (the harness has never spent).
ALTER TABLE audit_findings DROP CONSTRAINT IF EXISTS audit_findings_arm_chk;
ALTER TABLE audit_findings ADD CONSTRAINT audit_findings_arm_chk
  CHECK (arm IS NULL OR arm IN ('A', 'B', 'C')) NOT VALID;

-- FAIL-CLOSED (plan §4 R2-H1): an arm-specific stage (gemini|gpt-round) MUST
-- carry an explicit arm. Production final-review findings have stage NULL (the
-- production path never stamps stage), so they satisfy this untouched — only the
-- shadow writes stage ∈ (gemini,gpt-round) and it MUST set arm. NOT VALID so any
-- pre-existing straggler is grandfathered; new writes are enforced.
ALTER TABLE audit_findings DROP CONSTRAINT IF EXISTS audit_findings_arm_specific_chk;
ALTER TABLE audit_findings ADD CONSTRAINT audit_findings_arm_specific_chk
  CHECK (stage IS NULL OR stage NOT IN ('gemini', 'gpt-round') OR arm IS NOT NULL) NOT VALID;

CREATE INDEX IF NOT EXISTS audit_findings_arm_idx
  ON audit_findings (run_id, arm) WHERE arm IS NOT NULL;

-- ── 3. audit_pass_stats — arm tag for per-arm cost attribution (D7/M1) ────────
-- v2 runs B-gemini and C-gemini as DISTINCT executions with the SAME stage
-- ('gemini') and model, so per-arm cost can't be split by stage alone — the
-- arm-specific pass-stats carry `arm` too. Shared oss-gen leaves it NULL (its
-- cost is counted per-arm for the standalone frontier, once for actual burn).
ALTER TABLE audit_pass_stats ADD COLUMN IF NOT EXISTS arm text;

CREATE INDEX IF NOT EXISTS audit_pass_stats_arm_stage_type_idx
  ON audit_pass_stats (run_id, stage, arm);

-- Extend the per-arm-execution unique grain to include `arm` (the v1 index
-- 20260701120000 keyed run_id/pass_name/round/source_model/stage). Without arm,
-- B-gemini and C-gemini (SAME stage='gemini' + model + round) would collide on
-- the unique key and the second write would be lost. DROP+CREATE is idempotent;
-- COALESCE(arm,'') keeps non-experiment rows (arm NULL) collapsing to one key.
DROP INDEX IF EXISTS audit_pass_stats_arm_grain_uk;
CREATE UNIQUE INDEX IF NOT EXISTS audit_pass_stats_arm_grain_uk
  ON audit_pass_stats (
    run_id, pass_name, COALESCE(round, -1),
    COALESCE(source_model, ''), COALESCE(stage, ''), COALESCE(arm, '')
  );

-- ── 4. audit_arms — seed arm-set v2 (the v2 compositions) ────────────────────
-- Mirrors CANONICAL_ARMS in scripts/lib/audit-arms.mjs (the store's ensureArmSet
-- re-asserts this so code stays the source of truth). v1 (version 1) rows are
-- left intact for any historical reference.
INSERT INTO audit_arms (arm_set_version, arm_id, stages, is_baseline, label) VALUES
  (2, 'A', ARRAY['gpt-gen','gemini'],            true,  'GPT audit → Gemini review (production control)'),
  (2, 'B', ARRAY['oss-gen','gpt-round','gemini'], false, 'OSS audit → 1 GPT round → Gemini review (does the GPT round earn its keep?)'),
  (2, 'C', ARRAY['oss-gen','gemini'],            false, 'OSS audit → Gemini review (can OSS+Gemini replace GPT+Gemini?)')
ON CONFLICT (arm_set_version, arm_id) DO UPDATE
  SET stages = EXCLUDED.stages, is_baseline = EXCLUDED.is_baseline, label = EXCLUDED.label;

-- ── 5. model_ab_attribute_arms — the SQL mirror of attributeStageToArms ──────
-- Single source for the hybrid rule across all three views (no CASE drift).
-- SHARED stages derive (arm tag ignored, matching the JS); ARM-SPECIFIC stages
-- take the explicit arm, else the '__INVALID__' fail-closed sentinel (a null arm
-- on gemini/gpt-round) which the readers exclude — never a real A/B/C.
CREATE OR REPLACE FUNCTION model_ab_attribute_arms(p_stage text, p_arm text)
RETURNS text[] LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE
    WHEN p_stage = 'oss-gen' THEN ARRAY['B','C']            -- shared derive
    WHEN p_stage = 'gpt-gen' THEN ARRAY['A']                -- shared derive
    WHEN p_stage IS NULL     THEN ARRAY['A']                -- production baseline provenance
    WHEN p_stage IN ('gemini','gpt-round') THEN             -- arm-specific: explicit or fail-closed
      CASE WHEN p_arm IN ('A','B','C') THEN ARRAY[p_arm] ELSE ARRAY['__INVALID__'] END
    ELSE ARRAY[]::text[]
  END;
$$;

-- ── 6. model_ab_effectiveness — aggregate scorer (CREATE OR REPLACE, hybrid) ─
-- Kept for the aggregate `model-ab-stats` display + backward compat. Same
-- grain/leading columns as v1 (run_id, arm, stage, source_model, …) so CREATE OR
-- REPLACE is legal; arm derivation now HYBRID (explicit arm else stage-derive,
-- fail-closed on __INVALID__ excluded); APPENDS stage_type + assignment_id.
CREATE OR REPLACE VIEW model_ab_effectiveness AS
WITH canon AS (
  SELECT
    f.run_id,
    r.commit_sha,
    COALESCE(r.assignment_id, r.commit_sha, r.id::text) AS assignment_id,
    COALESCE(r.stage_type, 'audit-code')                AS stage_type,
    f.stage,
    f.arm AS explicit_arm,
    f.source_model,
    f.severity,
    COALESCE(f.adjudication_outcome, 'pending') AS outcome,
    COALESCE(fe.canonical_finding_id, f.finding_fingerprint) AS canonical_id,
    model_ab_attribute_arms(f.stage, f.arm) AS arms
  FROM audit_findings f
  JOIN audit_runs r ON r.id = f.run_id
  LEFT JOIN finding_equivalence fe
    ON fe.duplicate_finding_id = f.finding_fingerprint
),
expanded AS (
  SELECT run_id, commit_sha, assignment_id, stage_type, unnest(arms) AS arm,
         stage, source_model, severity, outcome, canonical_id
  FROM canon
  WHERE arms <> ARRAY['__INVALID__']   -- fail-closed rows never enter the score
),
pass_cost AS (
  SELECT run_id, stage, source_model,
         SUM(cost_usd)                                   AS cost_usd,
         COUNT(*)                                        AS pass_executions,
         COUNT(*) FILTER (WHERE structured_output_ok)    AS conformant_passes,
         BOOL_OR(usage_unmeterable)                      AS any_unmeterable
  FROM audit_pass_stats
  WHERE stage IS NOT NULL
  GROUP BY run_id, stage, source_model
)
SELECT
  e.run_id,
  e.arm,
  e.stage,
  e.source_model,
  COUNT(DISTINCT e.canonical_id) FILTER (WHERE e.outcome = 'accepted')          AS accepted_uniques,
  COUNT(DISTINCT e.canonical_id) FILTER (WHERE e.outcome = 'dismissed')         AS dismissed_uniques,
  COUNT(DISTINCT e.canonical_id) FILTER (WHERE e.outcome = 'pending')           AS pending_uniques,
  COUNT(DISTINCT e.canonical_id)                                                AS total_uniques,
  COUNT(DISTINCT e.canonical_id) FILTER (WHERE e.severity = 'HIGH' AND e.outcome = 'accepted') AS accepted_high,
  pc.cost_usd,
  pc.pass_executions,
  pc.conformant_passes,
  CASE WHEN pc.pass_executions > 0
       THEN round(pc.conformant_passes::numeric / pc.pass_executions, 4)
       ELSE NULL END                                                            AS conformance_rate,
  pc.any_unmeterable,
  e.commit_sha,
  e.stage_type,
  e.assignment_id
FROM expanded e
LEFT JOIN pass_cost pc
  ON pc.run_id = e.run_id AND pc.stage = e.stage
     AND COALESCE(pc.source_model, '') = COALESCE(e.source_model, '')
GROUP BY e.run_id, e.arm, e.stage, e.source_model, e.commit_sha, e.stage_type, e.assignment_id,
         pc.cost_usd, pc.pass_executions, pc.conformant_passes, pc.any_unmeterable;

COMMENT ON VIEW model_ab_effectiveness IS
  'Model-A/B/C v2 aggregate scorer: per run × arm × stage × source_model unique CANONICAL finding counts + per-arm cost/conformance. Arm membership HYBRID (explicit arm for gemini/gpt-round else stage-derived; __INVALID__ fail-closed rows excluded). Carries commit_sha/stage_type/assignment_id. The DECISION module reads the finer model_ab_finding_scores + model_ab_arm_cost views for the two-level outcome-based rank.';

-- ── 7. model_ab_finding_scores — FINDING GRAIN for the outcome-based score ───
-- One row per (finding × attributed arm). The decision module (model-ab-decision.mjs)
-- folds these into (assignment × within-assignment canonical cluster) units and
-- computes weighted-quality score + recall + precision in pure JS (the view
-- exposes the RAW inputs; the module applies the gate/score — plan §7 Gemini R2).
-- Scoring/recall unit = (assignment_id × canonical_id); dedup is cross-ARM
-- WITHIN an assignment only (finding_equivalence is global, so the SAME bug in
-- two assignments is TWO detection events — §4 R2-M3 / Gemini R1).
CREATE OR REPLACE VIEW model_ab_finding_scores AS
WITH canon AS (
  SELECT
    f.run_id,
    r.commit_sha,
    COALESCE(r.assignment_id, r.commit_sha, r.id::text) AS assignment_id,
    COALESCE(r.stage_type, 'audit-code')                AS stage_type,
    r.phase,
    COALESCE(r.prompt_variant, 'default')               AS prompt_variant,
    f.finding_fingerprint,
    f.stage,
    f.source_model,
    f.severity,
    COALESCE(f.adjudication_outcome, 'pending')             AS outcome,
    COALESCE(f.remediation_state, 'pending')               AS remediation_state,
    COALESCE(f.is_quick_fix, false)                        AS is_quick_fix,
    COALESCE(fe.canonical_finding_id, f.finding_fingerprint) AS canonical_id,
    model_ab_attribute_arms(f.stage, f.arm) AS arms
  FROM audit_findings f
  JOIN audit_runs r ON r.id = f.run_id
  LEFT JOIN finding_equivalence fe
    ON fe.duplicate_finding_id = f.finding_fingerprint
)
SELECT
  run_id, commit_sha, assignment_id, stage_type, phase, prompt_variant,
  unnest(arms) AS arm,
  stage, source_model, finding_fingerprint, canonical_id,
  severity, outcome, remediation_state, is_quick_fix
FROM canon
WHERE arms <> ARRAY['__INVALID__'];

COMMENT ON VIEW model_ab_finding_scores IS
  'Model-A/B/C v2 FINDING-grain scorer input: one row per (finding × attributed arm) with the within-assignment canonical_id, adjudicated severity/outcome, remediation_state + is_quick_fix (quality tier), and the assignment grain (assignment_id, stage_type, phase, prompt_variant). The decision module clusters by (assignment_id × canonical_id) and computes weighted-quality score + recall + precision.';

-- ── 8. model_ab_arm_cost — per (assignment × arm) STANDALONE cost + conformance
-- Standalone cost (D7/M1): a SHARED stage (oss-gen) is counted FULLY for EACH arm
-- it serves ("what deploying this arm would cost") — the frontier denominator.
-- Actual € burn (shared counted ONCE) comes from the spend ledger, not here.
CREATE OR REPLACE VIEW model_ab_arm_cost AS
WITH ps AS (
  SELECT
    ps.run_id,
    r.commit_sha,
    COALESCE(r.assignment_id, r.commit_sha, r.id::text) AS assignment_id,
    COALESCE(r.stage_type, 'audit-code')                AS stage_type,
    r.phase,
    COALESCE(r.prompt_variant, 'default')               AS prompt_variant,
    ps.stage, ps.cost_usd, ps.structured_output_ok, ps.usage_unmeterable,
    model_ab_attribute_arms(ps.stage, ps.arm) AS arms
  FROM audit_pass_stats ps
  JOIN audit_runs r ON r.id = ps.run_id
  WHERE ps.stage IS NOT NULL
),
exp AS (
  SELECT assignment_id, commit_sha, stage_type, phase, prompt_variant,
         cost_usd, structured_output_ok, usage_unmeterable,
         unnest(arms) AS arm
  FROM ps
  WHERE arms <> ARRAY['__INVALID__']
)
SELECT
  assignment_id, commit_sha, stage_type, phase, prompt_variant, arm,
  SUM(cost_usd)                                   AS standalone_cost_usd,
  bool_and(cost_usd IS NOT NULL)                  AS cost_known,
  COUNT(*)                                        AS pass_executions,
  COUNT(*) FILTER (WHERE structured_output_ok)    AS conformant_passes,
  BOOL_OR(usage_unmeterable)                      AS any_unmeterable
FROM exp
GROUP BY assignment_id, commit_sha, stage_type, phase, prompt_variant, arm;

COMMENT ON VIEW model_ab_arm_cost IS
  'Model-A/B/C v2 STANDALONE cost + conformance per (assignment × arm × stage_type): a shared stage (oss-gen) is counted FULLY for each arm it serves ("what deploying this arm would cost"). The Pareto frontier (€/accepted-weighted, €/accepted-HIGH) divides this by score — NEVER folded into the score. Actual € burn (shared counted once) comes from the spend ledger.';
