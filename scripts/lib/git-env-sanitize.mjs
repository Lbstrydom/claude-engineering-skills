/**
 * @fileoverview Strips git's own "local" environment variables (GIT_DIR,
 * GIT_WORK_TREE, GIT_INDEX_FILE, ...) before handing an environment to a
 * child process that must resolve its OWN git repository from its OWN cwd.
 *
 * Root cause this closes (2026-07-23, confirmed live + empirically, not
 * theorized): git's own hook-invocation machinery exports these into the
 * pre-push hook's process (documented behaviour — see githooks(5): "these
 * variables... are exported so that Git commands run by the hook can
 * correctly locate the repository"). scripts/prepush-check.mjs spawns
 * `npm run check` inheriting `process.env` by default, so a test that builds
 * an "isolated" fixture repo via `execFileSync('git', [...], {cwd: tmpDir})`
 * doesn't get isolation at all -- git gives GIT_DIR precedence over cwd, so
 * the fixture's `git init`/`git commit` silently redirects to the REAL repo
 * that launched the hook. This produced six live incidents in one session:
 * synthetic commits ("seed", "init", "add data + readme" -- the literal
 * strings from tests/diff-scope-resolver.test.mjs's own fixture helper)
 * landing directly on this repo's real HEAD.
 *
 * Git's own documented fix is `unset $(git rev-parse --local-env-vars)`
 * before crossing into a foreign repository/worktree -- git's own versioned
 * list, not a hand-maintained one that can miss a future addition (verified
 * live on this machine's git 2.54.0: 15 vars, several -- GIT_CONFIG,
 * GIT_CONFIG_PARAMETERS, GIT_IMPLICIT_WORK_TREE, GIT_GRAFT_FILE,
 * GIT_NO_REPLACE_OBJECTS, GIT_REPLACE_REF_BASE -- that a guessed list would
 * have missed). This module is the Node equivalent of that shell idiom,
 * used at the hook->sandbox boundary and by tests/helpers/fixtures.mjs's
 * `gitFixtureEnv()` (which imports {@link GIT_LOCAL_ENV_VARS} rather than
 * keeping its own copy -- two independently-maintained lists is exactly the
 * drift risk a plan audit round caught: this module's dynamic discovery vs.
 * a separate static list could silently diverge on a future git version).
 *
 * `GIT_LOCAL_ENV_VARS` is a FLOOR, not the primary mechanism: dynamic
 * discovery via `git rev-parse --local-env-vars` is git's own
 * version-authoritative source and is preferred whenever it succeeds
 * (unioned with the baseline, so the baseline can only ADD coverage, never
 * remove it). The baseline exists for two reasons: (1) a fail-open path
 * for when discovery itself fails transiently -- a genuine risk under the
 * resource-contended, multi-concurrent-session conditions this whole
 * module exists to harden against (audit round 3: `getGitLocalEnvVarNames`
 * previously returned `[]` on a discovery failure, meaning the hook
 * boundary would silently strip NOTHING at exactly the worst moment); (2)
 * tests/helpers/fixtures.mjs's fixture-layer callers, who deliberately do
 * NOT re-run `git rev-parse` on every fixture spawn (real, avoidable
 * subprocess overhead across hundreds of per-test fixture calls) and use
 * the static baseline alone.
 *
 * @module scripts/lib/git-env-sanitize
 */
import { execFileSync } from 'node:child_process';

/**
 * Known git-local environment variable names, as of git 2.54 -- see the
 * module docblock for why this coexists with dynamic discovery rather than
 * replacing or being replaced by it.
 * @type {string[]}
 */
export const GIT_LOCAL_ENV_VARS = [
  'GIT_DIR', 'GIT_WORK_TREE', 'GIT_IMPLICIT_WORK_TREE', 'GIT_INDEX_FILE',
  'GIT_OBJECT_DIRECTORY', 'GIT_ALTERNATE_OBJECT_DIRECTORIES', 'GIT_COMMON_DIR',
  'GIT_PREFIX', 'GIT_SHALLOW_FILE', 'GIT_GRAFT_FILE', 'GIT_NO_REPLACE_OBJECTS',
  'GIT_REPLACE_REF_BASE', 'GIT_CONFIG', 'GIT_CONFIG_PARAMETERS', 'GIT_CONFIG_COUNT',
];

/**
 * @param {string} [cwd] - any directory inside a real git repo; the returned
 *   list is a fixed set of variable NAMES for this git version, not values,
 *   so cwd only needs to be somewhere `git` can run.
 * @returns {string[]} the union of {@link GIT_LOCAL_ENV_VARS} and the live
 *   `git rev-parse --local-env-vars` result when discovery succeeds; just
 *   the static baseline (never `[]`) when it doesn't — a discovery failure
 *   must never mean "strip nothing".
 */
export function getGitLocalEnvVarNames(cwd = process.cwd()) {
  try {
    const out = execFileSync('git', ['rev-parse', '--local-env-vars'], { cwd, encoding: 'utf8' });
    const dynamic = out.split('\n').map((s) => s.trim()).filter(Boolean);
    return Array.from(new Set([...GIT_LOCAL_ENV_VARS, ...dynamic]));
  } catch {
    return [...GIT_LOCAL_ENV_VARS];
  }
}

/**
 * Returns a COPY of `baseEnv` with every git-local variable name deleted.
 * Deletion (not setting `undefined`) so the child's environment is
 * unambiguous rather than depending on how the child's runtime treats an
 * explicit-undefined env value.
 *
 * @param {string} [cwd]
 * @param {NodeJS.ProcessEnv} [baseEnv]
 * @returns {NodeJS.ProcessEnv}
 */
export function sanitizeGitEnv(cwd = process.cwd(), baseEnv = process.env) {
  const env = { ...baseEnv };
  for (const name of getGitLocalEnvVarNames(cwd)) delete env[name];
  return env;
}
