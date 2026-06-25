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

  const vm = n.verifyMeta || { live: false };
  const banner = vm.live
    ? `<p class="summary">🟢 <strong>Live-verified</strong> from <code>${ui.escapeHtml(vm.url)}</code> · states ${ui.escapeHtml((vm.states || []).join(', '))} · ${ui.escapeHtml(vm.generatedAt)}</p>`
    : `<p class="summary">⚪ <strong>Static</strong> — run <code>nav-audit --verify &lt;url&gt;</code> for authoritative layer verdicts (pass/misplaced/missing)${vm.reason ? ` · ${ui.escapeHtml(vm.reason)}` : ''}.</p>`;

  const scorecard = n.scorecard.length
    ? banner + `<h4>Per-persona reachability</h4><div class="table-wrap"><table>`
      + `<thead><tr><th>Persona</th><th>Intent</th><th>Destination</th><th>Expected anchor</th><th>Observed anchor</th><th>Status</th></tr></thead><tbody>`
      + n.scorecard.map((r) => {
          // Handle live verdicts (pass/misplaced/missing) + static (ok/red/
          // unverified/unknown). A missed status must NOT silently render green.
          const LABEL = {
            pass: ['🟢', 'in required layer'], ok: ['🟢', 'reachable'],
            missing: ['🔴', 'not in live nav'], red: ['🔴', 'out of primary nav'],
            misplaced: ['🟡', 'live, wrong layer'], unverified: ['🟡', 'unverified — run --verify'],
            unknown: ['🟡', 'unknown'],
          };
          const [icon, text] = LABEL[r.status] || ['⚪', r.status || '—'];
          const status = `<td><span aria-label="${ui.escapeHtml(text)}" title="${ui.escapeHtml(text)}">${icon} ${ui.escapeHtml(text)}</span></td>`;
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
