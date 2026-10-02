-- Repair CONTROL-STATE markers that a ledger ruled `accepted`, which turned a
-- machine coverage notice into an open obligation.
--
-- 20260722120000_control_marker_auto_dismissed.sql routed an UN-ruled control
-- marker (`ADJACENCY_INCOMPLETE …`) to `auto_dismissed`, on the stated premise
-- that "a ledger never adjudicates it". That premise was never enforced: an
-- agent writing the ledger could rule the notice `accepted` (the coverage WAS
-- incomplete), `recordAdjudicationEvent` wrote `adjudication_outcome =
-- 'accepted'`, and the row surfaced in `unremediated_acceptances_all` as a
-- defect owed a fix. Measured on the live store 2026-10-02: 34 control markers
-- carried `accepted`; 3 were still open in the view (primary_file `diff`,
-- `scripts/lib/skill-frontmatter-layout.mjs`, `tests/audit-base-ancestry.test.mjs`).
--
-- The fix is at WRITE time: finalize-outcomes.mjs passes `isControlMarkerDetail`
-- to outcome-sync's `enrichFindings` as `cannotAccept`, which refuses any
-- ledger ruling but `dismissed` on a control marker, so it stays pending and
-- takes the existing auto-dismiss route. That is the one place a
-- ruling attaches to a finding, and it also stops the same row inflating the
-- bandit reward, pass stats and the run's `acceptedCount` — a view filter
-- would have hidden only one of those consumers. It reuses
-- `isControlMarkerDetail`, so no new live prefix list exists anywhere.
--
-- This file only repairs rows written BEFORE that fix. Its prefix literal is a
-- dated snapshot, not a list to keep in sync: the fixed writer can no longer
-- produce the state it matches. Scope is deliberately the OBLIGATION set only —
-- exactly what `unremediated_acceptances_all` selects (accepted /
-- severity_adjusted, remediation not yet fixed/verified). The 31 rows already
-- marked fixed/verified are not obligations and are left as history, and a
-- human-set `user_action` (fix-now, accepted-permanent, …) is never clobbered —
-- the same guard `markRunFindingsAutoDismissed` uses.
--
-- Each repaired row is made exactly what the fixed write path produces for a
-- ledger-accepted control marker: no adjudication event, no outcome, no
-- remediation state, `user_action = 'auto_dismissed'`. The event is deleted
-- rather than left behind, because an event disagreeing with
-- `audit_findings` is itself the divergence
-- tests/adjudication-remediation-propagation-live.test.mjs guards against.
--
-- Idempotent: the DELETE runs first while the predicate still matches; the
-- UPDATE then clears `adjudication_outcome`, so a second run matches nothing.
-- No schema change — `--check-drift` is unaffected.

DELETE FROM finding_adjudication_events
 WHERE finding_id IN (
   SELECT id FROM audit_findings
    WHERE detail_snapshot LIKE 'ADJACENCY\_INCOMPLETE%' ESCAPE '\'
      AND adjudication_outcome IN ('accepted', 'severity_adjusted')
      AND (remediation_state IS NULL OR remediation_state IN ('pending', 'planned'))
      AND (user_action IS NULL OR user_action IN ('needs_triage', 'auto_dismissed'))
 );

UPDATE audit_findings
   SET adjudication_outcome = NULL,
       decided_at = NULL,
       remediation_state = NULL,
       user_action = 'auto_dismissed',
       dismiss_reason = 'control-marker: auto-dismissed — machine-generated coverage notice, not a real finding'
 WHERE detail_snapshot LIKE 'ADJACENCY\_INCOMPLETE%' ESCAPE '\'
   AND adjudication_outcome IN ('accepted', 'severity_adjusted')
   AND (remediation_state IS NULL OR remediation_state IN ('pending', 'planned'))
   AND (user_action IS NULL OR user_action IN ('needs_triage', 'auto_dismissed'));
