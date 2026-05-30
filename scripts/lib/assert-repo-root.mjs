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

import path from 'node:path';
import { fileURLToPath } from 'node:url';

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

  const scriptPath = fileURLToPath(importMetaUrl);
  const expectedRoot = findExpectedRoot(scriptPath);
  if (!expectedRoot) return { root: '', cwd: process.cwd() };

  const cwd = path.resolve(process.cwd());
  if (cwd === expectedRoot) return { root: expectedRoot, cwd };

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

export const _internals = Object.freeze({ findExpectedRoot });
