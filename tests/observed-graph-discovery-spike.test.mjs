/**
 * @fileoverview Tier-1 regression test for the observed-graph discovery
 * spike's package-resolution seam.
 *
 * Closes blocking-unknown #1 of
 * docs/plans/observed-graph-discovery-unification.md. The spike used to
 * import `dependency-cruiser` at its own top level, which ALWAYS resolves
 * relative to THIS repo (claude-engineering-skills) no matter what `--repo`
 * was passed — and this repo has no `typescript` dependency, so dependency-
 * cruiser resolved from here silently loses TypeScript-awareness and
 * mis-resolves extensionless relative TS imports (`couldNotResolve: true`).
 * Measured live on ai-organiser: the broken spike reported 68% of the repo
 * invisible; the real production pipeline (which resolves dependency-cruiser
 * from ai-organiser's OWN node_modules, where `typescript` is a sibling)
 * measured 99%+ coverage the whole time. The bug was in the spike's
 * measurement, not in production.
 *
 * `findPackageDir`/`loadCruiseFn` are the fix: resolve the TARGET repo's own
 * package tree, the way Node's own module resolution would from inside that
 * repo — exactly what the synced `extract.mjs` experiences in production.
 * These tests exercise that resolution against fixture `node_modules` trees
 * (no real dependency-cruiser/typescript install needed) so the seam stays
 * covered without a slow, environment-fragile integration test.
 *
 * Plan: docs/plans/observed-graph-discovery-unification.md §3.1
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { findPackageDir, loadCruiseFn } from '../scripts/spikes/observed-graph-discovery-spike.mjs';

/**
 * A fresh temp dir per test, cleaned up after `fn` settles.
 *
 * Always async, and always `await`s `fn(dir)` — several callers below pass an
 * async `fn` that does real work (dynamic `import()`) after the temp dir is
 * created; a bare `try { return fn(dir) } finally { rmSync }` would delete
 * the directory the instant `fn` returns its (still-pending) promise, not
 * once the work inside it actually finishes.
 */
async function withTempDir(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'discovery-spike-test-'));
  try {
    return await fn(dir);
  } finally {
    // recursive+maxRetries+force+retryDelay: Node's own retry-hardened form
    // (repo-wide contract, tests/rmsync-retry-guard.test.mjs) — a bare
    // {recursive, force} rmSync can throw EPERM/EBUSY on Windows when AV/
    // indexer still holds a handle on a just-closed dynamic-import()ed file.
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  }
}

/** Write a minimal fixture npm package at `<dir>/node_modules/<name>`. */
function writeFixturePackage(dir, name, { version = '1.0.0', exportedValue }) {
  const pkgDir = path.join(dir, 'node_modules', name);
  fs.mkdirSync(pkgDir, { recursive: true });
  fs.writeFileSync(path.join(pkgDir, 'package.json'), JSON.stringify({
    name, version, exports: { '.': { import: './index.mjs' } },
  }));
  fs.writeFileSync(path.join(pkgDir, 'index.mjs'),
    `export const cruise = () => ${JSON.stringify(exportedValue)};\n`);
  return pkgDir;
}

describe('findPackageDir', () => {
  it('finds a package in the immediate node_modules', () => {
    return withTempDir((dir) => {
      const pkgDir = writeFixturePackage(dir, 'dependency-cruiser', { exportedValue: 'here' });
      assert.equal(findPackageDir(dir, 'dependency-cruiser'), pkgDir);
    });
  });

  it('walks up parent directories when not found in the starting dir', () => {
    return withTempDir((dir) => {
      const pkgDir = writeFixturePackage(dir, 'dependency-cruiser', { exportedValue: 'outer' });
      const nested = path.join(dir, 'a', 'b', 'c');
      fs.mkdirSync(nested, { recursive: true });
      assert.equal(findPackageDir(nested, 'dependency-cruiser'), pkgDir);
    });
  });

  it('returns null when the package is not found anywhere up the tree', () => {
    return withTempDir((dir) => {
      assert.equal(findPackageDir(dir, 'dependency-cruiser'), null);
    });
  });

  // The regression this whole fix exists for: two candidate trees exist
  // (one "outer", one specific to the target repo) — the resolver must pick
  // the one closest to (i.e. owned by) the target directory, never a
  // coincidentally-present other one. This is the shape of the real bug:
  // the spike's own tree (claude-engineering-skills) and the target repo's
  // tree (ai-organiser) both have a `dependency-cruiser`, and picking the
  // wrong one is exactly what silently broke TS resolution.
  it('prefers the target-tree package over an unrelated outer one', () => {
    return withTempDir((dir) => {
      writeFixturePackage(dir, 'dependency-cruiser', { exportedValue: 'outer-wrong-tree' });
      const targetRepo = path.join(dir, 'consumer-repo');
      fs.mkdirSync(targetRepo, { recursive: true });
      const innerPkgDir = writeFixturePackage(targetRepo, 'dependency-cruiser', { exportedValue: 'target-repo-own-install' });
      assert.equal(findPackageDir(targetRepo, 'dependency-cruiser'), innerPkgDir);
    });
  });
});

describe('loadCruiseFn', () => {
  it('loads the cruise() function from the TARGET repo\'s own install, not an outer one', async () => {
    await withTempDir(async (dir) => {
      // An outer tree with a DIFFERENT fixture, standing in for "the tool's
      // own repo" — if loadCruiseFn ever regresses to a static top-level
      // import (or resolves from the wrong start dir), this is the value
      // that would come back instead.
      writeFixturePackage(dir, 'dependency-cruiser', { exportedValue: 'WRONG-outer-tree' });

      const targetRepo = path.join(dir, 'consumer-repo');
      fs.mkdirSync(targetRepo, { recursive: true });
      writeFixturePackage(targetRepo, 'dependency-cruiser', { exportedValue: 'right-target-tree' });

      const cruiseFn = await loadCruiseFn(targetRepo);
      assert.equal(cruiseFn(), 'right-target-tree');
    });
  });

  it('throws a clear, actionable error when the target repo has no dependency-cruiser install', async () => {
    await withTempDir(async (dir) => {
      await assert.rejects(
        () => loadCruiseFn(dir),
        /dependency-cruiser is not resolvable from/,
      );
    });
  });

  it('falls back to package.json "main" when there is no ESM exports map', async () => {
    await withTempDir(async (dir) => {
      const pkgDir = path.join(dir, 'node_modules', 'dependency-cruiser');
      fs.mkdirSync(pkgDir, { recursive: true });
      fs.writeFileSync(path.join(pkgDir, 'package.json'), JSON.stringify({
        name: 'dependency-cruiser', version: '0.0.0-fixture', main: './main.mjs',
      }));
      fs.writeFileSync(path.join(pkgDir, 'main.mjs'), `export const cruise = () => 'via-main';\n`);
      const cruiseFn = await loadCruiseFn(dir);
      assert.equal(cruiseFn(), 'via-main');
    });
  });
});

// Sanity check on the constant used across the module — pathToFileURL must
// round-trip a Windows drive-letter path without throwing (the same
// ERR_UNSUPPORTED_ESM_URL_SCHEME class of bug the file's own comments warn
// about for the local-.dependency-cruiser.cjs load path).
describe('pathToFileURL usage (defence against ERR_UNSUPPORTED_ESM_URL_SCHEME)', () => {
  it('produces a URL import() can consume for an absolute path with spaces', () => {
    return withTempDir((dir) => {
      const file = path.join(dir, 'a b', 'mod.mjs');
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, `export const marker = 42;\n`);
      return import(pathToFileURL(file).href).then((m) => assert.equal(m.marker, 42));
    });
  });
});
