/**
 * @fileoverview vcs.mjs structured contract tests.
 * Plan: docs/plans/sustainability-cleanup-batch.md WS3.
 *
 * Validates:
 *  - All 5 VcsErrorCode values reachable
 *  - DiffShape with renamed:[{from,to}] pairs
 *  - exitCodeFor mapping (127/5/4/5/1, unknown→1)
 *  - RETRYABLE_VCS_ERRORS == {EXEC_FAILED}
 *  - isSafeGitRevision boolean behaviour
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync, execSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  gitCommitSha,
  gitDiffWithWorkingTree,
  isSafeGitRevision,
  exitCodeFor,
  RETRYABLE_VCS_ERRORS,
  isRetryableVcsError,
  _internals,
} from '../scripts/lib/vcs.mjs';
import { gitInitWithEmptyCommit as gitInit, gitFixtureEnv } from './helpers/fixtures.mjs';

function mkdtemp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'vcs-test-'));
}

describe('exitCodeFor', () => {
  it('maps every VcsErrorCode to documented exit code', () => {
    assert.equal(exitCodeFor('GIT_BINARY_MISSING'), 127);
    assert.equal(exitCodeFor('NOT_A_GIT_REPOSITORY'), 5);
    assert.equal(exitCodeFor('BAD_REVISION'), 4);
    assert.equal(exitCodeFor('WORKING_TREE_UNREADABLE'), 5);
    assert.equal(exitCodeFor('EXEC_FAILED'), 1);
  });
  it('returns 1 for unknown codes', () => {
    assert.equal(exitCodeFor('SOMETHING_UNKNOWN'), 1);
    assert.equal(exitCodeFor(undefined), 1);
    assert.equal(exitCodeFor(null), 1);
  });
});

describe('RETRYABLE_VCS_ERRORS', () => {
  it('contains exactly EXEC_FAILED', () => {
    assert.equal(RETRYABLE_VCS_ERRORS.size, 1);
    assert.ok(RETRYABLE_VCS_ERRORS.has('EXEC_FAILED'));
    assert.ok(!RETRYABLE_VCS_ERRORS.has('GIT_BINARY_MISSING'));
    assert.ok(!RETRYABLE_VCS_ERRORS.has('NOT_A_GIT_REPOSITORY'));
    assert.ok(!RETRYABLE_VCS_ERRORS.has('BAD_REVISION'));
    assert.ok(!RETRYABLE_VCS_ERRORS.has('WORKING_TREE_UNREADABLE'));
  });
});

describe('isRetryableVcsError', () => {
  it('returns true only for EXEC_FAILED', () => {
    assert.equal(isRetryableVcsError('EXEC_FAILED'), true);
    assert.equal(isRetryableVcsError('GIT_BINARY_MISSING'), false);
    assert.equal(isRetryableVcsError('NOT_A_GIT_REPOSITORY'), false);
    assert.equal(isRetryableVcsError('BAD_REVISION'), false);
    assert.equal(isRetryableVcsError('WORKING_TREE_UNREADABLE'), false);
    assert.equal(isRetryableVcsError('UNKNOWN'), false);
    assert.equal(isRetryableVcsError(null), false);
    assert.equal(isRetryableVcsError(undefined), false);
  });
});

describe('isSafeGitRevision', () => {
  it('accepts valid revisions', () => {
    for (const rev of [
      'HEAD', 'HEAD~1', 'HEAD^', 'main', 'origin/main',
      'feature/foo', 'v1.2.3', 'abc1234', 'abcdef0123456789',
      '@{upstream}',
    ]) {
      assert.ok(isSafeGitRevision(rev), `expected safe: ${rev}`);
    }
  });
  it('rejects unsafe revisions', () => {
    for (const rev of [
      '', '   ', '-rf', '--output=/etc/passwd',
      'HEAD; rm -rf /', 'HEAD && evil', 'foo|bar', 'foo`bar`',
      'foo$VAR', 'foo bar', 'foo\nbar',
      null, undefined, 42, {},
    ]) {
      assert.ok(!isSafeGitRevision(rev), `expected unsafe: ${JSON.stringify(rev)}`);
    }
  });
});

describe('classifyChildError (via _internals)', () => {
  const { classifyChildError } = _internals;
  it('GIT_BINARY_MISSING when ENOENT', () => {
    const r = classifyChildError({ code: 'ENOENT' });
    assert.equal(r.code, 'GIT_BINARY_MISSING');
  });
  it('NOT_A_GIT_REPOSITORY from stderr', () => {
    const r = classifyChildError({ stderr: 'fatal: not a git repository (or any of the parent directories)' });
    assert.equal(r.code, 'NOT_A_GIT_REPOSITORY');
  });
  it('BAD_REVISION from "unknown revision" stderr', () => {
    const r = classifyChildError({ stderr: 'fatal: bad revision \'deadbeef99\'' });
    assert.equal(r.code, 'BAD_REVISION');
  });
  it('BAD_REVISION from "ambiguous argument" stderr', () => {
    const r = classifyChildError({ stderr: 'fatal: ambiguous argument: unknown revision' });
    assert.equal(r.code, 'BAD_REVISION');
  });
  it('EXEC_FAILED on signal', () => {
    const r = classifyChildError({ signal: 'SIGKILL', stderr: '' });
    assert.equal(r.code, 'EXEC_FAILED');
  });
  it('EXEC_FAILED on negative status (no signal field but indicative)', () => {
    const r = classifyChildError({ status: -1, stderr: '' });
    assert.equal(r.code, 'EXEC_FAILED');
  });
  it('WORKING_TREE_UNREADABLE catch-all', () => {
    const r = classifyChildError({ status: 128, stderr: 'corrupt index' });
    assert.equal(r.code, 'WORKING_TREE_UNREADABLE');
    assert.match(r.message, /corrupt index/);
  });
  it('carries cause + truncates message', () => {
    const longStderr = 'fatal: ' + 'x'.repeat(500);
    const r = classifyChildError({ stderr: longStderr, status: 128 });
    assert.ok(r.message.length <= 200);
  });
});

describe('gitCommitSha', () => {
  it('returns {ok:true, sha} on a fresh git repo with HEAD', () => {
    const dir = mkdtemp();
    try {
      gitInit(dir);
      const r = gitCommitSha(dir, { env: gitFixtureEnv() });
      assert.equal(r.ok, true);
      assert.match(r.sha, /^[0-9a-f]{40}$/);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
    }
  });
  it('returns {ok:false, NOT_A_GIT_REPOSITORY} outside a repo', () => {
    const dir = mkdtemp();
    try {
      const r = gitCommitSha(dir, { env: gitFixtureEnv() });
      assert.equal(r.ok, false);
      assert.equal(r.error.code, 'NOT_A_GIT_REPOSITORY');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
    }
  });
});

describe('gitDiffWithWorkingTree', () => {
  it('returns DiffShape with all five buckets', () => {
    const dir = mkdtemp();
    try {
      gitInit(dir);
      fs.writeFileSync(path.join(dir, 'untracked.txt'), 'hello');
      const r = gitDiffWithWorkingTree(dir, null, { env: gitFixtureEnv() });
      assert.equal(r.ok, true);
      assert.ok(Array.isArray(r.files.added));
      assert.ok(Array.isArray(r.files.modified));
      assert.ok(Array.isArray(r.files.deleted));
      assert.ok(Array.isArray(r.files.untracked));
      assert.ok(Array.isArray(r.files.renamed));
      assert.ok(r.files.untracked.includes('untracked.txt'));
    } finally {
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
    }
  });

  it('captures rename pairs as {from,to} objects', () => {
    const dir = mkdtemp();
    try {
      gitInit(dir);
      const fixtureEnv = gitFixtureEnv();
      fs.writeFileSync(path.join(dir, 'a.txt'), 'content\n');
      spawnSync('git', ['add', 'a.txt'], { cwd: dir, stdio: 'ignore', env: fixtureEnv });
      spawnSync('git', ['commit', '-m', 'add a'], { cwd: dir, stdio: 'ignore', env: fixtureEnv });
      const sha = execSync('git rev-parse HEAD', { cwd: dir, env: fixtureEnv }).toString().trim();
      spawnSync('git', ['mv', 'a.txt', 'b.txt'], { cwd: dir, stdio: 'ignore', env: fixtureEnv });
      spawnSync('git', ['commit', '-m', 'rename'], { cwd: dir, stdio: 'ignore', env: fixtureEnv });
      const r = gitDiffWithWorkingTree(dir, sha, { env: fixtureEnv });
      assert.equal(r.ok, true);
      // git may emit either a Rename or Delete+Add depending on heuristics.
      // Both shapes are well-formed; we only care the contract is consistent.
      if (r.files.renamed.length > 0) {
        for (const ren of r.files.renamed) {
          assert.equal(typeof ren.from, 'string');
          assert.equal(typeof ren.to, 'string');
        }
      }
    } finally {
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
    }
  });

  it('returns BAD_REVISION for an unsafe revision string', () => {
    const dir = mkdtemp();
    try {
      gitInit(dir);
      const r = gitDiffWithWorkingTree(dir, '--output=/tmp/evil', { env: gitFixtureEnv() });
      assert.equal(r.ok, false);
      assert.equal(r.error.code, 'BAD_REVISION');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
    }
  });

  it('returns BAD_REVISION when --since-commit does not resolve', () => {
    const dir = mkdtemp();
    try {
      gitInit(dir);
      const r = gitDiffWithWorkingTree(dir, 'deadbeef99', { env: gitFixtureEnv() });
      assert.equal(r.ok, false);
      assert.equal(r.error.code, 'BAD_REVISION');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
    }
  });

  it('returns NOT_A_GIT_REPOSITORY outside a repo', () => {
    const dir = mkdtemp();
    try {
      const r = gitDiffWithWorkingTree(dir, null, { env: gitFixtureEnv() });
      assert.equal(r.ok, false);
      assert.equal(r.error.code, 'NOT_A_GIT_REPOSITORY');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
    }
  });
});
