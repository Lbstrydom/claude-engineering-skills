/**
 * @fileoverview The lock worksheet's test-file suggestion.
 *
 * Reported from wine-cellar-app 2026-08-01: the worksheet computed ONE path,
 * `tests/<basename>.test.mjs`, and printed "none found — write one" whenever it
 * missed. That formula encodes this repo's flat layout and `.mjs` extension;
 * the consumer uses `tests/unit/**\/<name>.test.js`, so every suggestion came
 * back empty for findings whose test already existed — and following the
 * worksheet would have produced duplicate suites. The tooling syncs to consumer
 * repos, which is exactly why a layout assumption baked into it is wrong
 * everywhere but here.
 *
 * @module tests/test-file-search
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { findTestFilesFor, testStemFor } from '../scripts/lib/test-file-search.mjs';

describe('testStemFor', () => {
  it('drops exactly one extension', () => {
    assert.equal(testStemFor('src/public/cellarSwitcher.js'), 'cellarSwitcher');
    assert.equal(testStemFor('scripts/lib/db/query.mjs'), 'query');
    assert.equal(testStemFor('src/foo.config.ts'), 'foo.config');
  });

  it('returns empty for the shapes that cannot be matched on', () => {
    for (const p of ['', null, undefined, '.env', 'a/.gitignore']) {
      assert.equal(testStemFor(p), '', `${JSON.stringify(p)} must yield no stem`);
    }
  });

  it('reads a Windows-separated path the same as a POSIX one', () => {
    assert.equal(testStemFor('src\\public\\cellarSwitcher.js'), 'cellarSwitcher');
  });
});

describe('findTestFilesFor — layout independence (the reported defect)', () => {
  let root;

  before(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'testsearch-'));
    const mk = (rel, body = '') => {
      const abs = path.join(root, rel);
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, body);
    };
    // The consumer's layout — nested, `.js`, not `.mjs`.
    mk('tests/unit/public/cellarSwitcher.test.js');
    mk('tests/unit/restaurantPairing/state.test.js');
    // A shallower same-named match, to pin the ordering rule.
    mk('tests/state.spec.ts');
    // Noise that must never match.
    mk('tests/unit/public/cellarSwitcherHelpers.test.js');
    mk('src/public/cellarSwitcher.js');
    mk('node_modules/pkg/tests/state.test.js');
  });

  after(() => { fs.rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }); });

  it('finds a nested .test.js the old tests/<base>.test.mjs formula missed', () => {
    assert.deepEqual(
      findTestFilesFor('src/public/cellarSwitcher.js', root),
      ['tests/unit/public/cellarSwitcher.test.js']);
  });

  it('matches .spec as well as .test, shallowest first for a stable suggestion', () => {
    // A worksheet whose suggestion changes between identical runs is not a
    // worksheet — the ordering is the contract, not an implementation detail.
    assert.deepEqual(
      findTestFilesFor('src/restaurantPairing/state.js', root),
      ['tests/state.spec.ts', 'tests/unit/restaurantPairing/state.test.js']);
  });

  it('never matches a prefix — cellarSwitcherHelpers is a different module', () => {
    const hits = findTestFilesFor('src/public/cellarSwitcher.js', root);
    assert.ok(!hits.some((h) => h.includes('Helpers')));
  });

  it('never walks node_modules', () => {
    const hits = findTestFilesFor('src/state.js', root);
    assert.ok(!hits.some((h) => h.includes('node_modules')),
      'a dependency\'s test is not this repo\'s regression lock');
  });

  it('returns empty — not a guess — when nothing matches', () => {
    assert.deepEqual(findTestFilesFor('src/neverTested.js', root), []);
  });

  it('a repo with no test root is a non-result, never a throw', () => {
    const bare = fs.mkdtempSync(path.join(os.tmpdir(), 'testsearch-bare-'));
    try {
      assert.deepEqual(findTestFilesFor('src/foo.js', bare), []);
    } finally {
      fs.rmSync(bare, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
    }
  });

  it('a regex-special stem is matched literally, not as a pattern', () => {
    assert.deepEqual(findTestFilesFor('src/foo.config.ts', root), [],
      'the `.` in the stem must not match any character');
  });
});

describe('findTestFilesFor — against this repo', () => {
  it('resolves a real source file to its real test', () => {
    const repoRoot = path.resolve(import.meta.dirname, '..');
    const hits = findTestFilesFor('scripts/lib/test-file-search.mjs', repoRoot);
    assert.deepEqual(hits, ['tests/test-file-search.test.mjs']);
  });
});
