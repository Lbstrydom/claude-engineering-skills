/**
 * @fileoverview The consumer dependency contract — derived, not hand-written.
 *
 * Guards the upstream#57 class: the synced bundle grows an import, nobody
 * updates the installer's dep list, and every consumer that lacks the package
 * dies with ERR_MODULE_NOT_FOUND at the first entry point that touches it.
 * `@babel/traverse` did exactly this to wine-cellar-app's `/audit-plan`.
 *
 * The fix is derivation (`requiredDeps()` reads the import graph), so the
 * interesting assertions here are the ones that would catch the derivation
 * itself silently returning nothing — the "can this go green having checked
 * nothing?" rule from AGENTS.md.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { bundleDeps, requiredDeps, OPTIONAL_DEPS, findMissingDeps } from '../scripts/lib/install/deps.mjs';
import { packageNameFromSpecifier, collectImportClosure } from '../scripts/lib/module-graph.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

describe('consumer dependency contract', () => {
  it('derives a non-empty dependency set', () => {
    // The failure this guards: a broken walk returns [], findMissingDeps
    // reports nothing missing, and every consumer reads "all deps present"
    // while the bundle is unrunnable. Green-having-checked-nothing.
    assert.ok(bundleDeps().length >= 10, `expected a real dep set, got ${bundleDeps().length}`);
  });

  it('includes the packages whose absence broke a consumer (upstream#57)', () => {
    const deps = bundleDeps();
    for (const pkg of ['@babel/parser', '@babel/traverse']) {
      assert.ok(deps.includes(pkg), `${pkg} must be in the derived contract`);
    }
  });

  it('classifies every derived dep as required or optional, with no overlap', () => {
    const required = new Set(requiredDeps());
    const optional = new Set(OPTIONAL_DEPS);
    for (const pkg of bundleDeps()) {
      assert.ok(
        required.has(pkg) !== optional.has(pkg),
        `${pkg} must be exactly one of required/optional`,
      );
    }
  });

  it('has no stale OPTIONAL_DEPS entry the bundle no longer imports', () => {
    // A hand-curated list is allowed to exist, but not to rot: an entry the
    // graph never sees means the curation is describing a bundle that is gone.
    const derived = new Set(bundleDeps());
    const stale = OPTIONAL_DEPS.filter(d => !derived.has(d));
    assert.deepEqual(stale, [], `stale OPTIONAL_DEPS: ${stale.join(', ')}`);
  });

  it('every required dep is declared in the source package.json', () => {
    // The source repo must be able to run what it ships, and `npm install`
    // in a consumer resolves the same versions.
    const pkg = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf-8'));
    const declared = new Set([
      ...Object.keys(pkg.dependencies || {}),
      ...Object.keys(pkg.devDependencies || {}),
    ]);
    const undeclared = requiredDeps().filter(d => !declared.has(d));
    assert.deepEqual(undeclared, [], `bundle imports but source package.json omits: ${undeclared.join(', ')}`);
  });

  it('findMissingDeps reports nothing for a repo with no package.json', () => {
    const res = findMissingDeps(path.join(REPO_ROOT, 'tests', '__no_such_repo__'));
    assert.equal(res.hasPackageJson, false);
    assert.deepEqual(res.missing, []);
  });
});

describe('packageNameFromSpecifier', () => {
  it('extracts plain and scoped package names, ignoring subpaths', () => {
    assert.equal(packageNameFromSpecifier('openai'), 'openai');
    assert.equal(packageNameFromSpecifier('@babel/traverse'), '@babel/traverse');
    assert.equal(packageNameFromSpecifier('zod/v4'), 'zod');
    assert.equal(packageNameFromSpecifier('@google/genai/dist/x.js'), '@google/genai');
  });

  it('rejects node builtins — nothing to install', () => {
    assert.equal(packageNameFromSpecifier('node:fs'), null);
    assert.equal(packageNameFromSpecifier('fs'), null);
    assert.equal(packageNameFromSpecifier('path'), null);
  });

  it('rejects relative specifiers', () => {
    assert.equal(packageNameFromSpecifier('./a.mjs'), null);
    assert.equal(packageNameFromSpecifier('../lib/b.mjs'), null);
  });

  it('rejects prose caught by the import regex, rather than guessing', () => {
    // parseImports is a regex, so doc-comment and template-literal fragments
    // reach here. A dep contract built from these would be junk.
    for (const noise of [
      'write the final result to disk',
      'https:',
      'C:\\repo\\.dependency-cruiser.cjs',
      'Foo',                 // capitals are not valid npm names
      '',
    ]) {
      assert.equal(packageNameFromSpecifier(noise), null, `should reject: ${JSON.stringify(noise)}`);
    }
  });
});

describe('collectImportClosure external bucket', () => {
  const FILES = {
    'scripts/entry.mjs': [
      "import { x } from './lib/a.mjs';",
      "import 'node:fs';",
      "import { parse } from '@babel/parser';",
    ].join('\n'),
    'scripts/lib/a.mjs': "import traverse from '@babel/traverse';\nimport { z } from './missing.mjs';",
  };
  const repoFiles = new Set(Object.keys(FILES));
  const readFile = (rel) => (rel in FILES ? FILES[rel] : null);

  it('reports bare deps as external, with their importer', () => {
    const { external } = collectImportClosure({ entryPoints: ['scripts/entry.mjs'], repoFiles, readFile });
    const pkgs = external.map(e => e.pkg).sort();
    assert.deepEqual(pkgs, ['@babel/parser', '@babel/traverse']);
    assert.equal(external.find(e => e.pkg === '@babel/traverse').from, 'scripts/lib/a.mjs');
  });

  it('keeps external and unresolved disjoint', () => {
    const { external, unresolved } = collectImportClosure({ entryPoints: ['scripts/entry.mjs'], repoFiles, readFile });
    assert.deepEqual(unresolved.map(u => u.specifier), ['./missing.mjs']);
    assert.equal(external.some(e => e.specifier === './missing.mjs'), false);
  });

  it('excludes node builtins from external', () => {
    const { external } = collectImportClosure({ entryPoints: ['scripts/entry.mjs'], repoFiles, readFile });
    assert.equal(external.some(e => e.specifier === 'node:fs'), false);
  });
});
