/**
 * @fileoverview Ship-health tab — per-repo /ship outcome mix + recent events.
 *
 * Cluster D / Phase 7 of docs/plans/learning-store-signal-recovery.md.
 * Signature: `default({src, shipHealth}, ui) → string`.
 *
 * @module scripts/lib/dashboard/sections/ship-health
 */

const SECTION = 'shipHealth';

export default function sectionShipHealth({ src, shipHealth }, ui) {
  if (ui.NON_OK.has(src.status)) return ui.warningPanel(SECTION, src);
  const s = shipHealth;
  if (src.status === 'missing-optional') {
    return ui.emptyPanel(null, src.detail || 'Ship telemetry unavailable.');
  }
  if (!s || !s.cloud || !s.byOutcome.length) {
    return ui.emptyPanel(null, 'No ship events recorded yet.');
  }
  const outcomeRows = s.byOutcome
    .map((o) => `<tr><td>${ui.escapeHtml(o.outcome)}</td><td>${ui.escapeHtml(o.count)}</td></tr>`)
    .join('');
  const recentRows = s.recent
    .map((e) => `<tr>
      <td>${ui.escapeHtml(e.outcome)}${e.overridden ? ' <span class="muted">(override)</span>' : ''}</td>
      <td>${ui.escapeHtml(e.branch)}</td>
      <td><code>${ui.escapeHtml(e.commitSha)}</code></td>
      <td class="muted">${ui.escapeHtml(e.createdAt)}</td>
    </tr>`)
    .join('');
  return `<div class="table-wrap"><table><thead><tr><th>Outcome</th><th>Count</th></tr></thead>
    <tbody>${outcomeRows}</tbody></table></div>
    <h3>Recent ships</h3>
    <div class="table-wrap"><table><thead><tr><th>Outcome</th><th>Branch</th><th>Commit</th><th>When</th></tr></thead>
    <tbody>${recentRows}</tbody></table></div>`;
}
