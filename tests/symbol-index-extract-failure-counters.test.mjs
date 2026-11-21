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

  it('increments parseFailures when ts-morph createSourceFile throws, and still completes', (t) => {
    const root = makeTmpRepo();
    try {
      const parseFailAbs = path.resolve(path.join(root, 'parse-fail.mjs'));
      const realAdd = Project.prototype.createSourceFile;
      t.mock.method(Project.prototype, 'createSourceFile', function (p, ...rest) {
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

  it('increments parseFailures when the verified read refuses the file (no ts-morph open by path)', () => {
    const root = makeTmpRepo();
    try {
      const target = path.join(root, 'parse-fail.mjs');
      const files = ['ok.mjs', 'parse-fail.mjs'].map((f) => path.join(root, f));
      const stats = extractSymbols(files, root, {
        // parse-fail.mjs is replaced (new inode) after each open; only its own read can notice.
        readHooks: { afterOpen: () => { fs.renameSync(target, `${target}.old`); fs.writeFileSync(target, 'export const x = 1;'); } },
      });
      assert.equal(stats.parseFailures, 1, 'only the replaced file is refused');
      assert.ok(stats.symbolCount >= 1, 'the OTHER file must still be extracted');
    } finally {
      fs.rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
    }
  });

  it('counts an admitted .py file as a failure when no Python stage collector is attached (never a silent drop)', () => {
    const root = makeTmpRepo();
    try {
      fs.writeFileSync(path.join(root, 'm.py'), 'def f():\n    return 1\n');
      const stats = extractSymbols([path.join(root, 'm.py')], root);
      assert.equal(stats.parseFailures, 1);
      const collected = [];
      const stats2 = extractSymbols([path.join(root, 'm.py')], root, { pythonAdmissions: collected });
      assert.equal(collected.length, 1, 'control: with a collector the file is handed over, not counted');
      assert.equal(stats2.parseFailures, 0);
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
