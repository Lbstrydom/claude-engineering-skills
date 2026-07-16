/**
 * @fileoverview Tier 3, same-commit egress test for the duplication audit
 * wave (AGENTS.md testing doctrine — sensitive-path egress is HARD
 * test-first, non-negotiable). Mirrors tests/audit-scope-egress.test.mjs's
 * assembly-level pattern: asserts the actual composed artifact a real audit
 * would send to an external LLM, not the classifier in isolation.
 *
 * Two halves, per docs/completed/audit-code-duplication-wave.md §2/§4 Phase 4:
 *  1. Secret-shaped CONTENT never reaches the assembled bouncer prompt
 *     (formatCandidatesForPrompt → buildRedactedAuditContext's refuse,
 *     never scrub-and-send, doctrine).
 *  2. A sensitive/symlink-resolved-sensitive PATH is excluded from the
 *     candidate set before any file read occurs (the detector's step-9
 *     WS-CANON gate, exercised here against the REAL resolveAndClassify —
 *     not a fake — so the symlink-resolution behaviour itself is covered,
 *     not just the detector's plumbing around it).
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { formatCandidatesForPrompt } from '../scripts/lib/audit/duplication-report.mjs';
import { runDuplicationAnalysis } from '../scripts/lib/audit/duplication-detector.mjs';
import { resolveAndClassify } from '../scripts/lib/sensitive-paths.mjs';

const skipOnWin = process.platform === 'win32';

function mkRepo() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'dup-egress-'));
}

const SNAP = { refreshId: 'r1', activeEmbeddingModel: 'gemini-embedding-001', activeEmbeddingDim: 768 };
function baseAdapters(overrides = {}) {
  return {
    async getRepoId() { return 'repo-1'; },
    async getActiveSnapshot() { return SNAP; },
    async extractSymbolsForFiles() { return []; },
    async gitShowAtRevision() { return { ok: false, error: { code: 'BAD_REVISION', message: 'x' } }; },
    async embedText() { return new Array(768).fill(0.1); },
    async callNeighbourhoodRpc() { return []; },
    gateSymbolForEgress(p, repoRoot) { return resolveAndClassify(p, { repoRoot }); },
    readFileSync(p) { return fs.readFileSync(p, 'utf-8'); },
    ...overrides,
  };
}

describe('formatCandidatesForPrompt — secret-shaped content never reaches the prompt', () => {
  it('refuses (does not scrub-and-send) a candidate whose file contains an AWS-key-shaped literal', () => {
    const repo = mkRepo();
    fs.mkdirSync(path.join(repo, 'src'), { recursive: true });
    const secretLine = 'const AWS_KEY = "AKIAABCDEFGHIJKLMNOP";';
    fs.writeFileSync(path.join(repo, 'src', 'a.mjs'), `${secretLine}\nfunction foo() {}\n`, 'utf-8');
    fs.writeFileSync(path.join(repo, 'src', 'canonical.mjs'), 'function foo() {}\n', 'utf-8');

    const cwd = process.cwd();
    process.chdir(repo);
    try {
      const { prompt, includedIds, refusedIds } = formatCandidatesForPrompt([{
        id: 'dup-1',
        candidate: { filePath: 'src/a.mjs', symbolName: 'foo', kind: 'function', purposeSummary: 'x' },
        topMatch: { filePath: 'src/canonical.mjs', symbolName: 'foo', kind: 'function', similarity: 0.9 },
        allMatches: [{ filePath: 'src/canonical.mjs', symbolName: 'foo', kind: 'function', similarity: 0.9 }],
      }], { repoRoot: repo });
      assert.ok(!prompt.includes('AKIAABCDEFGHIJKLMNOP'), 'secret-shaped literal must never appear in the assembled prompt');
      assert.deepEqual(includedIds, []);
      assert.deepEqual(refusedIds, ['dup-1']);
    } finally {
      process.chdir(cwd);
      fs.rmSync(repo, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
    }
  });

  it('includes a candidate pair with no secret-shaped content', () => {
    const repo = mkRepo();
    fs.mkdirSync(path.join(repo, 'src'), { recursive: true });
    fs.writeFileSync(path.join(repo, 'src', 'a.mjs'), 'function foo() { return 1; }\n', 'utf-8');
    fs.writeFileSync(path.join(repo, 'src', 'canonical.mjs'), 'function foo() { return 1; }\n', 'utf-8');

    const cwd = process.cwd();
    process.chdir(repo);
    try {
      const { prompt, includedIds, refusedIds } = formatCandidatesForPrompt([{
        id: 'dup-1',
        candidate: { filePath: 'src/a.mjs', symbolName: 'foo', kind: 'function', purposeSummary: 'x' },
        topMatch: { filePath: 'src/canonical.mjs', symbolName: 'foo', kind: 'function', similarity: 0.9 },
        allMatches: [{ filePath: 'src/canonical.mjs', symbolName: 'foo', kind: 'function', similarity: 0.9 }],
      }], { repoRoot: repo });
      assert.deepEqual(refusedIds, []);
      assert.deepEqual(includedIds, ['dup-1']);
      assert.ok(prompt.includes('src/a.mjs'));
    } finally {
      process.chdir(cwd);
      fs.rmSync(repo, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
    }
  });
});

describe('formatCandidatesForPrompt — excerpts the symbol span, not the whole file (round-1 code-audit M24)', () => {
  it('a secret elsewhere in the file (outside the candidate/match line spans) never reaches the prompt', () => {
    const repo = mkRepo();
    fs.mkdirSync(path.join(repo, 'src'), { recursive: true });
    // The secret sits on line 1, far from the candidate symbol at lines 5-7.
    const secretLine = 'const UNRELATED_KEY = "AKIAABCDEFGHIJKLMNOP";';
    fs.writeFileSync(
      path.join(repo, 'src', 'a.mjs'),
      `${secretLine}\n\n\nfunction foo() {\n  return 1;\n}\n`,
      'utf-8',
    );
    fs.writeFileSync(path.join(repo, 'src', 'canonical.mjs'), 'function foo() {\n  return 1;\n}\n', 'utf-8');

    const cwd = process.cwd();
    process.chdir(repo);
    try {
      const { prompt, includedIds, refusedIds } = formatCandidatesForPrompt([{
        id: 'dup-1',
        candidate: { filePath: 'src/a.mjs', symbolName: 'foo', kind: 'function', purposeSummary: 'x', startLine: 4, endLine: 6 },
        topMatch: { filePath: 'src/canonical.mjs', symbolName: 'foo', kind: 'function', similarity: 0.9, startLine: 1, endLine: 3 },
        allMatches: [{ filePath: 'src/canonical.mjs', symbolName: 'foo', kind: 'function', similarity: 0.9 }],
      }], { repoRoot: repo });
      // Since the excerpt is scoped to the symbol's own span, the secret on
      // line 1 (outside [4,6]) is never even READ into the candidate excerpt
      // — this is not passing because of the redaction scan; it's because
      // the whole-file content was never fetched in the first place.
      assert.deepEqual(refusedIds, []);
      assert.deepEqual(includedIds, ['dup-1']);
      assert.ok(!prompt.includes('AKIAABCDEFGHIJKLMNOP'));
      assert.ok(prompt.includes('src/a.mjs'));
    } finally {
      process.chdir(cwd);
      fs.rmSync(repo, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
    }
  });
});

describe('runDuplicationAnalysis — sensitive/symlink path never read (WS-CANON, real resolveAndClassify)', () => {
  it('excludes a candidate whose matched canonical path is lexically sensitive (.env) — no read attempted', async () => {
    const repo = mkRepo();
    let readCalled = false;
    const report = await runDuplicationAnalysis({
      repoRoot: repo,
      changedFiles: [{ status: 'added', currentPath: 'a.mjs' }],
      auditBaseCommit: 'HEAD',
      adapters: baseAdapters({
        extractSymbolsForFiles: async () => [{ filePath: 'a.mjs', symbolName: 'foo', kind: 'function', startLine: 1, endLine: 2, signature: 'function foo()', signatureHash: 'h', purposeSummary: 'x' }],
        callNeighbourhoodRpc: async () => [{ file_path: '.env.production', symbol_name: 'foo', kind: 'function', similarity: 0.95 }],
        readFileSync: (p) => { readCalled = true; return fs.readFileSync(p, 'utf-8'); },
      }),
    });
    assert.equal(report.state, 'clean');
    assert.equal(readCalled, false);
    fs.rmSync(repo, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  });

  it('excludes a candidate whose matched path is an innocent-looking symlink resolving into a sensitive target', { skip: skipOnWin }, async () => {
    const repo = mkRepo();
    fs.mkdirSync(path.join(repo, 'secrets'), { recursive: true });
    fs.writeFileSync(path.join(repo, 'secrets', 'db.yaml'), 'password: hunter2\n', 'utf-8');
    fs.writeFileSync(path.join(repo, 'a.mjs'), 'function foo() {}\n', 'utf-8');
    fs.symlinkSync(path.join(repo, 'secrets', 'db.yaml'), path.join(repo, 'notes.txt'));

    let readCalled = false;
    const report = await runDuplicationAnalysis({
      repoRoot: repo,
      changedFiles: [{ status: 'added', currentPath: 'a.mjs' }],
      auditBaseCommit: 'HEAD',
      adapters: baseAdapters({
        extractSymbolsForFiles: async () => [{ filePath: 'a.mjs', symbolName: 'foo', kind: 'function', startLine: 1, endLine: 2, signature: 'function foo()', signatureHash: 'h', purposeSummary: 'x' }],
        callNeighbourhoodRpc: async () => [{ file_path: 'notes.txt', symbol_name: 'foo', kind: 'function', similarity: 0.95 }],
        readFileSync: (p) => { readCalled = true; return fs.readFileSync(p, 'utf-8'); },
      }),
    });
    assert.equal(report.state, 'clean');
    assert.equal(readCalled, false);
    fs.rmSync(repo, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  });
});
