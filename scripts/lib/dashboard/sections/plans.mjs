/**
 * @fileoverview Plans tab — Active + Completed grouped lists with status
 * suffix in the collapsed summary.
 *
 * Plan: docs/plans/sustainability-cleanup-batch.md (WS2).
 *
 * Signature: `default({src, plans}, ui) → string`.
 *   plans = { active, completed }
 *
 * @module scripts/lib/dashboard/sections/plans
 */

const SECTION = 'plans';

function planList(plans, ui) {
  if (!plans.length) return '<p class="empty">None.</p>';
  return plans.map((p) => {
    // The collapsed summary shows only the status's first clause — some
    // plan files carry a whole paragraph in their `Status:` line; the full
    // text stays available in the expanded body.
    const shortStatus = p.status ? p.status.split(/\s+[—–-]\s+|\s*\(/)[0].trim() : '';
    const statusBled = p.status && shortStatus !== p.status.trim();
    return `<details class="row">
    <summary><strong>${ui.escapeHtml(p.title)}</strong>${shortStatus ? ` &mdash; ${ui.escapeHtml(shortStatus)}` : ''}</summary>
    <div>${p.date ? `Date: ${ui.escapeHtml(p.date)}<br>` : ''}${statusBled ? `Status: ${ui.escapeHtml(p.status)}<br>` : ''}<code>${ui.escapeHtml(p.path)}</code>${p.malformed ? ' <span class="lock">(metadata unparsed)</span>' : ''}</div>
  </details>`;
  }).join('');
}

export default function sectionPlans({ src, plans }, ui) {
  const { active, completed } = plans;
  // A non-ok status (e.g. one plan file failed to read) gets a warning
  // PREFIX — but any plans that WERE discovered are still rendered;
  // discarding them would be a degraded-mode data-loss bug.
  const warn = ui.NON_OK.has(src.status) ? ui.warningPanel(SECTION, src) : '';
  if (!active.length && !completed.length) {
    return warn || ui.emptyPanel(null, 'No plans found.');
  }
  return `${warn}<h3>Active (${active.length})</h3>${planList(active, ui)}
    <h3>Completed (${completed.length})</h3>${planList(completed, ui)}`;
}
