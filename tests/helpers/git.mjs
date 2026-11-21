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
 * @param {Record<string, string>} [env] extra variables layered over the sanitised `process.env` (e.g. a pinned `GIT_COMMITTER_DATE`)
 * @returns {string} stdout, trimmed
 */
/**
 * Repository-SELECTION variables: inherited from a hook or a parent git (pre-push exports GIT_DIR), any of them retargets the
 * command away from `cwd`. They are dropped from the INHERITED environment always (matched case-insensitively — Windows env names
 * are); a caller that means one passes it in `env`, deliberately.
 */
export const REPO_SELECTION_VARS = Object.freeze(['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_OBJECT_DIRECTORY',
  'GIT_ALTERNATE_OBJECT_DIRECTORIES', 'GIT_COMMON_DIR', 'GIT_NAMESPACE', 'GIT_PREFIX', 'GIT_CEILING_DIRECTORIES', 'GIT_DISCOVERY_ACROSS_FILESYSTEM']);
const SELECTION = new Set(REPO_SELECTION_VARS);

/** `process.env` without the repository-selection variables, with `extra` layered on top. */
export function fixtureGitEnv(extra = {}) {
  const out = {};
  for (const [k, v] of Object.entries(process.env)) if (!SELECTION.has(k.toUpperCase())) out[k] = v;
  return { ...out, ...extra };
}

export function git(args, cwd, env) {
  return execFileSync('git', args, {
    cwd, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'], env: fixtureGitEnv(env ?? {}),
  }).trim();
}
