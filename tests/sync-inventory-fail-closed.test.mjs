/**
 * @fileoverview Debt 8e5974a92c98: `readSource` turned EVERY filesystem error into
 * `null`, and the closure walker reads `null` as "this file imports nothing". An
 * unreadable entry therefore silently dropped its whole import subtree from the
 * bundle, and the next sync's GC then deleted that subtree from every consumer.
 *
 * A file the walker VISITS is, by construction, a member of the universe that was
 * enumerated from disk a moment earlier, so a read failure on it is a race or a
 * fault, never a retirement. It must throw. A declared entry point that is not on
 * disk must throw too.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { collectImportClosure } from '../scripts/lib/module-graph.mjs';
import {
  readSource, resolveBundle, realMissingDeps, bundleForRepo, SourceReadError, MissingEntryPointError,
} from '../scripts/lib/sync-inventory.mjs';

const fsError = (code) => Object.assign(new Error(`${code} injected`), { code });

describe('readSource — a failed read is never "no imports"', () => {
  it('reads a real source file (positive control: it can succeed)', () => {
    assert.match(readSource('scripts/lib/sync-argv.mjs'), /parseSyncArgv/);
  });

  for (const code of ['EACCES', 'EIO', 'ENOENT', 'EISDIR']) {
    it(`${code} throws SourceReadError naming the file and code`, () => {
      assert.throws(
        () => readSource('scripts/lib/cli-io.mjs', { read: () => { throw fsError(code); } }),
        (err) => err instanceof SourceReadError && err.code === code && err.path === 'scripts/lib/cli-io.mjs',
      );
    });
  }
});

describe('the closure walk — red-then-green on the dropped subtree', () => {
  const ENTRY = ['scripts/lib/sync-receipt.mjs']; // imports exactly one other file
  const real = (rel) => readSource(rel);

  it('PARENT behaviour (catch → null): an unreadable import silently drops its subtree', () => {
    const parentRead = (rel) => {
      try { if (rel === 'scripts/lib/bundle-generated-stores.mjs') throw fsError('EIO'); return real(rel); } catch { return null; }
    };
    const universe = new Set(resolveBundle(ENTRY).files);
    let parent;
    assert.doesNotThrow(() => { parent = collectImportClosure({ entryPoints: ENTRY, repoFiles: universe, readFile: parentRead }); },
      'the parent walker accepts an unreadable file and carries on');
    // ...and reports an ordinary-looking bundle: the failure is invisible to its caller (that silence is the defect).
    assert.ok(parent.files.length >= 1 && Array.isArray(parent.unresolved));
    assert.equal(parent.files.includes('scripts/lib/bundle-generated-stores.mjs'), true,
      'the unreadable file is still listed as shipped while its own imports were never read');
  });

  it('FIXED: the same failure aborts bundle resolution before any consumer is touched', () => {
    assert.throws(
      () => resolveBundle(ENTRY, [], { readFile: (rel) => { if (rel === 'scripts/lib/bundle-generated-stores.mjs') throw new SourceReadError(rel, fsError('EIO')); return real(rel); } }),
      SourceReadError,
    );
  });

  it('a visited file that vanished (ENOENT) throws as well — a retired file is never visited at all', () => {
    assert.throws(
      () => resolveBundle(ENTRY, [], { readFile: (rel) => readSource(rel, { read: () => { throw fsError('ENOENT'); } }) }),
      SourceReadError,
    );
  });

  it('negative control: an untouched resolution succeeds and reaches the dependency', () => {
    assert.ok(resolveBundle(ENTRY).files.includes('scripts/lib/bundle-generated-stores.mjs'));
  });
});

describe('MissingEntryPointError', () => {
  it('a declared entry that is not on disk throws, naming every missing one', () => {
    const exists = (abs) => !/(gone-a|gone-b)\.mjs$/.test(abs);
    assert.throws(
      () => resolveBundle(['scripts/lib/sync-receipt.mjs', 'scripts/gone-a.mjs', 'scripts/gone-b.mjs'], [], { exists }),
      (err) => err instanceof MissingEntryPointError && err.missing.length === 2
        && err.missing.includes('scripts/gone-a.mjs') && err.missing.includes('scripts/gone-b.mjs'),
    );
  });

  it('every entry the real lists declare exists on disk (the check has no false positive on today\'s tree)', () => {
    const bundle = bundleForRepo(); // runs the MissingEntryPoint check against every real entry list
    assert.ok(bundle.files.length > 1000);
  });
});

describe('realMissingDeps (moved with the inventory, behaviour unchanged)', () => {
  it('keeps path-like specifiers and drops template-literal parser noise', () => {
    const real1 = { from: 'a.mjs', specifier: './missing.mjs' };
    const real2 = { from: 'a.mjs', specifier: '../x/y.mjs' };
    const noise = [
      { from: 'a.mjs', specifier: './${basename}' },
      { from: 'a.mjs', specifier: './a b.mjs' },
      { from: 'a.mjs', specifier: '`./x`' },
      { from: 'a.mjs', specifier: 'bare-package' },
    ];
    assert.deepEqual(realMissingDeps([real1, ...noise, real2]), [real1, real2]);
    assert.deepEqual(realMissingDeps(undefined), []);
  });
});
