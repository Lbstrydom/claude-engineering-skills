/**
 * @fileoverview `emptyIndexWarning` — the warning a full refresh owes when it
 * published an index with 0 symbols. It may only name a cause the evidence
 * supports, and a failure to enumerate the tracked tree is "unknown", not "empty".
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { emptyIndexWarning } from '../scripts/lib/symbol-index/graph-coverage.mjs';

const idx = ['.ts', '.js'];
const py = Array.from({ length: 5 }, (_, i) => `pkg/m${i}.py`).concat(['data/a.csv', 'README.md']);
const base = { symbolCount: 0, mode: 'full', trackedFiles: py, indexedExtensions: idx };

describe('emptyIndexWarning', () => {
  it('no indexed-type file at all: names what is tracked and that the languages are not indexed', () => {
    const w = emptyIndexWarning(base);
    assert.match(w, /0 symbols over 7 tracked file/);
    assert.match(w, /\.py 5/);
    assert.match(w, /\.ts \.js/);
    assert.match(w, /languages are not indexed/);
    assert.match(w, /NOT "no similar code"/);
  });

  it('indexed-type files exist but no symbol came out: does NOT claim the language is unsupported', () => {
    const w = emptyIndexWarning({ ...base, trackedFiles: ['a.ts', 'b.ts', 'c.md'] });
    assert.match(w, /2 are of a type the index reads, yet no symbol was extracted/);
    assert.doesNotMatch(w, /languages are not indexed/);
  });

  it('git could not list the tree (null): an explicit incomplete-check warning, not silence', () => {
    const w = emptyIndexWarning({ ...base, trackedFiles: null });
    assert.match(w, /could not list tracked files/);
  });

  it('CONTROLS: symbols published, an incremental run, or a genuinely empty tree owe nothing', () => {
    assert.equal(emptyIndexWarning({ ...base, symbolCount: 3 }), null);
    assert.equal(emptyIndexWarning({ ...base, mode: 'incremental' }), null);
    assert.equal(emptyIndexWarning({ ...base, trackedFiles: [] }), null);
    assert.equal(emptyIndexWarning({ ...base, symbolCount: 4, trackedFiles: null }), null);
    assert.equal(emptyIndexWarning({ ...base, mode: 'incremental', trackedFiles: null }), null);
  });
});
