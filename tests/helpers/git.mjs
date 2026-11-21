/**
 * @fileoverview Shared test helper — run git synchronously in a temp repo.
 *
 * Two suites had defined a byte-identical wrapper (flagged by the duplication
 * wave at similarity 0.90), the same shape that produced `run-cli.mjs`. All
 * three stdio streams are piped so a failing command's stderr lands on the
 * thrown error rather than on the test runner's console, where it reads as
 * output from an unrelated test.
 *
 * @module tests/helpers/git
 */
import { execFileSync } from 'node:child_process';

/**
 * @param {string[]} args - git argv, e.g. `['worktree', 'list', '--porcelain']`
 * @param {string} cwd
 * @param {Record<string, string>} [env] extra variables layered over `process.env` (e.g. a pinned `GIT_COMMITTER_DATE`)
 * @returns {string} stdout, trimmed
 */
export function git(args, cwd, env) {
  return execFileSync('git', args, {
    cwd, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'], ...(env ? { env: { ...process.env, ...env } } : {}),
  }).trim();
}
