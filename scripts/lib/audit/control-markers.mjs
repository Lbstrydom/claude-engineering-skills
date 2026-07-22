/**
 * @fileoverview Single JS-side source of truth for CONTROL-STATE marker
 * prefixes — machine-generated notices a wave prints about its OWN
 * execution (coverage caps, aborted enumeration), never a defect in the
 * audited code. They are byte-identical every time they fire, so anything
 * that treats them as an ordinary finding (similarity clustering,
 * needs-triage routing) misreads control state as duplicated signal.
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
  return CONTROL_MARKER_PREFIXES.some(prefix => detailText.startsWith(prefix));
}
