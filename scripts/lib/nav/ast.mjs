/**
 * @fileoverview AST parsing + a lightweight walker for the nav extractor
 * (debt-1 upgrade — replaces the regex JSX scan that missed nested `>`/`{}`).
 *
 * Uses `@babel/parser` (a direct dependency) with error recovery, and a small
 * hand-rolled recursive walker that tracks the nearest enclosing component name
 * — so we avoid pulling in `@babel/traverse` and its dep tree.
 *
 * @module scripts/lib/nav/ast
 */
import { parse } from '@babel/parser';

// Babel 8: most ES syntax plugins are on by default; keep only the ones that
// still need explicit opt-in (and NOT the removed `importAssertions`).
const PLUGINS = [
  'jsx',
  'typescript',
  'decorators-legacy',
];

/**
 * Parse a source string to a Babel AST. Error-recovery is on so a single syntax
 * error doesn't lose the whole file; a hard failure returns `{ast:null,error}`.
 * @param {string} content
 * @returns {{ast: object|null, error: string|null}}
 */
export function parseSource(content) {
  try {
    const ast = parse(content, {
      sourceType: 'unambiguous',
      allowReturnOutsideFunction: true,
      errorRecovery: true,
      plugins: PLUGINS,
    });
    return { ast, error: null };
  } catch (err) {
    return { ast: null, error: err.message };
  }
}

const SKIP_KEYS = new Set(['loc', 'start', 'end', 'range', 'leadingComments', 'trailingComments', 'innerComments', 'comments', 'tokens', 'extra']);

/**
 * Recursively walk an AST, invoking `visit(node, ctx)` for every node. `ctx`
 * carries `enclosing` — the nearest named function/class/component ancestor.
 * @param {object} ast - a File node (or any node)
 * @param {(node: object, ctx: {enclosing: string|undefined, line: number}) => void} visit
 */
export function walk(ast, visit) {
  const root = ast && ast.type === 'File' ? ast.program : ast;
  recur(root, undefined);

  function recur(node, enclosing) {
    if (!node || typeof node.type !== 'string') return;
    const named = componentNameOf(node);
    const nextEnclosing = named || enclosing;
    visit(node, { enclosing: nextEnclosing, line: node.loc?.start?.line ?? 0 });
    for (const key of Object.keys(node)) {
      if (SKIP_KEYS.has(key)) continue;
      const child = node[key];
      if (Array.isArray(child)) {
        for (const c of child) if (c && typeof c.type === 'string') recur(c, nextEnclosing);
      } else if (child && typeof child.type === 'string') {
        recur(child, nextEnclosing);
      }
    }
  }
}

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

/** The component/function name a node introduces, or null. */
export function componentNameOf(node) {
  if ((node.type === 'FunctionDeclaration' || node.type === 'ClassDeclaration') && node.id) return node.id.name;
  if (node.type === 'VariableDeclarator' && node.id?.type === 'Identifier' && node.init &&
      (node.init.type === 'ArrowFunctionExpression' || node.init.type === 'FunctionExpression' || node.init.type === 'ClassExpression')) {
    return node.id.name;
  }
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
