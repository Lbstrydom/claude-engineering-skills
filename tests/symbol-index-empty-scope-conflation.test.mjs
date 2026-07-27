/**
 * @fileoverview Regression guard for b021576b: `restrictFiles === null`
 * (no restriction, full walk) and `restrictFiles === []` (a valid
 * incremental scope of ZERO files) were being treated identically —
 * `enumerateFiles` fell back to a full repo walk, and `isFullRun`
 * (now `isFullRunFromFiles`) measured coverage as a full run, whenever the
 * caller's resolved scope was legitimately empty rather than unrestricted.
 */
import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { enumerateFiles, isFullRunFromFiles } from '../scripts/symbol-index/extract.mjs';

describe('isFullRunFromFiles', () => {
  it('null (no --files/--files-from at all) is a full run', () => {
    assert.equal(isFullRunFromFiles(null), true);
  });

  it('[] (a resolved incremental scope of zero files) is NOT a full run', () => {
    assert.equal(isFullRunFromFiles([]), false);
  });

  it('a non-empty file list is not a full run', () => {
    assert.equal(isFullRunFromFiles(['a.mjs']), false);
  });
});

describe('enumerateFiles — null vs [] restrictFiles', () => {
  const tmpDirs = [];
  after(() => {
    while (tmpDirs.length) {
      const d = tmpDirs.pop();
      try { fs.rmSync(d, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }); } catch { /* best-effort */ }
    }
  });

  it('null walks the whole repo (returns something, since this test file itself exists on disk)', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'enumerate-files-null-'));
    tmpDirs.push(root);
    fs.writeFileSync(path.join(root, 'a.mjs'), 'export const x = 1;');
    fs.writeFileSync(path.join(root, 'b.mjs'), 'export const y = 2;');
    const files = enumerateFiles(root, null);
    assert.equal(files.length, 2, 'a null restriction must walk and find every file in the root');
  });

  it('[] (empty array) returns ZERO files — must NOT fall back to a full walk (b021576b)', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'enumerate-files-empty-'));
    tmpDirs.push(root);
    fs.writeFileSync(path.join(root, 'a.mjs'), 'export const x = 1;');
    fs.writeFileSync(path.join(root, 'b.mjs'), 'export const y = 2;');
    const files = enumerateFiles(root, []);
    assert.deepEqual(files, [], 'an empty restriction must return zero files, not walk the repo');
  });

  it('a non-empty restriction returns exactly those files, resolved to absolute paths', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'enumerate-files-restricted-'));
    tmpDirs.push(root);
    fs.writeFileSync(path.join(root, 'a.mjs'), 'export const x = 1;');
    fs.writeFileSync(path.join(root, 'b.mjs'), 'export const y = 2;');
    const files = enumerateFiles(root, ['a.mjs']);
    assert.deepEqual(files, [path.join(root, 'a.mjs')]);
  });
});
