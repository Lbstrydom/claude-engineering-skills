/**
 * @fileoverview Behavioural coverage for scripts/lib/git-lock-retry.mjs —
 * the retry-with-backoff mitigation for transient `.git/config.lock` /
 * `.git/index.lock` contention from a concurrent process (as opposed to a
 * corrupted VALUE, which is a different, already-fixed problem — see
 * scripts/prepush-check.mjs and .githooks/pre-push).
 *
 * Cannot exercise this via scripts/prepush-check.mjs directly: that module
 * calls `process.exit(main())` unconditionally at import time (no
 * `import.meta.url` main-guard), so importing it from a test would abort the
 * test runner. The retry logic lives in its own module for exactly this
 * reason — real behavioural coverage without spawning a subprocess per case.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { GIT_LOCK_RETRY_DELAYS_MS, isGitLockContentionError, withGitLockRetry } from '../scripts/lib/git-lock-retry.mjs';

function lockError(message) {
  const err = new Error('Command failed');
  err.stderr = Buffer.from(message, 'utf-8');
  return err;
}

function otherError(message) {
  const err = new Error('Command failed');
  err.stderr = Buffer.from(message, 'utf-8');
  return err;
}

describe('isGitLockContentionError', () => {
  it('matches git config-lock text', () => {
    assert.equal(isGitLockContentionError(lockError(
      "error: could not lock config file C:/repo/.git/config: File exists",
    )), true);
  });

  it('matches git index-lock text', () => {
    assert.equal(isGitLockContentionError(lockError(
      "fatal: Unable to create 'C:/repo/.git/index.lock': File exists.",
    )), true);
  });

  it('does not match an unrelated git failure', () => {
    assert.equal(isGitLockContentionError(otherError(
      "fatal: 'deadbeef' is not a valid commit",
    )), false);
  });

  it('does not match when stderr is absent', () => {
    assert.equal(isGitLockContentionError(new Error('spawn failed')), false);
  });
});

describe('withGitLockRetry', () => {
  it('retries on lock contention and returns the eventual success', () => {
    let calls = 0;
    const sleeps = [];
    const result = withGitLockRetry(() => {
      calls++;
      if (calls < 3) throw lockError("error: could not lock config file: File exists");
      return 'ok';
    }, { sleep: (ms) => sleeps.push(ms) });

    assert.equal(result, 'ok');
    assert.equal(calls, 3);
    assert.deepEqual(sleeps, GIT_LOCK_RETRY_DELAYS_MS.slice(0, 2), 'backoff must follow the documented 200/400/800ms schedule');
  });

  it('does not retry a non-lock error — no benefit waiting out a real failure', () => {
    let calls = 0;
    assert.throws(() => {
      withGitLockRetry(() => {
        calls++;
        throw otherError("fatal: 'deadbeef' is not a valid commit");
      }, { sleep: () => { throw new Error('must not sleep for a non-lock error'); } });
    }, (err) => /not a valid commit/.test(err.stderr.toString()));
    assert.equal(calls, 1, 'a non-lock error must fail on the first attempt');
  });

  it('exhausts the retry budget and rethrows the last lock error', () => {
    let calls = 0;
    const sleeps = [];
    assert.throws(() => {
      withGitLockRetry(() => {
        calls++;
        throw lockError("error: could not lock config file: File exists");
      }, { sleep: (ms) => sleeps.push(ms) });
    }, (err) => /could not lock config file/.test(err.stderr.toString()));

    assert.equal(calls, GIT_LOCK_RETRY_DELAYS_MS.length + 1, 'one initial attempt plus one per delay');
    assert.deepEqual(sleeps, GIT_LOCK_RETRY_DELAYS_MS);
  });

  it('invokes onRetry with the attempt index and delay before each retry', () => {
    let calls = 0;
    const retries = [];
    withGitLockRetry(() => {
      calls++;
      if (calls < 2) throw lockError("fatal: Unable to create '.git/index.lock': File exists.");
      return 'ok';
    }, {
      sleep: () => {},
      onRetry: (attempt, delayMs) => retries.push({ attempt, delayMs }),
    });

    assert.deepEqual(retries, [{ attempt: 0, delayMs: GIT_LOCK_RETRY_DELAYS_MS[0] }]);
  });

  it('respects a custom delays schedule', () => {
    let calls = 0;
    const sleeps = [];
    const result = withGitLockRetry(() => {
      calls++;
      if (calls < 2) throw lockError("could not lock config file");
      return 'ok';
    }, { delays: [10], sleep: (ms) => sleeps.push(ms) });

    assert.equal(result, 'ok');
    assert.deepEqual(sleeps, [10]);
  });
});
