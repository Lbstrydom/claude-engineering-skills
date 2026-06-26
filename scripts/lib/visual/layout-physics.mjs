/**
 * @fileoverview Tier 3 — rendered layout physics (plan §2a TIER 3, Gemini-G3).
 * Pure rect/scroll math over extract.mjs evidence for ONE device×theme:
 *   - layout_overflow   : a node's right edge exceeds the viewport width
 *   - content_clipping  : scrollWidth>clientWidth with no wrap/ellipsis/scroll escape
 *   - unexpected_overlap: two NON-containment nodes' boxes intersect (sweep-line
 *                         over x-intervals; ancestor-descendant pairs excluded —
 *                         a child rect always intersects its parent)
 *   - image_distortion  : rendered aspect ratio ≠ natural, with a distorting object-fit
 *
 * @module scripts/lib/visual/layout-physics
 */

const CLIP_ESCAPE_WRAP = new Set(['break-word', 'anywhere', 'break-all']);
const SAFE_OBJECT_FIT = new Set(['contain', 'cover', 'scale-down']);
// Below this, a box is collapsed/empty (e.g. an unauthenticated empty-state label
// at clientWidth 1px), not clipping readable text — a collapse/visibility concern,
// not text-overflow. `content_clipping` is the wrong class for it, so we don't fire
// (shakedown pass-4 #1). A genuinely-clipping element is always wider than this.
const MIN_CLIP_DIM = 4;

/**
 * @param {object[]} nodes - evidence nodes (one device×theme)
 * @param {object} contract
 * @param {{viewportWidth?:number}} [opts]
 * @returns {object[]} partial findings
 */
export function runLayoutPhysics(nodes, contract, { viewportWidth = null } = {}) {
  const list = (nodes || []).filter((n) => n && n.displayed !== false && n.rect);
  const out = [];

  // ── overflow + clipping + image distortion (per node) ──
  for (const node of list) {
    const { rect, computed = {}, scroll = {} } = node;
    if (viewportWidth != null && rect.x + rect.width > viewportWidth + 1) {
      out.push(mk('unexpected', 'layout_overflow', node, null, `viewport ${viewportWidth}px`, `right edge ${Math.round(rect.x + rect.width)}px`));
    }
    const sw = scroll.scrollWidth;
    const cw = scroll.clientWidth;
    const degenerate = cw < MIN_CLIP_DIM || (rect.height ?? 0) < MIN_CLIP_DIM;
    if (!degenerate && Number.isFinite(sw) && Number.isFinite(cw) && sw > cw + 1) {
      const ellipsis = String(computed['text-overflow'] || '').includes('ellipsis');
      const wrap = CLIP_ESCAPE_WRAP.has(String(computed['overflow-wrap'] || computed['word-break'] || '').trim());
      const scrolls = /(auto|scroll)/.test(String(computed['overflow-x'] || ''));
      if (!ellipsis && !wrap && !scrolls) {
        out.push(mk('clip', 'content_clipping', node, null, 'content fits OR wraps/ellipsis/scrolls', `scrollWidth ${sw}px > clientWidth ${cw}px, no escape`));
      }
    }
    if (node.isImage && node.naturalWidth > 0 && node.naturalHeight > 0 && rect.width > 0 && rect.height > 0) {
      const naturalAR = node.naturalWidth / node.naturalHeight;
      const renderedAR = rect.width / rect.height;
      const fit = String(computed['object-fit'] || 'fill').trim();
      if (!SAFE_OBJECT_FIT.has(fit) && Math.abs(naturalAR - renderedAR) / naturalAR > 0.02) {
        out.push(mk('img', 'image_distortion', node, 'object-fit', `aspect ${naturalAR.toFixed(3)} (natural)`, `aspect ${renderedAR.toFixed(3)} rendered, object-fit:${fit}`));
      }
    }
  }

  // ── overlap (sweep-line over x-intervals, ancestor-descendant excluded) ──
  out.push(...detectOverlaps(list));
  return out;
}

function detectOverlaps(nodes) {
  const out = [];
  const parentOf = new Map();
  const byId = new Map();
  for (const n of nodes) if (n.auditInstanceId) { parentOf.set(n.auditInstanceId, n.parentInstanceId ?? null); byId.set(n.auditInstanceId, n); }

  const isAncestor = (ancId, descId) => {
    let cur = parentOf.get(descId);
    let hops = 0;
    while (cur != null && hops++ < 64) {
      if (cur === ancId) return true;
      cur = parentOf.get(cur);
    }
    return false;
  };

  // The stacking LAYER a node lives in: the nearest fixed/absolute ancestor (or
  // self), else null (the in-flow page). Two nodes in DIFFERENT layers — a static
  // child of a fixed overlay vs the page chrome behind it — overlap by design
  // (shakedown #2), so we don't flag them; same-layer overlaps still fire.
  const layerCache = new Map();
  const layerRoot = (id) => {
    if (layerCache.has(id)) return layerCache.get(id);
    let cur = id;
    let hops = 0;
    let root = null;
    while (cur != null && hops++ < 64) {
      const pos = String((byId.get(cur)?.computed || {}).position || 'static').trim();
      if (pos === 'fixed' || pos === 'absolute') { root = cur; break; }
      cur = parentOf.get(cur);
    }
    // No in-subtree overlay → fall back to the ancestor-derived surfaceLayer (set
    // by extract.mjs when a fixed/absolute ancestor sits ABOVE the contracted root,
    // e.g. a `#auth-screen` overlay containing a static `.auth-card`).
    if (root == null) root = byId.get(id)?.surfaceLayer ?? null;
    layerCache.set(id, root);
    return root;
  };

  // Events sorted by x — a node is "active" between its left and right edge.
  const events = [];
  for (const n of nodes) {
    if (!n.rect || n.rect.width <= 0 || n.rect.height <= 0) continue;
    events.push({ x: n.rect.x, type: 'open', n });
    events.push({ x: n.rect.x + n.rect.width, type: 'close', n });
  }
  events.sort((a, b) => a.x - b.x || (a.type === 'close' ? -1 : 1));

  const active = new Set();
  const seenPair = new Set();
  for (const ev of events) {
    if (ev.type === 'close') { active.delete(ev.n); continue; }
    for (const other of active) {
      if (rectsIntersect(ev.n.rect, other.rect)) {
        const aId = ev.n.auditInstanceId;
        const bId = other.auditInstanceId;
        if (ev.n.overlapAllowed || other.overlapAllowed) continue;
        if (isAncestor(aId, bId) || isAncestor(bId, aId)) continue; // containment, not overlap
        // Different stacking layers (overlay subtree vs page behind) → intentional
        // cover, not an unexpected overlap (shakedown #2). Same-layer overlaps fire.
        if (layerRoot(aId) !== layerRoot(bId)) continue;
        const pairKey = [String(aId), String(bId)].sort().join('::');
        if (seenPair.has(pairKey)) continue;
        seenPair.add(pairKey);
        out.push(mk('overlap', 'unexpected_overlap', ev.n, null, 'no non-containment overlap', `overlaps ${other.nodeKey || other.auditInstanceId}`));
      }
    }
    active.add(ev.n);
  }
  return out;
}

function rectsIntersect(a, b) {
  return a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y;
}

function mk(_tag, cls, node, property, expected, actual) {
  return {
    class: cls,
    surfaceId: node.surfaceId ?? null,
    nodeKey: node.nodeKey ?? null,
    device: node.device ?? null,
    theme: node.theme ?? null,
    property: property ?? null,
    expected,
    actual,
    evidence: [node.nodeKey ? `${node.surfaceId}/${node.nodeKey}` : ''].filter(Boolean),
  };
}
