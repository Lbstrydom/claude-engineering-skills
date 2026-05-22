/**
 * @fileoverview Process Flows tab — renders the skill-chain hand-off graph
 * inline (each step shows the targets it hands off to).
 *
 * Plan: docs/plans/sustainability-cleanup-batch.md (WS2).
 *
 * Signature: `default({src, flows}, ui) → string`.
 *
 * @module scripts/lib/dashboard/sections/flows
 */

const SECTION = 'flows';

export default function sectionFlows({ src, flows }, ui) {
  if (ui.NON_OK.has(src.status)) return ui.warningPanel(SECTION, src);
  if (!flows || !flows.nodes.length) {
    return ui.emptyPanel(null, 'Flow data unavailable (flows.json absent).');
  }
  // `missing-optional` here (flows present, but skill refs not cross-checked
  // because the skills source failed) is a real degraded state — surface it.
  const caveat = src.status === 'missing-optional' && src.detail
    ? `<p class="section-note"><span class="status-dot status-warn"></span>${ui.escapeHtml(src.detail)}</p>`
    : '';
  // Connected flow: each node box, then a down-arrow to every node it hands
  // off to (so branches and the cycle orchestrator are visible inline) —
  // not a separate node-list + edge-list.
  const byId = new Map(flows.nodes.map((n) => [n.id, n]));
  const steps = flows.nodes.map((n) => {
    const outs = flows.edges.filter((e) => e.from === n.id);
    const arrows = outs.map((e) => {
      const tgt = byId.get(e.to);
      const lbl = e.label ? ` <span class="flow-edge-label">${ui.escapeHtml(e.label)}</span>` : '';
      return `<div class="flow-arrow">&darr;&ensp;<code>/${ui.escapeHtml(tgt ? tgt.skill : e.to)}</code>${lbl}</div>`;
    }).join('');
    return `<div class="flow-step">
      <div class="flow-node"><span class="flow-skill">/${ui.escapeHtml(n.skill)}</span> &mdash; ${ui.escapeHtml(n.label)}</div>
      ${arrows}
    </div>`;
  }).join('');
  return `${caveat}<p class="section-note">Skill-chain process flow — each step shows what it hands off to.</p>
    <div class="flow">${steps}</div>`;
}
