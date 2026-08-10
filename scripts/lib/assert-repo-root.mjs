/**
 * @fileoverview Repo-root cwd guard for CLI entry points.
 *
 * Catches the case where a user cd'd into a subdirectory (e.g. `scripts/`)
 * and ran `node entry.mjs` directly — Node finds the script, but relative
 * paths inside (`.requirements/`, `.audit/`, etc.) resolve to the wrong
 * place. Without this guard the failure is silent or cryptic; with it the
 * user gets a one-line "cd to <path> and re-run" message.
 *
 * NOT a fix for the inverse case (cwd is too far up, like the repo's
 * parent directory). That fails at Node's module loader before any
 * script code runs — no in-script guard can intercept it.
 *
 * @module scripts/lib/assert-repo-root
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';

/**
 * Do two path strings denote the SAME directory?
 *
 * Not `===`. Two strings can name one directory, and on 2026-08-08 that made
 * this guard reject a correct cwd: a git worktree under the temp dir resolved
 * as `…\C--GIT-claude-engineering-skills\…` via `process.cwd()` and
 * `…\c--GIT-claude-engineering-skills\…` via `import.meta.url`, differing only
 * in the case of one segment. Windows is case-insensitive, so both named the
 * same real directory — the guard fired anyway, `sync-to-repos.mjs` exited
 * before copying anything, and the push reported "Sync completed with
 * warnings". Consumers silently went un-synced.
 *
 * `realpathSync.native` is the primary test because on Windows it returns the
 * TRUE on-disk casing for both sides, collapsing the difference exactly rather
 * than by guessing. It also resolves junctions/symlinks, which is what we want:
 * the question is "is cwd this repo root", not "did you spell it the same way".
 *
 * Case-folding is only the fallback for when realpath cannot run (a path that
 * does not exist, or a permission error), and only on win32 where the
 * filesystem is unambiguously case-insensitive. That direction of error is the
 * safe one: this guard is a UX nicety that catches an accidental
 * cd-into-a-subdirectory, so a false ACCEPT merely declines to warn, while a
 * false REJECT aborts real work — which is the bug being fixed.
 *
 * @param {string} a
 * @param {string} b
 * @returns {boolean}
 */
function sameDirectory(a, b) {
  if (a === b) return true;
  try {
    if (fs.realpathSync.native(a) === fs.realpathSync.native(b)) return true;
  } catch {
    // Fall through — an unresolvable path is handled by the fold below.
  }
  if (process.platform === 'win32') return a.toLowerCase() === b.toLowerCase();
  return false;
}

/**
 * Walk up from `scriptPath` until we find a directory whose basename is
 * `scripts`. The directory ABOVE that is the expected repo root.
 *
 * Returns null when no `scripts` ancestor is found (the calling script
 * doesn't live under `scripts/`, so we can't enforce the contract).
 *
 * @param {string} scriptPath — absolute path to the calling script
 * @returns {string | null}
 */
function findExpectedRoot(scriptPath) {
  let dir = path.dirname(scriptPath);
  while (path.basename(dir) !== 'scripts') {
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
  return path.dirname(dir);
}

/**
 * Throw an actionable error and exit(1) when cwd is not the repo root that
 * contains the calling script's `scripts/` directory.
 *
 * Usage at the top of a CLI entry point:
 *   import { assertRepoRoot } from './lib/assert-repo-root.mjs';
 *   assertRepoRoot(import.meta.url);
 *
 * @param {string} importMetaUrl — pass `import.meta.url` verbatim
 * @param {object} [opts]
 * @param {NodeJS.WritableStream} [opts.stderr] — overridable for tests
 * @param {(code: number) => never} [opts.exit] — overridable for tests
 * @returns {{ root: string, cwd: string }} when the guard passes
 */
export function assertRepoRoot(importMetaUrl, opts = {}) {
  const stderr = opts.stderr || process.stderr;
  const exit = opts.exit || ((code) => process.exit(code));
  const env = opts.env || process.env;

  const scriptPath = fileURLToPath(importMetaUrl);
  const expectedRoot = findExpectedRoot(scriptPath);
  if (!expectedRoot) return { root: '', cwd: process.cwd() };

  const cwd = path.resolve(process.cwd());

  // Escape hatch for LEGITIMATE cross-repo invocation. The consumer's pre-push
  // hook deliberately runs the SOURCE repo's openai-audit.mjs against the
  // CONSUMER's cwd — the audit reads its diff/files from process.cwd(), so
  // cwd !== the script's own repo is correct there, not a mistake. The guard
  // exists only to catch an accidental cd-into-a-subdirectory; a caller that
  // sets AUDIT_ALLOW_FOREIGN_CWD=1 is explicitly opting out of the cwd check.
  // (env is overridable via opts.env for tests.)
  if (env.AUDIT_ALLOW_FOREIGN_CWD === '1') return { root: expectedRoot, cwd };

  if (sameDirectory(cwd, expectedRoot)) return { root: expectedRoot, cwd };

  const rel = path.relative(expectedRoot, scriptPath).replaceAll(path.sep, '/');
  stderr.write(
    `Error: This script must be run from the repo root.\n` +
    `  Current directory: ${cwd}\n` +
    `  Expected:          ${expectedRoot}\n` +
    `  Re-run: cd "${expectedRoot}" && node ${rel}\n`
  );
  exit(1);
  return { root: expectedRoot, cwd };
}

/**
 * Non-asserting variant: return the expected repo root for a given script
 * URL without performing the cwd check or exiting on mismatch. Useful for
 * computing repo-rooted paths at module load time, where the asserting form
 * would crash any importer whose cwd doesn't match (e.g. a verifier importing
 * a library from a different repo).
 *
 * Returns null when the script doesn't live under a `scripts/` ancestor.
 *
 * @param {string} importMetaUrl
 * @returns {string | null}
 */
export function findRepoRootFromScript(importMetaUrl) {
  const scriptPath = fileURLToPath(importMetaUrl);
  return findExpectedRoot(scriptPath);
}

/**
 * Resolve the git repo root containing `startDir`, memoised per directory.
 *
 * Distinct from `findRepoRootFromScript`, which answers "where does this CODE
 * live". This answers "which repo is the caller WORKING in" — the right
 * question for a user-supplied path, since a path typed from a subdirectory is
 * relative to the repo, not to the module resolving it.
 *
 * Added 2026-08-10 for debt `0fd6bf8f`: `validatePlanPath` defaulted its
 * containment root to `process.cwd()`, so running any plan-recording command
 * from a subdirectory rejected a valid absolute in-repo plan path as
 * `escapes-repo`. Reproduced from `scripts/` before fixing.
 *
 * Deliberately NOT the `findRepoRoot` in `sync-manifest.mjs`, which is the same
 * computation: importing a store/library module from the sync feature would
 * manufacture a false domain edge, the defect that got `file-lock.mjs` moved
 * out of `lib/brainstorm/`. That copy has 13 dependents, so moving it is a
 * separate change; this lives where a domain-neutral repo-root primitive
 * belongs.
 *
 * Falls back to `startDir` outside a git checkout (tarball install, CI export)
 * — the pre-existing behaviour, so a non-git consumer is unaffected.
 *
 * @param {string} [startDir]
 * @returns {string} absolute repo root, or the resolved startDir
 */
export function findRepoRootFromCwd(startDir = process.cwd()) {
  const key = path.resolve(startDir);
  if (_rootCache.has(key)) return _rootCache.get(key);
  let root;
  try {
    root = execSync('git rev-parse --show-toplevel', {
      cwd: key, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    root = key;
  }
  // A spawn per call would be paid on every plan write; the root cannot change
  // for a given directory within one process.
  _rootCache.set(key, root);
  return root;
}

const _rootCache = new Map();

/** Test-only: the cache is process-lifetime, so a test changing cwd must clear it. */
export function _resetRepoRootCache() { _rootCache.clear(); }

export const _internals = Object.freeze({ findExpectedRoot, sameDirectory });
