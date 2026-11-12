/**
 * @fileoverview Single JS-side source of truth for CONTROL-STATE marker
 * prefixes — machine-generated notices a wave prints about its OWN
 * execution (coverage caps, aborted enumeration), never a defect in the
 * audited code. They are byte-identical every time they fire, so anything
 * that treats them as an ordinary finding (similarity clustering,
 * needs-triage routing) misreads control state as duplicated signal.
 *
 * finalize-outcomes.mjs consumes it twice: an un-ruled marker goes to
 * `auto_dismissed`, never `needs_triage`; and a ledger may dismiss a marker
 * but never accept it (passed to outcome-sync as `cannotAccept`), so it can
 * never become an `unremediated_acceptances` obligation.
 *
 * Mirrors `control_marker_prefixes` in
 * supabase/migrations/20260720210000_memory_health_control_markers.sql
 * (the cluster-density metric's exclusion list). The two lists are not
 * mechanically synced across the JS/SQL boundary — add a prefix here AND
 * there when a new wave starts emitting control state.
 *
 * @module scripts/lib/audit/control-markers
 */

export const CONTROL_MARKER_PREFIXES = Object.freeze(['ADJACENCY_INCOMPLETE']);

/**
 * Markers that say a part of the audit's INPUT was never verified (hook v18): the run is not evidence about the change, so the pre-push
 * gate classifies it `unmeasured`, not `clean`. They live in the audit's result envelope only - never in the learning store - so they are
 * deliberately NOT in {@link CONTROL_MARKER_PREFIXES}, which mirrors the SQL metric exclusion list.
 *  - `OWNERSHIP_UNVERIFIED`: `git check-ignore` could not say which files the repo owns (lib/disowned-paths.mjs `degraded`).
 */
export const MEASUREMENT_DEGRADING_MARKER_PREFIXES = Object.freeze(['OWNERSHIP_UNVERIFIED']);

/**
 * Is `detailText` a control-state marker rather than a real finding?
 * Matched on the detail-text PREFIX, deliberately never the category — the
 * adjacency wave emits genuine findings under the same `[Adjacency]`-
 * flavoured category, so excluding by category would drop real signal.
 *
 * @param {string|null|undefined} detailText
 * @returns {boolean}
 */
export function isControlMarkerDetail(detailText) {
  if (typeof detailText !== 'string' || !detailText) return false;
  return CONTROL_MARKER_PREFIXES.some(prefix => detailText.startsWith(prefix)) || isMeasurementDegradingDetail(detailText);
}

/** Is `detailText` a marker saying the audit's input went unverified (so the run is not a measurement)? A subset of the control markers. */
export function isMeasurementDegradingDetail(detailText) {
  return typeof detailText === 'string' && MEASUREMENT_DEGRADING_MARKER_PREFIXES.some(prefix => detailText.startsWith(prefix));
}

/**
 * Is this audit FINDING a control-state marker? The one predicate a finding-list consumer (the pre-push gate's severity count) uses:
 * the same prefix rule over the finding's `detail`, so a marker can never be counted as a defect in one place and excluded in another.
 *
 * @param {{detail?: unknown}|null|undefined} finding
 * @returns {boolean}
 */
export function isControlMarkerFinding(finding) {
  return isControlMarkerDetail(finding?.detail);
}
