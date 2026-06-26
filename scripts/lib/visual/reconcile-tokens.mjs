/**
 * @fileoverview Tier 1 — declared-token reconciliation (plan §2 decision 2,
 * §2a TIER 1, §2b-D). For each audited node × property, the rendered value must
 * be EITHER on the declared scale (`valueOnScale`) OR set by a token-referencing
 * declaration (`declarationUsesToken`). A value that is neither, on an opted-in
 * surface, is a `token_violation`. Pure — consumes extract.mjs evidence + a
 * TokenIndex. No-op in inferredMode (clustering handles token-less apps elsewhere).
 *
 * @module scripts/lib/visual/reconcile-tokens
 */
import { normalizeByFamily } from './tokens.mjs';
import { resolveProvenance } from './provenance-resolver.mjs';

/** Audited family → the computed properties that carry that family's value. */
export const AUDITED_PROPERTIES = [
  { family: 'colors', property: 'color' },
  { family: 'colors', property: 'background-color' },
  { family: 'colors', property: 'border-top-color' },
  { family: 'radius', property: 'border-top-left-radius' },
  { family: 'borderWidth', property: 'border-top-width' },
  { family: 'fontSize', property: 'font-size' },
  { family: 'lineHeight', property: 'line-height' },
  { family: 'fontWeight', property: 'font-weight' },
  { family: 'shadow', property: 'box-shadow' },
  { family: 'spacing', property: 'padding-top' },
  { family: 'spacing', property: 'padding-left' },
  { family: 'spacing', property: 'margin-top' },
];

/** Values that mean "nothing" — never a token violation. */
const NEUTRAL = new Set(['0px', 'none', 'normal', 'auto', '0,0,0,0', 'transparent']);

/** SVG-internal / non-paint-bearing tags — auditing `font-size`/`color`/border on a
 *  `<use>`/`<path>` is meaningless and floods the run (shakedown noise #1/#2). */
const DECORATIVE_TAGS = new Set(['use', 'path', 'g', 'defs', 'symbol', 'stop', 'lineargradient', 'radialgradient', 'clippath', 'mask', 'marker', 'pattern']);

/** Is this node's border on `side` actually painted? (border-color computes even on
 *  a zero-width / `border-style:none` edge → don't reconcile an invisible border.) */
function borderPainted(computed, side) {
  const style = String(computed[`border-${side}-style`] || 'none').trim();
  const width = normalizeByFamily('borderWidth', computed[`border-${side}-width`]);
  return style !== 'none' && style !== 'hidden' && width != null && width !== '0px';
}

/**
 * @param {object[]} nodes - extract.mjs evidence nodes for ONE device×theme
 * @param {object} tokenIndex - from tokens.buildTokenIndex
 * @param {object} allowedSet - {families, inferredMode}
 * @param {object} contract
 * @returns {object[]} partial findings ({class:'token_violation', ...})
 */
export function runReconcileTokens(nodes, tokenIndex, allowedSet, contract) {
  if (!allowedSet || allowedSet.inferredMode) return []; // token-less app → clustering path
  // tokenAudited: absent/undefined → audit ALL families (default); explicit [] →
  // audit NONE (the contract off-switch for the token tier — `?? []` made [] a
  // no-op that still audited everything); a subset → just those (shakedown gate #2a).
  const policy = contract?.propertyPolicy?.tokenAudited;
  const audited = Array.isArray(policy) ? new Set(policy) : null;
  // Per-family empty-scale guard (shakedown noise #1): a family with NO declared
  // tokens isn't tokenized by this app — reconciling it emits a gate-eligible
  // violation on every node (e.g. ~1,300 P1s for typography an app keeps as raw
  // px). Such families are skipped here; findings.mjs runs the report-only
  // inferred-cluster fallback for them instead.
  const tokenized = new Set(Object.entries(allowedSet.families || {}).filter(([, v]) => Array.isArray(v) && v.length).map(([k]) => k));
  const out = [];
  for (const node of nodes || []) {
    if (node?.displayed === false) continue;
    if (DECORATIVE_TAGS.has(node.tag)) continue;
    const computed = node.computed || {};
    for (const { family, property } of AUDITED_PROPERTIES) {
      if (audited && !audited.has(family)) continue; // null = audit all; Set = subset/none
      if (!tokenized.has(family)) continue; // empty-scale guard
      if (property === 'border-top-color' && !borderPainted(computed, 'top')) continue;
      const raw = computed[property];
      if (raw == null) continue;
      const norm = normalizeByFamily(family, raw);
      if (norm == null || NEUTRAL.has(norm)) continue;

      const onScale = tokenIndex.has(family, norm, node.theme);
      if (onScale) continue;

      // rgba(var(--token-rgb), α) composites a token RGB triplet with alpha — the
      // alpha'd value isn't enumerated in the scale, but its OPAQUE base is, so it's
      // a tokened color at reduced opacity, not a violation (shakedown gate #2b: 12
      // alpha-derived error/scrim colors). Only the opaque-base match is trusted;
      // a coincidental literal would also need the alpha to line up.
      if (family === 'colors') {
        const parts = norm.split(',');
        if (parts.length === 4 && tokenIndex.has('colors', parts.slice(0, 3).join(','), node.theme)) continue;
      }

      // Provenance: does the WINNING declaration use a token var? (catches a token
      // whose value isn't enumerated in our allowed-set but is legitimately a var)
      const prov = node.matched?.[property]
        ?? (Array.isArray(node.declarations) ? resolveProvenance(node.declarations, property) : null);
      if (prov?.usesToken) continue;

      out.push({
        class: 'token_violation',
        surfaceId: node.surfaceId ?? null,
        nodeKey: node.nodeKey ?? null,
        device: node.device ?? null,
        theme: node.theme ?? null,
        property,
        expected: `${family} on declared scale`,
        actual: String(raw),
        evidence: [node.nodeKey ? `${node.surfaceId}/${node.nodeKey}` : (node.auditInstanceId || '')].filter(Boolean),
      });
    }
  }
  return out;
}
