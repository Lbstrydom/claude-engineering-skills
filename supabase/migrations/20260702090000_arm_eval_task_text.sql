-- arm-eval: store the verbatim task/topic text on the session (operator request
-- 2026-07-02 — the committed session archive under docs/arm-eval/sessions/ is a
-- scientific log; a researcher cannot recover the prompt from the task_id hash).
-- Nullable + idempotent: pre-existing sessions keep NULL (backfilled separately
-- where the operator still has the prompt text). The run path secret-redacts
-- task text before persistence (same shape-based redactor as the export).

ALTER TABLE arm_eval_sessions ADD COLUMN IF NOT EXISTS task_text text;

COMMENT ON COLUMN arm_eval_sessions.task_text IS
  'Verbatim task/topic prompt given to every arm (shape-redacted). task_id remains the canonical dedup/diversity hash.';
