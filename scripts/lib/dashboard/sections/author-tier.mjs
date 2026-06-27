/**
 * @fileoverview Author-Tier tab — model-tier-observation telemetry (read-only).
 *
 * Shows the heuristic's suggested tier vs convergence, the declared author-model
 * ladders (the cross-model-bias partition key), and the diversity gate the
 * deferred routing phase waits on. Signature: `default({src, authorTier}, ui) → string`.
 * Plan: docs/completed/model-tier-observation.md.
 *
 * @module scripts/lib/dashboard/sections/author-tier
 */

const SECTION = 'authorTier';

export default function sectionAuthorTier({ src, authorTier }, ui) {
  if (ui.NON_OK.has(src.status)) return ui.warningPanel(SECTION, src);
  const a = authorTier;
  if (src.status === 'missing-optional') {
    return ui.emptyPanel(null, src.detail || 'Author-tier telemetry unavailable.');
  }
  if (!a || !a.cloud || !a.total) {
    return ui.emptyPanel(null, 'No author_tier observations recorded yet. Set AUDIT_AUTHOR_TIER_HINT and run an audit.');
  }

  const tierRows = a.bySuggestedTier
    .map((t) => `<tr>
      <td>${ui.escapeHtml(t.tier)}</td>
      <td>${ui.escapeHtml(t.total)}</td>
      <td>${ui.escapeHtml(t.converged)}</td>
      <td>${ui.escapeHtml(t.convergedPct)}%</td>
    </tr>`)
    .join('');

  const ladderRows = a.ladders.length
    ? a.ladders
      .map((l) => `<tr>
        <td>${ui.escapeHtml(l.provider)}</td>
        <td>${ui.escapeHtml(l.family)}</td>
        <td><code>${ui.escapeHtml(l.model)}</code></td>
        <td>${ui.escapeHtml(l.count)}</td>
      </tr>`)
      .join('')
    : `<tr><td colspan="4" class="muted">No declared author models yet — set AUDIT_AUTHOR_TIER_HINT to a concrete model id (e.g. claude-opus-4-8) to populate the ladder partition key.</td></tr>`;

  const gate = a.diversityGateMet
    ? `<span class="ok">met</span>`
    : `<span class="muted">not met</span>`;
  const ag = a.agreement;

  return `<p class="muted">Observation-only — nothing routes on this. The future routing phase is gated on ladder
    <strong>diversity</strong> (≥3 provider ladders), not sample count. Per-repo view.</p>
    <div class="kv">
      <div><span class="muted">Observations</span> <strong>${ui.escapeHtml(a.total)}</strong></div>
      <div><span class="muted">Distinct provider ladders</span> <strong>${ui.escapeHtml(a.distinctProviderLadders)}</strong></div>
      <div><span class="muted">Diversity gate</span> ${gate}</div>
      <div><span class="muted">Suggested vs declared</span> ${ui.escapeHtml(ag.agree)} agree / ${ui.escapeHtml(ag.disagree)} disagree / ${ui.escapeHtml(ag.declaredUnknown)} unknown</div>
    </div>
    <h3>Suggested tier × convergence</h3>
    <div class="table-wrap"><table><thead><tr><th>Suggested tier</th><th>Observations</th><th>Converged</th><th>Converged %</th></tr></thead>
    <tbody>${tierRows}</tbody></table></div>
    <h3>Declared author ladders (partition key)</h3>
    <div class="table-wrap"><table><thead><tr><th>Provider</th><th>Family</th><th>Model</th><th>Observations</th></tr></thead>
    <tbody>${ladderRows}</tbody></table></div>`;
}
