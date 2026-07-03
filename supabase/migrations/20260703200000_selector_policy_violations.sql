-- Selector-policy violation telemetry (plan: docs/completed/ux-lock-selector-policy.md).
-- Observation-only in v1 — no reader consumes these columns yet; they exist so
-- the /ux-lock runner's selector-policy lint leaves an auditable trend.
-- Idempotent; consumers pick this up via .audit-loop/migrations sync +
-- `node scripts/.claude-skills/setup-postgres.mjs --migrate`.

ALTER TABLE regression_spec_runs
  ADD COLUMN IF NOT EXISTS selector_policy_violations INTEGER;

ALTER TABLE plan_verification_runs
  ADD COLUMN IF NOT EXISTS selector_policy_violations INTEGER;

COMMENT ON COLUMN regression_spec_runs.selector_policy_violations IS
  'Count of UNJUSTIFIED selector-policy violations (classes: structural-selector, unresolvable-selector, app-module-import) for THIS spec file plus its local-helper import closure. Justified (marked) usages and stale-marker warnings are excluded. NULL = run predates the lint or the runner could not scan.';

COMMENT ON COLUMN plan_verification_runs.selector_policy_violations IS
  'Count of UNJUSTIFIED selector-policy violations (classes: structural-selector, unresolvable-selector, app-module-import) across the verify spec + its local-helper import closure for this run. Justified usages and stale-marker warnings are excluded. NULL = run predates the lint.';
