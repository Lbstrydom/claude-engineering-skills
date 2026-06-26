/**
 * @fileoverview Resolve the WINNING declaration per audited CSS property from the
 * cascade-ordered rules CDP returns (plan §2b-F, GPT-R2-H2). `declarationUsesToken`
 * is only sound against the declaration that actually paints — not any matched rule
 * that mentions a `var()`. The resolver:
 *
 *   - expands the audited shorthands (border, margin, padding, box-shadow) into the
 *     longhands the tiers compare;
 *   - picks the winner per property by the cascade: `!important` > cascade-layer
 *     order > specificity > source order;
 *   - reports whether the winning value references a token `var(--…)`.
 *
 * Pure — consumes a plain declaration list extract.mjs flattens from CDP. Tested
 * with canned fixtures (tests/visual-provenance.test.mjs).
 *
 * NOTE (v1 scope): the `!important`-reverses-layer-precedence interaction is not
 * modelled — `!important` always wins here. Documented limit; revisit if a real
 * app trips it (cascade layers + !important is rare in token-driven systems).
 *
 * @module scripts/lib/visual/provenance-resolver
 */

/** Audited shorthands → the longhand properties they set (subset the tiers read). */
const SHORTHAND_EXPANSIONS = {
  margin: ['margin-top', 'margin-right', 'margin-bottom', 'margin-left'],
  padding: ['padding-top', 'padding-right', 'padding-bottom', 'padding-left'],
  'border-width': ['border-top-width', 'border-right-width', 'border-bottom-width', 'border-left-width'],
};

/**
 * @typedef {object} RawDeclaration
 * @property {string} property      e.g. 'color', 'border', 'box-shadow'
 * @property {string} value         raw declaration value (may contain `var(--x)`)
 * @property {boolean} [important]
 * @property {[number,number,number]} [specificity] [idCount, classCount, typeCount]
 * @property {number} [sourceOrder] position in the matched-rules list (higher = later)
 * @property {number} [layerOrder]  cascade-layer index (higher = wins); default 0
 */

/**
 * Resolve provenance for a single audited property.
 * @param {RawDeclaration[]} declarations - ALL matched declarations for the node
 * @param {string} property - the audited longhand property
 * @returns {{winningValue:string, usesToken:boolean, varName:string|null}|null}
 */
export function resolveProvenance(declarations, property) {
  const candidates = expandFor(declarations, property);
  if (!candidates.length) return null;
  const winner = candidates.slice().sort(cascadeCompare)[0];
  const varName = extractVar(winner.value);
  return { winningValue: winner.value.trim(), usesToken: varName != null, varName };
}

/**
 * Does the winning declaration for `property` use a token var?
 * @param {RawDeclaration[]} declarations
 * @param {string} property
 * @returns {boolean}
 */
export function declarationUsesToken(declarations, property) {
  return resolveProvenance(declarations, property)?.usesToken === true;
}

/** All declarations that set `property` (directly or via an audited shorthand). */
function expandFor(declarations, property) {
  const out = [];
  for (const d of declarations || []) {
    if (!d || typeof d.property !== 'string') continue;
    const prop = d.property.toLowerCase();
    if (prop === property) { out.push(d); continue; }
    // shorthand that expands to this longhand
    const longhands = SHORTHAND_EXPANSIONS[prop];
    if (longhands && longhands.includes(property)) out.push(d);
    // `border` shorthand sets *-width/-color too — model the width/color longhands
    if (prop === 'border' && /^border-(top|right|bottom|left)-(width|color)$/.test(property)) out.push(d);
    if (prop === 'border-color' && /^border-(top|right|bottom|left)-color$/.test(property)) out.push(d);
  }
  return out;
}

/** Cascade comparator: returns <0 when `a` wins over `b`. */
function cascadeCompare(a, b) {
  if (!!b.important !== !!a.important) return a.important ? -1 : 1;
  const al = a.layerOrder ?? 0;
  const bl = b.layerOrder ?? 0;
  if (al !== bl) return bl - al; // higher layer wins
  const spec = compareSpecificity(a.specificity, b.specificity);
  if (spec !== 0) return spec;
  return (b.sourceOrder ?? 0) - (a.sourceOrder ?? 0); // later source wins
}

/** Returns <0 when spec `a` is higher than `b`. */
function compareSpecificity(a, b) {
  const x = Array.isArray(a) ? a : [0, 0, 0];
  const y = Array.isArray(b) ? b : [0, 0, 0];
  for (let i = 0; i < 3; i++) {
    if ((x[i] || 0) !== (y[i] || 0)) return (y[i] || 0) - (x[i] || 0);
  }
  return 0;
}

/** Extract the first `var(--name)` token name from a value, or null. */
function extractVar(value) {
  const m = String(value || '').match(/var\(\s*(--[\w-]+)/);
  return m ? m[1] : null;
}
