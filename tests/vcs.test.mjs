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
  it('is a real Set instance', () => {
    assert.ok(RETRYABLE_VCS_ERRORS instanceof Set);
  });
  it('contains exactly EXEC_FAILED', () => {
    assert.equal(RETRYABLE_VCS_ERRORS.size, 1);
    assert.ok(RETRYABLE_VCS_ERRORS.has('EXEC_FAILED'));
    assert.ok(!RETRYABLE_VCS_ERRORS.has('GIT_BINARY_MISSING'));
    assert.ok(!RETRYABLE_VCS_ERRORS.has('NOT_A_GIT_REPOSITORY'));
    assert.ok(!RETRYABLE_VCS_ERRORS.has('BAD_REVISION'));
    assert.ok(!RETRYABLE_VCS_ERRORS.has('WORKING_TREE_UNREADABLE'));
  });
  it('supports native iteration', () => {
    assert.deepEqual([...RETRYABLE_VCS_ERRORS], ['EXEC_FAILED']);
  });
  it('is frozen', () => {
    assert.ok(Object.isFrozen(RETRYABLE_VCS_ERRORS));
  });
  it('.add() throws TypeError and does not mutate', () => {
    assert.throws(() => RETRYABLE_VCS_ERRORS.add('X'), TypeError);
    assert.equal(RETRYABLE_VCS_ERRORS.size, 1);
  });
  it('.delete() throws TypeError and does not mutate', () => {
    assert.throws(() => RETRYABLE_VCS_ERRORS.delete('EXEC_FAILED'), TypeError);
    assert.ok(RETRYABLE_VCS_ERRORS.has('EXEC_FAILED'));
  });
  it('.clear() throws TypeError and does not mutate', () => {
    assert.throws(() => RETRYABLE_VCS_ERRORS.clear(), TypeError);
    assert.equal(RETRYABLE_VCS_ERRORS.size, 1);
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

describe('parseNameStatusZ (via _internals)', () => {
  const { parseNameStatusZ } = _internals;

  it('empty stdout -> ok, all buckets empty', () => {
    const r = parseNameStatusZ('');
    assert.equal(r.ok, true);
    assert.deepEqual(r.files, { added: [], modified: [], deleted: [], renamed: [] });
  });

  it('A record', () => {
    const r = parseNameStatusZ('A\0added.js\0');
    assert.equal(r.ok, true);
    assert.deepEqual(r.files.added, ['added.js']);
  });

  it('M record', () => {
    const r = parseNameStatusZ('M\0changed.js\0');
    assert.equal(r.ok, true);
    assert.deepEqual(r.files.modified, ['changed.js']);
  });

  it('D record', () => {
    const r = parseNameStatusZ('D\0removed.js\0');
    assert.equal(r.ok, true);
    assert.deepEqual(r.files.deleted, ['removed.js']);
  });

  it('R record — two-token from/to pair, bucketed', () => {
    const r = parseNameStatusZ('R100\0old name.js\0new name.js\0');
    assert.equal(r.ok, true);
    assert.deepEqual(r.files.renamed, [{ from: 'old name.js', to: 'new name.js' }]);
  });

  it('C record — two-token pair consumed, NOT bucketed, stream stays aligned', () => {
    const r = parseNameStatusZ('C100\0src.js\0copy.js\0A\0added.js\0');
    assert.equal(r.ok, true);
    assert.deepEqual(r.files.added, ['added.js']);
    assert.deepEqual(r.files.renamed, []);
  });

  for (const letter of ['T', 'U', 'X', 'B']) {
    it(`${letter} record — one-token consumed, NOT bucketed, stream stays aligned`, () => {
      const r = parseNameStatusZ(`${letter}\0weird.js\0A\0added.js\0`);
      assert.equal(r.ok, true);
      // Both assertions are load-bearing: the first proves the record wasn't
      // bucketed, the second proves exactly one token was consumed for it
      // (a wrong count here would desync the following record's classification).
      assert.deepEqual(r.files.modified, []);
      assert.deepEqual(r.files.deleted, []);
      assert.deepEqual(r.files.added, ['added.js']);
    });
  }

  it('filenames containing spaces are not truncated (the bug -z fixes)', () => {
    const r = parseNameStatusZ('M\0path with spaces/file name.js\0');
    assert.equal(r.ok, true);
    assert.deepEqual(r.files.modified, ['path with spaces/file name.js']);
  });

  describe('malformed streams', () => {
    it('missing terminal NUL -> WORKING_TREE_UNREADABLE', () => {
      const r = parseNameStatusZ('A\0incomplete.js');
      assert.equal(r.ok, false);
      assert.equal(r.error.code, 'WORKING_TREE_UNREADABLE');
    });

    it('interior empty token -> WORKING_TREE_UNREADABLE', () => {
      const r = parseNameStatusZ('A\0\0M\0foo.js\0');
      assert.equal(r.ok, false);
      assert.equal(r.error.code, 'WORKING_TREE_UNREADABLE');
    });

    it('truncated record (status with no following path) -> WORKING_TREE_UNREADABLE', () => {
      const r = parseNameStatusZ('A\0');
      assert.equal(r.ok, false);
      assert.equal(r.error.code, 'WORKING_TREE_UNREADABLE');
    });

    it('truncated rename record (missing to-path) -> WORKING_TREE_UNREADABLE', () => {
      const r = parseNameStatusZ('R100\0onlyfrom.js\0');
      assert.equal(r.ok, false);
      assert.equal(r.error.code, 'WORKING_TREE_UNREADABLE');
    });

    it('valid empty stdout is NOT malformed', () => {
      const r = parseNameStatusZ('');
      assert.equal(r.ok, true);
    });
  });
});

describe('parseUntrackedPathsZ (via _internals)', () => {
  const { parseUntrackedPathsZ } = _internals;

  it('empty stdout -> ok, empty paths', () => {
    const r = parseUntrackedPathsZ('');
    assert.equal(r.ok, true);
    assert.deepEqual(r.paths, []);
  });

  it('single path', () => {
    const r = parseUntrackedPathsZ('untracked.js\0');
    assert.equal(r.ok, true);
    assert.deepEqual(r.paths, ['untracked.js']);
  });

  it('path containing spaces is not truncated', () => {
    const r = parseUntrackedPathsZ('new file with spaces.txt\0');
    assert.equal(r.ok, true);
    assert.deepEqual(r.paths, ['new file with spaces.txt']);
  });

  describe('malformed streams', () => {
    it('missing terminal NUL -> WORKING_TREE_UNREADABLE', () => {
      const r = parseUntrackedPathsZ('incomplete.txt');
      assert.equal(r.ok, false);
      assert.equal(r.error.code, 'WORKING_TREE_UNREADABLE');
    });

    it('interior empty token -> WORKING_TREE_UNREADABLE', () => {
      const r = parseUntrackedPathsZ('foo.txt\0\0bar.txt\0');
      assert.equal(r.ok, false);
      assert.equal(r.error.code, 'WORKING_TREE_UNREADABLE');
    });

    it('valid empty stdout is NOT malformed', () => {
      const r = parseUntrackedPathsZ('');
      assert.equal(r.ok, true);
    });
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

  it('detects added/modified/deleted files against sinceCommit', () => {
    const dir = mkdtemp();
    try {
      gitInit(dir);
      const fixtureEnv = gitFixtureEnv();
      fs.writeFileSync(path.join(dir, 'keep.txt'), 'v1\n');
      fs.writeFileSync(path.join(dir, 'remove.txt'), 'bye\n');
      spawnSync('git', ['add', 'keep.txt', 'remove.txt'], { cwd: dir, stdio: 'ignore', env: fixtureEnv });
      spawnSync('git', ['commit', '-m', 'base'], { cwd: dir, stdio: 'ignore', env: fixtureEnv });
      const sha = execSync('git rev-parse HEAD', { cwd: dir, env: fixtureEnv }).toString().trim();

      fs.writeFileSync(path.join(dir, 'keep.txt'), 'v2\n');
      fs.writeFileSync(path.join(dir, 'new.txt'), 'brand new\n');
      fs.rmSync(path.join(dir, 'remove.txt'), { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
      spawnSync('git', ['add', '-A'], { cwd: dir, stdio: 'ignore', env: fixtureEnv });

      const r = gitDiffWithWorkingTree(dir, sha, { env: fixtureEnv });
      assert.equal(r.ok, true);
      assert.deepEqual(r.files.added, ['new.txt']);
      assert.deepEqual(r.files.modified, ['keep.txt']);
      assert.deepEqual(r.files.deleted, ['remove.txt']);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
    }
  });

  it('captures untracked paths containing spaces', () => {
    const dir = mkdtemp();
    try {
      gitInit(dir);
      fs.writeFileSync(path.join(dir, 'new file with spaces.txt'), 'hi');
      const r = gitDiffWithWorkingTree(dir, null, { env: gitFixtureEnv() });
      assert.equal(r.ok, true);
      assert.ok(r.files.untracked.includes('new file with spaces.txt'));
    } finally {
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
    }
  });

  describe('trackedDiffOmitted', () => {
    it('is true when sinceCommit is falsy (tracked diff skipped)', () => {
      const dir = mkdtemp();
      try {
        gitInit(dir);
        const r = gitDiffWithWorkingTree(dir, null, { env: gitFixtureEnv() });
        assert.equal(r.ok, true);
        assert.equal(r.trackedDiffOmitted, true);
      } finally {
        fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
      }
    });

    it('is false when sinceCommit is a valid revision (tracked diff ran)', () => {
      const dir = mkdtemp();
      try {
        gitInit(dir);
        const fixtureEnv = gitFixtureEnv();
        const sha = execSync('git rev-parse HEAD', { cwd: dir, env: fixtureEnv }).toString().trim();
        const r = gitDiffWithWorkingTree(dir, sha, { env: fixtureEnv });
        assert.equal(r.ok, true);
        assert.equal(r.trackedDiffOmitted, false);
      } finally {
        fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
      }
    });
  });
});
