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
import { installedTreeStale } from './installed-tree-identity.mjs';
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
 * The bytes the tools read are still the pushed commit's; the TOOLS are the checkout's installed tree, and two things can make that
 * tree disagree with the pushed commit, which the caller says out loud (installing per push is a cost the audit budget cannot carry):
 *  - `installed`: does the installed tree match the PUSHED package-lock.json? Asked of npm's own install record
 *    (`node_modules/.package-lock.json`) by lib/installed-tree-identity.mjs - the record of what was installed, not the lockfile that
 *    happens to sit beside it now, which can have been edited or pulled since. Any doubt reads as a mismatch, with its reason.
 *  - `localLinks`: package entries anywhere in the tree that are links resolving OUTSIDE it (workspace packages, `file:` and
 *    `npm link` dependencies; see findLocalLinks). A tool following an import into one reads the checkout's WORKING COPY, not the
 *    pushed bytes. pnpm's own links stay inside the tree (`.pnpm`), so they are not counted.
 *
 * Refuses, removing its own link and never throwing, when the link does not RESOLVE: on Windows a junction to a missing target is
 * created without error (docs/runbooks/prepush-sandbox.md §2.2).
 *
 * @param {{checkoutRoot: string, intoDir: string, pushedRoot: string}} input
 * @returns {{linked: true, modules: string, installed: {matches: boolean, reason: string},
 *   localLinks: {links: string[], count: number, complete: boolean}}
 *   | {linked: false, reason: string}}
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
  return { linked: true, modules, installed: installedMatchesPushed(modules, pushedRoot), localLinks: findLocalLinks(modules) };
}

/** Does npm's record of what is installed in `modules` match the pushed package-lock.json? Fails toward "no", with a reason. */
export function installedMatchesPushed(modules, pushedRoot) {
  const read = (file) => { try { return fs.readFileSync(file, 'utf8'); } catch { return null; } };
  const pushed = read(path.join(pushedRoot, 'package-lock.json'));
  if (pushed === null) return { matches: false, reason: 'the pushed commit has no readable package-lock.json to compare with' };
  const verdict = installedTreeStale(pushed, read(path.join(modules, '.package-lock.json')));
  return { matches: !verdict.stale, reason: verdict.reason };
}

/**
 * Package entries anywhere in the `modules` tree that are links resolving OUTSIDE it: each `node_modules` level (top, `@scope/`, and
 * every nested `<pkg>/node_modules`) is walked, links are never followed, and an entry that cannot be resolved counts as outside (it
 * cannot be shown to be inside). Dot-directories are walked too - pnpm's `.pnpm` store is where its nested links live - except
 * `.bin` and `.cache`, which hold no packages. A nested `node_modules` that is itself a link is classified, never walked into.
 *
 * `complete` is false when part of the tree could not be read or the walk hit its entry budget: a partial scan is never reported
 * as a clean one. `links` is capped (the caller prints a sample, not an inventory); `count` is how many were found.
 *
 * @returns {{links: string[], count: number, complete: boolean}} package locations relative to `modules`, forward slashes
 */
export function findLocalLinks(modules, { cap = 50, maxEntries = 200_000 } = {}) {
  let root;
  try { root = fs.realpathSync.native(modules); } catch { return { links: [], count: 0, complete: false }; }
  const inside = (p) => { const rel = path.relative(root, p); return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel); };
  const found = new Set();
  let complete = true;
  let seen = 0;
  const queue = [[root, '']];
  while (queue.length) {
    const [dir, prefix] = queue.shift();
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { complete = false; continue; }
    for (const e of entries) {
      if (++seen > maxEntries) { complete = false; queue.length = 0; break; }
      if (e.name === '.bin' || e.name === '.cache') continue;
      const full = path.join(dir, e.name);
      const name = `${prefix}${e.name}`;
      if (e.isSymbolicLink()) {
        let target = null;
        try { target = fs.realpathSync.native(full); } catch { target = null; }
        if (!target || !inside(target)) found.add(name);
        continue;
      }
      if (!e.isDirectory()) continue;
      // A scope directory sits directly in a node_modules level; inside it are packages, never another scope.
      const atLevel = prefix === '' || prefix.endsWith('node_modules/');
      // pnpm's store is a directory of `<pkg>@<version>/node_modules/` trees: its entries are walked like packages.
      if (atLevel && (e.name.startsWith('@') || e.name === '.pnpm')) { queue.push([full, `${name}/`]); continue; }
      // A directory NAMED node_modules is a level, not a package (pnpm's hoisted `.pnpm/node_modules`).
      if (e.name === 'node_modules') { queue.push([full, `${name}/`]); continue; }
      const nested = path.join(full, 'node_modules');
      let st = null;
      try { st = fs.lstatSync(nested); } catch (err) { if (err?.code !== 'ENOENT') complete = false; }
      if (st?.isSymbolicLink()) {
        let target = null;
        try { target = fs.realpathSync.native(nested); } catch { target = null; }
        if (!target || !inside(target)) found.add(`${name}/node_modules`);
      } else if (st?.isDirectory()) {
        queue.push([nested, `${name}/node_modules/`]);
      }
    }
  }
  const all = [...found].sort();
  return { links: all.slice(0, cap), count: all.length, complete };
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
