/**
 * @fileoverview Shared AST module locating `fs.rmSync` call sites.
 * Uses `@babel/traverse`'s real lexical-scope resolution (`scope.getBinding`)
 * rather than name-only matching — the established pattern in this repo for
 * callers needing real scope analysis (see `ast.mjs`'s own docstring, and
 * `scripts/lib/audit/adjacency-detector.mjs`). Name-only matching cannot tell
 * a genuine `fs` import from a local variable/parameter that happens to be
 * named `fs` (or `remove`, for an aliased named import) and shadows it — scope
 * resolution can. CommonJS `require('fs').rmSync` is explicitly out of scope —
 * see docs/plans/windows-fs-transient-error-hardening.md's "Out of Scope"
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
import _traverse from '@babel/traverse';

// @babel/traverse ships CJS; under ESM the callable lands on .default (and on
// .default.default via some interop paths). Normalise once, loudly — same
// pattern as adjacency-detector.mjs.
const traverse = _traverse?.default?.default ?? _traverse?.default ?? _traverse;

const FS_IMPORT_SOURCES = new Set(['node:fs', 'fs']);

/**
 * Resolve a scope binding to which recognized fs-import shape (if any) it
 * traces back to. Returns `null` for every other case, including a binding
 * with no declaration path (e.g. a function parameter) or an import from a
 * source other than `node:fs`/`fs` — this is what makes a shadowing
 * parameter or local variable correctly NOT match, unlike name-only checks.
 * @param {object|undefined} binding - result of `path.scope.getBinding(name)`
 * @returns {'namespace' | 'named-rmsync' | null}
 */
function resolveFsImportKind(binding) {
  if (!binding || !binding.path) return null;
  const declPath = binding.path;
  // `imported` is an Identifier (`.name`) for the ordinary spelling
  // (`import { default as fs }`) but a StringLiteral (`.value`) for the
  // ES2022 arbitrary-module-namespace-name spelling
  // (`import { "default" as fs }` / `import { "rmSync" as remove }`) —
  // both are valid, real syntax and must resolve identically.
  const importedName = declPath.node?.imported?.name ?? declPath.node?.imported?.value;
  const isDefaultLike = declPath.isImportDefaultSpecifier()
    || declPath.isImportNamespaceSpecifier()
    // `import { default as fs } from 'node:fs'` is a valid, semantically
    // equivalent ESM spelling of a default import — Babel parses it as an
    // ImportSpecifier with imported name/value === 'default', not an
    // ImportDefaultSpecifier, so it needs its own check here.
    || (declPath.isImportSpecifier() && importedName === 'default');
  if (isDefaultLike) {
    // default (`import fs from 'node:fs'`), namespace
    // (`import * as fs from 'node:fs'`), and `import { default as fs }`
    // all produce a local binding used identically at the call site — one
    // rule covers all three.
    const importDecl = declPath.parentPath;
    if (importDecl?.isImportDeclaration() && FS_IMPORT_SOURCES.has(importDecl.node.source.value)) {
      return 'namespace';
    }
    return null;
  }
  if (declPath.isImportSpecifier() && importedName === 'rmSync') {
    // named import, aliasing supported via the local binding name
    // (`import { rmSync as remove } from 'node:fs'` resolves as `remove`).
    const importDecl = declPath.parentPath;
    if (importDecl?.isImportDeclaration() && FS_IMPORT_SOURCES.has(importDecl.node.source.value)) {
      return 'named-rmsync';
    }
    return null;
  }
  return null;
}

/**
 * Parse a call's options argument (arguments[1]) into a properties map,
 * plus the byte offset a codemod should splice new properties after.
 *
 * Only a non-computed `ObjectProperty` with an `Identifier` or
 * `StringLiteral` key has a runtime key/value pair readable straight off
 * the AST. Anything else — `SpreadElement` (`{...opts, recursive: true}`),
 * `ObjectMethod` (`{ get recursive() {...} }`), or a COMPUTED key
 * (`{ [overrideVar]: false }`, whose actual runtime key is `overrideVar`'s
 * VALUE, not the literal identifier text "overrideVar") — makes the
 * object's full effective property set statically unknowable from this
 * call site alone: any of these forms could itself supply, mask, or
 * override `recursive`/`maxRetries`/`retryDelay` set elsewhere in the same
 * literal. Reporting only the safely-readable entries would silently hide
 * that override (e.g. `{recursive: true, [overrideVar]: false}` would
 * report `recursive: true` even though `overrideVar === 'recursive'` makes
 * the runtime object `{recursive: false}`). So ANY such entry fails the
 * WHOLE object closed to `properties: null` — the same "can't verify"
 * signal used for a non-ObjectExpression argument — rather than reporting
 * a partial map a caller could mistake for the complete runtime options.
 *
 * @param {object|undefined} optionsArgNode
 */
function extractOptionsInfo(optionsArgNode) {
  if (!optionsArgNode || optionsArgNode.type !== 'ObjectExpression') {
    return { optionsNode: null, properties: null, lastPropertyEnd: null };
  }
  const properties = {};
  let lastPropertyEnd = null;
  let hasUnknowableProperty = false;
  for (const prop of optionsArgNode.properties) {
    if (
      prop.type === 'ObjectProperty'
      && !prop.computed
      && (prop.key.type === 'Identifier' || prop.key.type === 'StringLiteral')
    ) {
      // `{ 'recursive': true }` (quoted key) is syntactically and
      // semantically identical to `{ recursive: true }` — both must resolve
      // to the same property name, or a quoted-key options object would be
      // silently misreported as omitting keys it actually sets.
      const keyName = prop.key.type === 'Identifier' ? prop.key.name : prop.key.value;
      let value;
      if (prop.value.type === 'BooleanLiteral' || prop.value.type === 'NumericLiteral') {
        value = prop.value.value;
      } else {
        value = undefined; // non-literal value — recorded as present but unclassified
      }
      properties[keyName] = value;
    } else {
      hasUnknowableProperty = true;
    }
    if (typeof prop.end === 'number') lastPropertyEnd = prop.end;
  }
  return { optionsNode: optionsArgNode, properties: hasUnknowableProperty ? null : properties, lastPropertyEnd };
}

/**
 * Detect the `retrySync(() => fs.rmSync(...))` / `retrySync(() => { return
 * fs.rmSync(...); })` wrapping shape from an rmSync CallExpression's
 * ancestor chain (root-to-immediate-parent order). Returns the outer
 * CallExpression node (so the guard can resolve `.callee` against its own
 * file's import bindings) or null if the call isn't wrapped this way.
 *
 * An `async` arrow (`retrySync(async () => fs.rmSync(...))`) is NOT
 * recognized as this wrapping shape: `retrySync` is a synchronous retry
 * helper (its own name says so), and an async callback returns a Promise
 * immediately — an exception thrown inside it rejects that Promise
 * asynchronously rather than throwing synchronously into `retrySync`'s own
 * try/catch, so the call would not actually be retry-protected at runtime
 * despite superficially matching the wrapping shape.
 *
 * @param {object} rmSyncCallNode
 * @param {object[]} ancestors
 */
// @duplicate-justification: target=tests/atomic-write-adoption-guard.test.mjs:findEnclosingCall reason=that test file's own docstring documents this as a deliberate local inline copy — its 9-file target set is fixed and stated in-file, not discovered via a repo-wide corpus like this module's, so it intentionally avoids taking this module as a dependency rather than sharing an accidental duplicate.
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

  if (!arrowFn || arrowFn.async) return null;

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
 * Locate every `fs.rmSync`/bare-`rmSync` call site in `sourceText`, resolved
 * via real lexical scope (not name matching) — a call through a shadowing
 * local variable or parameter is correctly excluded.
 * @param {string} sourceText
 * @returns {RmSyncCallSite[]}
 */
export function findRmSyncCallSites(sourceText) {
  const ast = parse(sourceText, { sourceType: 'module', plugins: [] });
  const sites = [];

  traverse(ast, {
    'CallExpression|OptionalCallExpression'(path) {
      const node = path.node;
      const callee = node.callee;
      let isRmSync = false;

      if (callee.type === 'MemberExpression' || callee.type === 'OptionalMemberExpression') {
        const propName = !callee.computed && callee.property.type === 'Identifier'
          ? callee.property.name
          : (callee.computed && callee.property.type === 'StringLiteral' ? callee.property.value : null);
        if (propName === 'rmSync' && callee.object.type === 'Identifier') {
          const binding = path.scope.getBinding(callee.object.name);
          if (resolveFsImportKind(binding) === 'namespace') isRmSync = true;
        }
      } else if (callee.type === 'Identifier') {
        const binding = path.scope.getBinding(callee.name);
        if (resolveFsImportKind(binding) === 'named-rmsync') isRmSync = true;
      }

      if (!isRmSync) return;

      const { optionsNode, properties, lastPropertyEnd } = extractOptionsInfo(node.arguments[1]);
      // Adapt Babel's immediate-to-root NodePath ancestry (current node included
      // at index 0) into the root-to-immediate-parent raw-node array
      // findEnclosingCall expects (its index arithmetic counts back from the end).
      const ancestors = path.getAncestry().slice(1).reverse().map((p) => p.node);
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
    },
  });

  return sites;
}
