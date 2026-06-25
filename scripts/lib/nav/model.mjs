/**
 * @fileoverview Build the nav MODEL from extracted edges (plan §2.3, §4a.C).
 *
 * Core jobs:
 *   1. Attribute each edge to ALL its declared-anchor ANCESTORS via the component
 *      render-containment graph (NOT exact entryPoint match — real nav composes:
 *      PrimarySidebar → NavGroup → NavItem → <a>; Gemini-1-H. And a reusable
 *      component can sit under several anchors — audit H8/M18, so we collect every
 *      declared-anchor ancestor, not just the nearest). The import/render graph is
 *      used for *containment attribution*, never as proof a route is linked.
 *   2. Seed destination records from the adapter-discovered route INVENTORY as
 *      well as from inbound edges, so a zero-inbound route still appears and orphan
 *      detection can fire (audit H3/H10).
 *
 * @module scripts/lib/nav/model
 */
import { indexSymbols, enclosingSymbol } from './ast-lite.mjs';

/**
 * @param {object[]} edges - from extract.mjs (anchor:null on input)
 * @param {object} args
 * @param {object|null} args.contract - validated NavContract (for declared anchors/layers)
 * @param {Array<{path: string, content: string}>} [args.sources] - to build render containment
 * @param {Array<{id: string}>} [args.destinations] - adapter-discovered route inventory
 * @returns {{destinations: Map<string, object>, edges: object[], declaredAnchors: Set<string>, layerOfAnchor: Map<string,string>}}
 */
export function buildModel(edges, { contract = null, sources = [], destinations: inventory = [] } = {}) {
  const layerOfAnchor = new Map();
  const declaredAnchors = new Set();
  const navLayers = contract?.navLayers ?? {};
  for (const [layer, anchors] of Object.entries(navLayers)) {
    for (const a of anchors) { declaredAnchors.add(a); layerOfAnchor.set(a, layer); }
  }

  const reverseContainment = buildReverseContainment(sources);

  // Attribute anchors: ALL declared ancestors (not just nearest), with the
  // nearest recorded on the edge for display + a depth-based confidence decay.
  const attributed = edges.map((e) => {
    const { anchors, nearest, depth } = declaredAncestors(e.entryPoint, declaredAnchors, reverseContainment);
    let confidence = e.confidence;
    if (nearest && depth >= 2 && confidence === 'high') confidence = 'medium';
    return { ...e, anchor: nearest ?? null, anchorAncestors: anchors, layer: nearest ? (layerOfAnchor.get(nearest) ?? e.layer) : e.layer, confidence };
  });

  const destinations = new Map();
  const ensure = (id) => {
    if (!destinations.has(id)) {
      destinations.set(id, { id, inDegree: 0, affordanceTypes: new Set(), anchors: new Set(), layers: new Set(), labels: new Set(), edges: [], discovered: false });
    }
    return destinations.get(id);
  };

  // Seed every discovered route so zero-inbound routes are present (orphan domain).
  for (const d of inventory) {
    if (d && typeof d.id === 'string') ensure(d.id).discovered = true;
  }

  for (const e of attributed) {
    const d = ensure(e.destination);
    d.inDegree++;
    d.affordanceTypes.add(e.affordanceType);
    for (const a of e.anchorAncestors) { d.anchors.add(a); d.layers.add(layerOfAnchor.get(a) ?? e.layer); }
    if (!e.anchorAncestors.length) d.layers.add(e.layer);
    if (e.label) d.labels.add(e.label);
    d.edges.push(e);
  }

  return { destinations, edges: attributed, declaredAnchors, layerOfAnchor };
}

/** child→parents containment: a parent "renders" a child when the child's JSX tag
 *  appears inside the parent's body (approximated by enclosing top-level symbol). */
function buildReverseContainment(sources) {
  const reverse = new Map();
  for (const s of sources) {
    const symbols = indexSymbols(s.content);
    const usageRe = /<([A-Z][A-Za-z0-9_]*)\b/g;
    let m;
    while ((m = usageRe.exec(s.content)) !== null) {
      const child = m[1];
      const parent = enclosingSymbol(symbols, m.index);
      if (!parent || parent === child) continue;
      if (!reverse.has(child)) reverse.set(child, new Set());
      reverse.get(child).add(parent);
    }
  }
  return reverse;
}

/** BFS up the containment graph collecting EVERY declared-anchor ancestor, plus
 *  the nearest one and its depth. */
function declaredAncestors(start, declaredAnchors, reverseContainment) {
  if (!start) return { anchors: [], nearest: null, depth: -1 };
  if (declaredAnchors.has(start)) return { anchors: [start], nearest: start, depth: 0 };
  const anchors = new Set();
  let nearest = null;
  let nearestDepth = -1;
  const seen = new Set([start]);
  let frontier = [start];
  let depth = 0;
  while (frontier.length && depth < 12) {
    depth++;
    const next = [];
    for (const node of frontier) {
      for (const parent of reverseContainment.get(node) ?? []) {
        if (seen.has(parent)) continue;
        seen.add(parent);
        if (declaredAnchors.has(parent)) {
          anchors.add(parent);
          if (nearest === null) { nearest = parent; nearestDepth = depth; }
        }
        next.push(parent);
      }
    }
    frontier = next;
  }
  return { anchors: [...anchors], nearest, depth: nearestDepth };
}
