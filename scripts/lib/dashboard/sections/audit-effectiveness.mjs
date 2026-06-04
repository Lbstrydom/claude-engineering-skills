/**
 * @fileoverview Audit-effectiveness tab — per-repo user-visible precision/recall
 * from the persona↔audit correlation ground truth (audit_effectiveness view).
 *
 * Cluster D / Phase 7 of docs/plans/learning-store-signal-recovery.md.
 * Signature: `default({src, auditEffectiveness}, ui) → string`.
 *
 * @module scripts/lib/dashboard/sections/audit-effectiveness
 */

const SECTION = 'auditEffectiveness';

/** Format a [0,1] rate as a percent, or an em-dash when the input is null. */
function pct(v, ui) {
  if (v == null) return '<span class="muted">—</span>';
  return ui.escapeHtml(`${(v * 100).toFixed(0)}%`);
}

export default function sectionAuditEffectiveness({ src, auditEffectiveness }, ui) {
  if (ui.NON_OK.has(src.status)) return ui.warningPanel(SECTION, src);
  const e = auditEffectiveness;
  if (src.status === 'missing-optional') {
    // Carries the specific reason (cloud off vs no correlations yet).
    return ui.emptyPanel(null, src.detail || 'Audit-effectiveness telemetry unavailable.');
  }
  if (!e || !e.cloud) {
    return ui.emptyPanel(null, 'Effectiveness telemetry needs cloud + a service-role key.');
  }
  return `<p class="muted">User-visible precision/recall from persona↔audit correlations. Precision = confirmed ÷ (confirmed + false-positive); recall = confirmed ÷ (confirmed + missed). "—" = not enough correlation data yet.</p>
  <div class="table-wrap"><table><thead><tr><th>Metric</th><th>Value</th></tr></thead><tbody>
    <tr><td>Precision (user-visible)</td><td>${pct(e.precision, ui)}</td></tr>
    <tr><td>Recall (user-visible)</td><td>${pct(e.recall, ui)}</td></tr>
    <tr><td>Confirmed hits</td><td>${ui.escapeHtml(e.confirmedHits)}</td></tr>
    <tr><td>Audit misses (persona-only)</td><td>${ui.escapeHtml(e.auditMisses)}</td></tr>
    <tr><td>False positives</td><td>${ui.escapeHtml(e.falsePositives)}</td></tr>
    <tr><td>Severity understated</td><td>${ui.escapeHtml(e.severityUnderstated)}</td></tr>
    <tr><td>Severity overstated</td><td>${ui.escapeHtml(e.severityOverstated)}</td></tr>
  </tbody></table></div>`;
}
