import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { parse } from '@babel/parser';
import _traverse from '@babel/traverse';
import {
  resolvesToNamedImport,
  resolveNamedImportBinding,
  resolvesToModuleBinding,
  findSyncCallbackWrapper,
  classifyCallbackWrapper,
} from '../scripts/lib/import-binding.mjs';

// @babel/traverse ships CJS; under ESM the callable lands on .default (and on
// .default.default via some interop paths). Same normalisation as
// find-rmsync-sites.mjs / adjacency-detector.mjs.
const traverse = _traverse?.default?.default ?? _traverse?.default ?? _traverse;

const REPO_ROOT = path.resolve(import.meta.dirname, '..');
// Virtual paths — no real files are read; only `path.resolve`'s arithmetic is
// exercised, mirroring the "fixed module id" simplification the plan's own
// throwaway harness (sa-verify2.mjs) used.
const CONSUMER_ABS = path.resolve(REPO_ROOT, 'virtual/src/consumer.mjs');
const FILE_IO_ABS = path.resolve(REPO_ROOT, 'virtual/lib/file-io.mjs');
const OTHER_FILE_IO_ABS = path.resolve(REPO_ROOT, 'virtual/lib/other-file-io.mjs');
const FS_SOURCES = new Set(['node:fs', 'fs']);

const NAMED_SPEC = { importedName: 'atomicWriteFileSync', moduleAbsPath: FILE_IO_ABS, fromFileAbsPath: CONSUMER_ABS };
const MODULE_SPEC = { moduleSources: FS_SOURCES };

/**
 * Parse `source` and return the NodePath of the callee identifier (bare call,
 * e.g. `write(a, b)`) or the callee's object identifier (member call, e.g.
 * `fs.renameSync(a, b)`, when `memberProp` is given) for the first
 * CallExpression whose local callee name matches.
 */
function findCalleeIdentifierPath(source, name, { memberProp } = {}) {
  const ast = parse(source, { sourceType: 'module', plugins: [] });
  let result = null;
  traverse(ast, {
    CallExpression(callPath) {
      if (result) return;
      const callee = callPath.node.callee;
      if (memberProp) {
        if (
          callee.type === 'MemberExpression'
          && !callee.computed
          && callee.property.type === 'Identifier'
          && callee.property.name === memberProp
          && callee.object.type === 'Identifier'
          && callee.object.name === name
        ) {
          result = callPath.get('callee').get('object');
        }
      } else if (callee.type === 'Identifier' && callee.name === name) {
        result = callPath.get('callee');
      }
    },
  });
  assert.ok(result, `fixture bug: no call site found for ${name}${memberProp ? `.${memberProp}` : ''}`);
  return result;
}

/**
 * Parse `source` and return `{ node, ancestors }` for the first CallExpression
 * matching `matchFn`, in the root-to-immediate-parent raw-node shape
 * findSyncCallbackWrapper expects (mirrors find-rmsync-sites.mjs's own
 * `path.getAncestry().slice(1).reverse().map((p) => p.node)` construction).
 */
function findSiteWithAncestry(source, matchFn) {
  const ast = parse(source, { sourceType: 'module', plugins: [] });
  let result = null;
  traverse(ast, {
    CallExpression(callPath) {
      if (result || !matchFn(callPath.node)) return;
      const ancestors = callPath.getAncestry().slice(1).reverse().map((p) => p.node);
      result = { node: callPath.node, ancestors };
    },
  });
  assert.ok(result, 'fixture bug: no matching call site found for wrapper test');
  return result;
}

const isRenameSyncCall = (node) =>
  node.callee.type === 'MemberExpression'
  && !node.callee.computed
  && node.callee.property.type === 'Identifier'
  && node.callee.property.name === 'renameSync';

describe('import-binding — resolvesToNamedImport', () => {
  it('named-plain: plain named import, direct call — true', () => {
    const src = `
      import { atomicWriteFileSync } from '../lib/file-io.mjs';
      function apply() { atomicWriteFileSync(a, b); }
    `;
    const idPath = findCalleeIdentifierPath(src, 'atomicWriteFileSync');
    assert.equal(resolvesToNamedImport(idPath, NAMED_SPEC), true);
  });

  it('named-aliased: import aliased to a different local name — true', () => {
    const src = `
      import { atomicWriteFileSync as write } from '../lib/file-io.mjs';
      function apply() { write(a, b); }
    `;
    const idPath = findCalleeIdentifierPath(src, 'write');
    assert.equal(resolvesToNamedImport(idPath, NAMED_SPEC), true);
  });

  it('named-es2022-string-form: string-literal imported-name spelling — true', () => {
    const src = `
      import { "atomicWriteFileSync" as write } from '../lib/file-io.mjs';
      function apply() { write(a, b); }
    `;
    const idPath = findCalleeIdentifierPath(src, 'write');
    assert.equal(resolvesToNamedImport(idPath, NAMED_SPEC), true);
  });

  it('named-shadowed-by-param: local name shadowed by a function parameter — false', () => {
    const src = `
      import { atomicWriteFileSync } from '../lib/file-io.mjs';
      function apply(atomicWriteFileSync) { atomicWriteFileSync(a, b); }
    `;
    const idPath = findCalleeIdentifierPath(src, 'atomicWriteFileSync');
    assert.equal(resolvesToNamedImport(idPath, NAMED_SPEC), false);
  });

  it('named-shadowed-by-local-const: local name shadowed by a const declaration — false', () => {
    const src = `
      import { atomicWriteFileSync } from '../lib/file-io.mjs';
      function apply() {
        const atomicWriteFileSync = (p, d) => fs.writeFileSync(p, d);
        atomicWriteFileSync(a, b);
      }
    `;
    const idPath = findCalleeIdentifierPath(src, 'atomicWriteFileSync');
    assert.equal(resolvesToNamedImport(idPath, NAMED_SPEC), false);
  });

  it('named-shadowed-by-catch-binding: local name shadowed by a catch clause parameter — false', () => {
    const src = `
      import { atomicWriteFileSync } from '../lib/file-io.mjs';
      function apply() {
        try { risky(); } catch (atomicWriteFileSync) { atomicWriteFileSync(a, b); }
      }
    `;
    const idPath = findCalleeIdentifierPath(src, 'atomicWriteFileSync');
    assert.equal(resolvesToNamedImport(idPath, NAMED_SPEC), false);
  });

  it('named-same-name-different-module: same local + exported name, wrong module source — false', () => {
    const src = `
      import { atomicWriteFileSync } from '../lib/other-file-io.mjs';
      function apply() { atomicWriteFileSync(a, b); }
    `;
    const idPath = findCalleeIdentifierPath(src, 'atomicWriteFileSync');
    assert.equal(resolvesToNamedImport(idPath, NAMED_SPEC), false);
    // Sanity: the fixture really does resolve to a DIFFERENT module, not the
    // expected one — otherwise this test would pass for the wrong reason.
    assert.notEqual(OTHER_FILE_IO_ABS, FILE_IO_ABS);
  });

  it('named-unresolvable-global: no import at all, binding does not resolve — false', () => {
    const src = `function apply() { atomicWriteFileSync(a, b); }`;
    const idPath = findCalleeIdentifierPath(src, 'atomicWriteFileSync');
    assert.equal(resolvesToNamedImport(idPath, NAMED_SPEC), false);
  });

  it('named-decoy-wrong-export-aliased-to-expected-local: local spelling matches, imported name does not — false', () => {
    const src = `
      import { somethingElse as atomicWriteFileSync } from '../lib/file-io.mjs';
      function apply() { atomicWriteFileSync(a, b); }
    `;
    const idPath = findCalleeIdentifierPath(src, 'atomicWriteFileSync');
    assert.equal(resolvesToNamedImport(idPath, NAMED_SPEC), false);
  });
});

describe('import-binding — resolveNamedImportBinding (discriminated form, round-3 M4)', () => {
  it("matched: genuine reference to the expected import — 'matched'", () => {
    const src = `
      import { atomicWriteFileSync } from '../lib/file-io.mjs';
      function apply() { atomicWriteFileSync(a, b); }
    `;
    const idPath = findCalleeIdentifierPath(src, 'atomicWriteFileSync');
    assert.equal(resolveNamedImportBinding(idPath, NAMED_SPEC), 'matched');
  });

  it("different-binding: shadowed by a parameter — 'different-binding', not 'unresolvable'", () => {
    const src = `
      import { atomicWriteFileSync } from '../lib/file-io.mjs';
      function apply(atomicWriteFileSync) { atomicWriteFileSync(a, b); }
    `;
    const idPath = findCalleeIdentifierPath(src, 'atomicWriteFileSync');
    assert.equal(resolveNamedImportBinding(idPath, NAMED_SPEC), 'different-binding');
  });

  it("different-binding: resolves to an import, but the wrong module — 'different-binding'", () => {
    const src = `
      import { atomicWriteFileSync } from '../lib/other-file-io.mjs';
      function apply() { atomicWriteFileSync(a, b); }
    `;
    const idPath = findCalleeIdentifierPath(src, 'atomicWriteFileSync');
    assert.equal(resolveNamedImportBinding(idPath, NAMED_SPEC), 'different-binding');
  });

  it("unresolvable: no import at all, binding does not resolve — 'unresolvable', not 'different-binding'", () => {
    const src = `function apply() { atomicWriteFileSync(a, b); }`;
    const idPath = findCalleeIdentifierPath(src, 'atomicWriteFileSync');
    assert.equal(resolveNamedImportBinding(idPath, NAMED_SPEC), 'unresolvable');
  });

  it('resolvesToNamedImport is exactly the matched projection of this result', () => {
    const matchedSrc = `
      import { atomicWriteFileSync } from '../lib/file-io.mjs';
      function apply() { atomicWriteFileSync(a, b); }
    `;
    const shadowedSrc = `
      import { atomicWriteFileSync } from '../lib/file-io.mjs';
      function apply(atomicWriteFileSync) { atomicWriteFileSync(a, b); }
    `;
    const matchedPath = findCalleeIdentifierPath(matchedSrc, 'atomicWriteFileSync');
    const shadowedPath = findCalleeIdentifierPath(shadowedSrc, 'atomicWriteFileSync');
    assert.equal(resolvesToNamedImport(matchedPath, NAMED_SPEC), resolveNamedImportBinding(matchedPath, NAMED_SPEC) === 'matched');
    assert.equal(resolvesToNamedImport(shadowedPath, NAMED_SPEC), resolveNamedImportBinding(shadowedPath, NAMED_SPEC) === 'matched');
  });
});

describe('import-binding — resolvesToModuleBinding', () => {
  it('module-default: default import, member call — true', () => {
    const src = `
      import fs from 'node:fs';
      function apply() { fs.renameSync(a, b); }
    `;
    const idPath = findCalleeIdentifierPath(src, 'fs', { memberProp: 'renameSync' });
    assert.equal(resolvesToModuleBinding(idPath, MODULE_SPEC), true);
  });

  it('module-namespace: namespace import, member call — true', () => {
    const src = `
      import * as fs from 'node:fs';
      function apply() { fs.renameSync(a, b); }
    `;
    const idPath = findCalleeIdentifierPath(src, 'fs', { memberProp: 'renameSync' });
    assert.equal(resolvesToModuleBinding(idPath, MODULE_SPEC), true);
  });

  it('module-default-as-named: `{ default as fs }` spelling — true', () => {
    const src = `
      import { default as fs } from 'node:fs';
      function apply() { fs.renameSync(a, b); }
    `;
    const idPath = findCalleeIdentifierPath(src, 'fs', { memberProp: 'renameSync' });
    assert.equal(resolvesToModuleBinding(idPath, MODULE_SPEC), true);
  });

  it('module-shadowed-by-param: local name shadowed by a function parameter — false', () => {
    const src = `
      import fs from 'node:fs';
      function apply(fs) { fs.renameSync(a, b); }
    `;
    const idPath = findCalleeIdentifierPath(src, 'fs', { memberProp: 'renameSync' });
    assert.equal(resolvesToModuleBinding(idPath, MODULE_SPEC), false);
  });

  it('module-same-name-different-module: same local name, wrong module source — false', () => {
    const src = `
      import fs from 'graceful-fs';
      function apply() { fs.renameSync(a, b); }
    `;
    const idPath = findCalleeIdentifierPath(src, 'fs', { memberProp: 'renameSync' });
    assert.equal(resolvesToModuleBinding(idPath, MODULE_SPEC), false);
  });
});

describe('import-binding — findSyncCallbackWrapper', () => {
  it('wrapper-sync-concise: concise-body sync arrow — returns the outer call', () => {
    const src = `retrySync(() => fs.renameSync(a, b));`;
    const { node, ancestors } = findSiteWithAncestry(src, isRenameSyncCall);
    const outer = findSyncCallbackWrapper(node, ancestors);
    assert.ok(outer);
    assert.equal(outer.callee.name, 'retrySync');
  });

  it('wrapper-sync-block: block-body sync arrow with an explicit return — returns the outer call', () => {
    const src = `retrySync(() => { return fs.renameSync(a, b); });`;
    const { node, ancestors } = findSiteWithAncestry(src, isRenameSyncCall);
    const outer = findSyncCallbackWrapper(node, ancestors);
    assert.ok(outer);
    assert.equal(outer.callee.name, 'retrySync');
  });

  it('wrapper-async-concise: concise-body ASYNC arrow — null (not retry-protected at runtime)', () => {
    const src = `retrySync(async () => fs.renameSync(a, b));`;
    const { node, ancestors } = findSiteWithAncestry(src, isRenameSyncCall);
    assert.equal(findSyncCallbackWrapper(node, ancestors), null);
  });

  it('wrapper-async-block: block-body ASYNC arrow with an explicit return — null', () => {
    const src = `retrySync(async () => { return fs.renameSync(a, b); });`;
    const { node, ancestors } = findSiteWithAncestry(src, isRenameSyncCall);
    assert.equal(findSyncCallbackWrapper(node, ancestors), null);
  });
});

describe('import-binding — classifyCallbackWrapper (round-5 M1: one shared ancestor-chain classifier)', () => {
  it("sync wrapper — status 'sync-wrapper', callNode is the outer call", () => {
    const src = `retrySync(() => fs.renameSync(a, b));`;
    const { node, ancestors } = findSiteWithAncestry(src, isRenameSyncCall);
    const result = classifyCallbackWrapper(node, ancestors);
    assert.equal(result.status, 'sync-wrapper');
    assert.equal(result.callNode.callee.name, 'retrySync');
  });

  it("async wrapper — status 'async-wrapper', callNode STILL populated (unlike findSyncCallbackWrapper's null)", () => {
    const src = `retrySync(async () => fs.renameSync(a, b));`;
    const { node, ancestors } = findSiteWithAncestry(src, isRenameSyncCall);
    const result = classifyCallbackWrapper(node, ancestors);
    assert.equal(result.status, 'async-wrapper');
    assert.equal(result.callNode.callee.name, 'retrySync');
  });

  it("no wrapper at all — status 'no-wrapper', callNode null", () => {
    const src = `fs.renameSync(a, b);`;
    const { node, ancestors } = findSiteWithAncestry(src, isRenameSyncCall);
    const result = classifyCallbackWrapper(node, ancestors);
    assert.equal(result.status, 'no-wrapper');
    assert.equal(result.callNode, null);
  });

  it('findSyncCallbackWrapper is exactly the sync-wrapper projection of this classifier', () => {
    for (const src of [
      `retrySync(() => fs.renameSync(a, b));`,
      `retrySync(async () => fs.renameSync(a, b));`,
      `fs.renameSync(a, b);`,
    ]) {
      const { node, ancestors } = findSiteWithAncestry(src, isRenameSyncCall);
      const classified = classifyCallbackWrapper(node, ancestors);
      const projected = classified.status === 'sync-wrapper' ? classified.callNode : null;
      assert.equal(findSyncCallbackWrapper(node, ancestors), projected);
    }
  });
});

describe('import-binding — spec contract', () => {
  it('spec-both-forms-throws: supplying moduleSources AND the abs-path form throws', () => {
    const badSpec = {
      importedName: 'x',
      moduleSources: new Set(['fs']),
      moduleAbsPath: FILE_IO_ABS,
      fromFileAbsPath: CONSUMER_ABS,
    };
    // Validation runs before any node access, so a caller bug is caught even
    // with no real identifierPath to resolve against.
    for (const fn of [resolvesToNamedImport, resolvesToModuleBinding]) {
      assert.throws(() => fn(null, badSpec));
    }
  });

  it('spec-neither-form-throws: supplying neither form throws', () => {
    const badSpec = { importedName: 'x' };
    for (const fn of [resolvesToNamedImport, resolvesToModuleBinding]) {
      assert.throws(() => fn(null, badSpec));
    }
  });

  it('spec-partial-abs-path-throws: only one of {moduleAbsPath, fromFileAbsPath} throws (round-4 L1)', () => {
    for (const partial of [{ moduleAbsPath: FILE_IO_ABS }, { fromFileAbsPath: CONSUMER_ABS }]) {
      const badSpec = { importedName: 'x', ...partial };
      for (const fn of [resolvesToNamedImport, resolvesToModuleBinding]) {
        assert.throws(() => fn(null, badSpec));
      }
    }
  });

  it('spec-module-sources-plus-partial-abs-path-throws: a stray abs-path field alongside moduleSources throws', () => {
    const badSpec = { importedName: 'x', moduleSources: new Set(['fs']), moduleAbsPath: FILE_IO_ABS };
    for (const fn of [resolvesToNamedImport, resolvesToModuleBinding]) {
      assert.throws(() => fn(null, badSpec));
    }
  });
});
