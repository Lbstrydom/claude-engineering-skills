/**
 * @fileoverview Retry-with-backoff for git commands that transiently lose a
 * race on `.git/config.lock` / `.git/index.lock` to a concurrent process.
 *
 * Distinct from a CORRUPTED value (e.g. core.bare flipped true mid-run by a
 * peer that successfully wrote and released the lock) — that needs a
 * worktree-scoped config override, not a retry, since the bad value is
 * durably on disk until something resets it (see scripts/prepush-check.mjs
 * and .githooks/pre-push for that half of the fix). This module covers the
 * OTHER half: a lock briefly held by a peer that is about to release it,
 * where git aborts immediately instead of waiting. Standard mitigation is
 * exponential backoff, matching git's own advice for its advisory locks.
 *
 * Root cause (2026-07-23): anthropics/claude-code #34645 and #55724 describe
 * concurrent worktree/git operations racing on one shared .git directory —
 * this repo reproduces it with two ordinary concurrent sessions each running
 * their own sandboxed pre-push, no Agent(isolation:"worktree") required.
 *
 * @module scripts/lib/git-lock-retry
 */
import { blockingSleep } from './retry-transient-fs.mjs';

export const GIT_LOCK_RETRY_DELAYS_MS = [200, 400, 800];

const GIT_LOCK_CONTENTION_PATTERN = /could not lock|\.lock['"]?: File exists|unable to create.*\.lock/i;

/** @param {Error & {stderr?: Buffer|string}} err */
export function isGitLockContentionError(err) {
  return GIT_LOCK_CONTENTION_PATTERN.test(err?.stderr?.toString() ?? '');
}

/**
 * @param {() => any} fn - a zero-arg call to execFileSync('git', ...) (must
 *   be invoked with stdio capturing stderr, or lock-contention text can
 *   never be seen and every failure rethrows on attempt 1).
 * @param {{delays?: number[], sleep?: (ms:number)=>void, onRetry?: (attempt:number, delayMs:number, err:Error)=>void}} [opts]
 * @returns {any} fn()'s return value
 */
export function withGitLockRetry(fn, opts = {}) {
  const delays = opts.delays ?? GIT_LOCK_RETRY_DELAYS_MS;
  const sleep = opts.sleep ?? blockingSleep;
  for (let attempt = 0; ; attempt++) {
    try {
      return fn();
    } catch (err) {
      if (attempt >= delays.length || !isGitLockContentionError(err)) throw err;
      opts.onRetry?.(attempt, delays[attempt], err);
      sleep(delays[attempt]);
    }
  }
}
