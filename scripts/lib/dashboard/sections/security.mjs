/**
 * @fileoverview Security telemetry tab — security-incident governance from the
 * security_incidents index + security_strategy_events audit trail.
 *
 * Surfaces: incident count + embedding coverage, per-status breakdown, the
 * secret-gate tallies (refused / redacted — the security-substantive signal),
 * and the most recent audit-trail events. Back-port: docs/plans/security/PLAN.md
 * §4.2 / Phase 6.
 *
 * Signature: `default({src, security}, ui) → string`.
 *
 * @module scripts/lib/dashboard/sections/security
 */

const SECTION = 'security';

// Friendlier labels for the closed event-kind set.
const EVENT_LABELS = {
  inserted: 'Incidents inserted',
  updated: 'Incidents updated',
  marked_historical: 'Marked historical',
  refused_secret: 'Secrets refused (kept out of index)',
  redacted_secret: 'PII redacted before write',
};

export default function sectionSecurity({ src, security }, ui) {
  if (ui.NON_OK.has(src.status)) return ui.warningPanel(SECTION, src);
  const s = security;
  if (src.status === 'missing-optional') {
    return ui.emptyPanel(null, src.detail || 'Security telemetry unavailable.');
  }
  if (!s.cloud) {
    return ui.emptyPanel(null, 'Security telemetry needs cloud + a service-role key.');
  }
  if (!s.totalIncidents && (!s.recentEvents || s.recentEvents.length === 0)) {
    return ui.emptyPanel(null, 'No security incidents indexed yet. Run npm run security:refresh.');
  }

  const last = s.lastRefreshAt ? ui.escapeHtml(s.lastRefreshAt) : '—';
  const summary = `<p class="summary">`
    + `<strong>${ui.escapeHtml(s.totalIncidents)}</strong> incident(s) · `
    + `<strong>${ui.escapeHtml(s.embedded)}</strong> embedded · `
    + `last refresh <code>${last}</code></p>`;

  const statusTable = (s.byStatus && s.byStatus.length)
    ? `<h4>By status</h4><div class="table-wrap"><table><thead><tr><th>Status</th><th>Count</th></tr></thead><tbody>`
      + s.byStatus.map(r =>
          `<tr><td>${ui.escapeHtml(r.status)}</td><td>${ui.escapeHtml(r.count)}</td></tr>`).join('')
      + `</tbody></table></div>`
    : '';

  const eventTable = (s.eventCounts && s.eventCounts.length)
    ? `<h4>Audit-trail activity</h4><div class="table-wrap"><table><thead><tr><th>Event</th><th>Count</th></tr></thead><tbody>`
      + s.eventCounts.map(r =>
          `<tr><td>${ui.escapeHtml(EVENT_LABELS[r.kind] || r.kind)}</td><td>${ui.escapeHtml(r.count)}</td></tr>`).join('')
      + `</tbody></table></div>`
    : '';

  const recent = (s.recentEvents && s.recentEvents.length)
    ? `<h4>Recent events</h4><div class="table-wrap"><table><thead><tr>`
      + `<th>When</th><th>Incident</th><th>Event</th><th>Branch</th></tr></thead><tbody>`
      + s.recentEvents.map(e =>
          `<tr><td><code>${ui.escapeHtml(e.createdAt)}</code></td>`
          + `<td>${ui.escapeHtml(e.incidentId)}</td>`
          + `<td>${ui.escapeHtml(EVENT_LABELS[e.eventKind] || e.eventKind)}</td>`
          + `<td>${ui.escapeHtml(e.branch)}</td></tr>`).join('')
      + `</tbody></table></div>`
    : '';

  return summary + statusTable + eventTable + recent;
}
