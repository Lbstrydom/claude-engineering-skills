/**
 * @fileoverview Convergence tab — rounds-to-pass for code and plan audits (item 8d).
 *
 * Signature: `default({src, convergence}, ui) → string`.
 * Plan: docs/plans/audit-convergence-metrics.md. Every share sits beside its counts;
 * an unmeasured group says so and never renders as 0%.
 *
 * @module scripts/lib/dashboard/sections/convergence
 */

const SECTION = 'convergence';

const pct = (x) => (x == null ? 'n/a' : `${(x * 100).toFixed(1)}%`);

export default function sectionConvergence({ src, convergence }, ui) {
  if (ui.NON_OK.has(src.status)) return ui.warningPanel(SECTION, src);
  if (src.status === 'missing-optional') {
    return ui.emptyPanel(null, src.detail || 'Convergence metrics unavailable.');
  }
  const c = convergence;
  if (!c || !c.cloud || !c.rows.length) {
    return ui.emptyPanel(null, 'No audited sessions in the window yet.');
  }
  const body = c.rows.map((r) => {
    const label = `${ui.escapeHtml(r.mode)} · ${ui.escapeHtml(r.repo)}`;
    if (r.status !== 'measured') {
      return `<tr><td>${label}</td><td colspan="5" class="muted">Unmeasured — ${ui.escapeHtml(r.reason || '')} (${ui.escapeHtml(r.sessions)} sessions)</td>
        <td class="muted">${ui.escapeHtml(r.unpassedSettled)} (+${ui.escapeHtml(r.unpassedOpen)} open, ${ui.escapeHtml(r.unknownOutcome)} unknown) · pass rate ${ui.escapeHtml(pct(r.passRate))}</td></tr>`;
    }
    return `<tr>
      <td>${label}</td>
      <td>${ui.escapeHtml(r.passed)}</td>
      <td>${ui.escapeHtml(pct(r.passedFirstRoundShare))}</td>
      <td>${ui.escapeHtml(pct(r.fiveOrMoreShare))}</td>
      <td>${ui.escapeHtml(r.meanRoundsToPass)}</td>
      <td>${ui.escapeHtml(r.medianRoundsToPass)}</td>
      <td class="muted">${ui.escapeHtml(r.unpassedSettled)} (+${ui.escapeHtml(r.unpassedOpen)} open, ${ui.escapeHtml(r.unknownOutcome)} unknown) · pass rate ${ui.escapeHtml(pct(r.passRate))}</td>
    </tr>`;
  }).join('');
  const e = c.excluded;
  return `<p class="muted">Last ${ui.escapeHtml(c.windowDays)} days, as of ${ui.escapeHtml(c.asOf)}. A change is a session of audit rounds; it
    passes at the first round that met the gate. Shares are over <strong>passed</strong> sessions, shown beside the sessions that never passed.</p>
    <div class="table-wrap"><table><thead><tr><th>Audit · repo</th><th>Passed</th><th>Passed at round 1</th><th>Needed 5+ rounds</th><th>Mean rounds</th><th>Median</th><th>Never passed</th></tr></thead>
    <tbody>${body}</tbody></table></div>
    <p class="muted">Excluded, not dropped: ${ui.escapeHtml(e.experimentRows)} experiment rows, ${ui.escapeHtml(e.notFinalisedRows)} unfinalised rows,
    ${ui.escapeHtml(e.truncatedHeadSessions)} sessions cut by the fetch start, ${ui.escapeHtml(e.outsideWindowSessions)} sessions outside the window.</p>`;
}
