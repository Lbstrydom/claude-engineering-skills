/**
 * @fileoverview Requirements telemetry tab — grouped by kind, sorted by
 * actionability within each group.
 *
 * Plan: docs/plans/sustainability-cleanup-batch.md (WS2).
 *
 * Signature: `default({src, requirements}, ui) → string`.
 *
 * @module scripts/lib/dashboard/sections/requirements
 */

const SECTION = 'requirements';

// Most-actionable status first, within each requirement kind.
const REQ_STATUS_ORDER = { active: 0, 'needs-review': 1, 'inferred-only': 2 };

export default function sectionRequirements({ src, requirements }, ui) {
  if (ui.NON_OK.has(src.status)) return ui.warningPanel(SECTION, src);
  const r = requirements;
  if (!r.present) return ui.emptyPanel(null, 'No requirements ledger — run `node scripts/requirements.mjs`.');
  if (r.total === 0) return ui.emptyPanel(null, 'Requirements ledger is empty.');

  // Group invariants by `kind` (behavioural / security / safety / …); within
  // a kind, sort most-actionable status first.
  const byKind = new Map();
  for (const i of r.items) {
    if (!byKind.has(i.kind)) byKind.set(i.kind, []);
    byKind.get(i.kind).push(i);
  }
  const rank = (s) => (s in REQ_STATUS_ORDER ? REQ_STATUS_ORDER[s] : 3);
  const note = r.truncated
    ? `${ui.escapeHtml(r.active)} active of ${ui.escapeHtml(r.total)} invariants — first ${ui.escapeHtml(r.items.length)} shown, grouped by kind.`
    : `${ui.escapeHtml(r.active)} active of ${ui.escapeHtml(r.total)} invariants, grouped by kind.`;
  let out = `<p class="section-note">${note}</p>`;
  for (const kind of [...byKind.keys()].sort()) {
    const items = byKind.get(kind)
      .sort((a, b) => rank(a.status) - rank(b.status) || a.id.localeCompare(b.id));
    const rows = items.map((i) => `<tr>
      <td><code>${ui.escapeHtml(i.id)}</code></td>
      <td>${ui.escapeHtml(i.statement)}</td>
      <td>${ui.escapeHtml(i.status)}</td></tr>`).join('');
    out += `<h3>${ui.escapeHtml(kind)} <span class="kind-count">(${items.length})</span></h3>
      <div class="table-wrap"><table><thead><tr><th>ID</th><th>Statement</th><th>Status</th></tr></thead>
      <tbody>${rows}</tbody></table></div>`;
  }
  return out;
}
