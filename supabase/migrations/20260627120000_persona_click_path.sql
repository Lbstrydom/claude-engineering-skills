-- Add click_path (jsonb) to persona_test_sessions — the per-step reachability
-- evidence a persona actually walked during /persona-test (sanitized + redacted
-- server-side before write). Consumed by /nav-audit --bootstrap to seed
-- personaIntents from real reachability. Plan: docs/completed/persona-clickpath-nav-seeding.md
--
-- Idempotent (IF NOT EXISTS / guarded constraint) — safe to re-run.

ALTER TABLE persona_test_sessions
  ADD COLUMN IF NOT EXISTS click_path jsonb NOT NULL DEFAULT '[]'::jsonb;

-- click_path must be a JSON array, never a scalar/object (R1-M3).
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'persona_click_path_is_array'
  ) THEN
    ALTER TABLE persona_test_sessions
      ADD CONSTRAINT persona_click_path_is_array
        CHECK (jsonb_typeof(click_path) = 'array');
  END IF;
END $$;

-- Serve the reachability reader's `WHERE repo_name = $1 ORDER BY created_at DESC`
-- access path (R2-M4). Partial (repo_name IS NOT NULL) mirrors the existing
-- commit/deployment indexes — the reader only ever filters a non-null repo_name.
CREATE INDEX IF NOT EXISTS persona_test_sessions_repo_name_created_idx
  ON persona_test_sessions (repo_name, created_at DESC)
  WHERE repo_name IS NOT NULL;

COMMENT ON COLUMN persona_test_sessions.click_path IS
  'Sanitized/redacted per-step path a persona walked (array of {step,action,url,targetText}, no typed input values); seeds /nav-audit reachability evidence.';
