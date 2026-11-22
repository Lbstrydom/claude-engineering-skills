-- Own-model full capture, phase P0 (docs/plans/own-model-full-capture.md section 2.9 and 2.10).
-- METADATA ONLY. No content table, no new writer: the existing audit.llmCalls writer fills these
-- columns. Idempotent and schema-portable (unqualified names, IF NOT EXISTS, DROP-then-ADD CHECK).
--
--   logical_call_id        one id per logical call (one callGPT / final-review invocation); every
--                          retry is an ATTEMPT row (its own call_id) carrying the same logical id
--   attempt_no             1-based attempt index inside the logical call
--   attempt_outcome        what the provider attempt did: closed vocabulary below
--   capture_schema_version stamped on every capture row; readers report per version, never pooled
--
-- Rows written before this migration have all four NULL, which the completeness report reads as
-- `pre-p0`, never as a failure and never as a success.
ALTER TABLE llm_call_provenance ADD COLUMN IF NOT EXISTS logical_call_id uuid;
ALTER TABLE llm_call_provenance ADD COLUMN IF NOT EXISTS attempt_no integer;
ALTER TABLE llm_call_provenance ADD COLUMN IF NOT EXISTS attempt_outcome text;
ALTER TABLE llm_call_provenance ADD COLUMN IF NOT EXISTS capture_schema_version integer;

ALTER TABLE llm_call_provenance DROP CONSTRAINT IF EXISTS llm_call_provenance_attempt_outcome_chk;
ALTER TABLE llm_call_provenance ADD CONSTRAINT llm_call_provenance_attempt_outcome_chk
  CHECK (attempt_outcome IS NULL OR attempt_outcome IN
    ('success', 'schema-reject', 'partial', 'timeout', 'cancel', 'refusal', 'error', 'missing-payload'));
