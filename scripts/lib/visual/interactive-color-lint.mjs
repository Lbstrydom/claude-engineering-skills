/**
 * @fileoverview Theme-safety PIECE 1a (static, no browser, ADVISORY) — the
 * "styled the box, forgot the text" smell caught at PR time from the CSS source.
 * Flags a form-control selector that sets `background`/`border` but not `color`
 * (so the text falls back to the UA default → black-on-dark in dark mode).
 *
 * Regex/`.match()` parsing, matching the tokens.mjs convention (NOT a new postcss
 * dep — an AST parser is unjustified for an advisory lint; the runtime PIECE 2 is
 * the precise net). REPORT-ONLY: not in GATE_ELIGIBLE_CLASSES, never gates in v1;
 * gate-promotion is v1.1. Documented limits: cascade layers, deep `:is()`/`:where()`,
 * and CSS-in-JS/runtime-generated styles are out of static reach → PIECE 2 covers those.
 *
 * Plan: docs/plans/visual-audit-theme-safety-v1.md.
 * @module scripts/lib/visual/interactive-color-lint
 */

import { CONTROL_SELECTOR_RE } from './theme-safety-scope.mjs';

/** Parse `selector { decls }` blocks (naive; @media/@supports wrappers still expose inner rules). */
const RULE_RE = /([^{}]+)\{([^{}]*)\}/g;

/** A `background`/`border` value that paints NO visible box (audit L2) — so it's
 *  not "styled the box": background none/transparent, border 0-width/none/transparent. */
function isInvisibleBoxValue(prop, value) {
  const v = String(value).trim().toLowerCase();
  if (prop === 'background' || prop === 'background-color') {
    return v === 'none' || v === 'transparent' || /\brgba?\([^)]*[,/]\s*0\s*\)$/.test(v);
  }
  // A `border`/`border-<side>` shorthand: tokenize — invisible if the width token is
  // 0, the style is `none`, or the color is `transparent` (audit M1/L1:
  // `border: 1px solid transparent`, `border: 0 solid red` etc.).
  if (prop === 'border' || /^border-(top|right|bottom|left)$/.test(prop)) {
    const toks = v.split(/\s+/).filter(Boolean);
    if (toks.includes('none') || toks.includes('transparent')) return true;
    const widthTok = toks.find((t) => /^\d*\.?\d+(px|rem|em)?$/.test(t) || t === 'thin' || t === 'medium' || t === 'thick');
    if (widthTok && /^0(px|rem|em)?$/.test(widthTok)) return true;
    return false;
  }
  if (v === 'none' || v === '0' || v === 'transparent') return true;
  if (/^border(-(top|right|bottom|left))?-width$/.test(prop) && /^0(px|rem|em)?$/.test(v)) return true;
  if (/^border(-(top|right|bottom|left))?-color$/.test(prop) && v === 'transparent') return true;
  if (/^border(-(top|right|bottom|left))?-style$/.test(prop) && v === 'none') return true;
  return false;
}

/** A declaration → the category it sets (respecting the VALUE — audit L2). */
function classifyDecl(prop, value) {
  const p = prop.trim().toLowerCase();
  if (p === 'color') return 'color';
  const isBoxProp = p === 'background' || p === 'background-color'
    || /^border(-(top|right|bottom|left))?(-(color|width|style))?$/.test(p); // NOT border-radius
  if (isBoxProp && !isInvisibleBoxValue(p, value)) return 'box';
  return null;
}

/** What a decl block sets: {color:bool, box:bool}. */
function blockSets(declText) {
  const sets = { color: false, box: false };
  for (const decl of String(declText).split(';')) {
    const i = decl.indexOf(':');
    if (i < 0) continue;
    const cat = classifyDecl(decl.slice(0, i), decl.slice(i + 1));
    if (cat === 'color') sets.color = true;
    else if (cat === 'box') sets.box = true;
  }
  return sets;
}

/** Normalize a (possibly grouped) selector into its trimmed sub-selectors. */
function subSelectors(sel) {
  return String(sel).split(',').map((s) => s.trim()).filter(Boolean);
}

/**
 * Lint contracted style sources for form controls that style the box but not the text.
 * @param {Array<{path:string, content:string}>} styleSources
 * @returns {object[]} advisory findings ({class:'interactive_color_unset', reportOnly})
 */
export function lintInteractiveColor(styleSources) {
  // Pass 1 — collect, per source, the rules and a set of sub-selectors that DO set
  // `color` anywhere (companion-rule satisfaction: a split rule setting color clears it).
  const rules = []; // { path, selector, sets }
  const setsColor = new Set(); // normalized sub-selector that sets color in ANY rule
  for (const src of styleSources || []) {
    const content = String(src?.content || '');
    let m;
    RULE_RE.lastIndex = 0;
    while ((m = RULE_RE.exec(content)) !== null) {
      const sets = blockSets(m[2]);
      const subs = subSelectors(m[1]);
      for (const sub of subs) {
        if (sets.color) setsColor.add(sub.toLowerCase());
        rules.push({ path: src?.path ?? null, selector: sub, sets });
      }
    }
  }

  // Pass 2 — flag form-control sub-selectors that set the box but never (here or in a
  // companion rule) set color.
  const out = [];
  const flagged = new Set();
  for (const r of rules) {
    if (!r.sets.box || r.sets.color) continue;
    if (!CONTROL_SELECTOR_RE.test(r.selector)) continue;
    if (setsColor.has(r.selector.toLowerCase())) continue; // companion rule sets color
    const key = `${r.path}|${r.selector}`;
    if (flagged.has(key)) continue;
    flagged.add(key);
    out.push({
      class: 'interactive_color_unset',
      severity: 'info',
      surfaceId: null,
      nodeKey: null,
      device: null,
      theme: null,
      property: 'color',
      expected: 'an author-set `color` (so text adapts across themes)',
      actual: `selector \`${r.selector}\` sets background/border but not \`color\` — text falls back to the UA default`,
      evidence: [r.path ? `${r.path}: ${r.selector}` : r.selector],
      gateEligible: false, // advisory v1 (not in GATE_ELIGIBLE_CLASSES); promotion is v1.1
      reportOnly: true,    // shape parity with the runtime producer (audit M4)
      source: 'static',
    });
  }
  return out;
}
