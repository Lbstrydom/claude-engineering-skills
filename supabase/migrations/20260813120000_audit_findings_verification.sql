-- audit_findings: carry the deterministic verification gate's verdict.
--
-- Plan: docs/plans/adaptive-context-blast-radius.md — Phase 1 (the gate itself,
-- scripts/lib/audit/finding-verification.mjs, shipped without a persistence leg).
--
-- WHY. The gate resolves every "missing file/module/symbol" finding against the
-- real repo and marks the provably-false ones `refuted`. That verdict lived only
-- in the gitignored local `.audit/*-result.json` and one stderr line, so:
--
--   1. `audit_findings.severity` records the MODEL's severity — correct and
--      deliberate (the model's claim is immutable, audit M2) — but with no
--      sibling verdict column, a HIGH the gate PROVED false is stored
--      indistinguishably from a real HIGH. Every reader that counts
--      HIGH/MEDIUM off this table therefore counts findings known to be wrong.
--   2. The natural quality metric (rate of refuted / requires_verification among
--      existence claims) had no baseline and was not queryable at all, which
--      makes any future change to this class unfalsifiable.
--   3. Concretely: the `NO_MANIFEST_ABSENCE_VERDICTS` prompt rule (d6741c00)
--      declared its own success metric as "count the findings the gate labels
--      `looks like an external dependency` per run; it should go to zero without
--      `confirmed` moving". That string lives in `verification_reason`. Until
--      this migration the rule that ALREADY SHIPPED could not be checked outside
--      the one machine holding the local artifacts.
--
--   verification        'refuted' | 'confirmed' | 'requires_verification' — the
--                       closed domain `verifyExistenceFindings` emits (`mk`).
--   verification_reason the gate's own prose, already capped at 300 chars there.
--                       Load-bearing rather than decorative: it is what
--                       distinguishes the residual CLASSES from one another,
--                       which is the whole measurement above.
--   verdict_severity    the severity a reader should TRIAGE on
--                       (`effectiveSeverity`): the model's severity for
--                       confirmed / requires_verification, 'LOW' for refuted.
--
-- SEVERITY IS NOT TOUCHED, and that asymmetry is deliberate — the same rule
-- `recordFindings` already applies when a provider omits severity ("the metric
-- the A/B stopping rule counts, so it is never fabricated"). Overwriting it with
-- the effective value would corrupt that metric from the other side and destroy
-- the model's immutable claim. Readers apply `effectiveSeverity` themselves.
--
-- ALL THREE ARE ADDITIVE AND NULLABLE. A pre-existing row keeps NULL, which
-- reads as "this finding predates the persistence leg" — deliberately distinct
-- from `requires_verification`, which would claim the gate looked and could not
-- decide. NULL is also the correct value for the majority of findings: the gate
-- only attaches `verification` to findings `classifyFinding` marks as existence
-- claims, and leaves every other finding untouched.
--
-- The CHECK is expressed DROP-then-ADD because Postgres has no idempotent
-- `ADD CONSTRAINT IF NOT EXISTS` — the same shape 20260812080000 uses. It admits
-- NULL, so it validates cleanly against every existing row.

BEGIN;

ALTER TABLE audit_findings
  ADD COLUMN IF NOT EXISTS verification text;

ALTER TABLE audit_findings
  ADD COLUMN IF NOT EXISTS verification_reason text;

ALTER TABLE audit_findings
  ADD COLUMN IF NOT EXISTS verdict_severity text;

ALTER TABLE audit_findings
  DROP CONSTRAINT IF EXISTS audit_findings_verification_check;

ALTER TABLE audit_findings
  ADD CONSTRAINT audit_findings_verification_check
  CHECK (verification IS NULL OR verification = ANY (ARRAY[
    'refuted',
    'confirmed',
    'requires_verification'
  ]));

-- `verdict_severity` gets the SAME domain as `severity` (which has carried
-- `audit_findings_severity_check` all along) and as `verdictSeverity` in
-- schemas.mjs. Without it this was the only one of the three new columns with no
-- domain guard — an asymmetry that lets a typo'd severity land silently in the
-- column readers are meant to TRIAGE on.
--
-- Deliberately NOT a cross-column CHECK (`refuted` ⇒ 'LOW'). That would encode a
-- gate POLICY in the schema: `mk` chooses LOW for a refuted finding, and if that
-- choice ever changes, a stale constraint would reject the batch — and a
-- constraint violation inside a caller-supplied transaction discards every
-- finding in it, not just the offending row. The policy has an owner already
-- (`effectiveSeverity`); the schema's job is the vocabulary.
ALTER TABLE audit_findings
  DROP CONSTRAINT IF EXISTS audit_findings_verdict_severity_check;

ALTER TABLE audit_findings
  ADD CONSTRAINT audit_findings_verdict_severity_check
  CHECK (verdict_severity IS NULL OR verdict_severity = ANY (ARRAY[
    'HIGH',
    'MEDIUM',
    'LOW'
  ]));

COMMENT ON COLUMN audit_findings.verification IS
  'Deterministic existence-gate verdict: refuted | confirmed | requires_verification. '
  'NULL = not an existence claim, or the finding predates the persistence leg — NEVER '
  'the same as requires_verification. Written by recordFindings from finding.verification; '
  'see scripts/lib/audit/finding-verification.mjs.';

COMMENT ON COLUMN audit_findings.verification_reason IS
  'The gate''s stated reason, capped at 300 chars by `mk`. Distinguishes the residual '
  'classes from one another (e.g. "looks like an external dependency" = the manifest '
  'class), which is what makes the per-class metrics queryable.';

COMMENT ON COLUMN audit_findings.verdict_severity IS
  'The severity a reader should TRIAGE on (effectiveSeverity): LOW for a refuted finding, '
  'the model''s own severity otherwise. `severity` deliberately keeps the model''s '
  'immutable claim and is never rewritten.';

COMMIT;
