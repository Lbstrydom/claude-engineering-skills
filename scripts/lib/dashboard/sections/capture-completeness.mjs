/**
 * @fileoverview Capture Completeness tab: the own-model capture-loss reconciliation over the last 7 days
 * (docs/plans/own-model-full-capture.md section 2.9, P0). Read-only; `npm run capture:completeness` stays the
 * authoritative CLI and both use the SAME report builder (`lib/capture/report.mjs`), so they cannot disagree.
 * UNMEASURED is never rendered green: an `unmeasured:*` or `partial:*` group, or zero judgeable starts, is a
 * warning row, not an ok one.
 * Signature: `default({src, captureCompleteness}, ui) → string`.
 *
 * @module scripts/lib/dashboard/sections/capture-completeness
 */

const SECTION = 'captureCompleteness';

/** PURE. The css class for a group status: only a bare `ok` is ok. */
export function statusClass(status) {
  if (status === 'ok') return 'ok';
  return /^(unmeasured|partial)/.test(String(status)) ? 'muted' : 'warn';
}

export default function sectionCaptureCompleteness({ src, captureCompleteness }, ui) {
  if (ui.NON_OK.has(src.status)) return ui.warningPanel(SECTION, src);
  const c = captureCompleteness;
  if (src.status === 'missing-optional' || !c || !c.cloud) {
    return ui.emptyPanel(null, 'No capture-completeness data: this needs the cloud store (and its migrations). Run npm run capture:completeness once it is reachable.');
  }
  const verdict = c.exitCode === 0
    ? { cls: 'ok', msg: `Measured and no gap over ${c.windowDays} days.` }
    : c.exitCode === 3
      ? { cls: 'muted', msg: `UNMEASURED over ${c.windowDays} days (exit 3): zero judgeable starts, or a group that cannot be reconciled. This is not a pass.` }
      : { cls: 'warn', msg: `A measured capture gap over ${c.windowDays} days (exit 1).` };
  const rows = c.groups.length
    ? c.groups.map((g) => `<tr><td>${ui.escapeHtml(g.section)}</td><td>${ui.escapeHtml(g.repo)}</td><td class="${statusClass(g.status)}">${ui.escapeHtml(g.status)}</td><td>${ui.escapeHtml(g.detail)}</td></tr>`).join('')
    : '<tr><td colspan="4" class="muted">No starts in the window: unmeasured, not zero loss.</td></tr>';
  return `
    <h2>Capture completeness</h2>
    <p class="${verdict.cls}">${ui.escapeHtml(verdict.msg)}</p>
    <p class="muted">Cost reconciliation: ${ui.escapeHtml(c.cost)}. Schema v${ui.escapeHtml(c.captureSchemaVersion)}.</p>
    <table><thead><tr><th>Source</th><th>Repo</th><th>Status</th><th>Detail</th></tr></thead><tbody>${rows}</tbody></table>
    <p class="muted">Authoritative CLI: <code>npm run capture:completeness</code>.</p>`;
}
