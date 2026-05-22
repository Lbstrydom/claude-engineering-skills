/**
 * @fileoverview Learning telemetry tab — pending-triage / no-brainer /
 * stale-cluster metrics from the adaptive-learning store.
 *
 * Plan: docs/plans/sustainability-cleanup-batch.md (WS2).
 *
 * Signature: `default({src, learning}, ui) → string`.
 *
 * @module scripts/lib/dashboard/sections/learning
 */

const SECTION = 'learning';

export default function sectionLearning({ src, learning }, ui) {
  if (ui.NON_OK.has(src.status)) return ui.warningPanel(SECTION, src);
  const l = learning;
  // `missing-optional` carries a specific reason (cloud off vs repo not
  // found) — surface that detail rather than collapsing every non-ok
  // state into a generic "no decisions" message.
  if (src.status === 'missing-optional') {
    return ui.emptyPanel(null, src.detail || 'Learning telemetry unavailable.');
  }
  if (!l.cloud) {
    return ui.emptyPanel(null, 'Learning telemetry needs cloud + a service-role key.');
  }
  if (!l.pendingTriageCount && !l.noBrainerCount && !l.staleClusterCount) {
    return ui.emptyPanel(null, 'No learning decisions recorded yet.');
  }
  return `<div class="table-wrap"><table><thead><tr><th>Metric</th><th>Count</th></tr></thead><tbody>
    <tr><td>Pending triage</td><td>${ui.escapeHtml(l.pendingTriageCount)}</td></tr>
    <tr><td>No-brainer recommendations</td><td>${ui.escapeHtml(l.noBrainerCount)}</td></tr>
    <tr><td>Stale clusters</td><td>${ui.escapeHtml(l.staleClusterCount)}</td></tr>
  </tbody></table></div>`;
}
