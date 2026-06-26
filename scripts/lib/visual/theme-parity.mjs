/**
 * @fileoverview Tier 2 — theme parity (plan §2 decision 3, §2a TIER 2, Gemini-G2-3)
 * plus the contrast byproduct (§2b-G). Pure.
 *
 *   - runThemeParity: join the SAME node (by nodeKey) across two themes, compare
 *     MUST-MATCH in-flow geometry (equality within tolerance) — but ONLY for nodes
 *     rendered in BOTH themes (a `display:none`-in-one-theme node is a legitimate
 *     theme-conditional element, not drift). A may-differ color/background that is
 *     a hardcoded literal identical across both themes → `theme_unmapped_token`
 *     (it can't adapt — the dark-on-dark class).
 *   - runContrast: per node per theme, compute text contrast over the resolved
 *     effective backdrop; below the declared ratio (and backdrop resolved) →
 *     `contrast_failure`. Unverified backdrops never fire.
 *
 * @module scripts/lib/visual/theme-parity
 */
import { normalizeLength, normalizeColor } from './tokens.mjs';
import { resolveProvenance } from './provenance-resolver.mjs';
import { resolveEffectiveBackground } from './effective-background.mjs';
import { textContrast } from './contrast.mjs';

const MAY_DIFFER_COLOR_PROPS = ['color', 'background-color', 'border-top-color'];
const DECORATIVE_TAGS = new Set(['use', 'path', 'g', 'defs', 'symbol', 'stop', 'lineargradient', 'radialgradient', 'clippath', 'mask', 'marker', 'pattern']);

/**
 * @param {Record<string, object[]>} nodesByTheme - themeName → evidence nodes (one device)
 * @param {object} contract
 * @returns {object[]} partial findings
 */
export function runThemeParity(nodesByTheme, contract) {
  const themes = Object.keys(nodesByTheme || {});
  if (themes.length < 2) return []; // single-theme capture → parity not assessable
  const [tA, tB] = themes;
  const aByKey = indexByKey(nodesByTheme[tA]);
  const bByKey = indexByKey(nodesByTheme[tB]);
  const geomProps = contract?.propertyPolicy?.mustMatchGeometry ?? ['width', 'height', 'padding', 'margin'];
  const tol = contract?.tolerances?.geometryPx ?? 1;
  const out = [];

  for (const [key, a] of aByKey) {
    const b = bByKey.get(key);
    if (!b) continue;
    const bothDisplayed = a.displayed !== false && b.displayed !== false;

    // MUST-MATCH geometry — only when rendered in both themes (Gemini-G2-3).
    if (bothDisplayed) {
      for (const prop of expandGeometry(geomProps)) {
        const av = normalizeLength((a.computed || {})[prop]);
        const bv = normalizeLength((b.computed || {})[prop]);
        if (av == null || bv == null) continue;
        if (Math.abs(parseFloat(av) - parseFloat(bv)) > tol) {
          out.push(mk('theme_geometry_drift', a, prop, `${tA}=${av} (parity within ${tol}px)`, `${tB}=${bv}`, [tA, tB]));
        }
      }
    }

    // MAY-DIFFER-IF-TOKENED: a literal color identical across themes can't remap.
    if (DECORATIVE_TAGS.has(a.tag)) continue; // SVG-internal nodes don't carry meaningful paint
    for (const prop of MAY_DIFFER_COLOR_PROPS) {
      // `color` inherits — reporting it on every descendant re-counts one frozen
      // literal N times (shakedown noise #4). Only flag `color` on text-bearing
      // nodes (the node that actually paints the glyphs).
      if (prop === 'color' && a.hasText === false) continue;
      if (prop === 'border-top-color' && !borderPaintedTop(a.computed)) continue;
      const av = normalizeColor((a.computed || {})[prop]);
      const bv = normalizeColor((b.computed || {})[prop]);
      if (av == null || bv == null) continue;
      if (av !== bv) continue; // it DID change across themes → fine
      if (av === '0,0,0,0') continue; // transparent — nothing to adapt
      const prov = a.matched?.[prop] ?? (Array.isArray(a.declarations) ? resolveProvenance(a.declarations, prop) : null);
      if (prov?.usesToken) continue; // tokened + same value across themes is a deliberate theme-agnostic token
      out.push(mk('theme_unmapped_token', a, prop, 'value should adapt across themes (token-mapped)', `literal ${av} identical in ${tA} & ${tB}`, [tA, tB]));
    }
  }
  return out;
}

/**
 * @param {object[]} nodes - evidence nodes for ONE device×theme (text nodes carry color + backgroundStack)
 * @param {object} contract
 * @returns {object[]} partial findings ({class:'contrast_failure'})
 */
export function runContrast(nodes, contract) {
  const minRatio = contract?.tolerances?.contrastRatio ?? 4.5;
  const out = [];
  for (const node of nodes || []) {
    if (node?.displayed === false) continue;
    if (node.hasText === false) continue; // only text nodes
    const fg = normalizeColor((node.computed || {}).color);
    if (!fg) continue;
    const bg = resolveEffectiveBackground(node.backgroundStack, { theme: node.theme });
    if (bg.status !== 'resolved') continue; // unverified backdrop → never gate (G2-M1/G1)
    const ratio = textContrast(fg, bg.color);
    if (ratio == null) continue;
    if (ratio < minRatio) {
      out.push(mk('contrast_failure', node, 'color', `≥ ${minRatio}:1`, `${ratio}:1 over ${bg.color}`, []));
    }
  }
  return out;
}

function indexByKey(nodes) {
  const m = new Map();
  for (const n of nodes || []) if (n?.nodeKey) m.set(n.nodeKey, n);
  return m;
}

/** Don't reconcile an invisible top border (color computes even at width 0). */
function borderPaintedTop(computed = {}) {
  const style = String(computed['border-top-style'] || 'none').trim();
  const w = parseFloat(computed['border-top-width']);
  return style !== 'none' && style !== 'hidden' && Number.isFinite(w) && w > 0;
}

/** Expand padding/margin shorthand policy entries into the longhands we measure. */
function expandGeometry(props) {
  const out = [];
  for (const p of props) {
    if (p === 'padding') out.push('padding-top', 'padding-right', 'padding-bottom', 'padding-left');
    else if (p === 'margin') out.push('margin-top', 'margin-right', 'margin-bottom', 'margin-left');
    else if (p === 'grid-template') out.push('grid-template-columns', 'grid-template-rows');
    else out.push(p);
  }
  return out;
}

function mk(cls, node, property, expected, actual, extraEvidence) {
  return {
    class: cls,
    surfaceId: node.surfaceId ?? null,
    nodeKey: node.nodeKey ?? null,
    device: node.device ?? null,
    theme: node.theme ?? null,
    property,
    expected,
    actual,
    evidence: [node.nodeKey ? `${node.surfaceId}/${node.nodeKey}` : '', ...(extraEvidence || [])].filter(Boolean),
  };
}
