/**
 * @fileoverview Tier-1 tests for `scripts/symbol-index/refresh-lock.mjs` —
 * extracted from `refresh.mjs` (docs/plans/tiered-pipeline-refresh-god-module-decomposition.md
 * Phase 4).
 *
 * `classifyLockOpenError` is the directly unit-testable surface. The retry
 * SEQUENCE itself (`findStaleRunningRefresh`/`abortRefreshRun` "were called")
 * stays covered the way lock acquisition has always been covered
 * (operationally, via a real `--force` refresh run) — this repo's own
 * established ESM-mocking limitation (plain named exports, not object
 * methods) means there is no call-observation seam for it in this codebase's
 * tooling; the plan's first-draft assertions claiming otherwise are withdrawn.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { classifyLockOpenError, resolveWalkStartCommit } from '../scripts/symbol-index/refresh-lock.mjs';
import { gitInit, commit } from './helpers/fixtures.mjs';

describe('classifyLockOpenError', () => {
  it('REFRESH_IN_FLIGHT + force:false → exit-in-flight', () => {
    assert.deepEqual(classifyLockOpenError({ code: 'REFRESH_IN_FLIGHT' }, { force: false }), { action: 'exit-in-flight' });
  });

  it('REFRESH_IN_FLIGHT + force:true → retry-with-abort', () => {
    assert.deepEqual(classifyLockOpenError({ code: 'REFRESH_IN_FLIGHT' }, { force: true }), { action: 'retry-with-abort' });
  });

  it('any other error code → rethrow, regardless of force', () => {
    assert.deepEqual(classifyLockOpenError({ code: 'SOMETHING_ELSE' }, { force: false }), { action: 'rethrow' });
    assert.deepEqual(classifyLockOpenError({ code: 'SOMETHING_ELSE' }, { force: true }), { action: 'rethrow' });
  });

  it('an error with no code at all → rethrow', () => {
    assert.deepEqual(classifyLockOpenError(new Error('boom'), { force: true }), { action: 'rethrow' });
  });
});

describe('resolveWalkStartCommit', () => {
  it('returns the current HEAD sha for a real repo with at least one commit', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'refresh-lock-walkstart-'));
    try {
      gitInit(dir);
      const sha = commit(dir, 'a.txt', 'hello\n', 'init');
      assert.equal(resolveWalkStartCommit(dir), sha);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
    }
  });

  it('returns null (not a throw) for a brand-new repo with no commits yet', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'refresh-lock-walkstart-empty-'));
    try {
      gitInit(dir);
      assert.equal(resolveWalkStartCommit(dir), null);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
    }
  });

  it('returns null (not a throw) for a directory that is not a git repo at all', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'refresh-lock-walkstart-norepo-'));
    try {
      assert.equal(resolveWalkStartCommit(dir), null);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
    }
  });
});
