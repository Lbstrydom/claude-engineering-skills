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
import { isDeepStrictEqual } from 'node:util';
import { withGitLockRetry, GIT_LOCK_RETRY_DELAYS_MS } from './git-lock-retry.mjs';
import { sanitizeGitEnv } from './git-env-sanitize.mjs';
import { removeSandboxDir, detachNodeModulesLink, CONSUMER_SNAPSHOT_PREFIX } from './prepush-sandbox-cleanup.mjs';
import { findNodeModules } from './node-modules-resolver.mjs';

/** The consumer hook's snapshot prefix; defined beside the sweep that must know it (one spelling). */
export { CONSUMER_SNAPSHOT_PREFIX, detachNodeModulesLink };

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
 * walk, lib/node-modules-resolver.mjs) into `intoDir` as a junction (a directory symlink off Windows). The consumer snapshot passes
 * the snapshot's WRAPPER directory, the parent of the worktree, so the link is never inside the audited tree.
 *
 * Why (upstream report e5a067c3, 2026-11-15): a snapshot lives under the OS temp directory, so no directory above it had a
 * `node_modules`. Every cwd-relative tool lookup the audit makes from it - `npx --no-install eslint|tsc`, an eslint config's own
 * plugin imports - found nothing, or a GLOBAL copy of another version (measured: tsc 5.4.3 against the consumer's 5.9.3). Node and
 * npx both walk up past the worktree's package.json, so a link one level above it serves them (measured both ways).
 *
 * Why BESIDE the worktree, not in it: inside, git would see the link, and whether the pushed commit's ignore rules cover it is not a
 * question with a portable answer - `node_modules/` matches a junction on Git for Windows but not a POSIX symlink, and
 * `git check-ignore` also consults local and global excludes the pushed commit does not carry. Beside it, git never sees it. Creating
 * the snapshot inside the checkout was rejected for the opposite reason: every checkout-rooted walker would read a second tree.
 *
 * The bytes the tools read are still the pushed commit's; the TOOLS are the checkout's installed tree. `lock` says whether the pushed
 * package-lock.json is the one that tree was installed from (the modules OWNER's, as prepush-check compares - in a linked worktree
 * that is the main checkout, not `checkoutRoot`): `same`, `differs`, or `unknown` when either side could not be read. `workspaces`
 * says the pushed package.json declares workspaces, whose package links resolve into the CHECKOUT's working copy, not the snapshot.
 * Installing per push is a cost the audit budget cannot carry, so the caller says these out loud instead.
 *
 * Refuses, removing its own link and never throwing, when the link does not RESOLVE: on Windows a junction to a missing target is
 * created without error (docs/runbooks/prepush-sandbox.md §2.2).
 *
 * @param {{checkoutRoot: string, intoDir: string, pushedRoot: string}} input
 * @returns {{linked: true, modules: string, lock: 'same'|'differs'|'unknown', workspaces: boolean} | {linked: false, reason: string}}
 */
export function linkCheckoutNodeModules({ checkoutRoot, intoDir, pushedRoot }) {
  const modules = findNodeModules(checkoutRoot);
  if (!modules) return { linked: false, reason: `no node_modules at or above ${checkoutRoot}` };
  const link = path.join(intoDir, 'node_modules');
  try {
    fs.symlinkSync(modules, link, 'junction');
  } catch (err) {
    return { linked: false, reason: `the link could not be made (${err?.code || err?.message || 'error'})` };
  }
  if (!fs.existsSync(path.join(link, '.'))) {
    const d = detachNodeModulesLink(intoDir);
    return { linked: false, reason: `the link to ${modules} does not resolve${d.state === 'failed' ? ' (and could not be removed)' : ''}` };
  }
  return { linked: true, modules, lock: compareLockfiles(path.dirname(modules), pushedRoot), workspaces: declaresWorkspaces(pushedRoot) };
}

/** Read a file, distinguishing absent (null) from unreadable (throws). */
function readOrAbsent(file) {
  try { return fs.readFileSync(file); } catch (err) {
    if (err?.code === 'ENOENT') return null;
    throw err;
  }
}

/**
 * `same` only when both sides were READ and parse to the same JSON, or both are provably absent; `unknown` when either side could not be
 * read or parsed. Compared as parsed JSON, not bytes: line endings and formatting are not dependency identity, and parsing needs no
 * import of lib/file-io.mjs, whose barrel would put this module (and every pre-push test that reaches it) downstream of half the repo.
 */
export function compareLockfiles(installedRoot, pushedRoot) {
  let a; let b;
  try {
    a = readOrAbsent(path.join(installedRoot, 'package-lock.json'));
    b = readOrAbsent(path.join(pushedRoot, 'package-lock.json'));
  } catch { return 'unknown'; }
  if (a === null && b === null) return 'same';
  if (a === null || b === null) return 'differs';
  let ja; let jb;
  try { ja = JSON.parse(a.toString('utf8')); jb = JSON.parse(b.toString('utf8')); } catch { return 'unknown'; }
  return isDeepStrictEqual(ja, jb) ? 'same' : 'differs';
}

/** Does the pushed package.json declare workspaces? Unreadable or unparseable reads as no: it is a warning, never a gate. */
function declaresWorkspaces(root) {
  try {
    const w = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'))?.workspaces;
    return Array.isArray(w) ? w.length > 0 : Boolean(w && typeof w === 'object');
  } catch { return false; }
}

/**
 * Remove a snapshot worktree and report whether its directory is ACTUALLY gone.
 *
 * A `node_modules` link inside it (prepush-check's provisionNodeModules) is detached FIRST, and a failed detach stops the removal
 * with the snapshot left standing for a later sweep: neither `git worktree remove` nor rmSync may be the thing that decides whether
 * to descend into the checkout's real tree.
 *
 * Order matters: `git worktree prune` runs only AFTER the directory is confirmed removed, and only when git's own removal failed. Pruning first
 * deregisters a worktree whose directory may still stand, turning a visible husk into an invisible one.
 *
 * @param {{repoRoot: string, dir: string, onRetry?: (line: string) => void}} input
 * @returns {{removed: boolean, gitRemoveFailed: boolean, error: Error|null}}
 */
export function removeSnapshot({ repoRoot, dir, onRetry = null }) {
  const detached = detachNodeModulesLink(dir);
  if (detached.state === 'failed') return { removed: false, gitRemoveFailed: false, error: detached.error ?? null };
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
