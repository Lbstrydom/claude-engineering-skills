import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { parse } from '@babel/parser';

// AST-based wiring-proof guard for docs/plans/atomic-write-adoption-remaining-sites.md.
// A regex/text check can be satisfied by an unrelated call, a shadowed local, a
// comment, or a rename outside the intended callback — none of which prove the
// actual wiring landed. This does real import-binding resolution instead,
// reusing the same technique docs/plans/windows-fs-transient-error-hardening.md's
// find-rmsync-sites.mjs established. Inlined locally (not a shared production
// module) because the 9-file target set here is fixed and stated below, not
// discovered — no separate discovery step is needed the way rmSync's repo-wide
// corpus required one.

const REPO_ROOT = path.resolve(import.meta.dirname, '..');

function abs(p) {
  return path.resolve(REPO_ROOT, p);
}

function parseFile(absPath) {
  const src = fs.readFileSync(absPath, 'utf-8');
  const ast = parse(src, { sourceType: 'module', plugins: [] });
  return { src, ast };
}

/** Resolve local binding names for a named import matching (exportedName, moduleAbsPath). */
function collectNamedImportBindings(program, exportedName, moduleAbsPath, fileAbsPath) {
  const bindings = new Set();
  const fileDir = path.dirname(fileAbsPath);
  for (const node of program.body) {
    if (node.type !== 'ImportDeclaration') continue;
    const resolvedSource = path.resolve(fileDir, node.source.value);
    if (resolvedSource !== moduleAbsPath) continue;
    for (const spec of node.specifiers) {
      if (spec.type === 'ImportSpecifier' && spec.imported.name === exportedName) {
        bindings.add(spec.local.name);
      }
    }
  }
  return bindings;
}

/** fs.rmSync-style member/bare bindings, generalized to any target fs method name(s). */
function collectFsMethodBindings(program, methodNames) {
  const memberAccessIdents = new Set(); // bound to default/namespace fs import
  const bareIdentsByMethod = new Map(methodNames.map((m) => [m, new Set()]));
  for (const node of program.body) {
    if (node.type !== 'ImportDeclaration') continue;
    if (node.source.value !== 'node:fs' && node.source.value !== 'fs') continue;
    for (const spec of node.specifiers) {
      if (spec.type === 'ImportDefaultSpecifier' || spec.type === 'ImportNamespaceSpecifier') {
        memberAccessIdents.add(spec.local.name);
      } else if (spec.type === 'ImportSpecifier' && bareIdentsByMethod.has(spec.imported.name)) {
        bareIdentsByMethod.get(spec.imported.name).add(spec.local.name);
      }
    }
  }
  return { memberAccessIdents, bareIdentsByMethod };
}

function walkAst(node, ancestors, visit) {
  if (!node || typeof node.type !== 'string') return;
  visit(node, ancestors);
  const next = ancestors.concat([node]);
  for (const key of Object.keys(node)) {
    if (key === 'loc' || key === 'start' || key === 'end' || key === 'range'
      || key === 'leadingComments' || key === 'trailingComments' || key === 'innerComments') continue;
    const val = node[key];
    if (Array.isArray(val)) {
      for (const v of val) if (v && typeof v === 'object') walkAst(v, next, visit);
    } else if (val && typeof val === 'object' && typeof val.type === 'string') {
      walkAst(val, next, visit);
    }
  }
}

/** Same enclosingCall detection as find-rmsync-sites.mjs, inlined locally. */
function findEnclosingCall(siteNode, ancestors) {
  const n = ancestors.length;
  if (n === 0) return null;
  const immediateParent = ancestors[n - 1];
  let arrowFn = null;
  if (immediateParent.type === 'ArrowFunctionExpression' && immediateParent.body === siteNode) {
    arrowFn = immediateParent;
  } else if (immediateParent.type === 'ReturnStatement' && n >= 3) {
    const blockParent = ancestors[n - 2];
    const arrowParent = ancestors[n - 3];
    if (blockParent?.type === 'BlockStatement' && arrowParent?.type === 'ArrowFunctionExpression' && arrowParent.body === blockParent) {
      arrowFn = arrowParent;
    }
  }
  if (!arrowFn) return null;
  const arrowIdx = ancestors.lastIndexOf(arrowFn);
  if (arrowIdx <= 0) return null;
  const outerCall = ancestors[arrowIdx - 1];
  if (outerCall?.type === 'CallExpression' && outerCall.arguments.length === 1 && outerCall.arguments[0] === arrowFn) {
    return outerCall;
  }
  return null;
}

/** Find every fs.renameSync/unlinkSync (or bare-imported) call site in the AST. */
function findFsMethodSites(program, methodNames) {
  const { memberAccessIdents, bareIdentsByMethod } = collectFsMethodBindings(program, methodNames);
  const sites = [];
  walkAst(program, [], (node, ancestors) => {
    if (node.type !== 'CallExpression') return;
    const callee = node.callee;
    let method = null;
    if (callee.type === 'MemberExpression' && !callee.computed
      && callee.property.type === 'Identifier' && methodNames.includes(callee.property.name)
      && callee.object.type === 'Identifier' && memberAccessIdents.has(callee.object.name)) {
      method = callee.property.name;
    } else if (callee.type === 'Identifier') {
      for (const m of methodNames) {
        if (bareIdentsByMethod.get(m).has(callee.name)) { method = m; break; }
      }
    }
    if (!method) return;
    sites.push({ node, method, enclosingCall: findEnclosingCall(node, ancestors) });
  });
  return sites;
}

/** Locate a named FunctionDeclaration or `const name = (...) => {}` at the top level. */
function findNamedFunctionRange(program, name) {
  for (const node of program.body) {
    if (node.type === 'FunctionDeclaration' && node.id?.name === name) {
      return { start: node.start, end: node.end };
    }
    if (node.type === 'ExportNamedDeclaration' && node.declaration?.type === 'FunctionDeclaration' && node.declaration.id?.name === name) {
      return { start: node.declaration.start, end: node.declaration.end };
    }
    if (node.type === 'VariableDeclaration') {
      for (const decl of node.declarations) {
        if (decl.id?.type === 'Identifier' && decl.id.name === name
          && (decl.init?.type === 'ArrowFunctionExpression' || decl.init?.type === 'FunctionExpression')) {
          return { start: decl.init.start, end: decl.init.end };
        }
      }
    }
  }
  return null;
}

/** Does the named function contain a CallExpression resolving to atomicWriteFileSync? */
function functionCallsAtomicWriteFileSync(program, functionName, atomicWriteBindings) {
  const range = findNamedFunctionRange(program, functionName);
  assert.ok(range, `could not locate function/const "${functionName}" in file`);
  let found = false;
  walkAst(program, [], (node) => {
    if (node.type !== 'CallExpression') return;
    if (node.start < range.start || node.end > range.end) return;
    if (node.callee.type === 'Identifier' && atomicWriteBindings.has(node.callee.name)) found = true;
  });
  return found;
}

const FILE_IO_MODULE = abs('scripts/lib/file-io.mjs');
const RETRY_MODULE = abs('scripts/lib/retry-transient-fs.mjs');

// ── Rule 1 — Shape A: named target function delegates to atomicWriteFileSync ──

const SHAPE_A_TARGETS = [
  { file: 'scripts/learning/backfill-outcomes.mjs', fn: 'drainFrictionFallback' },
  { file: 'scripts/lib/brainstorm/session-store.mjs', fn: 'appendQuarantine' },
  { file: 'scripts/lib/claudemd/autofix.mjs', fn: 'applyFixes' },
  { file: 'scripts/lib/learning/decision-logger.mjs', fn: 'writeOutbox' },
  { file: 'scripts/lib/learning/quickfix-stats.mjs', fn: 'writeAtomic' },
  { file: 'scripts/memory-health.mjs', fn: 'atomicWrite' },
  { file: 'scripts/symbol-index/drift.mjs', fn: 'atomicWrite' },
];

describe('atomic-write-adoption guard — Rule 1: Shape-A delegation', () => {
  for (const { file, fn } of SHAPE_A_TARGETS) {
    it(`${file}::${fn} calls atomicWriteFileSync`, () => {
      const fileAbsPath = abs(file);
      const { ast } = parseFile(fileAbsPath);
      const bindings = collectNamedImportBindings(ast.program, 'atomicWriteFileSync', FILE_IO_MODULE, fileAbsPath);
      assert.ok(bindings.size > 0, `${file} does not import atomicWriteFileSync from the correct path`);
      assert.ok(
        functionCallsAtomicWriteFileSync(ast.program, fn, bindings),
        `${file}::${fn} does not call atomicWriteFileSync`,
      );
    });
  }
});

// ── Rule 2 — every renameSync/unlinkSync site found is retrySync-wrapped ──
// Applies to: persona-consistency-promote.mjs (whole file) and
// backfill-outcomes.mjs scoped to drainFrictionFallback only (the other Shape-A
// files have zero renameSync/unlinkSync remaining, which Rule 1 already proves by
// locating the real write path). archive-completed-plans.mjs was removed here by
// docs/plans/reference-integrity-gate.md Cluster C (Phase 5) — the archiver is
// deleted, so its Rule-2 assertion went with it.

function assertAllSitesRetrySyncWrapped(fileRel, { scopeToFunction } = {}) {
  const fileAbsPath = abs(fileRel);
  const { ast } = parseFile(fileAbsPath);
  const retryBindings = collectNamedImportBindings(ast.program, 'retrySync', RETRY_MODULE, fileAbsPath);
  assert.ok(retryBindings.size > 0, `${fileRel} does not import retrySync from the correct path`);

  let sites = findFsMethodSites(ast.program, ['renameSync', 'unlinkSync']);
  if (scopeToFunction) {
    const range = findNamedFunctionRange(ast.program, scopeToFunction);
    assert.ok(range, `could not locate function "${scopeToFunction}" in ${fileRel}`);
    sites = sites.filter((s) => s.node.start >= range.start && s.node.end <= range.end);
  }

  for (const site of sites) {
    const call = site.enclosingCall;
    const wrapped = !!call && call.callee.type === 'Identifier' && retryBindings.has(call.callee.name);
    assert.ok(
      wrapped,
      `${fileRel}:${site.node.loc.start.line} — fs.${site.method} call is not wrapped in retrySync(...)`,
    );
  }
  return sites.length;
}

describe('atomic-write-adoption guard — Rule 2: retrySync wrapping', () => {
  it('persona-consistency-promote.mjs — exactly 12 sites (3 rename + 9 unlink), all wrapped', () => {
    const count = assertAllSitesRetrySyncWrapped('scripts/persona-consistency-promote.mjs');
    assert.equal(count, 12);
  });

  it('backfill-outcomes.mjs::drainFrictionFallback — its unlinkSync sibling is wrapped', () => {
    const count = assertAllSitesRetrySyncWrapped('scripts/learning/backfill-outcomes.mjs', {
      scopeToFunction: 'drainFrictionFallback',
    });
    assert.equal(count, 1);
  });
});
