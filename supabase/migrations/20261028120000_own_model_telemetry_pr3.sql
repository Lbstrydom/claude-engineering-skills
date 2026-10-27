-- Own-model telemetry PR 3 (docs/plans/own-model-telemetry-pr3.md; memo
-- docs/research/own-model-roadmap-2026-10.md section 6.8).
--
-- Decision-time provenance, label ingest time, per-LLM-call provenance, and an
-- append-only consent history. Every column added here has a writer in the same
-- PR and an entry in .own-model-coverage.json, so a column that stops filling is
-- visible instead of silently null.
--
-- Idempotent: IF NOT EXISTS / CREATE OR REPLACE / guarded backfills.
-- public-only, no schema-qualified names (parity:check-coupling).

-- ── learning_decisions: versions, propensity, point-in-time inputs, denominators ──
ALTER TABLE learning_decisions ADD COLUMN IF NOT EXISTS tool_sha text;
ALTER TABLE learning_decisions ADD COLUMN IF NOT EXISTS policy_version text;
ALTER TABLE learning_decisions ADD COLUMN IF NOT EXISTS schema_version integer;
ALTER TABLE learning_decisions ADD COLUMN IF NOT EXISTS selection_rule text;
ALTER TABLE learning_decisions ADD COLUMN IF NOT EXISTS selection_probability numeric;
ALTER TABLE learning_decisions ADD COLUMN IF NOT EXISTS randomised boolean;
ALTER TABLE learning_decisions ADD COLUMN IF NOT EXISTS input_snapshot jsonb;
ALTER TABLE learning_decisions ADD COLUMN IF NOT EXISTS options_not_chosen jsonb;
ALTER TABLE learning_decisions ADD COLUMN IF NOT EXISTS eligible_population integer;

-- ── audit_runs: code and policy version ──
ALTER TABLE audit_runs ADD COLUMN IF NOT EXISTS tool_sha text;
ALTER TABLE audit_runs ADD COLUMN IF NOT EXISTS policy_version text;

-- ── finding_adjudication_events: event time vs ingest time ──
-- created_at stays the EVENT time. ingested_at is when the store received the row.
-- History has no record of true receipt time, so existing rows are backfilled
-- ingested_at = created_at and flagged inferred; new rows are observed (false).
ALTER TABLE finding_adjudication_events ADD COLUMN IF NOT EXISTS ingested_at timestamptz;
ALTER TABLE finding_adjudication_events ADD COLUMN IF NOT EXISTS ingested_at_inferred boolean NOT NULL DEFAULT false;
UPDATE finding_adjudication_events
   SET ingested_at = created_at, ingested_at_inferred = true
 WHERE ingested_at IS NULL;
ALTER TABLE finding_adjudication_events ALTER COLUMN ingested_at SET DEFAULT now();
ALTER TABLE finding_adjudication_events ALTER COLUMN ingested_at SET NOT NULL;

-- The label source of truth: every adjudication row per finding, in order. The
-- overwrite column audit_findings.user_action is deprecated.
CREATE OR REPLACE VIEW finding_label_history AS
SELECT e.finding_id,
       e.adjudication_outcome AS outcome,
       e.remediation_state    AS state,
       e.created_at,
       e.ingested_at,
       e.ingested_at_inferred,
       ROW_NUMBER() OVER (PARTITION BY e.finding_id ORDER BY e.created_at, e.id) AS ordinal
  FROM finding_adjudication_events e;

-- ── audit_repos: consent lineage ──
ALTER TABLE audit_repos ADD COLUMN IF NOT EXISTS training_eligibility_approved_by text;
ALTER TABLE audit_repos ADD COLUMN IF NOT EXISTS training_eligibility_set_at timestamptz;

CREATE TABLE IF NOT EXISTS training_eligibility_events (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  repo_id      uuid NOT NULL,
  eligible     boolean NOT NULL,
  reason       text NOT NULL,
  approved_by  text,
  set_at       timestamptz NOT NULL,
  ingested_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_tee_repo ON training_eligibility_events (repo_id, set_at);

-- Seed one history row per already-decided repo so the lineage starts from what is
-- true today. The approver was never recorded before this migration, and says so.
INSERT INTO training_eligibility_events (repo_id, eligible, reason, approved_by, set_at)
SELECT r.id, r.training_eligible, COALESCE(r.training_eligibility_reason, 'pre-lineage decision'),
       'unrecorded (pre-lineage)', COALESCE(r.training_eligibility_set_at, now())
  FROM audit_repos r
 WHERE r.training_eligible IS NOT NULL
   AND NOT EXISTS (SELECT 1 FROM training_eligibility_events t WHERE t.repo_id = r.id);

-- ── per-LLM-call provenance ──
-- call_id is a client-derived UUIDv5 (run | producer | process nonce | seq), so a
-- replayed spill collapses on the primary key and two processes cannot collide.
CREATE TABLE IF NOT EXISTS llm_call_provenance (
  call_id          uuid PRIMARY KEY,
  audit_run_id     uuid,
  repo_id          uuid,
  work_item_id     text,
  producer         text NOT NULL,
  purpose          text,
  model_resolved   text,
  route            text,
  prompt_hash      text,
  prompt_variant   text,
  temperature      numeric,
  reasoning_effort text,
  input_tokens     integer,
  cached_tokens    integer,
  output_tokens    integer,
  reasoning_tokens integer,
  latency_ms       integer,
  cost_usd         numeric,
  truncated        boolean,
  retried          boolean,
  fallback         boolean,
  schema_version   integer NOT NULL,
  created_at       timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE llm_call_provenance DROP CONSTRAINT IF EXISTS llm_call_provenance_producer_chk;
ALTER TABLE llm_call_provenance ADD CONSTRAINT llm_call_provenance_producer_chk
  CHECK (producer IN ('audit', 'final-review'));
CREATE INDEX IF NOT EXISTS idx_lcp_run ON llm_call_provenance (audit_run_id, created_at);

-- One row per producing process, so two producers on one run never overwrite each
-- other's recorded/dropped counts.
CREATE TABLE IF NOT EXISTS llm_call_log_summary (
  audit_run_id  uuid NOT NULL,
  producer      text NOT NULL,
  process_nonce text NOT NULL,
  recorded      integer NOT NULL,
  dropped       integer NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (audit_run_id, producer, process_nonce)
);
