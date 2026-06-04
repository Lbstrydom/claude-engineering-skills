/**
 * @fileoverview Audit Runs telemetry tab — cloud + local pass stats with
 * a degraded-mode data-preservation rule (cloud error never discards
 * local fallback rows). Cloud query is per-repo when the cwd resolves to a
 * canonical audit_repos row (`scope==='repo'`), else project-wide.
 *
 * Plan: docs/plans/sustainability-cleanup-batch.md (WS2).
 *
 * Signature: `default({src, auditRuns}, ui) → string`.
 *
 * @module scripts/lib/dashboard/sections/audit-runs
 */

const SECTION = 'auditRuns';

export default function sectionAuditRuns({ src, auditRuns }, ui) {
  const a = auditRuns;
  // A non-ok status gets a warning panel — but it is a PREFIX, not an
  // early return: a cloud failure still leaves usable local fallback data
  // in `a`, and discarding it would be a degraded-mode data-loss bug.
  const warn = ui.NON_OK.has(src.status) ? ui.warningPanel(SECTION, src) : '';
  const hasData = a.cloud || a.local.total > 0;
  if (!hasData) {
    return warn || ui.emptyPanel('telemetry-empty',
      'No audit data yet — run /audit-code to generate audit telemetry.');
  }
  // The cloud query is scoped to this repo's canonical audit_repos row when
  // one resolves (`scope==='repo'`); otherwise it falls back to the
  // project-wide query. Labelled honestly so the user knows which they see.
  const cloudLabel = a.scope === 'repo' ? 'Supabase (this repo)' : 'Supabase (project-wide)';
  let out = warn + `<p class="section-note">${a.cloud ? cloudLabel : 'local-only'} · `
    + `${ui.escapeHtml(a.runCount)} runs · ${ui.escapeHtml(a.labeledCount)} labeled</p>`;
  if (a.passes.length) {
    const rows = a.passes.map((p) => `<tr>
      <td>${ui.escapeHtml(p.name)}</td><td>${ui.escapeHtml(p.runs)}</td>
      <td>${ui.escapeHtml(p.raised)}</td><td>${ui.escapeHtml(p.accepted)}</td>
      <td>${ui.escapeHtml(p.dismissed)}</td></tr>`).join('');
    out += `<div class="table-wrap"><table><thead><tr><th>Pass</th><th>Runs</th><th>Raised</th>
      <th>Accepted</th><th>Dismissed</th></tr></thead><tbody>${rows}</tbody></table></div>`;
  }
  if (a.local.total) {
    out += `<p class="section-note">Local outcomes: ${ui.escapeHtml(a.local.total)} total, ${ui.escapeHtml(a.local.labeled)} labeled.</p>`;
  }
  // Accepted/Dismissed come from triage labelling. When nothing is labelled
  // those columns are legitimately all-zero — say so rather than letting
  // bare zeros read as a bug.
  if (a.cloud && a.labeledCount === 0) {
    out += `<p class="section-note"><span class="status-dot status-warn"></span>`
      + `Accepted / Dismissed are 0 because no run has been triage-labelled — `
      + `the audit pipeline records findings raised, not their adjudication outcome.</p>`;
  }
  return out;
}
