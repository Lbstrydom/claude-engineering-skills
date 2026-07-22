-- Stop CONTROL-STATE marker findings from reaching the human triage queue.
--
-- The adjacency wave emits a machine-generated coverage notice —
-- `ADJACENCY_INCOMPLETE (enumeration-bound): maxContainers=20 reached …` —
-- verbatim every time it hits its cap. A ledger never adjudicates it (it is
-- not a real finding to rule on), so the needs-triage reconciliation
-- (`markRunFindingsNeedsTriage`, scripts/lib/finalize-outcomes.mjs) was
-- flagging it `user_action = 'needs_triage'` exactly like a genuinely
-- un-ruled finding — landing it in `pending_triage_findings` and the weekly
-- digest. A live-DB check on 2026-07-22 found 10 such stale rows.
--
-- 20260720210000_memory_health_control_markers.sql already excludes the same
-- class from the cluster-density metric by filtering at READ time
-- (`control_marker_prefixes`). This migration closes the sibling gap at
-- WRITE time: the code fix (scripts/lib/finalize-outcomes.mjs,
-- splitPendingFindings) now routes control markers to a distinct
-- `auto_dismissed` terminal state instead of `needs_triage`, so
-- `pending_triage_findings` (which only selects `needs_triage`) excludes
-- them going forward with no view change needed.
--
-- Widen, don't replace (mirrors 20260718120000_plans_status_vocabulary.sql):
-- ADD `auto_dismissed` and keep every existing value — dropping one would
-- fail existing rows on the next write. Idempotent: drop-if-exists then
-- re-add, matching the append-only migration convention (constraint name is
-- stable, so re-running is safe).

ALTER TABLE audit_findings DROP CONSTRAINT IF EXISTS audit_findings_user_action_check;
ALTER TABLE audit_findings ADD CONSTRAINT audit_findings_user_action_check
  CHECK (user_action IN ('fix-now', 'deferred', 'dismissed', 'needs_triage', 'accepted-permanent', 'auto_dismissed'));

-- One-time cleanup: relabel the stale rows found by the 2026-07-22 live-DB
-- check so they stop appearing in `pending_triage_findings` / the weekly
-- digest. Safe + idempotent: scoped to rows that are still sitting in
-- needs_triage AND whose detail_snapshot carries the control-marker prefix —
-- a second run finds nothing left to touch. Keep this WHERE clause's prefix
-- list in sync with scripts/lib/audit/control-markers.mjs
-- (CONTROL_MARKER_PREFIXES) and the SQL sibling in
-- 20260720210000_memory_health_control_markers.sql (control_marker_prefixes)
-- if a new wave ever starts emitting control state.

UPDATE audit_findings
   SET user_action = 'auto_dismissed',
       dismiss_reason = 'control-marker: auto-dismissed — machine-generated coverage notice, not a real finding'
 WHERE user_action = 'needs_triage'
   AND detail_snapshot LIKE 'ADJACENCY\_INCOMPLETE%' ESCAPE '\';
