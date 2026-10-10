/**
 * @fileoverview The glob seam (scripts/lib/glob.mjs). Pins the micromatch
 * semantics callers relied on (list negation, any-of, brace alternation, dot
 * files) now that the engine is picomatch, and that the vulnerable recursive
 * brace expander is gone (GHSA-vfj7-8cjw-p6xm).
 */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';

import { filterMatches, isMatch, matcher } from '../scripts/lib/glob.mjs';
import { readBundleDeps } from '../scripts/lib/install/bundle-deps.mjs';

describe('glob seam', () => {
  test('filterMatches: "!" patterns are EXCLUSIONS (micromatch list semantics), not independent matchers', () => {
    const files = ['a.js', 'b.md', 'c/d.js', '.hidden.js'];
    assert.deepEqual(filterMatches(files, ['**/*.js', '!c/**'], { dot: true }), ['a.js', '.hidden.js']);
    assert.deepEqual(filterMatches(files, ['!*.md'], { dot: true }), ['a.js', 'c/d.js', '.hidden.js'], 'only negations: everything but them');
    assert.deepEqual(filterMatches(files, [], { dot: true }), files, 'no patterns: nothing excluded');
    assert.deepEqual(filterMatches(files, '*.md'), ['b.md'], 'a single string pattern');
  });

  test('isMatch is any-of; dot files follow the dot option', () => {
    assert.equal(isMatch('src/a.mjs', ['lib/**', 'src/**']), true);
    assert.equal(isMatch('src/.env', 'src/*'), false);
    assert.equal(isMatch('src/.env', 'src/*', { dot: true }), true);
    assert.equal(isMatch('x', []), false);
    assert.equal(matcher([])('anything'), false);
  });

  test('brace alternation still matches', () => {
    assert.equal(isMatch('docs/a.md', 'docs/*.{md,txt}'), true);
    assert.equal(isMatch('docs/a.js', 'docs/*.{md,txt}'), false);
  });

  test('a negative EXTGLOB `!(…)` is a positive pattern, not a list exclusion (R1-M5)', () => {
    const list = ['a.mjs', 'a.test.mjs', 'b.md'];
    assert.deepEqual(filterMatches(list, ['!(*.test).mjs']), ['a.mjs'], 'the extglob selects; it is not stripped to "(*.test).mjs" and inverted');
    assert.deepEqual(filterMatches(list, ['*.mjs', '!*.test.mjs']), ['a.mjs'], 'a plain leading ! is still an exclusion');
    assert.deepEqual(filterMatches(list, ['**', '!!(*.md)']), ['b.md'], 'an exclusion OF a negative extglob: drop everything that is not *.md');
  });

  test('deeply nested braces never exhaust the stack (the braces CVE shape)', () => {
    const nested = `${'{a,'.repeat(3000)}b${'}'.repeat(3000)}`;
    let threw = null;
    let result;
    try { result = isMatch('a', nested); } catch (err) { threw = err; }
    assert.ok(!(threw instanceof RangeError), `no stack overflow (got ${threw?.message ?? result})`);
  });

  test('the engine is installed, declared to consumers, and the vulnerable expander is not', () => {
    const require = createRequire(import.meta.url);
    assert.doesNotThrow(() => require.resolve('picomatch'));
    const root = path.resolve(import.meta.dirname, '..');
    const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
    assert.equal(pkg.dependencies.micromatch, undefined, 'micromatch (and with it braces) is no longer a dependency');
    const lock = JSON.parse(fs.readFileSync(path.join(root, 'package-lock.json'), 'utf8'));
    assert.equal(Object.keys(lock.packages).some((k) => k.endsWith('node_modules/braces')), false, 'braces is not in the lockfile');
    const declared = readBundleDeps(path.join(root, 'scripts')).packages.find((p) => p.name === 'picomatch');
    assert.ok(declared?.importers.some((p) => p.endsWith('lib/glob.mjs')), 'the synced bundle declares picomatch, so consumers install it');
  });
});
