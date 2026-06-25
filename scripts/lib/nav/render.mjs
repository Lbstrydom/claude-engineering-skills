/**
 * @fileoverview Render nav-audit outputs (plan §7): the findings list, the
 * destination×in-degree×affordance×anchor×verdict table, a mermaid flowchart
 * (drilldown render — NOT the headline), and the gitignored edge-list JSON.
 *
 * @module scripts/lib/nav/render
 */
import { OBSERVED_FILE } from './schema.mjs';

const SEV_ORDER = { P0: 0, P1: 1, P2: 2, P3: 3 };

/** Human-readable findings list, sorted by severity then class. */
export function renderFindings(findings) {
  if (!findings.length) return 'No nav findings.';
  const sorted = [...findings].sort((a, b) => (SEV_ORDER[a.severity] - SEV_ORDER[b.severity]) || a.class.localeCompare(b.class));
  const lines = [`NAV FINDINGS (${findings.length})`, '─'.repeat(48)];
  for (const f of sorted) {
    lines.push(`  [${f.severity}] ${f.class} — ${f.destination}${f.gateEligible ? ' (gate-eligible)' : ''}`);
    lines.push(`     ${f.verdict}`);
    if (f.evidence?.length) lines.push(`     evidence: ${f.evidence[0]}`);
    lines.push(`     confidence: ${f.confidence}`);
  }
  return lines.join('\n');
}

/** Destination table: id · in-degree · affordance types · anchors · layers. */
export function renderTable(model) {
  const rows = [...model.destinations.values()].sort((a, b) => b.inDegree - a.inDegree);
  const lines = ['| Destination | In | Affordances | Anchors | Layers |', '|---|---|---|---|---|'];
  for (const d of rows) {
    lines.push(`| ${d.id} | ${d.inDegree} | ${[...d.affordanceTypes].join(', ') || '—'} | ${[...d.anchors].join(', ') || '—'} | ${[...d.layers].join(', ') || '—'} |`);
  }
  return lines.join('\n');
}

/** Mermaid flowchart: one subgraph per nav layer, destinations on the right,
 *  multi-in-degree destinations highlighted. A drilldown render, capped at
 *  MAX_NODES to avoid the 200-route hairball (plan §3). */
export function renderMermaid(model, { maxNodes = 40 } = {}) {
  const dests = [...model.destinations.values()].sort((a, b) => b.inDegree - a.inDegree).slice(0, maxNodes);
  const byLayer = new Map();
  for (const d of dests) {
    for (const layer of (d.layers.size ? d.layers : new Set(['content']))) {
      if (!byLayer.has(layer)) byLayer.set(layer, new Set());
      byLayer.get(layer).add(d);
    }
  }
  const lines = ['```mermaid', 'graph LR'];
  let i = 0;
  const nodeId = new Map();
  for (const [layer, set] of byLayer) {
    lines.push(`  subgraph ${safeId(layer)}["${esc(layer)}"]`);
    for (const d of set) {
      if (!nodeId.has(d.id)) nodeId.set(d.id, `N${i++}`);
      const highlight = d.inDegree >= 2 ? ':::multi' : '';
      lines.push(`    ${nodeId.get(d.id)}["${esc(d.id)} (${d.inDegree})"]${highlight}`);
    }
    lines.push('  end');
  }
  lines.push('  classDef multi fill:#ffd,stroke:#c90;');
  if (dests.length >= maxNodes) lines.push(`  %% capped at ${maxNodes} nodes — see ${OBSERVED_FILE} for the full edge list`);
  lines.push('```');
  return lines.join('\n');
}

function esc(s) {
  return String(s).replace(/"/g, "'").replace(/[\n\r]/g, ' ');
}
function safeId(s) {
  return String(s).replace(/[^A-Za-z0-9_]/g, '_');
}
