-- Own-model full capture, phase P0 part 2 (docs/plans/own-model-full-capture.md section 2.2, P0 row).
-- METADATA ONLY. The existing audit.llmCalls writer fills these; no new writer or table.
-- Idempotent and schema-portable (unqualified names, IF NOT EXISTS).
--
--   audited_tree   the git tree object id of the working tree the call audited (same value the run
--                  carries in audit_runs.audited_tree, stamped per call so a call stays attributable
--                  to the exact bytes it saw even if the run row is never completed)
--   diff_base_sha  the resolved commit the diff was taken against (audit_runs.diff_base_sha, per call)
--
-- Rows written before this migration have both NULL; readers report `pre-p0`, never a failure.
ALTER TABLE llm_call_provenance ADD COLUMN IF NOT EXISTS audited_tree text;
ALTER TABLE llm_call_provenance ADD COLUMN IF NOT EXISTS diff_base_sha text;
