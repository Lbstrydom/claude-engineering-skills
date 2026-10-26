-- Own-model decision ledger (docs/plans/own-model-decision-ledger.md, PR 2 of 3;
-- memo docs/research/own-model-roadmap-2026-10.md section 6).
--
-- ONE append-only, kind-discriminated table for coordinator-side tasks, decisions,
-- corrections, outcomes and usage. Separate from fleet_events, which stays
-- counts-only. Default-deny: training_eligible is NOT NULL DEFAULT false (false is
-- the safe direction when a writer omits it), and content is stored only when the
-- prepare pipeline decided the repo allows it (content_state = 'full').
--
-- Idempotent: IF NOT EXISTS / CREATE OR REPLACE / DROP ... IF EXISTS + ADD.
-- public-only, no schema-qualified names (parity:check-coupling).

CREATE SEQUENCE IF NOT EXISTS own_model_purge_gen;

CREATE TABLE IF NOT EXISTS own_model_ledger (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Identity of THIS row. Client-minted, so a re-drain is a no-op; derived
  -- observations use a deterministic UUIDv5 so concurrent sweepers collapse.
  event_id         UUID NOT NULL UNIQUE,
  kind             TEXT NOT NULL,
  work_item_id     TEXT,
  decision_id      UUID,
  parent_decision_id UUID,
  parent_event_id  UUID,
  -- NO foreign key to audit_repos: the ledger has its own lifecycle and is purged
  -- explicitly, so deleting a repo row can neither fail on the append-only trigger
  -- nor silently null provenance.
  repo_id          UUID,
  repo_name        TEXT,
  coordinator      TEXT NOT NULL,
  actor            TEXT NOT NULL,
  event_at         TIMESTAMPTZ NOT NULL,
  ingested_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  -- The purge generation the producer last observed from the store. NOT a clock:
  -- ordering against a purge is decided by this sequence-drawn number only.
  purge_generation BIGINT NOT NULL DEFAULT 0,
  schema_version   INTEGER NOT NULL,
  redaction_version INTEGER NOT NULL,
  tool_sha         TEXT,
  policy_version   TEXT,
  session_ref      TEXT,
  content_state    TEXT NOT NULL,
  training_eligible BOOLEAN NOT NULL DEFAULT false,
  eligibility_basis TEXT,
  payload          JSONB NOT NULL
);

ALTER TABLE own_model_ledger DROP CONSTRAINT IF EXISTS own_model_ledger_kind_chk;
ALTER TABLE own_model_ledger ADD CONSTRAINT own_model_ledger_kind_chk
  CHECK (kind IN ('task', 'decision', 'correction', 'outcome', 'usage'));
ALTER TABLE own_model_ledger DROP CONSTRAINT IF EXISTS own_model_ledger_coordinator_chk;
ALTER TABLE own_model_ledger ADD CONSTRAINT own_model_ledger_coordinator_chk
  CHECK (coordinator IN ('CES', 'WCA', 'STO', 'AIO', 'other'));
ALTER TABLE own_model_ledger DROP CONSTRAINT IF EXISTS own_model_ledger_actor_chk;
ALTER TABLE own_model_ledger ADD CONSTRAINT own_model_ledger_actor_chk
  CHECK (actor IN ('coordinator', 'louis', 'chip', 'system'));
ALTER TABLE own_model_ledger DROP CONSTRAINT IF EXISTS own_model_ledger_content_state_chk;
ALTER TABLE own_model_ledger ADD CONSTRAINT own_model_ledger_content_state_chk
  CHECK (content_state IN ('full', 'structural'));
-- A structural event can never be marked trainable on the strength of content it
-- does not carry, and an undecided/false repo never produces a trainable row.
ALTER TABLE own_model_ledger DROP CONSTRAINT IF EXISTS own_model_ledger_structural_not_eligible_chk;
ALTER TABLE own_model_ledger ADD CONSTRAINT own_model_ledger_structural_not_eligible_chk
  CHECK (content_state = 'full' OR training_eligible = false);

CREATE INDEX IF NOT EXISTS idx_oml_work_item ON own_model_ledger (work_item_id, event_at);
CREATE INDEX IF NOT EXISTS idx_oml_repo_kind ON own_model_ledger (repo_id, kind, event_at);
CREATE INDEX IF NOT EXISTS idx_oml_parent_event ON own_model_ledger (parent_event_id);

-- One terminal observation per merged event, even if two sweepers' payloads differ
-- (the second insert is a counted conflict, never a second row).
CREATE UNIQUE INDEX IF NOT EXISTS idx_oml_one_observation_per_merge
  ON own_model_ledger (parent_event_id)
  WHERE kind = 'outcome' AND payload->>'kind' IN ('reverted', 'observed-clean');

ALTER TABLE own_model_ledger ENABLE ROW LEVEL SECURITY;

COMMENT ON TABLE own_model_ledger IS
  'Append-only own-model decision ledger. UPDATE/DELETE refused by trigger unless own_model_purge() set own_model.purge. Content is stored only when content_state = full; export is gated by training_eligible and audit_repos.training_eligible.';

-- Purge barrier: per scope, the generation at which it was purged. A writer
-- refuses an event whose purge_generation is lower than its scope's barrier.
CREATE TABLE IF NOT EXISTS own_model_purge_barrier (
  scope_kind  TEXT NOT NULL,
  scope_value TEXT NOT NULL,
  generation  BIGINT NOT NULL,
  PRIMARY KEY (scope_kind, scope_value)
);
ALTER TABLE own_model_purge_barrier DROP CONSTRAINT IF EXISTS own_model_purge_barrier_kind_chk;
ALTER TABLE own_model_purge_barrier ADD CONSTRAINT own_model_purge_barrier_kind_chk
  CHECK (scope_kind IN ('work_item', 'repo'));
ALTER TABLE own_model_purge_barrier ENABLE ROW LEVEL SECURITY;

-- Append-only tripwire (the runtime role owns the table, so this guards against code
-- defects, it is not a security boundary).
CREATE OR REPLACE FUNCTION own_model_ledger_append_only() RETURNS trigger
LANGUAGE plpgsql AS $fn$
BEGIN
  IF current_setting('own_model.purge', true) = 'on' THEN
    IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'own_model_ledger is append-only (% refused); use own_model_purge()', TG_OP
    USING ERRCODE = 'integrity_constraint_violation';
END
$fn$;

DROP TRIGGER IF EXISTS own_model_ledger_append_only_trg ON own_model_ledger;
CREATE TRIGGER own_model_ledger_append_only_trg
  BEFORE UPDATE OR DELETE ON own_model_ledger
  FOR EACH ROW EXECUTE FUNCTION own_model_ledger_append_only();

-- Advisory-lock key shared by writers (shared mode) and purge (exclusive mode), so
-- a purge waits for every in-flight writer batch and blocks new ones until commit.
-- A fixed bigint literal: hashtext() would be a second source of truth.
CREATE OR REPLACE FUNCTION own_model_purge_lock_key() RETURNS bigint
LANGUAGE sql IMMUTABLE AS $fn$ SELECT 7203948201234501::bigint $fn$;

-- Purge by work item and/or repo, in ONE transaction. Returns the deleted count
-- and the generation now recorded in the barrier.
CREATE OR REPLACE FUNCTION own_model_purge(p_work_item text, p_repo text)
RETURNS TABLE (deleted bigint, generation bigint)
LANGUAGE plpgsql AS $fn$
DECLARE
  g bigint;
  n bigint := 0;
  m bigint;
BEGIN
  IF p_work_item IS NULL AND p_repo IS NULL THEN
    RAISE EXCEPTION 'own_model_purge needs a work item or a repo';
  END IF;
  PERFORM pg_advisory_xact_lock(own_model_purge_lock_key());
  g := nextval('own_model_purge_gen');
  PERFORM set_config('own_model.purge', 'on', true);
  IF p_work_item IS NOT NULL THEN
    INSERT INTO own_model_purge_barrier (scope_kind, scope_value, generation)
      VALUES ('work_item', p_work_item, g)
      ON CONFLICT (scope_kind, scope_value) DO UPDATE SET generation = EXCLUDED.generation;
    DELETE FROM own_model_ledger WHERE work_item_id = p_work_item;
    GET DIAGNOSTICS m = ROW_COUNT; n := n + m;
  END IF;
  IF p_repo IS NOT NULL THEN
    INSERT INTO own_model_purge_barrier (scope_kind, scope_value, generation)
      VALUES ('repo', p_repo, g)
      ON CONFLICT (scope_kind, scope_value) DO UPDATE SET generation = EXCLUDED.generation;
    DELETE FROM own_model_ledger WHERE repo_name = p_repo OR repo_id::text = p_repo;
    GET DIAGNOSTICS m = ROW_COUNT; n := n + m;
  END IF;
  PERFORM set_config('own_model.purge', 'off', true);
  RETURN QUERY SELECT n, g;
END
$fn$;

-- Per-task cost. Each side aggregates independently in its own CTE and the two
-- one-row-per-work-item results are joined, so neither fans out the other. Audit
-- cost comes ONLY from audit_runs; ledger usage excludes audit sources (the writer
-- refuses them), so the two cannot overlap.
CREATE OR REPLACE VIEW own_model_task_cost AS
WITH ledger_usage AS (
  SELECT work_item_id,
         SUM((payload->>'cost_usd')::numeric)       AS usage_cost_usd,
         SUM((payload->>'input_tokens')::bigint)    AS input_tokens,
         SUM((payload->>'output_tokens')::bigint)   AS output_tokens,
         COUNT(*)                                   AS usage_events
    FROM own_model_ledger
   WHERE kind = 'usage' AND work_item_id IS NOT NULL
   GROUP BY work_item_id
), audit_cost AS (
  SELECT work_item_id,
         SUM(total_cost_estimate)                   AS audit_cost_usd,
         COUNT(*)                                   AS audit_runs
    FROM audit_runs
   WHERE work_item_id IS NOT NULL
   GROUP BY work_item_id
)
SELECT COALESCE(u.work_item_id, a.work_item_id) AS work_item_id,
       u.usage_cost_usd, u.input_tokens, u.output_tokens, COALESCE(u.usage_events, 0) AS usage_events,
       a.audit_cost_usd, COALESCE(a.audit_runs, 0) AS audit_runs,
       COALESCE(u.usage_cost_usd, 0) + COALESCE(a.audit_cost_usd, 0) AS total_cost_usd
  FROM ledger_usage u
  FULL OUTER JOIN audit_cost a ON a.work_item_id = u.work_item_id;
