/**
 * @fileoverview Regression tests for extractSymbols()'s statFailures/
 * parseFailures counters (docs/plans/audit-backlog-triage-hardening.md
 * item 7, audit 9cc6f93b, 2026-07-17). Before this fix, a statSync failure
 * or a source-file parse/add failure was swallowed with no counter and no
 * result-shape signal — a run could report a clean summary while silently
 * omitting files. These tests assert the counters increment and the run
 * still completes (fail-open, count-don't-crash — matching this file's
 * existing failure philosophy elsewhere).
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Project } from 'ts-morph';
import { extractSymbols } from '../scripts/symbol-index/extract.mjs';

function makeTmpRepo() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'extract-failure-counters-'));
  fs.writeFileSync(path.join(root, 'ok.mjs'), 'export function ok() { return 1; }\n');
  fs.writeFileSync(path.join(root, 'stat-fail.mjs'), 'export function statFail() { return 1; }\n');
  fs.writeFileSync(path.join(root, 'parse-fail.mjs'), 'export function parseFail() { return 1; }\n');
  return root;
}

describe('extractSymbols() — statFailures / parseFailures counters', () => {
  it('increments statFailures when fs.statSync throws for a file, and still completes', (t) => {
    const root = makeTmpRepo();
    try {
      const statFailAbs = path.join(root, 'stat-fail.mjs');
      const realStatSync = fs.statSync.bind(fs);
      t.mock.method(fs, 'statSync', (p, ...rest) => {
        if (path.resolve(String(p)) === path.resolve(statFailAbs)) {
          throw new Error('simulated stat failure');
        }
        return realStatSync(p, ...rest);
      });

      const files = ['ok.mjs', 'stat-fail.mjs'].map((f) => path.join(root, f));
      const stats = extractSymbols(files, root);

      assert.equal(stats.statFailures, 1, 'the throwing file must be counted as a stat failure');
      assert.equal(stats.parseFailures, 0);
      assert.ok(stats.symbolCount >= 1, 'the OTHER (non-throwing) file must still be extracted — fail-open');
    } finally {
      fs.rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
    }
  });

  it('increments parseFailures when addSourceFileAtPathIfExists throws, and still completes', (t) => {
    const root = makeTmpRepo();
    try {
      const parseFailAbs = path.resolve(path.join(root, 'parse-fail.mjs'));
      const realAdd = Project.prototype.addSourceFileAtPathIfExists;
      t.mock.method(Project.prototype, 'addSourceFileAtPathIfExists', function (p, ...rest) {
        if (path.resolve(String(p)) === parseFailAbs) {
          throw new Error('simulated parse failure');
        }
        return realAdd.call(this, p, ...rest);
      });

      const files = ['ok.mjs', 'parse-fail.mjs'].map((f) => path.join(root, f));
      const stats = extractSymbols(files, root);

      assert.equal(stats.parseFailures, 1, 'the throwing file must be counted as a parse failure');
      assert.equal(stats.statFailures, 0);
      assert.ok(stats.symbolCount >= 1, 'the OTHER (non-throwing) file must still be extracted — fail-open');
    } finally {
      fs.rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
    }
  });

  it('increments parseFailures when addSourceFileAtPathIfExists returns undefined WITHOUT throwing (audit M5, 2026-07-24)', (t) => {
    const root = makeTmpRepo();
    try {
      const noFileAbs = path.resolve(path.join(root, 'parse-fail.mjs'));
      const realAdd = Project.prototype.addSourceFileAtPathIfExists;
      // ts-morph's `*IfExists` APIs return undefined on failure instead of
      // throwing — this is the non-exception failure path the try/catch
      // alone cannot see.
      t.mock.method(Project.prototype, 'addSourceFileAtPathIfExists', function (p, ...rest) {
        if (path.resolve(String(p)) === noFileAbs) return undefined;
        return realAdd.call(this, p, ...rest);
      });

      const files = ['ok.mjs', 'parse-fail.mjs'].map((f) => path.join(root, f));
      const stats = extractSymbols(files, root);

      assert.equal(stats.parseFailures, 1, 'a non-exception undefined return must still be counted as a parse failure');
      assert.ok(stats.symbolCount >= 1, 'the OTHER (successfully-loaded) file must still be extracted');
    } finally {
      fs.rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
    }
  });

  it('reports zero failures on an all-clean run (no false positives)', () => {
    const root = makeTmpRepo();
    try {
      const files = ['ok.mjs'].map((f) => path.join(root, f));
      const stats = extractSymbols(files, root);
      assert.equal(stats.statFailures, 0);
      assert.equal(stats.parseFailures, 0);
    } finally {
      fs.rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
    }
  });
});
