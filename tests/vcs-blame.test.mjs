/**
 * @fileoverview `contentExistsAtMappedRange` — occurrence-specific
 * pre-existence check for the tiered-recall Stage 0 evidence-relevance
 * split. Plan: docs/plans/stage0-evidence-relevance-split.md decision #4.
 *
 * Uses real git commits in a disposable temp repo (same pattern as
 * tests/vcs.test.mjs) — no mocking of `gitShowFileAtRevision`, since it
 * shells out directly and isn't injected.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync, execSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { contentExistsAtMappedRange } from '../scripts/lib/vcs.mjs';

// @duplicate-justification: target=tests/vcs.test.mjs:mkdtemp reason=a 2-line temp-dir helper duplicated across test files matching this repo's established per-file local-helper convention (AGENTS.md: "three similar lines is better than a premature abstraction") — a shared fixture module for one trivial helper is the over-engineered extreme, not the right-sized one.
function mkdtemp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'vcs-blame-test-'));
}

// @duplicate-justification: target=tests/vcs.test.mjs:gitInit reason=a 4-line disposable-git-repo-init helper duplicated across test files matching this repo's established per-file local-helper convention (AGENTS.md: "three similar lines is better than a premature abstraction") — a shared fixture module for one trivial helper is the over-engineered extreme, not the right-sized one.
function gitInit(dir) {
  spawnSync('git', ['init', '-q'], { cwd: dir, stdio: 'ignore' });
  spawnSync('git', ['config', 'user.email', 'test@example.com'], { cwd: dir, stdio: 'ignore' });
  spawnSync('git', ['config', 'user.name', 'Test'], { cwd: dir, stdio: 'ignore' });
  spawnSync('git', ['config', 'commit.gpgsign', 'false'], { cwd: dir, stdio: 'ignore' });
}

function commit(dir, filePath, content, message) {
  fs.writeFileSync(path.join(dir, filePath), content);
  spawnSync('git', ['add', filePath], { cwd: dir, stdio: 'ignore' });
  spawnSync('git', ['commit', '-m', message], { cwd: dir, stdio: 'ignore' });
  return execSync('git rev-parse HEAD', { cwd: dir }).toString().trim();
}

describe('contentExistsAtMappedRange', () => {
  it('returns true when the mapped range matches the quote at baseSha', () => {
    const dir = mkdtemp();
    try {
      gitInit(dir);
      const baseSha = commit(dir, 'a.txt', 'line1\nline2\nfunction foo() {}\nline4\n', 'base');
      const r = contentExistsAtMappedRange(dir, 'a.txt', { startLine: 3, endLine: 3 }, 'function foo() {}', baseSha);
      assert.equal(r, true);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
    }
  });

  it('returns false when the mapped range exists but content differs', () => {
    const dir = mkdtemp();
    try {
      gitInit(dir);
      const baseSha = commit(dir, 'a.txt', 'line1\nline2\nsomething else entirely\nline4\n', 'base');
      const r = contentExistsAtMappedRange(dir, 'a.txt', { startLine: 3, endLine: 3 }, 'function foo() {}', baseSha);
      assert.equal(r, false);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
    }
  });

  it('matches across a multi-line range, tolerant of line-ending/indentation only', () => {
    const dir = mkdtemp();
    try {
      gitInit(dir);
      const baseSha = commit(dir, 'a.txt', 'x\nfunction foo() {\n  return 1;\n}\ny\n', 'base');
      const r = contentExistsAtMappedRange(
        dir, 'a.txt', { startLine: 2, endLine: 4 }, 'function foo() {\n  return 1;\n}', baseSha,
      );
      assert.equal(r, true);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
    }
  });

  it('does NOT match when only INTERIOR whitespace differs — round-2 plan-audit-code H2 regression lock', () => {
    // "a  b" (two spaces) and "a b" (one space) are semantically different
    // string-literal content; collapsing interior whitespace (the OLD
    // normalizeWhitespace-based comparison) would wrongly match them.
    const dir = mkdtemp();
    try {
      gitInit(dir);
      const baseSha = commit(dir, 'a.txt', 'const s = "a  b";\n', 'base');
      const r = contentExistsAtMappedRange(dir, 'a.txt', { startLine: 1, endLine: 1 }, 'const s = "a b";', baseSha);
      assert.equal(r, false);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
    }
  });

  it('returns null when the file did not exist at baseSha (added by this commit)', () => {
    const dir = mkdtemp();
    try {
      gitInit(dir);
      const baseSha = commit(dir, 'other.txt', 'placeholder\n', 'base');
      const r = contentExistsAtMappedRange(dir, 'new-file.txt', { startLine: 1, endLine: 1 }, 'anything', baseSha);
      assert.equal(r, null);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
    }
  });

  it('returns null for an unreadable/unsafe revision', () => {
    const dir = mkdtemp();
    try {
      gitInit(dir);
      commit(dir, 'a.txt', 'line1\n', 'base');
      const r = contentExistsAtMappedRange(dir, 'a.txt', { startLine: 1, endLine: 1 }, 'line1', '--output=/tmp/evil');
      assert.equal(r, null);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
    }
  });

  it('returns null when the mapped range is out of the base file\'s bounds', () => {
    const dir = mkdtemp();
    try {
      gitInit(dir);
      const baseSha = commit(dir, 'a.txt', 'line1\nline2\n', 'base');
      const r = contentExistsAtMappedRange(dir, 'a.txt', { startLine: 10, endLine: 12 }, 'anything', baseSha);
      assert.equal(r, null);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
    }
  });

  it('returns null for an empty quote', () => {
    const dir = mkdtemp();
    try {
      gitInit(dir);
      const baseSha = commit(dir, 'a.txt', 'line1\n', 'base');
      const r = contentExistsAtMappedRange(dir, 'a.txt', { startLine: 1, endLine: 1 }, '   ', baseSha);
      assert.equal(r, null);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
    }
  });

  it('uses opts.preloadedContent instead of fetching, when provided (decision #5/M4 caching)', () => {
    const dir = mkdtemp();
    try {
      gitInit(dir);
      // A baseSha that doesn't even resolve to real content for this file —
      // proves the function used the PRELOADED content, not a fresh fetch.
      const baseSha = commit(dir, 'other.txt', 'unrelated\n', 'base');
      const r = contentExistsAtMappedRange(
        dir, 'a.txt', { startLine: 1, endLine: 1 }, 'function foo() {}', baseSha,
        { preloadedContent: 'function foo() {}\n' },
      );
      assert.equal(r, true);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
    }
  });
});
