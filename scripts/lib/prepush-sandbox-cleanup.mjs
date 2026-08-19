/**
 * @fileoverview Directory removal + stale-husk sweep for the pre-push sandbox.
 *
 * WHY THIS EXISTS (measured 2026-08-01): 21 `ces-prepush-*` husks accumulated
 * in %TEMP% over three days — one per push — each containing exactly one
 * surviving entry, `node_modules`. The cause is NOT a swallowed error, which
 * was the intuitive reading. It is that
 *
 *     git worktree remove --force <sandbox>
 *
 * EXITS 0 while leaving the directory standing, whenever the worktree contains
 * an entry git declines to delete. `provisionNodeModules()` puts exactly such
 * an entry there on every single run (a `node_modules` junction, or a real
 * installed tree). Reproduced directly: git deregisters the worktree, deletes
 * the tracked files, returns exit status 0, and the directory remains with
 * `node_modules` inside.
 *
 * So the runner's fallback `rmSync` was never reached — it lived in the `catch`
 * of a call that always succeeded. The leak was invisible because the ONLY
 * thing that ever looked was git's own exit code.
 *
 * THE RULE THIS ENCODES, which is the repo's own doctrine turned on its own
 * tooling: a success signal from a subprocess is not evidence of the
 * postcondition. `stat` is. Every function here reports what it OBSERVED on
 * disk afterwards, never what an exit code claimed.
 *
 * Sweeping is the companion: single-run cleanup cannot be made total on
 * Windows (a `SIGKILL`, a held handle, a lost race with an AV scanner all
 * defeat it), so a later run removes what an earlier one could not. Failure to
 * clean temp is machine state, never repo state — it warns, and must never
 * block a push.
 *
 * @module scripts/lib/prepush-sandbox-cleanup
 */
import fs from 'node:fs';
import path from 'node:path';

/** Directory-name prefix used by scripts/prepush-check.mjs for its sandbox. */
export const SANDBOX_PREFIX = 'ces-prepush-';

/**
 * How old a husk must be before a later run will sweep it.
 *
 * The only thing this threshold has to clear is a CONCURRENT push's live
 * sandbox — two sessions share this repo's working tree, so a second push can
 * legitimately have a fresh sandbox on disk while this one starts. `npm run
 * check` is a minutes-long job, so six hours is orders of magnitude of
 * headroom, while still self-healing within a day rather than at the point the
 * temp volume fills. Age is a sufficient discriminator here precisely because
 * a live sandbox is always young.
 */
export const STALE_SANDBOX_AGE_MS = 6 * 60 * 60 * 1000;

/**
 * Remove a directory and report whether it is ACTUALLY gone afterwards.
 *
 * Never throws: callers are cleanup paths that must not convert a temp-file
 * problem into a failed push.
 *
 * The post-removal `existsSync` is the whole point of this function, not
 * belt-and-braces. Its contract is the postcondition ("the path is gone"), not
 * the absence of a throw — which is the exact distinction the `git worktree
 * remove` bug in the module header turns on.
 *
 * @param {string} dir
 * @returns {{removed: boolean, error?: Error}}
 */
export function removeSandboxDir(dir) {
  if (!fs.existsSync(dir)) return { removed: true };
  try {
    // Windows holds handles briefly after a process exits; retry per the
    // repo-wide rmSync hardening contract (tests/rmsync-retry-guard.test.mjs
    // — a static lint over call-site SYNTAX, not this claim).
    //
    // rmSync does not follow the node_modules junction into the main
    // checkout's real tree — behaviourally verified against the exact shape
    // provisionNodeModules() creates, junction + git-worktree-remove fallback
    // included, in tests/prepush-sandbox-cleanup.test.mjs. A field incident
    // (2026-08-19) still reported the main checkout's node_modules emptied
    // during a run this call could not reproduce even against that fixture —
    // see prepush-check.mjs's postcondition guard (mainModulesForGuard) for
    // the belt-and-braces check that turns any future recurrence, from
    // whatever the actual mechanism turns out to be, into a loud failure
    // instead of a silent one.
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  } catch (error) {
    return { removed: false, error };
  }
  if (fs.existsSync(dir)) {
    return { removed: false, error: new Error('rmSync reported success but the path is still present') };
  }
  return { removed: true };
}

/**
 * List sandbox husks in `tmpDir` old enough to be certainly abandoned.
 *
 * @param {string} tmpDir
 * @param {object} [opts]
 * @param {number} [opts.now] - injectable clock, so the age rule is testable
 * @param {number} [opts.maxAgeMs]
 * @param {string} [opts.prefix]
 * @returns {string[]} absolute paths
 */
export function findStaleSandboxes(tmpDir, opts = {}) {
  const {
    now = Date.now(),
    maxAgeMs = STALE_SANDBOX_AGE_MS,
    prefix = SANDBOX_PREFIX,
  } = opts;

  let entries;
  try {
    entries = fs.readdirSync(tmpDir, { withFileTypes: true });
  } catch {
    return []; // unreadable temp dir is not this gate's problem
  }

  const stale = [];
  for (const entry of entries) {
    // Prefix-scoped on purpose: %TEMP% is shared with every other tool on the
    // machine, and with this repo's own test fixtures (ces-db-test-*,
    // ces-arch-gate-*) which have different owners and lifetimes.
    if (!entry.isDirectory() || !entry.name.startsWith(prefix)) continue;
    const abs = path.join(tmpDir, entry.name);
    try {
      if (now - fs.statSync(abs).mtimeMs >= maxAgeMs) stale.push(abs);
    } catch {
      // Vanished or unstattable between readdir and stat — nothing to do.
    }
  }
  return stale;
}

/**
 * Remove every stale husk in `tmpDir`. Never throws.
 *
 * @param {string} tmpDir
 * @param {object} [opts] - forwarded to findStaleSandboxes
 * @returns {{swept: string[], failed: string[]}}
 */
export function sweepStaleSandboxes(tmpDir, opts = {}) {
  const swept = [];
  const failed = [];
  for (const dir of findStaleSandboxes(tmpDir, opts)) {
    if (removeSandboxDir(dir).removed) swept.push(dir);
    else failed.push(dir);
  }
  return { swept, failed };
}
