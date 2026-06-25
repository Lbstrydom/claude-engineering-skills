/**
 * @fileoverview Nav-audit tab — the two panels from plan §3:
 *   1. Per-Persona Reachability Scorecard (persona → intent → expected vs
 *      observed anchor; RED when a high-value intent drops out of primary nav).
 *   2. Nav Drift — aged advisory divergences (orphans etc.), >14 days = smell.
 *
 * The full node-edge graph is deliberately NOT rendered here (200-route hairball,
 * plan §3) — it lives in the CLI mermaid drilldown.
 *
 * Signature: `default({src, navAudit}, ui) → string`.
 *
 * @module scripts/lib/dashboard/sections/nav-audit
 */

const SECTION = 'navAudit';

export default function sectionNavAudit({ src, navAudit }, ui) {
  if (ui.NON_OK.has(src.status)) return ui.warningPanel(SECTION, src);
  const n = navAudit || { scorecard: [], drift: [] };
  if (src.status === 'missing-optional') {
    return ui.emptyPanel(null, src.detail || 'Nav-audit unavailable — run node scripts/nav-audit.mjs --bootstrap then /nav-audit.');
  }
  if (!n.scorecard.length && !n.drift.length) {
    return ui.emptyPanel(null, 'No declared persona intents or divergences yet.');
  }

  const scorecard = n.scorecard.length
    ? `<h4>Per-persona reachability</h4><div class="table-wrap"><table>`
      + `<thead><tr><th>Persona</th><th>Intent</th><th>Destination</th><th>Expected anchor</th><th>Observed anchor</th><th>Status</th></tr></thead><tbody>`
      + n.scorecard.map((r) => {
          const status = r.status === 'red'
            ? `<td><span aria-label="out of primary nav" title="out of primary nav">🔴 buried</span></td>`
            : `<td><span aria-label="reachable">🟢 ok</span></td>`;
          const src2 = r.source === 'inferred' ? ' <em>(inferred)</em>' : '';
          return `<tr><td>${ui.escapeHtml(r.persona)}</td><td>${ui.escapeHtml(r.intent)}${src2}</td>`
            + `<td><code>${ui.escapeHtml(r.destination)}</code></td>`
            + `<td>${ui.escapeHtml((r.expectedAnchors || []).join(', ') || '—')}</td>`
            + `<td>${ui.escapeHtml((r.observedAnchors || []).join(', ') || '—')}</td>${status}</tr>`;
        }).join('')
      + `</tbody></table></div>`
    : '';

  const drift = n.drift.length
    ? `<h4>Nav drift (advisory)</h4><div class="table-wrap"><table>`
      + `<thead><tr><th>Class</th><th>Destination</th><th>Severity</th><th>Age (days)</th><th>Verdict</th></tr></thead><tbody>`
      + n.drift.map((d) => {
          const aged = (d.ageDays ?? 0) > 14 ? ` title="aged >14d — governance smell"` : '';
          return `<tr${aged}><td>${ui.escapeHtml(d.class)}</td><td><code>${ui.escapeHtml(d.destination)}</code></td>`
            + `<td>${ui.escapeHtml(d.severity)}</td><td>${ui.escapeHtml(d.ageDays ?? 0)}</td>`
            + `<td>${ui.escapeHtml(d.verdict || '')}</td></tr>`;
        }).join('')
      + `</tbody></table></div>`
    : '<p class="summary">No drift — observed matches intent.</p>';

  return scorecard + drift;
}
