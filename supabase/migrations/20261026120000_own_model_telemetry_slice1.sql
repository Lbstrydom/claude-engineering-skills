-- Own-model telemetry slice 1 (docs/plans/own-model-telemetry-slice-1.md; memo
-- docs/research/own-model-roadmap-2026-10.md §2.1).
--
-- Every column is NULLABLE with NO DEFAULT and the backfills below are pure
-- functions of columns that already exist: NULL means "unknown / not yet
-- captured", never a manufactured value. Chronology for legacy rows is NOT
-- backfilled (first_decided_at / fix_recorded_at / fixed_before_adjudication):
-- it is unknowable, so it stays NULL.
--
-- Idempotent: ADD COLUMN IF NOT EXISTS, DROP CONSTRAINT IF EXISTS + ADD,
-- CREATE ... IF NOT EXISTS, and every backfill is guarded `WHERE col IS NULL`.
-- `public`-only, no schema-qualified names (parity:check-coupling).

-- ── Gap 1: the diff a finding was raised on ─────────────────────────────────
-- `work_item_id` is the ledger join key. NOT `task_id`: audit_runs.task_id is
-- the arm-eval task-text hash and is empty.
ALTER TABLE audit_runs ADD COLUMN IF NOT EXISTS diff_ref            TEXT;
ALTER TABLE audit_runs ADD COLUMN IF NOT EXISTS diff_base_sha       TEXT;
ALTER TABLE audit_runs ADD COLUMN IF NOT EXISTS diff_bytes          INTEGER;
ALTER TABLE audit_runs ADD COLUMN IF NOT EXISTS diff_truncated      BOOLEAN;
ALTER TABLE audit_runs ADD COLUMN IF NOT EXISTS diff_redactions     INTEGER;
ALTER TABLE audit_runs ADD COLUMN IF NOT EXISTS diff_capture_status TEXT;
ALTER TABLE audit_runs ADD COLUMN IF NOT EXISTS work_item_id        TEXT;

ALTER TABLE audit_runs DROP CONSTRAINT IF EXISTS audit_runs_diff_capture_status_chk;
ALTER TABLE audit_runs ADD  CONSTRAINT audit_runs_diff_capture_status_chk
  CHECK (diff_capture_status IS NULL OR diff_capture_status IN
    ('captured', 'refused-secret', 'empty-after-filter', 'oversize-section', 'not-applicable', 'repo-excluded'));

COMMENT ON COLUMN audit_runs.diff_ref IS
  'sha256 of the stored (filtered, redacted, bounded) diff in audit_run_diffs. NULL + diff_capture_status says why.';
COMMENT ON COLUMN audit_runs.diff_base_sha IS
  'Resolved sha of the audit base commit the diff was taken against (audited_sha is the head side).';
COMMENT ON COLUMN audit_runs.work_item_id IS
  'Reserved ledger join key (own-model decision ledger). Not audit_runs.task_id, which is the arm-eval task-text hash.';

-- Content-addressed: identical stored text is one row. ONLY content-intrinsic
-- attributes live here; truncation / redaction count / capture status describe
-- a capture ATTEMPT and live on audit_runs.
CREATE TABLE IF NOT EXISTS audit_run_diffs (
  diff_ref   TEXT PRIMARY KEY,
  diff_text  TEXT NOT NULL,
  bytes      INTEGER NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT audit_run_diffs_bytes_chk CHECK (bytes >= 0)
);
-- Same posture as every cross-skill table: RLS on, no anon policy.
ALTER TABLE audit_run_diffs ENABLE ROW LEVEL SECURITY;
COMMENT ON TABLE audit_run_diffs IS
  'Redacted, bounded unified diffs, one row per distinct content. Training use is gated by audit_repos.training_eligible; only scripts/lib/store/training-eligibility.mjs, the writer and the census may read it.';

-- ── Gap 2: who decided ──────────────────────────────────────────────────────
-- ORIGIN (which workflow owns the row) is separate from KIND (who decided).
-- Campaign writers stamp 'campaign'; the normal adjudication path stamps 'audit'.
ALTER TABLE finding_adjudication_events ADD COLUMN IF NOT EXISTS event_origin TEXT;

ALTER TABLE finding_adjudication_events DROP CONSTRAINT IF EXISTS fae_event_origin_chk;
ALTER TABLE finding_adjudication_events ADD  CONSTRAINT fae_event_origin_chk
  CHECK (event_origin IS NULL OR event_origin IN ('audit', 'campaign'));

-- Campaign verdicts always carry `method` (verdictRowRefusal); every other
-- pre-migration row came from the normal path.
UPDATE finding_adjudication_events
   SET event_origin = CASE WHEN method IS NOT NULL THEN 'campaign' ELSE 'audit' END
 WHERE event_origin IS NULL;

-- 'pipeline' = the audit pipeline's own ruling; 'rule' = a deterministic
-- suppression. 'agent' stays the campaign-verdict kind (idx_fae_one_live_agent_verdict).
ALTER TABLE finding_adjudication_events DROP CONSTRAINT IF EXISTS fae_adjudicator_kind_chk;
ALTER TABLE finding_adjudication_events ADD  CONSTRAINT fae_adjudicator_kind_chk
  CHECK (adjudicator_kind IS NULL OR adjudicator_kind IN ('agent', 'human', 'pipeline', 'rule'));

-- ── Gaps 3, 4, 7: findings ──────────────────────────────────────────────────
ALTER TABLE audit_findings ADD COLUMN IF NOT EXISTS dismiss_reason_class      TEXT;
ALTER TABLE audit_findings ADD COLUMN IF NOT EXISTS first_decided_at          TIMESTAMPTZ;
ALTER TABLE audit_findings ADD COLUMN IF NOT EXISTS fix_recorded_at           TIMESTAMPTZ;
ALTER TABLE audit_findings ADD COLUMN IF NOT EXISTS fixed_before_adjudication BOOLEAN;
ALTER TABLE audit_findings ADD COLUMN IF NOT EXISTS fix_verified_commit       TEXT;

ALTER TABLE audit_findings DROP CONSTRAINT IF EXISTS afd_dismiss_class_chk;
ALTER TABLE audit_findings ADD  CONSTRAINT afd_dismiss_class_chk
  CHECK (dismiss_reason_class IS NULL OR dismiss_reason_class IN
    ('false-positive', 'not-actionable', 'duplicate', 'out-of-scope', 'accepted-risk',
     'already-fixed', 'control-marker', 'other', 'unclassified'));

COMMENT ON COLUMN audit_findings.fix_verified_commit IS
  'Commit at which the remediation sweep VERIFIED the fix: an upper bound, NOT the fix commit (that is fix_commit_sha, set only from an explicitly identified fix).';
COMMENT ON COLUMN audit_findings.time_to_resolution_ms IS
  'first_decided_at - created_at for findings decided after 20261026120000. For earlier rows it is decided_at - created_at, where decided_at is the LATEST decision time: an approximation.';

UPDATE audit_findings
   SET dismiss_reason_class = 'control-marker'
 WHERE dismiss_reason_class IS NULL
   AND dismiss_reason LIKE 'control-marker:%';

UPDATE audit_findings
   SET time_to_resolution_ms = (EXTRACT(EPOCH FROM (decided_at - created_at)) * 1000)::bigint
 WHERE time_to_resolution_ms IS NULL
   AND decided_at IS NOT NULL
   AND decided_at >= created_at;

-- ── Gap 6: corpus eligibility (default-deny) ────────────────────────────────
-- NULL = never decided = REFUSED at export. Only an explicit TRUE passes. The
-- migration sets no repo true; flips go through `cross-skill.mjs
-- training-eligibility set`, which requires a reason.
ALTER TABLE audit_repos ADD COLUMN IF NOT EXISTS training_eligible          BOOLEAN;
ALTER TABLE audit_repos ADD COLUMN IF NOT EXISTS training_eligibility_reason TEXT;
