/**
 * @fileoverview Purpose Health telemetry tab (dashboard v2 Part 3) — live
 * governance overlay on the purpose taxonomy. Cloud-backed; lives on the
 * TELEMETRY page so the reference Purpose tab stays deterministic.
 *
 * Honesty rule: a repo-wide metric is NEVER painted as per-purpose health. The
 * repo-wide block is the headline; only `preserve-trust-safety` carries a real
 * per-purpose badge in v2 (the rest are `na`/"repo-wide only").
 *
 * Health is conveyed by TEXT label + emoji, not colour alone (WCAG 1.4.1).
 * Signature: `default({src, purposeHealth}, ui) → string`.
 *
 * @module scripts/lib/dashboard/sections/purpose-health
 */

const SECTION = 'purposeHealth';

const BADGE = {
  ok:        { glyph: '🟢', label: 'ok' },
  'at-risk': { glyph: '🟠', label: 'at risk' },
  failing:   { glyph: '🔴', label: 'failing' },
  na:        { glyph: '⚪', label: 'n/a' },
};

export default function sectionPurposeHealth({ src, purposeHealth }, ui) {
  const esc = ui.escapeHtml;
  if (ui.NON_OK.has(src.status)) return ui.warningPanel(SECTION, src);
  const ph = purposeHealth || {};
  if (src.status === 'missing-optional' || !Array.isArray(ph.purposeBadges) || ph.purposeBadges.length === 0) {
    return ui.emptyPanel('purpose-health-empty',
      src.detail || 'Purpose health needs a cloud database connection (AUDIT_DB_URL).');
  }

  const rw = ph.repoWide || {};
  const n = (v) => (v == null ? '—' : esc(v));
  const summary = `<p class="section-note">`
    + `Governance · last ${esc(ph.windowDays)}d · as of <code>${esc(ph.asOf)}</code></p>`
    + `<p class="section-note">`
    + `<strong>${n(rw.recentHighFindings)}</strong> recent HIGH audit finding(s) · `
    + `<strong>${n(rw.plansWithFailingCriteria)}</strong> plan(s) with failing P0/P1 · `
    + `<strong>${n(rw.refusedSecrets)}</strong> refused secret(s)</p>`;

  const rows = ph.purposeBadges.map((b) => {
    const badge = BADGE[b.health] || BADGE.na;
    return `<tr>`
      + `<td>${esc(b.label)}</td>`
      + `<td><span class="health-badge health-${esc(b.health)}">${badge.glyph} ${esc(badge.label)}</span></td>`
      + `<td>${esc(b.reason)}</td></tr>`;
  }).join('');

  const table = `<div class="table-wrap"><table><thead><tr>`
    + `<th>Purpose</th><th>Health</th><th>Why</th></tr></thead><tbody>${rows}</tbody></table></div>`;

  const note = `<p class="section-note section-warn">Per-purpose attribution is repo-wide in v2 — `
    + `only <strong>Preserve trust &amp; safety</strong> is attributed (from refused-secret events). `
    + `The HIGH/failing-plan counts above are repo-wide, not per purpose.</p>`;

  return summary + table + note;
}
