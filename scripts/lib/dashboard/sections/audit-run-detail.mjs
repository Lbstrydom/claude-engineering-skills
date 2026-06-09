/**
 * @fileoverview Audit-run findings detail section
 * (docs/plans/dashboard-audit-run-viewer.md). Renders one run's findings as a
 * severity-banded, filterable table with collapsible evidence. Read-only —
 * filters/collapse are client-side over server-rendered rows (the filter JS
 * lives in the browser bundle, guarded by the `data-dashboard-kind` root this
 * section sets — M3). All raw text goes through `ui.escapeHtml`; CSS bands and
 * `data-*` filter keys come ONLY from the presenter's closed-enum tokens, never
 * from raw DB values (H3). `primary_file` is arbitrary text → it lives in the
 * escaped file cell's textContent, never in a `data-*` attribute.
 *
 * Signature: `default({ src, auditRun }, ui) → string`.
 *
 * @module scripts/lib/dashboard/sections/audit-run-detail
 */

const SECTION = 'auditRunDetail';

/** Run header — metadata line(s). `meta` may be null (degraded states). */
function runHeader(runId, meta, ui) {
  const heading = `<h2 class="audit-run-title">Audit run <code>${ui.escapeHtml(runId)}</code></h2>`;
  if (!meta) return heading;
  const bits = [];
  if (meta.mode) bits.push(`mode ${ui.escapeHtml(meta.mode)}`);
  if (meta.rounds != null) bits.push(`${ui.escapeHtml(meta.rounds)} rounds`);
  if (meta.geminiVerdict) bits.push(`Gemini ${ui.escapeHtml(meta.geminiVerdict)}`);
  if (meta.totalFindings != null) bits.push(`${ui.escapeHtml(meta.totalFindings)} findings`);
  if (meta.commitSha) bits.push(`commit <code>${ui.escapeHtml(meta.commitSha)}</code>`);
  const sub = bits.length ? `<p class="section-note">${bits.join(' · ')}</p>` : '';
  const plan = meta.planFile ? `<p class="section-note">plan: ${ui.escapeHtml(meta.planFile)}</p>` : '';
  return heading + sub + plan;
}

function chip(group, value, label, ui) {
  return `<button type="button" class="filter-chip" data-filter-group="${ui.escapeHtml(group)}" `
    + `data-filter-value="${ui.escapeHtml(value)}" aria-pressed="false">${ui.escapeHtml(label)}</button>`;
}

function filterBar(findings, ui) {
  // Distinct closed tokens actually present (so we never render a dead chip).
  const sevOrder = ['HIGH', 'MEDIUM', 'LOW'];
  const sevs = sevOrder.filter((s) => findings.some((f) => f.sevToken === s));
  const passSeen = new Map();   // passToken → passLabel (first seen)
  const statusSeen = new Map(); // statusToken → statusLabel (first seen)
  for (const f of findings) {
    if (!passSeen.has(f.passToken)) passSeen.set(f.passToken, f.passLabel);
    if (!statusSeen.has(f.statusToken)) statusSeen.set(f.statusToken, f.statusLabel);
  }
  const sevChips = sevs.map((s) => chip('severity', s, s, ui)).join('');
  const passChips = [...passSeen].map(([tok, label]) => chip('pass', tok, label, ui)).join('');
  const statusChips = [...statusSeen].map(([tok, label]) => chip('status', tok, label, ui)).join('');

  const fileId = 'audit-run-file-filter';
  return `<div class="filter-bar" role="group" aria-label="Filter findings">
    <div class="filter-group"><span class="filter-label">Severity</span>${sevChips}</div>
    <div class="filter-group"><span class="filter-label">Pass</span>${passChips}</div>
    <div class="filter-group"><span class="filter-label">Status</span>${statusChips}</div>
    <div class="filter-group">
      <label for="${fileId}" class="filter-label">File</label>
      <input id="${fileId}" type="search" class="filter-file" data-filter-file placeholder="filter by file…">
    </div>
    <button type="button" class="filter-reset" data-filter-reset>Reset</button>
  </div>
  <p class="filter-nomatch" role="status" data-filter-nomatch hidden>No findings match the current filters.</p>`;
}

function findingRow(f, ui) {
  const summary = (String(f.detail).split('\n')[0] || '').slice(0, 200);
  // data-* keys: closed presenter tokens only. The file is escaped text in the
  // cell (filtered by textContent), never an attribute.
  return `<tr class="finding-row ${f.sevClass}" data-severity="${ui.escapeHtml(f.sevToken)}" `
    + `data-pass="${ui.escapeHtml(f.passToken)}" data-status="${ui.escapeHtml(f.statusToken)}">
    <td class="sev-cell"><span class="sev-badge ${f.sevClass}">${ui.escapeHtml(f.sevLabel)}</span></td>
    <td class="pass-cell">${ui.escapeHtml(f.passLabel)}</td>
    <td class="file-cell" data-filter-file-cell>${ui.escapeHtml(f.fileLabel)}</td>
    <td class="status-cell">${ui.escapeHtml(f.statusLabel)}</td>
    <td class="detail-cell">
      <div class="finding-summary">${ui.escapeHtml(summary)}</div>
      <details>
        <summary>Show evidence</summary>
        <div class="evidence">
          <p class="evidence-meta">${ui.escapeHtml(f.category)} · round ${ui.escapeHtml(f.round ?? '—')} · `
    + `<code>${ui.escapeHtml(f.fingerprint)}</code></p>
          <pre class="evidence-detail">${ui.escapeHtml(f.detail)}</pre>
        </div>
      </details>
    </td>
  </tr>`;
}

function findingsTable(findings, ui) {
  const rows = findings.map((f) => findingRow(f, ui)).join('');
  return `<div class="table-wrap"><table class="findings-table">
    <thead><tr>
      <th scope="col">Severity</th><th scope="col">Pass</th><th scope="col">File</th>
      <th scope="col">Status</th><th scope="col">Finding</th>
    </tr></thead>
    <tbody>${rows}</tbody>
  </table></div>`;
}

export default function sectionAuditRunDetail({ src, auditRun }, ui) {
  const status = src?.status;
  const runId = auditRun?.runId || '(unknown)';
  const meta = auditRun?.meta || null;
  const findings = auditRun?.findings || [];

  // Id-resolved non-ok states → explicit panels (§5). No data-dashboard-kind
  // root (no filters to wire), so the filter JS no-ops on these pages.
  if (status === 'cloud_disabled') {
    return runHeader(runId, meta, ui) + ui.emptyPanel('audit-run-cloud-disabled',
      'No cloud store — set AUDIT_DB_URL and re-run an audit to view this run’s findings.');
  }
  if (status === 'run_not_found') {
    // NOTE: ui.emptyPanel escapes its message argument internally (see
    // helpers.mjs — `${escapeHtml(msg)}`), so the runId (which may be raw CLI
    // input) is XSS-safe here WITHOUT a manual escapeHtml — adding one would
    // double-escape. The table cells below escape manually only because they
    // interpolate into raw HTML strings the section builds itself. Verified:
    // a runId of `<script>` renders as escaped text, never an executable tag.
    return ui.emptyPanel('audit-run-not-found', `Run ${runId} not found in the store.`);
  }
  if (status === 'query_error') {
    return ui.warningPanel(SECTION, {
      status: 'unexpected-error',
      detail: src.detail || 'Findings query failed (redacted).',
    });
  }

  // status === 'ok'. The root carries data-dashboard-kind="audit-run" so the
  // browser bundle's initAuditRunFilters() wires up exactly this page (M3).
  const wrap = (inner) => `<div data-dashboard-kind="audit-run">${inner}</div>`;

  if (findings.length === 0) {
    const conv = auditRun.convergedAfter;
    const msg = conv != null
      ? `No open findings — run converged after round ${ui.escapeHtml(conv)}.`
      : 'No findings recorded for this run.';
    return wrap(runHeader(runId, meta, ui) + ui.emptyPanel('audit-run-empty', msg));
  }

  return wrap(runHeader(runId, meta, ui) + filterBar(findings, ui) + findingsTable(findings, ui));
}
