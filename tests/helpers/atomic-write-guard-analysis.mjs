/**
 * @fileoverview Pure analyzer backing `tests/atomic-write-adoption-guard.test.mjs`
 * and `tests/atomic-write-guard-soundness.test.mjs` — source-text in,
 * verdict-records out; no `assert`, no `describe`, no filesystem discovery,
 * no process state. Not a `.test.mjs` module: importing one under
 * `node:test` registers and runs its suites as an import side effect, which
 * would execute the guard's own assertions twice and turn an incidental test
 * file into an undocumented shared module with no ownership boundary. This
 * lives in `tests/helpers/`, an established convention here already holding
 * 5 similar support modules.
 *
 * Uses `scripts/lib/import-binding.mjs`'s binding predicates so "does this
 * identifier resolve to the real import" is answered by real lexical scope,
 * never by comparing identifier spelling — the defect class this module
 * exists to close (see `docs/plans/refactor-static-analysis.md`).
 *
 * @module tests/helpers/atomic-write-guard-analysis
 */
import path from 'node:path';
import { parse } from '@babel/parser';
import _traverse from '@babel/traverse';
import {
  resolvesToNamedImport,
  resolveNamedImportBinding,
  resolvesToModuleBinding,
  classifyCallbackWrapper,
} from '../../scripts/lib/import-binding.mjs';

// @babel/traverse ships CJS; under ESM the callable lands on .default (and on
// .default.default via some interop paths). Same normalisation as
// find-rmsync-sites.mjs / adjacency-detector.mjs.
const traverse = _traverse?.default?.default ?? _traverse?.default ?? _traverse;

const REPO_ROOT = path.resolve(import.meta.dirname, '../..');
const FILE_IO_MODULE = path.resolve(REPO_ROOT, 'scripts/lib/file-io.mjs');
const RETRY_MODULE = path.resolve(REPO_ROOT, 'scripts/lib/retry-transient-fs.mjs');
const FS_MODULE_SOURCES = new Set(['node:fs', 'fs']);

/**
 * Locate a named FunctionDeclaration or `const name = (...) => {}` at the
 * top level — exported or not (`export function name() {}` and
 * `export const name = () => {}` both unwrap to the same inner declaration
 * before matching).
 */
function findNamedFunctionRange(program, name) {
  for (const node of program.body) {
    const decl = node.type === 'ExportNamedDeclaration' ? node.declaration : node;
    if (!decl) continue;
    if (decl.type === 'FunctionDeclaration' && decl.id?.name === name) {
      return { start: decl.start, end: decl.end };
    }
    if (decl.type === 'VariableDeclaration') {
      for (const varDecl of decl.declarations) {
        if (
          varDecl.id?.type === 'Identifier' && varDecl.id.name === name
          && (varDecl.init?.type === 'ArrowFunctionExpression' || varDecl.init?.type === 'FunctionExpression')
        ) {
          return { start: varDecl.init.start, end: varDecl.init.end };
        }
      }
    }
  }
  return null;
}

/**
 * Same grammar as `findNamedFunctionRange`, but returns a NodePath rather
 * than a byte range — so a caller can `.traverse()` the target function's
 * OWN body while stopping at nested function boundaries (round-1 H1/H2: a
 * byte-range containment check cannot tell a call the target function
 * actually executes from one buried in an unexecuted nested closure).
 */
function findNamedFunctionNodePath(programPath, name) {
  for (const stmtPath of programPath.get('body')) {
    const declPath = stmtPath.isExportNamedDeclaration() ? stmtPath.get('declaration') : stmtPath;
    if (!declPath.node) continue;
    if (declPath.isFunctionDeclaration() && declPath.node.id?.name === name) {
      return declPath;
    }
    if (declPath.isVariableDeclaration()) {
      for (const declaratorPath of declPath.get('declarations')) {
        const idNode = declaratorPath.node.id;
        const initPath = declaratorPath.get('init');
        if (
          idNode?.type === 'Identifier' && idNode.name === name
          && (initPath.isArrowFunctionExpression() || initPath.isFunctionExpression())
        ) {
          return initPath;
        }
      }
    }
  }
  return null;
}

/**
 * Does `functionName` (a top-level FunctionDeclaration or `const` arrow/
 * function) call `atomicWriteFileSync`, imported from `scripts/lib/file-io.mjs`,
 * via a reference that genuinely RESOLVES to that import — not merely a
 * call to something spelled the same way?
 *
 * @param {string} sourceText
 * @param {string} fileAbsPath - absolute path of the file `sourceText` came from
 * @param {{functionName: string}} opts
 * @returns {{status: 'wired'|'shadowed'|'no-import'|'no-such-function'|'absent'}}
 */
export function analyzeShapeADelegation(sourceText, fileAbsPath, { functionName }) {
  const ast = parse(sourceText, { sourceType: 'module', plugins: [] });

  // The import's local spelling may be aliased — resolve it from the import
  // declaration(s) itself rather than assuming it matches the exported name.
  // ESM permits importing the same named export under more than one local
  // alias in one declaration, so this collects every such alias rather than
  // keeping only the last one seen.
  const importLocalNames = new Set();
  for (const node of ast.program.body) {
    if (node.type !== 'ImportDeclaration') continue;
    const resolvedSource = path.resolve(path.dirname(fileAbsPath), node.source.value);
    if (resolvedSource !== FILE_IO_MODULE) continue;
    for (const spec of node.specifiers) {
      if (spec.type !== 'ImportSpecifier') continue;
      const importedName = spec.imported.name ?? spec.imported.value;
      if (importedName === 'atomicWriteFileSync') importLocalNames.add(spec.local.name);
    }
  }
  if (importLocalNames.size === 0) return { status: 'no-import' };

  let targetFnPath = null;
  traverse(ast, {
    Program(programPath) {
      targetFnPath = findNamedFunctionNodePath(programPath, functionName);
      programPath.stop();
    },
  });
  if (!targetFnPath) return { status: 'no-such-function' };

  let sawCandidateCall = false;
  let resolvedToImport = false;
  const namedImportSpec = {
    importedName: 'atomicWriteFileSync',
    moduleAbsPath: FILE_IO_MODULE,
    fromFileAbsPath: fileAbsPath,
  };

  targetFnPath.traverse({
    CallExpression(callPath) {
      const node = callPath.node;
      if (node.callee.type !== 'Identifier' || !importLocalNames.has(node.callee.name)) return;
      sawCandidateCall = true;
      if (resolvesToNamedImport(callPath.get('callee'), namedImportSpec)) resolvedToImport = true;
    },
    // Don't descend into a NESTED function's own body — a call there is not
    // part of the target function's own executable flow unless that nested
    // function is itself invoked, which a static shape check cannot prove.
    Function(fnPath) {
      fnPath.skip();
    },
  });

  if (resolvedToImport) return { status: 'wired' };
  if (sawCandidateCall) return { status: 'shadowed' };
  return { status: 'absent' };
}

/**
 * Locate every call site of the given fs method name(s) — member form
 * (`fs.renameSync(...)`, computed-string and optional variants included) and
 * bare-named form (`renameSync(...)`, aliased or ES2022-string-spelled) —
 * whose object/callee binding genuinely resolves to `node:fs`/`fs`. A call
 * through a shadowing local, a different module, or a non-literal computed
 * key (`fs[methodVar](...)`) is correctly NOT discovered; see the plan's §4
 * fs-call grammar matrix for the full accepted/rejected table.
 */
function discoverFsMethodSites(ast, methodNames) {
  const sites = [];
  traverse(ast, {
    'CallExpression|OptionalCallExpression'(callPath) {
      const node = callPath.node;
      const callee = node.callee;

      if (callee.type === 'MemberExpression' || callee.type === 'OptionalMemberExpression') {
        const propName = !callee.computed && callee.property.type === 'Identifier'
          ? callee.property.name
          : (callee.computed && callee.property.type === 'StringLiteral' ? callee.property.value : null);
        if (propName && methodNames.includes(propName) && callee.object.type === 'Identifier') {
          const objectPath = callPath.get('callee').get('object');
          if (resolvesToModuleBinding(objectPath, { moduleSources: FS_MODULE_SOURCES })) {
            sites.push(buildSiteRecord(callPath, propName));
          }
        }
        return;
      }

      if (callee.type === 'Identifier') {
        for (const method of methodNames) {
          if (resolvesToNamedImport(callPath.get('callee'), { importedName: method, moduleSources: FS_MODULE_SOURCES })) {
            sites.push(buildSiteRecord(callPath, method));
            break;
          }
        }
      }
    },
  });
  return sites;
}

function buildSiteRecord(callPath, method) {
  const node = callPath.node;
  const ancestors = callPath.getAncestry().slice(1).reverse().map((p) => p.node);
  return { node, method, line: node.loc.start.line, ancestors };
}

/**
 * Index every CallExpression in `sourceText` by its `start:end` byte-offset
 * pair, mapped to the Babel NodePath at that position — so a raw AST node
 * obtained from an earlier, separate parse of the same text (the site
 * discovery pass) can be resolved back to a NodePath with real scope info.
 * Same join technique as `tests/rmsync-retry-guard.test.mjs`.
 */
function buildCallExpressionPathIndex(sourceText) {
  const ast = parse(sourceText, { sourceType: 'module', plugins: [] });
  const index = new Map();
  traverse(ast, {
    CallExpression(callPath) {
      index.set(`${callPath.node.start}:${callPath.node.end}`, callPath);
    },
  });
  return index;
}

/** The three-step join specified in the plan's §2.4.1 canonical contract. */
function resolveSiteStatus(siteNode, ancestors, callExpressionPathIndex, retryImportSpec) {
  const { status: wrapperStatus, callNode: outerCallNode } = classifyCallbackWrapper(siteNode, ancestors);
  if (wrapperStatus === 'no-wrapper') return 'no-wrapper';
  if (wrapperStatus === 'async-wrapper') return 'async-callback';

  const outerCallPath = callExpressionPathIndex.get(`${outerCallNode.start}:${outerCallNode.end}`);
  if (!outerCallPath) {
    // The analyzer found a wrapper node it could not resolve to a NodePath —
    // this is an analyzer bug, not a finding about the target file. Must
    // never be silently coerced into 'wrapped' or a generic 'no-wrapper'.
    return 'index-miss';
  }

  const calleeNode = outerCallPath.node.callee;
  if (calleeNode.type !== 'Identifier') return 'unresolvable-binding';
  const bindingResult = resolveNamedImportBinding(outerCallPath.get('callee'), retryImportSpec);
  if (bindingResult === 'matched') return 'wrapped';
  return bindingResult === 'different-binding' ? 'wrong-binding' : 'unresolvable-binding';
}

/**
 * Locate every call site of `methodNames` in `sourceText` (optionally scoped
 * to one named function) and classify each site's retry-wrapping status.
 * Only `'wrapped'` is a pass; every other value names a distinct way the
 * site is NOT retry-protected (see the module docstring / plan §2.4.1 for
 * the full enum and why it is not collapsed to a boolean).
 *
 * @param {string} sourceText
 * @param {string} fileAbsPath
 * @param {{methodNames: string[], scopeToFunction?: string}} opts
 * @returns {{sites: Array<{line: number, method: string, status: string}>}}
 */
export function analyzeRetryWrapping(sourceText, fileAbsPath, { methodNames, scopeToFunction } = {}) {
  const ast = parse(sourceText, { sourceType: 'module', plugins: [] });

  let range = null;
  if (scopeToFunction) {
    range = findNamedFunctionRange(ast.program, scopeToFunction);
    if (!range) {
      throw new Error(`analyzeRetryWrapping: could not locate function "${scopeToFunction}" in ${fileAbsPath}`);
    }
  }

  const allSites = discoverFsMethodSites(ast, methodNames);
  const scopedSites = range
    ? allSites.filter((s) => s.node.start >= range.start && s.node.end <= range.end)
    : allSites;

  const callExpressionPathIndex = buildCallExpressionPathIndex(sourceText);
  const retryImportSpec = { importedName: 'retrySync', moduleAbsPath: RETRY_MODULE, fromFileAbsPath: fileAbsPath };

  return {
    sites: scopedSites.map((s) => ({
      line: s.line,
      method: s.method,
      status: resolveSiteStatus(s.node, s.ancestors, callExpressionPathIndex, retryImportSpec),
    })),
  };
}
