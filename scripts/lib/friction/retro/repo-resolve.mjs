/**
 * @fileoverview Canonical repo identity for a transcript session's first `cwd`
 * (plan docs/plans/harness-retro.md §2 component 3).
 *
 * The cwd may be a subdirectory, a linked worktree of any path shape, a
 * worktree that has since been DELETED (the common case — sessions outlive
 * their worktrees), or a temp dir (`claude -p` runs spawned by the cli backend).
 * Resolution order:
 *   1. the cwd exists and git knows it → its toplevel (worktree-aware: identity
 *      below is the same for a worktree and its main checkout);
 *   2. otherwise the path heuristic maps it to a main root
 *      (`/.claude/worktrees/<name>`, `/.fleet-wt/<repo>/…`), and step 1 is tried there;
 *   3. the root goes to `resolveRepoIdentity` — committed `.audit-loop/repo-id`
 *      or uuidv5(canonical origin). A `path-fallback` identity (no origin) is NOT
 *      stable across machines, so it is treated as unresolved.
 * Unresolved returns `null` — counted and reported by the caller, never guessed.
 *
 * @module scripts/lib/friction/retro/repo-resolve
 */
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import { resolveRepoIdentity } from '../../repo-identity.mjs';

const WORKTREE_SUFFIX_RE = /[\\/]\.claude[\\/]worktrees[\\/][^\\/]+(?:[\\/].*)?$/i;
const FLEET_WT_RE = /^(.*)[\\/]\.fleet-wt[\\/]([^\\/]+)(?:[\\/].*)?$/i;

/**
 * Path-only guess at a session cwd's main checkout. Pure.
 * @param {string} cwd
 * @returns {string}
 */
export function heuristicMainRoot(cwd) {
  const c = String(cwd ?? '');
  const fleet = c.match(FLEET_WT_RE);
  if (fleet) return `${fleet[1]}${c.includes('\\') ? '\\' : '/'}${fleet[2]}`;
  return c.replace(WORKTREE_SUFFIX_RE, '');
}

function defaultRunGit(args, cwd) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', windowsHide: true, timeout: 10_000 });
  return r.status === 0 ? String(r.stdout).trim() : null;
}

const isDir = (p) => { try { return fs.statSync(p).isDirectory(); } catch { return false; } };

/**
 * @param {{runGit?: (args: string[], cwd: string) => string|null,
 *          resolveIdentity?: (root: string) => {repoUuid: string, name: string, source: string},
 *          dirExists?: (p: string) => boolean}} [deps]
 * @returns {{resolve: (cwd: string) => ({repoUuid: string, name: string, root: string}|null), size: () => number}}
 */
export function createRepoResolver(deps = {}) {
  const runGit = deps.runGit ?? defaultRunGit;
  const resolveIdentity = deps.resolveIdentity ?? resolveRepoIdentity;
  const dirExists = deps.dirExists ?? isDir;
  const cache = new Map();

  const toplevel = (dir) => (dir && dirExists(dir) ? runGit(['rev-parse', '--show-toplevel'], dir) : null);

  function resolve(cwd) {
    const key = String(cwd ?? '');
    if (cache.has(key)) return cache.get(key);
    let root = toplevel(key);
    if (!root) {
      const guess = heuristicMainRoot(key);
      if (guess && guess !== key) root = toplevel(guess);
    }
    let out = null;
    if (root) {
      try {
        const id = resolveIdentity(root);
        if (id?.repoUuid && id.source !== 'path-fallback') out = { repoUuid: id.repoUuid, name: id.name, root };
      } catch { out = null; }
    }
    cache.set(key, out);
    return out;
  }

  return { resolve, size: () => cache.size };
}
