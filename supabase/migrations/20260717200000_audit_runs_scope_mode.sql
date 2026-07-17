-- audit_runs.scope_mode — close a code-ahead-of-ledger schema gap.
--
-- `recordRunStart` (scripts/lib/store/runs-findings.mjs:167) has been writing
-- `scope_mode` since the audit-scope work, but NO migration ever added the
-- column. The write is conditional —
--     ...(scopeMode ? { scope_mode: scopeMode } : {})
-- — so the failure is selective rather than total, which is why it survived:
-- a /audit-code run that passes no scopeMode inserts fine, while EVERY
-- /audit-plan run (which always sets scopeMode='plan') fails the whole INSERT
-- with:
--     column "scope_mode" of relation "audit_runs" does not exist
-- and returns null. The audit then proceeds cloud-degraded by design (#16
-- graceful degradation), so nothing crashed and nobody noticed — plan-audit
-- runs simply never reached the cloud store.
--
-- Impact: `audit_runs` rows with mode='plan' — the plan-triage ground truth the
-- adaptive-learning loop consumes (AGENTS.md "plan audits create cloud
-- audit_runs rows with mode='plan' since 2026-07-13") — have been silently
-- absent since that claim was made. The claim was true of the code and false of
-- the schema.
--
-- Found 2026-07-17 while running /audit-plan on
-- docs/plans/reference-integrity-gate.md: three consecutive rounds each logged
-- `[learning] recordRunStart failed` to stderr.
--
-- Nullable TEXT, no CHECK: the column is descriptive telemetry ('diff' | 'plan'
-- | 'full' per scripts/lib/audit-scope.mjs:224), and schemas.mjs:507 already
-- types it `z.string().nullable().optional()`. A CHECK here would be a second
-- source of truth for a vocabulary the Zod schema already owns, and would fail
-- closed on a future scope mode for no safety benefit — this column gates
-- nothing.
--
-- Idempotent (ADD COLUMN IF NOT EXISTS), matching every other audit_runs
-- column addition in this directory (20260417120000, 20260419120000).

ALTER TABLE audit_runs ADD COLUMN IF NOT EXISTS scope_mode TEXT;

COMMENT ON COLUMN audit_runs.scope_mode IS
  'Audit scope for this run: diff | plan | full. Written by recordRunStart; descriptive telemetry only.';
