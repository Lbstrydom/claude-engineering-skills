/**
 * @fileoverview Persona Tests telemetry tab — WS3 of
 * docs/completed/persona-nav-feedback-recovery.md. Turns WS1's correlator
 * output into a visible surface and shows session staleness honestly
 * ("latest session: N days ago" — the exact signal a 7-week testing gap
 * would have caught).
 *
 * Signature: `default({src, personaTests}, ui) → string`.
 *
 * @module scripts/lib/dashboard/sections/persona-tests
 */

/** Returns null (never NaN) for an absent/invalid timestamp — code-audit L1 fix: an
 * unparseable ISO string must render "unknown", not the fabricated "NaN days ago". */
function daysAgo(iso) {
  if (!iso) return null;
  const parsed = new Date(iso).getTime();
  if (!Number.isFinite(parsed)) return null;
  return Math.max(0, Math.floor((Date.now() - parsed) / 86400000));
}

// Test seam (matches this repo's underscore-prefix convention for exposing
// an internal helper directly — see anthropic-client.mjs's `_internals`).
export const _daysAgoForTests = daysAgo;

export default function sectionPersonaTests({ src, personaTests }, ui) {
  if (ui.NON_OK.has(src.status)) return ui.warningPanel('personaTests', src);
  const p = personaTests;
  if (src.status === 'missing-optional') {
    return ui.emptyPanel(null, src.detail || 'Persona-test telemetry unavailable.');
  }
  // Defensive shape check (code-audit M1 fix) — a malformed/partial telemetry
  // object must degrade to the warning panel, never throw while rendering.
  if (!p || !p.cloud || !Array.isArray(p.latestByPersona) || !Array.isArray(p.trend) || !p.correlations || !Array.isArray(p.correlations.byType)) {
    if (p && p.cloud) {
      return ui.warningPanel('personaTests', { status: 'unexpected-error', detail: 'persona-tests telemetry shape is malformed' });
    }
    return ui.emptyPanel(null, 'No persona sessions recorded yet.');
  }
  if (p.latestByPersona.length === 0) {
    return ui.emptyPanel(null, 'No persona sessions recorded yet.');
  }

  const cards = p.latestByPersona.map((s) => {
    const age = daysAgo(s.createdAt);
    return `<div class="card">
      <strong>${ui.escapeHtml(s.persona)}</strong>
      <div>${ui.escapeHtml(s.verdict)} — P0: ${ui.escapeHtml(s.p0Count)}, P1: ${ui.escapeHtml(s.p1Count)}</div>
      <div class="muted">latest session: ${age === null ? 'unknown' : `${age} day${age === 1 ? '' : 's'} ago`}</div>
    </div>`;
  }).join('');

  const trendRows = p.trend.map((s) => `<tr>
    <td>${ui.escapeHtml(s.persona)}</td>
    <td>${ui.escapeHtml(s.verdict)}</td>
    <td>${ui.escapeHtml(s.p0Count)}</td>
    <td>${ui.escapeHtml(s.p1Count)}</td>
    <td class="muted">${ui.escapeHtml(s.createdAt)}</td>
  </tr>`).join('');

  const correlationLine = p.correlations.total === 0
    ? '<p class="muted">Correlation loop has not fired yet — no persona↔audit correlations recorded.</p>'
    : `<p>${ui.escapeHtml(p.correlations.total)} total correlations: ${
        p.correlations.byType.map((t) => `${ui.escapeHtml(t.type)} (${ui.escapeHtml(t.count)})`).join(', ')
      }</p>`;

  return `<div class="cards">${cards}</div>
    <h3>Correlation loop health</h3>
    ${correlationLine}
    <h3>Recent sessions (last ${p.trend.length})</h3>
    <div class="table-wrap"><table><thead><tr><th>Persona</th><th>Verdict</th><th>P0</th><th>P1</th><th>When</th></tr></thead>
    <tbody>${trendRows}</tbody></table></div>`;
}
