-- Remediation-state verification reconciler (docs/plans/remediation-state-verification-reconciler.md).
--
-- Two nullable tracking columns so an out-of-band verification pass can throttle
-- itself: re-check a stuck `accepted`/`severity_adjusted` finding only when its
-- `primary_file` has changed AGAIN since the later of (accepted_at_commit,
-- remediation_last_checked_commit). Without this, a finding the LLM verifier
-- already read once and found `still-present`/`uncertain` would be re-sent to
-- the model on every subsequent run for as long as the file stays unchanged.
--
-- `accepted_at_commit` needs no new column — it already exists as
-- `audit_runs.commit_sha`, exactly as `unremediated_acceptances_all` reads it
-- today (`r.commit_sha AS accepted_at_commit`).
--
-- Deliberately distinct from the existing `verification`/`verification_reason`/
-- `verdict_severity` columns (migration 20260813120000): those are the
-- deterministic existence-gate verdict computed at RECORD time against the
-- model's own citations. These are the reconciler's OWN throttle state,
-- computed independently, days or weeks later, against current code. Reusing
-- the existence-gate columns would conflate two different questions under one
-- field name.
--
-- `ADD COLUMN IF NOT EXISTS` — idempotent, matches every other additive
-- migration in this file family.

ALTER TABLE audit_findings
  ADD COLUMN IF NOT EXISTS remediation_last_checked_at timestamptz,
  ADD COLUMN IF NOT EXISTS remediation_last_checked_commit text;

-- Surface the two new columns on `unremediated_acceptances_all` — the
-- reconciler's own read side (`getStaleAcceptedFindingsForVerification`,
-- scripts/lib/store/ship-nudges.mjs) needs `remediation_last_checked_commit`
-- to compute its throttle, and `SELECT *` from the view would otherwise never
-- see a column the view's explicit projection doesn't list.
--
-- Reproduces the LIVE definition verbatim (per the same-file convention
-- established by 20260811160000_unremediated_acceptances_disposition.sql) and
-- appends the two columns at the END — the only projection change
-- `CREATE OR REPLACE VIEW` permits without a drop, so an accidental reorder or
-- omission fails loudly instead of silently changing what every existing
-- reader (the /ship 0.5e nudge included) sees.
--
-- Deliberately NOT propagated to the windowed `unremediated_acceptances`
-- sibling: that view is the human-facing nudge and has no use for a
-- reconciler-internal throttle column, and touching only what a feature
-- actually needs is the same restraint the disposition migration itself
-- exercised by leaving `unlocked_fixes` alone.
CREATE OR REPLACE VIEW unremediated_acceptances_all AS
 SELECT f.id AS audit_finding_id,
    f.run_id AS audit_run_id,
    r.repo_id,
    f.severity,
    f.category,
    f.primary_file,
    f.detail_snapshot,
    f.adjudication_outcome,
    f.remediation_state,
    r.commit_sha AS accepted_at_commit,
    r.created_at AS accepted_at,
    EXTRACT(day FROM now() - r.created_at)::integer AS days_open,
    r.mode AS audit_mode,
    f.finding_fingerprint,
    r.created_at < (now() - '7 days'::interval) AS is_mature,
    r.created_at > (now() - '30 days'::interval) AS is_recent,
    f.user_action,
    (f.user_action IS DISTINCT FROM 'accepted-permanent') AS is_open_disposition,
    f.remediation_last_checked_at,
    f.remediation_last_checked_commit
   FROM audit_findings f
     JOIN audit_runs r ON r.id = f.run_id
  WHERE (f.adjudication_outcome = ANY (ARRAY['accepted'::text, 'severity_adjusted'::text]))
    AND (f.remediation_state IS NULL OR (f.remediation_state = ANY (ARRAY['pending'::text, 'planned'::text])))
    AND (f.severity = ANY (ARRAY['HIGH'::text, 'MEDIUM'::text]));
