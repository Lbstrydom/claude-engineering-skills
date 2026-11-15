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
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { withGitLockRetry, GIT_LOCK_RETRY_DELAYS_MS } from './git-lock-retry.mjs';
import { sanitizeGitEnv } from './git-env-sanitize.mjs';
import { removeSandboxDir, CONSUMER_SNAPSHOT_PREFIX } from './prepush-sandbox-cleanup.mjs';
import { findNodeModules } from './node-modules-resolver.mjs';
import { canonicalizeEol } from './file-io.mjs';

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
 * Make the checkout's installed tools resolvable from a snapshot: link the `node_modules` the CHECKOUT resolves (Node's own upward
 * walk, lib/node-modules-resolver.mjs) into the snapshot root as a junction (a directory symlink off Windows).
 *
 * Why (upstream report e5a067c3, 2026-11-15): a snapshot lives under the OS temp directory, so no directory above it has a
 * `node_modules`. Every cwd-relative tool lookup the audit makes from it - `npx --no-install eslint|tsc`, an eslint config's own
 * plugin imports - found nothing, or found a GLOBAL copy of a different version. The tools are the checkout's; the bytes they read
 * are still the pushed commit's. The alternative, creating the snapshot inside the checkout, would put a second copy of the whole
 * tree where every checkout-rooted walker (eslint, the symbol index, an IDE) reads it.
 *
 * Refuses - removing its own link, never blocking - when the link does not RESOLVE (on Windows a junction to a missing target
 * is created without error, docs/runbooks/prepush-sandbox.md §2.2), or when the pushed commit's own ignore rules do not ignore it:
 * an unignored link is an untracked change the audit would read as part of the push. `git check-ignore` is asked, not a pattern
 * guessed: `node_modules/` matches a junction on Git for Windows but not a POSIX symlink.
 *
 * `lockDiffers` says when the pushed commit's package-lock.json is not the checkout's: the tools then measure with the checkout's
 * installed tree, which the caller says out loud (installing per push is a cost the audit budget cannot carry).
 *
 * @param {{checkoutRoot: string, dir: string}} input
 * @returns {{linked: true, modules: string, lockDiffers: boolean} | {linked: false, reason: string}}
 */
export function linkCheckoutNodeModules({ checkoutRoot, dir }) {
  const modules = findNodeModules(checkoutRoot);
  if (!modules) return { linked: false, reason: `no node_modules at or above ${checkoutRoot}` };
  const link = path.join(dir, 'node_modules');
  if (pathPresent(link)) return { linked: false, reason: 'the pushed commit already has a node_modules entry' };
  try {
    fs.symlinkSync(modules, link, 'junction');
  } catch (err) {
    return { linked: false, reason: `the link could not be made (${err?.code || err?.message || 'error'})` };
  }
  const refuse = (reason) => { unlinkNodeModulesLink(dir); return { linked: false, reason }; };
  if (!fs.existsSync(path.join(link, '.'))) return refuse(`the link to ${modules} does not resolve`);
  let ignored;
  try {
    execFileSync('git', ['check-ignore', '-q', '--', 'node_modules'], { cwd: dir, stdio: 'ignore', env: sanitizeGitEnv(dir) });
    ignored = true;
  } catch (err) {
    if (err?.status !== 1) return refuse(`git could not say whether node_modules is ignored (${err?.status ?? err?.code ?? 'error'})`);
    ignored = false;
  }
  if (!ignored) return refuse("the pushed commit's ignore rules do not ignore the link, so the audit would read it as an untracked change");
  const lock = (root) => { try { return canonicalizeEol(fs.readFileSync(path.join(root, 'package-lock.json'))); } catch { return null; } };
  const mine = lock(path.dirname(modules));
  const pushed = lock(dir);
  return { linked: true, modules, lockDiffers: !(mine && pushed ? mine.equals(pushed) : mine === pushed) };
}

/** lstat, not exists: a dangling link is still an entry. */
function pathPresent(p) {
  try { fs.lstatSync(p); return true; } catch { return false; }
}

/**
 * Remove the snapshot's `node_modules` entry ONLY when it is a link (what linkCheckoutNodeModules makes), BEFORE anything removes
 * the snapshot recursively: the link's target is the checkout's real tree, and the removal must never be the thing that decides
 * whether to descend into it (the 2026-08-19 incident in prepush-sandbox-cleanup.mjs is why this is not left to rmSync or git).
 * A real directory is left alone. Never throws.
 * @param {string} dir
 * @returns {boolean} true when a link was removed
 */
export function unlinkNodeModulesLink(dir) {
  const link = path.join(dir, 'node_modules');
  try {
    if (!fs.lstatSync(link).isSymbolicLink()) return false;
    fs.unlinkSync(link);
    return true;
  } catch {
    return false;
  }
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
  unlinkNodeModulesLink(dir);
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
