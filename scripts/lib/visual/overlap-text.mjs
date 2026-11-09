/**
 * @fileoverview Absolute-vs-static text overlap inside one positioned tile.
 *
 * Bug (WCA report d9306fe9): layout-physics treats any `absolute` node as its own
 * stacking LAYER and skips cross-layer pairs as "intentional cover" - correct for a
 * fixed modal over the page, wrong for an absolutely positioned badge laid over its
 * static sibling's text inside a `position:relative` tile (cellar-grid slot code over
 * the year). Those share a containing block: text colliding with text there is a
 * defect, not an overlay.
 *
 * Scope firewall (visual-audit imperative 4): assertable from computed style +
 * geometry alone, with no judgement about what the page is for. Both boxes must be
 * text leaves; intentional overlays are exempted by signals the DOM itself declares:
 * aria-hidden, opacity 0, fully transparent text colour, hidden or clipped boxes. An
 * absolute decorative badge with NO text is never a candidate (hasText gate).
 *
 * @module scripts/lib/visual/overlap-text
 */
import { isTransparent } from './unadapted-color.mjs';

/** Could this node's text be seen? (declared-invisible means exempt, never flagged) */
export function isVisibleText(n) {
  if (!n || !n.hasText || n.displayed === false) return false;
  if (n.ariaHidden || n.clipped) return false;
  const c = n.computed || {};
  // effectiveOpacity folds ancestors in (opacity is not inherited); fall back to the leaf's own.
  const op = Number.isFinite(n.effectiveOpacity) ? n.effectiveOpacity : parseFloat(c.opacity);
  if (Number.isFinite(op) && op <= 0) return false;
  if (c.color && isTransparent(c.color)) return false;
  return true;
}

/**
 * True when `a` and `b` are visible text leaves, exactly one of which sits in an
 * absolutely positioned box (the leaf itself or a wrapper around it), and both live
 * inside the same positioned containing block (the tile). The caller has already
 * established that their rects intersect.
 * @param {object} a
 * @param {object} b
 * @param {{parentOf:Map<string,string|null>, byId:Map<string,object>}} ctx
 */
export function isTileTextOverlap(a, b, { parentOf, byId }) {
  if (!isVisibleText(a) || !isVisibleText(b)) return false;
  const posOf = (id) => String((byId.get(id)?.computed || {}).position || 'static').trim();
  // Nearest positioned box at-or-above a node: the box that decides its layer.
  const positioned = (id) => {
    for (let cur = id, hops = 0; cur != null && hops++ < 64; cur = parentOf.get(cur)) {
      const p = posOf(cur);
      if (p !== 'static') return { id: cur, pos: p };
    }
    return null;
  };
  const pa = positioned(a.auditInstanceId);
  const pb = positioned(b.auditInstanceId);
  if (pa?.pos === 'fixed' || pb?.pos === 'fixed') return false; // viewport overlays are a different layer
  if ((pa?.pos === 'absolute') === (pb?.pos === 'absolute')) return false; // static-vs-static is the ordinary pass; two absolutes are distinct layers
  const absIsA = pa?.pos === 'absolute';
  const absBox = absIsA ? pa : pb;
  const other = absIsA ? b : a;
  // Tile = the absolute box's containing block (nearest positioned ancestor above it).
  const tile = positioned(parentOf.get(absBox.id));
  if (!tile) return false; // containing block is outside the captured subtree
  // Walk other -> tile. An independent overlay layer (a fixed or absolute container
  // strictly between them) is a deliberate cover, not text colliding in one block.
  let up = parentOf.get(other.auditInstanceId);
  for (let hops = 0; up != null && hops++ < 64; up = parentOf.get(up)) {
    if (up === tile.id) return true;
    const p = posOf(up);
    if (p === 'fixed' || p === 'absolute') return false;
  }
  return false;
}
