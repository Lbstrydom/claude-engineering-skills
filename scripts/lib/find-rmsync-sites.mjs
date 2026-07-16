/**
 * @fileoverview Shared AST module locating `fs.rmSync` call sites.
 * Exhaustive by construction for ES module imports (this repo's only
 * import form): every specifier of every `node:fs`/`fs` `ImportDeclaration`
 * is enumerated and classified, so there is no "unaccounted for" shape
 * left to miss for the two supported forms. CommonJS `require('fs').rmSync`
 * and further local aliasing of an `fs` method reference (e.g.
 * `const remove = fs.rmSync`) are explicitly out of scope — see
 * docs/plans/windows-fs-transient-error-hardening.md's "Out of Scope"
 * section for the rationale.
 *
 * One implementation, two consumers: the Phase 3 codemod (gitignored,
 * one-off) and `tests/rmsync-retry-guard.test.mjs` (committed regression
 * guard) both import this module so "found a call site" can never drift
 * between what gets transformed and what gets verified.
 *
 * @module scripts/lib/find-rmsync-sites
 */

import { parse } from '@babel/parser';

const FS_IMPORT_SOURCES = new Set(['node:fs', 'fs']);

/**
 * Enumerate every specifier of every node:fs/fs ImportDeclaration and
 * classify local bindings into the two recognized shapes.
 * @param {object} program - Babel Program node
 * @returns {{ memberAccessIdents: Set<string>, bareCallIdents: Set<string> }}
 */
function collectFsImportBindings(program) {
  const memberAccessIdents = new Set();
  const bareCallIdents = new Set();
  for (const node of program.body) {
    if (node.type !== 'ImportDeclaration') continue;
    if (!FS_IMPORT_SOURCES.has(node.source.value)) continue;
    for (const spec of node.specifiers) {
      if (spec.type === 'ImportDefaultSpecifier' || spec.type === 'ImportNamespaceSpecifier') {
        // default (`import fs from 'node:fs'`) and namespace
        // (`import * as fs from 'node:fs'`) both produce a local binding
        // used identically at the call site — one rule covers both.
        memberAccessIdents.add(spec.local.name);
      } else if (spec.type === 'ImportSpecifier' && spec.imported.name === 'rmSync') {
        // named import, aliasing supported via the local binding name
        // (`import { rmSync as remove } from 'node:fs'` resolves as `remove`).
        bareCallIdents.add(spec.local.name);
      }
      // Every other named specifier (mkdtempSync, existsSync, ...) is
      // enumerated here and ignored — not a removal call, not a failure
      // to classify.
    }
  }
  return { memberAccessIdents, bareCallIdents };
}

/**
 * Parse a call's options argument (arguments[1]) into a properties map,
 * plus the byte offset a codemod should splice new properties after.
 * @param {object|undefined} optionsArgNode
 */
function extractOptionsInfo(optionsArgNode) {
  if (!optionsArgNode || optionsArgNode.type !== 'ObjectExpression') {
    return { optionsNode: null, properties: null, lastPropertyEnd: null };
  }
  const properties = {};
  let lastPropertyEnd = null;
  for (const prop of optionsArgNode.properties) {
    if (prop.type === 'ObjectProperty' && prop.key.type === 'Identifier') {
      let value;
      if (prop.value.type === 'BooleanLiteral' || prop.value.type === 'NumericLiteral') {
        value = prop.value.value;
      } else {
        value = undefined; // non-literal value — recorded as present but unclassified
      }
      properties[prop.key.name] = value;
    }
    if (typeof prop.end === 'number') lastPropertyEnd = prop.end;
  }
  return { optionsNode: optionsArgNode, properties, lastPropertyEnd };
}

/**
 * Detect the `retrySync(() => fs.rmSync(...))` / `retrySync(() => { return
 * fs.rmSync(...); })` wrapping shape from an rmSync CallExpression's
 * ancestor chain (root-to-immediate-parent order). Returns the outer
 * CallExpression node (so the guard can resolve `.callee` against its own
 * file's import bindings) or null if the call isn't wrapped this way.
 * @param {object} rmSyncCallNode
 * @param {object[]} ancestors
 */
function findEnclosingCall(rmSyncCallNode, ancestors) {
  const n = ancestors.length;
  if (n === 0) return null;

  const immediateParent = ancestors[n - 1];
  let arrowFn = null;

  if (immediateParent.type === 'ArrowFunctionExpression' && immediateParent.body === rmSyncCallNode) {
    // Concise-body arrow: () => fs.rmSync(...)
    arrowFn = immediateParent;
  } else if (immediateParent.type === 'ReturnStatement' && n >= 3) {
    // Block-body arrow: () => { return fs.rmSync(...); }
    const blockParent = ancestors[n - 2];
    const arrowParent = ancestors[n - 3];
    if (
      blockParent?.type === 'BlockStatement'
      && arrowParent?.type === 'ArrowFunctionExpression'
      && arrowParent.body === blockParent
    ) {
      arrowFn = arrowParent;
    }
  }

  if (!arrowFn) return null;

  const arrowIdx = ancestors.lastIndexOf(arrowFn);
  if (arrowIdx <= 0) return null;
  const outerCall = ancestors[arrowIdx - 1];
  if (
    outerCall?.type === 'CallExpression'
    && outerCall.arguments.length === 1
    && outerCall.arguments[0] === arrowFn
  ) {
    return outerCall;
  }
  return null;
}

function walkAst(node, ancestors, visit) {
  if (!node || typeof node.type !== 'string') return;
  visit(node, ancestors);
  const nextAncestors = ancestors.concat([node]);
  for (const key of Object.keys(node)) {
    if (key === 'loc' || key === 'start' || key === 'end' || key === 'range'
      || key === 'leadingComments' || key === 'trailingComments' || key === 'innerComments') {
      continue;
    }
    const val = node[key];
    if (Array.isArray(val)) {
      for (const v of val) if (v && typeof v === 'object') walkAst(v, nextAncestors, visit);
    } else if (val && typeof val === 'object' && typeof val.type === 'string') {
      walkAst(val, nextAncestors, visit);
    }
  }
}

/**
 * @typedef {Object} RmSyncCallSite
 * @property {number} start - byte offset of the CallExpression's start
 * @property {number} end - byte offset of the CallExpression's end
 * @property {number} line - 1-indexed source line
 * @property {object|null} optionsNode - the options ObjectExpression, or null if absent/non-literal
 * @property {Object<string, boolean|number|undefined>|null} properties - parsed options keys, or null
 * @property {number|null} lastPropertyEnd - byte offset to splice new properties after (codemod anchor)
 * @property {object|null} enclosingCall - the retrySync(...)-shaped outer CallExpression, or null
 */

/**
 * Locate every `fs.rmSync`/bare-`rmSync` call site in `sourceText`.
 * @param {string} sourceText
 * @returns {RmSyncCallSite[]}
 */
export function findRmSyncCallSites(sourceText) {
  const ast = parse(sourceText, { sourceType: 'module', plugins: [] });
  const { memberAccessIdents, bareCallIdents } = collectFsImportBindings(ast.program);

  const sites = [];

  walkAst(ast.program, [], (node, ancestors) => {
    if (node.type !== 'CallExpression') return;
    const callee = node.callee;
    let isRmSync = false;

    if (
      callee.type === 'MemberExpression'
      && !callee.computed
      && callee.property.type === 'Identifier'
      && callee.property.name === 'rmSync'
      && callee.object.type === 'Identifier'
      && memberAccessIdents.has(callee.object.name)
    ) {
      isRmSync = true;
    } else if (callee.type === 'Identifier' && bareCallIdents.has(callee.name)) {
      isRmSync = true;
    }

    if (!isRmSync) return;

    const { optionsNode, properties, lastPropertyEnd } = extractOptionsInfo(node.arguments[1]);
    const enclosingCall = findEnclosingCall(node, ancestors);

    sites.push({
      start: node.start,
      end: node.end,
      line: node.loc.start.line,
      optionsNode,
      properties,
      lastPropertyEnd,
      enclosingCall,
    });
  });

  return sites;
}
