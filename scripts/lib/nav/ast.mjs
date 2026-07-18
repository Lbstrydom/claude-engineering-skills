/**
 * @fileoverview Nav-specific AST helpers for the nav extractor (debt-1 upgrade —
 * replaces the regex JSX scan that missed nested `>`/`{}`).
 *
 * **The generic half now lives in `scripts/lib/ast.mjs`** (`shared-lib`) and is
 * re-exported below, so every existing importer of this module keeps working
 * unchanged. The split closed two standing `shared-lib → nav-audit` forbidden
 * edges (`efficacy-lints.mjs`, `lint/on-conflict.mjs`) and pre-empted a third
 * from `audit-orchestration` — see `scripts/lib/ast.mjs`'s header and
 * docs/plans/adjacency-check-containment.md §D6. What remains here is genuinely
 * nav's: how a *navigation target* is spelled in source.
 *
 * @module scripts/lib/nav/ast
 */

// Re-exported from the shared primitive: generic parse + structural walk.
// `componentNameOf` moves with `walk` (its only caller) — see ast.mjs.
export { parseSource, walk, componentNameOf } from '../ast.mjs';

/** Unwrap an ObjectExpression that may be wrapped in `Object.freeze(...)`,
 *  `Object.assign({}, …)`, or a TS `as const` / `satisfies` (audit feedback #3 —
 *  `VIEWS = Object.freeze({...})` is the common SSoT shape). */
export function unwrapObjectExpression(node) {
  if (!node) return null;
  if (node.type === 'ObjectExpression') return node;
  if (node.type === 'CallExpression') {
    const arg = (node.arguments || []).find((a) => a?.type === 'ObjectExpression');
    if (arg) return arg;
  }
  if (node.type === 'TSAsExpression' || node.type === 'TSSatisfiesExpression') return unwrapObjectExpression(node.expression);
  return null;
}

/**
 * Classify a navigate/href target expression into a structured form the resolver
 * understands. Handles string literals, `VIEWS.X` members, template literals
 * (static prefix + dynamic tail), and opaque expressions.
 * @param {object} node - an expression node (attribute value or call arg)
 * @returns {{type: 'literal'|'member'|'template'|'unknown', value: string}}
 */
export function classifyTarget(node) {
  if (!node) return { type: 'unknown', value: '' };
  // JSXExpressionContainer wraps the real expression (e.g. to={'/x'}).
  if (node.type === 'JSXExpressionContainer') return classifyTarget(node.expression);
  if (node.type === 'StringLiteral') return { type: 'literal', value: node.value };
  if (node.type === 'JSXText') return { type: 'literal', value: node.value.trim() };
  if (node.type === 'MemberExpression' && node.object?.type === 'Identifier' && node.property?.type === 'Identifier' && !node.computed) {
    return { type: 'member', value: `${node.object.name}.${node.property.name}` };
  }
  if (node.type === 'TemplateLiteral') {
    // Reconstruct a static-prefix form, replacing each ${…} with a marker the
    // normalizer collapses to :param.
    let out = '';
    node.quasis.forEach((q, i) => { out += q.value.cooked ?? q.value.raw ?? ''; if (i < node.expressions.length) out += '${x}'; });
    return { type: 'template', value: out };
  }
  return { type: 'unknown', value: '' };
}

/** Extract the visible text label from a JSXElement's children (static text only). */
export function jsxLabel(element) {
  if (!element?.children) return null;
  const parts = [];
  for (const c of element.children) {
    if (c.type === 'JSXText') { const t = c.value.trim(); if (t) parts.push(t); }
  }
  const label = parts.join(' ').trim();
  return label.length ? label : null;
}

/** Get a JSX attribute node's value expression by attribute name. */
export function jsxAttr(openingElement, names) {
  const set = Array.isArray(names) ? names : [names];
  for (const attr of openingElement.attributes || []) {
    if (attr.type === 'JSXAttribute' && attr.name?.type === 'JSXIdentifier' && set.includes(attr.name.name)) {
      return attr.value;
    }
  }
  return null;
}

/** The tag name of a JSX opening element (e.g. 'a', 'Link', 'Route'). */
export function jsxTagName(openingElement) {
  const n = openingElement?.name;
  if (n?.type === 'JSXIdentifier') return n.name;
  if (n?.type === 'JSXMemberExpression') return n.property?.name ?? null;
  return null;
}

/** The callee name of a CallExpression as a dotted string (navigate, router.push). */
export function calleeName(node) {
  if (node.type !== 'CallExpression') return null;
  const c = node.callee;
  if (c?.type === 'Identifier') return c.name;
  if (c?.type === 'MemberExpression' && c.object?.type === 'Identifier' && c.property?.type === 'Identifier' && !c.computed) {
    return `${c.object.name}.${c.property.name}`;
  }
  return null;
}
