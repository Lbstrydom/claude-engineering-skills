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
import { parseSource, walk, componentNameOf } from './ast.mjs';

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

  // Attribute anchors. A pre-set DOM-container anchor (vanilla/template apps,
  // e.g. `#primary-nav`) is honored directly; otherwise attribute ALL declared
  // component ancestors via render-containment (React apps), nearest recorded on
  // the edge with a depth-based confidence decay.
  const attributed = edges.map((e) => {
    if (e.anchor) {
      // DOM anchor already attributed by the extractor.
      return { ...e, anchorAncestors: [e.anchor], layer: layerOfAnchor.get(e.anchor) ?? e.layer };
    }
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

/** child→parents containment, from two sources of truth:
 *  1. JSX composition — a parent "renders" a child when the child's JSX tag
 *     appears inside the parent's body (approximated by enclosing top-level symbol).
 *  2. Lexical nesting — a named closure defined INSIDE a component
 *     (`const renderItem = (d) => <li>…</li>` in `function AppNav`) is part of that
 *     component's render even though it is called imperatively
 *     (`ITEMS.map(renderItem)`) and never appears as a JSX tag. Without this edge
 *     the BFS starting at the closure has nowhere to go, and a correctly-declared
 *     anchor on the enclosing component never attributes. */
function buildReverseContainment(sources) {
  const reverse = new Map();
  const add = (child, parent) => {
    if (!parent || parent === child) return;
    if (!reverse.has(child)) reverse.set(child, new Set());
    reverse.get(child).add(parent);
  };
  for (const s of sources) {
    const symbols = indexSymbols(s.content);
    const usageRe = /<([A-Z][A-Za-z0-9_]*)\b/g;
    let m;
    while ((m = usageRe.exec(s.content)) !== null) add(m[1], enclosingSymbol(symbols, m.index));
    // Named-symbol identity matches extract.mjs's `entryPoint` exactly: both come
    // from the shared walker's `componentNameOf`. A parse failure contributes no
    // lexical edges (extract.mjs already warned about it).
    const { ast } = parseSource(s.content);
    if (ast) {
      walk(ast, (node, c) => {
        const own = componentNameOf(node);
        if (own && c.outer) add(own, c.outer);
      });
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
