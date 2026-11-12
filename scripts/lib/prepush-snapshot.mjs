/**
 * @fileoverview A detached worktree of one commit, created and removed the way both pre-push gates need it: CES's own sandbox
 * (`scripts/prepush-check.mjs`, prefix `ces-prepush-`) and the consumer hook's audit snapshot (`scripts/prepush-step.mjs snapshot`,
 * prefix `ces-consumer-snap-`). One implementation, so a fix to lock retry or removal lands once.
 *
 * Why a snapshot (docs/plans/prepush-gate-consumer-feedback-theme1.md D2): an audit run in the consumer's checkout read the WORKING
 * TREE, so an uncommitted 2.7 MB regenerated file overflowed the adjacency diff and an edit made mid-audit was read as pushed. A
 * detached worktree of the pushed commit holds exactly the pushed bytes, by construction.
 *
 * Removal is VERIFIED by stat, never by an exit code: `git worktree remove` has been measured exiting 0 and leaving the directory
 * standing (see removeSandboxDir in prepush-sandbox-cleanup.mjs). Neither function throws for a removal problem: cleanup must never turn
 * a temp-file problem into a failed push.
 *
 * @module scripts/lib/prepush-snapshot
 */
import { execFileSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { withGitLockRetry, GIT_LOCK_RETRY_DELAYS_MS } from './git-lock-retry.mjs';
import { sanitizeGitEnv } from './git-env-sanitize.mjs';
import { removeSandboxDir, CONSUMER_SNAPSHOT_PREFIX } from './prepush-sandbox-cleanup.mjs';

/** The consumer hook's snapshot prefix; defined beside the sweep that must know it (one spelling). */
export { CONSUMER_SNAPSHOT_PREFIX };

/**
 * `git worktree add/remove/prune` write the SHARED repo's `.git/worktrees/` metadata, which a concurrent session can hold locked for a
 * moment (anthropics/claude-code #34645/#55724). Retried with backoff; anything that is not lock contention throws at once.
 * @param {string} repoRoot
 * @param {string[]} args
 * @param {{onRetry?: (line: string) => void}} [opts]
 */
export function gitWithLockRetry(repoRoot, args, { onRetry = null } = {}) {
  return withGitLockRetry(
    () => execFileSync('git', args, { cwd: repoRoot, stdio: ['ignore', 'ignore', 'pipe'] }),
    {
      onRetry: (attempt, delayMs) => onRetry?.(
        `  ⚠ git ${args.join(' ')} hit lock contention (concurrent session?) — retry ${attempt + 1}/${GIT_LOCK_RETRY_DELAYS_MS.length} in ${delayMs}ms`,
      ),
    },
  );
}

/**
 * The snapshot directory for one invocation: `<tmpDir>/<prefix><tag>-<pid>`. The trailing pid is the owner token the sweep reads
 * (`sandboxOwnerPid`), so a husk whose owner died is swept at once.
 * @param {{prefix: string, tag: string, pid?: number, tmpDir?: string}} input
 */
export function snapshotPath({ prefix, tag, pid = process.pid, tmpDir = os.tmpdir() }) {
  return path.join(tmpDir, `${prefix}${tag}-${pid}`);
}

/**
 * Create a detached worktree of `sha` at `dir`, then pin a worktree-scoped `core.bare=false` (a concurrent writer to the shared
 * `.git/config` was observed flipping `core.bare=true` mid-run, 2026-07-23; the scoped pin cannot leak into other repositories).
 * The pin is best-effort: without it the snapshot is exactly as exposed as it always was.
 *
 * @param {{repoRoot: string, sha: string, dir: string, onRetry?: (line: string) => void}} input `sha` must already be resolved
 * @returns {{ok: true, dir: string} | {ok: false, error: string}}
 */
export function createSnapshot({ repoRoot, sha, dir, onRetry = null }) {
  try {
    gitWithLockRetry(repoRoot, ['worktree', 'add', '--detach', '--quiet', dir, sha], { onRetry });
  } catch (err) {
    return { ok: false, error: `could not create the snapshot worktree: ${err?.stderr?.toString().trim() || err?.message || 'git failed'}` };
  }
  try {
    // A hook exports GIT_DIR (githooks(5)); inherited, it would point this write at the CHECKOUT's worktree config, not the snapshot's.
    execFileSync('git', ['config', '--worktree', 'core.bare', 'false'], { cwd: dir, stdio: 'ignore', env: sanitizeGitEnv(dir) });
  } catch { /* best-effort hardening, see above */ }
  return { ok: true, dir };
}

/**
 * Remove a snapshot worktree and report whether its directory is ACTUALLY gone.
 *
 * Order matters: `git worktree prune` runs only AFTER the directory is confirmed removed, and only when git's own removal failed. Pruning first
 * deregisters a worktree whose directory may still stand, turning a visible husk into an invisible one.
 *
 * @param {{repoRoot: string, dir: string, onRetry?: (line: string) => void}} input
 * @returns {{removed: boolean, gitRemoveFailed: boolean, error: Error|null}}
 */
export function removeSnapshot({ repoRoot, dir, onRetry = null }) {
  let gitRemoveFailed = false;
  try {
    gitWithLockRetry(repoRoot, ['worktree', 'remove', '--force', dir], { onRetry });
  } catch {
    // Metadata already gone, a file locked on Windows, or contention past the retry budget. Not decisive: the stat below is.
    gitRemoveFailed = true;
  }
  const { removed, error } = removeSandboxDir(dir);
  // Only once the directory is GONE: pruning while it still stands deregisters a husk `git worktree list` would otherwise show.
  if (gitRemoveFailed && removed) {
    try { gitWithLockRetry(repoRoot, ['worktree', 'prune'], { onRetry }); } catch { /* noop */ }
  }
  return { removed, gitRemoveFailed, error: error ?? null };
}
