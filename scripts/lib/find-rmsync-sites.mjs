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
import {
  resolvesToModuleBinding, resolvesToNamedImport, resolveNamedImportBinding, findSyncCallbackWrapper,
} from './import-binding.mjs';

// @babel/traverse ships CJS; under ESM the callable lands on .default (and on
// .default.default via some interop paths). Normalise once, loudly — same
// pattern as adjacency-detector.mjs.
const traverse = _traverse?.default?.default ?? _traverse?.default ?? _traverse;

const FS_IMPORT_SOURCES = new Set(['node:fs', 'fs']);

/**
 * Resolve an identifier reference to which recognized fs-import shape (if
 * any) it traces back to, via real lexical scope resolution. Delegates to
 * scripts/lib/import-binding.mjs's binding predicates so this file and any
 * future fs-binding consumer share one implementation rather than a second
 * hand-rolled classifier. Returns `null` for every case those predicates
 * return `false` for, including a shadowing parameter/local binding or an
 * import from a source other than `node:fs`/`fs` — this is what makes a
 * shadowing parameter or local variable correctly NOT match, unlike
 * name-only checks.
 * @param {import('@babel/traverse').NodePath} identifierPath - the Identifier reference to resolve
 * @returns {'namespace' | 'named-rmsync' | null}
 */
function resolveFsImportKind(identifierPath) {
  if (resolvesToModuleBinding(identifierPath, { moduleSources: FS_IMPORT_SOURCES })) return 'namespace';
  if (resolvesToNamedImport(identifierPath, { importedName: 'rmSync', moduleSources: FS_IMPORT_SOURCES })) {
    return 'named-rmsync';
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
 * Delegates to scripts/lib/import-binding.mjs's findSyncCallbackWrapper,
 * which was extracted verbatim from this function (including the
 * `arrowFn.async` rejection above) so a second consumer never drifts from
 * this one again.
 *
 * @param {object} rmSyncCallNode
 * @param {object[]} ancestors
 */
function findEnclosingCall(rmSyncCallNode, ancestors) {
  return findSyncCallbackWrapper(rmSyncCallNode, ancestors);
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
 * @property {boolean|null} enclosingCallResolvesToWrapper - whether `enclosingCall`'s callee
 *   resolves, via REAL lexical scope in THIS parse, to `opts.wrapperImportSpec`. `null` when
 *   there is no `enclosingCall`, or `opts.wrapperImportSpec` was not supplied (finding 2ee66195).
 */

/**
 * Locate every `fs.rmSync`/bare-`rmSync` call site in `sourceText`, resolved
 * via real lexical scope (not name matching) — a call through a shadowing
 * local variable or parameter is correctly excluded.
 *
 * @param {string} sourceText
 * @param {{wrapperImportSpec?: {importedName: string, moduleAbsPath: string, fromFileAbsPath: string}}} [opts]
 *   Finding 2ee66195: `enclosingCall` is a raw Babel node, which cannot carry
 *   lexical-scope info across a re-parse — a second consumer needing "does
 *   the wrapper identifier resolve to a real import" (e.g.
 *   `tests/rmsync-retry-guard.test.mjs`) used to re-parse the same source,
 *   re-traverse it, and reconnect the two independently-created ASTs via a
 *   manually constructed `start:end` string key. Passing `wrapperImportSpec`
 *   here answers that question in THIS SAME traversal, where the real NodePath
 *   (and its scope) is still available — no second parse needed. Omitted
 *   (the default) is byte-identical to prior behaviour: every existing call
 *   site is unaffected, and `enclosingCallResolvesToWrapper` reads `null`.
 * @returns {RmSyncCallSite[]}
 */
export function findRmSyncCallSites(sourceText, opts = {}) {
  const { wrapperImportSpec = null } = opts;
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
          const objectPath = path.get('callee').get('object');
          if (resolveFsImportKind(objectPath) === 'namespace') isRmSync = true;
        }
      } else if (callee.type === 'Identifier') {
        const calleePath = path.get('callee');
        if (resolveFsImportKind(calleePath) === 'named-rmsync') isRmSync = true;
      }

      if (!isRmSync) return;

      const { optionsNode, properties, lastPropertyEnd } = extractOptionsInfo(node.arguments[1]);
      // Adapt Babel's immediate-to-root NodePath ancestry (current node included
      // at index 0) into the root-to-immediate-parent raw-node array
      // findEnclosingCall expects (its index arithmetic counts back from the end).
      const ancestryPaths = path.getAncestry().slice(1).reverse();
      const ancestors = ancestryPaths.map((p) => p.node);
      const enclosingCall = findEnclosingCall(node, ancestors);

      let enclosingCallResolvesToWrapper = null;
      if (enclosingCall && wrapperImportSpec) {
        // Reconnect the raw `enclosingCall` node to its OWN NodePath from
        // THIS traversal (reference-equal — findEnclosingCall returns a node
        // it read out of `ancestors`, which is exactly the array built above)
        // rather than re-parsing, which is the defect this parameter exists
        // to close.
        const enclosingPath = ancestryPaths.find((p) => p.node === enclosingCall);
        const calleeIdentPath = enclosingPath && enclosingCall.callee.type === 'Identifier'
          ? enclosingPath.get('callee')
          : null;
        enclosingCallResolvesToWrapper = calleeIdentPath
          ? resolveNamedImportBinding(calleeIdentPath, wrapperImportSpec) === 'matched'
          : false;
      }

      sites.push({
        start: node.start,
        end: node.end,
        line: node.loc.start.line,
        optionsNode,
        properties,
        lastPropertyEnd,
        enclosingCall,
        enclosingCallResolvesToWrapper,
      });
    },
  });

  return sites;
}
