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

/**
 * @param {object[]} nodes - extract.mjs evidence nodes for ONE device×theme
 * @param {object} tokenIndex - from tokens.buildTokenIndex
 * @param {object} allowedSet - {families, inferredMode}
 * @param {object} contract
 * @returns {object[]} partial findings ({class:'token_violation', ...})
 */
export function runReconcileTokens(nodes, tokenIndex, allowedSet, contract) {
  if (!allowedSet || allowedSet.inferredMode) return []; // token-less app → clustering path
  const audited = new Set(contract?.propertyPolicy?.tokenAudited ?? []);
  const out = [];
  for (const node of nodes || []) {
    if (node?.displayed === false) continue;
    const computed = node.computed || {};
    for (const { family, property } of AUDITED_PROPERTIES) {
      if (audited.size && !audited.has(family)) continue;
      const raw = computed[property];
      if (raw == null) continue;
      const norm = normalizeByFamily(family, raw);
      if (norm == null || NEUTRAL.has(norm)) continue;

      const onScale = tokenIndex.has(family, norm, node.theme);
      if (onScale) continue;

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
