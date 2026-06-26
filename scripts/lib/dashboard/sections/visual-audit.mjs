/**
 * @fileoverview Visual-audit tab — two panels (plan §3):
 *   1. Contracted-Surface Scorecard (surface → verified/unverified + violation count)
 *   2. Visual Findings (gate-eligible first; severity + node + expected/actual)
 * Plus the static source-coherence diagnostics when no live run exists.
 *
 * Signature: `default({src, visualAudit}, ui) → string`.
 *
 * @module scripts/lib/dashboard/sections/visual-audit
 */

const SECTION = 'visualAudit';
const SEV_ORDER = { P0: 0, P1: 1, P2: 2, P3: 3, info: 4 };

export default function sectionVisualAudit({ src, visualAudit }, ui) {
  if (ui.NON_OK.has(src.status)) return ui.warningPanel(SECTION, src);
  const v = visualAudit || { scorecard: [], findings: [], diagnostics: [] };
  if (src.status === 'missing-optional') {
    return ui.emptyPanel(null, src.detail || 'Visual-audit unavailable — run node scripts/visual-audit.mjs --bootstrap then --verify <url>.');
  }

  const vm = v.verifyMeta || { live: false };
  const banner = vm.live
    ? `<p class="summary">🟢 <strong>Live-verified</strong> from <code>${ui.escapeHtml(vm.url)}</code> · states ${ui.escapeHtml((vm.states || []).join(', '))} · ${ui.escapeHtml(vm.generatedAt)}</p>`
    : `<p class="summary">⚪ <strong>Static</strong> — run <code>visual-audit --verify &lt;url&gt;</code> for paint findings (token/theme/layout/signifier).${vm.reason ? ` · ${ui.escapeHtml(vm.reason)}` : ''}</p>`;

  if (!vm.live) {
    const diags = v.diagnostics || [];
    if (!diags.length) return banner + ui.emptyPanel(null, 'No source-coherence diagnostics. Run --verify for paint findings.');
    return banner + `<h4>Source-coherence diagnostics (report-only)</h4><div class="table-wrap"><table>`
      + `<thead><tr><th>Class</th><th>Detail</th></tr></thead><tbody>`
      + diags.map((d) => `<tr><td><code>${ui.escapeHtml(d.class)}</code></td><td>${ui.escapeHtml(d.detail)}</td></tr>`).join('')
      + `</tbody></table></div>`;
  }

  // Scorecard
  const scorecard = (v.scorecard || []).length
    ? `<h4>Contracted-surface scorecard</h4><div class="table-wrap"><table>`
      + `<thead><tr><th>Surface</th><th>Status</th><th>Violations</th></tr></thead><tbody>`
      + v.scorecard.map((r) => {
          const [icon, text] = r.status === 'unverified' ? ['🟡', 'unverified (stall/empty)'] : r.violations > 0 ? ['🔴', 'violations'] : ['🟢', 'clean'];
          return `<tr><td>${ui.escapeHtml(r.surfaceId)}</td><td><span title="${ui.escapeHtml(text)}">${icon} ${ui.escapeHtml(text)}</span></td><td>${r.violations}</td></tr>`;
        }).join('')
      + `</tbody></table></div>`
    : '';

  // Findings (gate-eligible first, by severity)
  const findings = [...(v.findings || [])].sort((a, b) => (Number(b.gateEligible) - Number(a.gateEligible)) || ((SEV_ORDER[a.severity] ?? 9) - (SEV_ORDER[b.severity] ?? 9)));
  const findingsTable = findings.length
    ? `<h4>Visual findings (${findings.length})</h4><div class="table-wrap"><table>`
      + `<thead><tr><th>Gate</th><th>Sev</th><th>Class</th><th>Where</th><th>Expected → Actual</th></tr></thead><tbody>`
      + findings.slice(0, 200).map((f) => {
          const where = ui.escapeHtml([f.surfaceId, f.nodeKey, f.device, f.theme].filter(Boolean).join('/'));
          const ea = ui.escapeHtml(`${f.expected ?? '—'} → ${f.actual ?? '—'}`);
          return `<tr><td>${f.gateEligible ? '⛔' : '·'}</td><td>${ui.escapeHtml(f.severity)}</td><td><code>${ui.escapeHtml(f.class)}</code></td><td>${where}</td><td>${ea}</td></tr>`;
        }).join('')
      + `</tbody></table></div>`
    : ui.emptyPanel(null, 'No visual findings on the contracted surfaces. 🟢');

  return banner + scorecard + findingsTable;
}
