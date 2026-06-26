/**
 * @fileoverview Tier 4 — the signifier matrix (plan §2 decision 5/7, §2a TIER 4).
 * Affordances via MATH, not narrative judgment. The scope-firewall rule: assert
 * only what's true of a computed style without knowing what the page is FOR. Pure;
 * consumes the per-pseudo-state computed snapshots extract.mjs produced via the
 * CDP forcePseudoState protocol (no live mouse/keyboard actuation):
 *
 *   - missing_visible_focus    : focusable node has no visible delta (outline /
 *                                box-shadow / border-color / background) in :focus/
 *                                :focus-visible vs default (Gemini-G2-M2: NOT just outline)
 *   - state_has_no_visual_delta: interactive node has no default→:hover paint delta
 *   - disabled_not_signified   : a disabled control doesn't look disabled (no
 *                                opacity<1, no grayscale filter, no cursor:not-allowed)
 *
 * @module scripts/lib/visual/signifiers
 */

const FOCUS_PROPS = ['outline-style', 'outline-width', 'outline-color', 'box-shadow', 'border-top-color', 'border-top-width', 'background-color', 'color'];
const HOVER_PROPS = ['background-color', 'color', 'border-top-color', 'box-shadow', 'opacity', 'transform', 'text-decoration-line'];
// SVG-internal nodes never carry a meaningful hover/focus/disabled signifier — a
// role/onclick on a `<use>`/`<path>` shouldn't probe the signifier matrix
// (shakedown pass-4 #2: trims the report-only state_has_no_visual_delta noise).
const DECORATIVE_TAGS = new Set(['use', 'path', 'g', 'defs', 'symbol', 'stop', 'lineargradient', 'radialgradient', 'clippath', 'mask', 'marker', 'pattern']);

/**
 * @param {object[]} nodes - evidence nodes (one device×theme); interactive nodes
 *        carry `pseudo: { focus, focusVisible, hover, disabled }` computed subsets.
 * @returns {object[]} partial findings
 */
export function runSignifiers(nodes) {
  const out = [];
  for (const node of nodes || []) {
    if (node?.displayed === false) continue;
    if (DECORATIVE_TAGS.has(node.tag)) continue;
    const base = node.computed || {};
    const pseudo = node.pseudo || {};

    if (node.focusable) {
      const focusState = pseudo.focusVisible || pseudo.focus || null;
      if (!focusState || !hasVisibleFocusDelta(base, focusState)) {
        out.push(mk('missing_visible_focus', node, 'focus', 'visible focus indicator (outline/ring/border/bg) on :focus-visible', focusState ? 'no visible delta vs default' : 'no :focus/:focus-visible rule'));
      }
    }

    if (node.interactive) {
      const hover = pseudo.hover || null;
      if (hover && !hasDelta(base, hover, HOVER_PROPS)) {
        out.push(mk('state_has_no_visual_delta', node, 'hover', 'a visible default→:hover paint change', 'no :hover delta'));
      }
    }

    if (node.disabled) {
      if (!signifiesDisabled(node)) {
        out.push(mk('disabled_not_signified', node, 'disabled', 'opacity<1 OR grayscale filter OR cursor:not-allowed', 'no visual disabled signifier (aria-disabled only)'));
      }
    }
  }
  return out;
}

/** A visible focus delta = any focus-prop changed in a perceivable way. */
function hasVisibleFocusDelta(base, focus) {
  // A real outline appearing is the canonical case.
  const ow = parseFloat(focus['outline-width']);
  const os = String(focus['outline-style'] || '').trim();
  if (os && os !== 'none' && Number.isFinite(ow) && ow > 0) return true;
  // Otherwise any change in ring/border/bg counts (G2-M2).
  return hasDelta(base, focus, ['box-shadow', 'border-top-color', 'border-top-width', 'background-color', 'color', 'outline-color']);
}

function hasDelta(base, state, props) {
  for (const p of props) {
    if (state[p] === undefined) continue;
    if (norm(state[p]) !== norm(base[p])) return true;
  }
  return false;
}

function signifiesDisabled(node) {
  const c = node.computed || {};
  const op = parseFloat(c.opacity);
  if (Number.isFinite(op) && op < 1) return true;
  if (/grayscale|brightness|contrast|opacity/.test(String(c.filter || ''))) return true;
  if (String(c.cursor || '').trim() === 'not-allowed') return true;
  return false;
}

function norm(v) { return String(v ?? '').trim().toLowerCase().replace(/\s+/g, ' '); }

function mk(cls, node, property, expected, actual) {
  return {
    class: cls,
    surfaceId: node.surfaceId ?? null,
    nodeKey: node.nodeKey ?? null,
    device: node.device ?? null,
    theme: node.theme ?? null,
    property,
    expected,
    actual,
    evidence: [node.nodeKey ? `${node.surfaceId}/${node.nodeKey}` : ''].filter(Boolean),
  };
}
