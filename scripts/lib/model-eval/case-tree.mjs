/**
 * @fileoverview The tree a model-eval generation call reads files from. A corpus case is a COMMIT: its diff is extracted from git,
 * but the audit pipeline resolves every file read against `process.cwd()`, so auditing from the fixture checkout showed the model
 * the commit's diff against TODAY's files. 14 of 91 expect_clean findings (2026-11-20) cited code added by a later commit, and a
 * `detect` case sees the defect already fixed. This materialises the case's own tree as a throwaway detached worktree.
 *
 * @module scripts/lib/model-eval/case-tree
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { isSafeGitRevision } from '../vcs.mjs';

// Variables that make `git -C <root>` act on a DIFFERENT repository (a git hook, e.g. pre-push, sets several): dropped for every call.
const GIT_REPO_SELECTORS = ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_COMMON_DIR', 'GIT_OBJECT_DIRECTORY', 'GIT_ALTERNATE_OBJECT_DIRECTORIES', 'GIT_NAMESPACE', 'GIT_PREFIX'];
const cleanEnv = () => { const e = { ...process.env }; for (const k of GIT_REPO_SELECTORS) delete e[k]; return e; };

// `core.hooksPath` pointed at nothing: a repository's own post-checkout hook must not run while a tree is materialised, or it could
// rewrite the files the audit is about to read.
const git = (root, args, { hooks = false } = {}) => execFileSync('git', [...(hooks ? [] : ['-c', `core.hooksPath=${os.devNull}`]), '-C', root, ...args],
  { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024, env: cleanEnv() });

/**
 * Run `fn(dir)` with `dir` a detached checkout of `sha` from `repoRoot`'s repository, then remove it, whether or not `fn` threw.
 * Removal is addressed through `repoRoot`, never through the worktree itself: a worktree already deregistered would otherwise
 * resolve `-C <dir>` to the parent repository. A cleanup that fails is REPORTED: it throws when `fn` succeeded, and rides on the
 * primary error as `cleanupErrors` when `fn` threw (the primary error is never replaced).
 * @template T
 * @param {{repoRoot: string, sha: string}} where
 * @param {(dir: string) => Promise<T>} fn
 * @returns {Promise<T>}
 */
export async function withCaseTree({ repoRoot, sha }, fn, { _git = git } = {}) {
  if (typeof sha !== 'string' || !isSafeGitRevision(sha)) throw new Error(`withCaseTree: "${sha}" is not a safe git revision`);
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'model-eval-tree-'));
  const dir = path.join(base, 'tree');
  let added = false; let result; let primary = null;
  try {
    _git(repoRoot, ['worktree', 'add', '--detach', '--force', dir, sha]);
    added = true;
    result = await fn(dir);
  } catch (err) { primary = err; }
  const cleanupErrors = [];
  if (added) {
    // Two --force: a locked worktree (a crashed earlier call, or anything that locked it) is still ours to remove.
    try { _git(repoRoot, ['worktree', 'remove', '--force', '--force', dir]); } catch (err) {
      cleanupErrors.push(`worktree remove ${dir}: ${err.message}`);
      // Remove the files, then prune the now-dangling registration: only on this failure path, never routinely, because prune is
      // repository-wide and must not touch other worktrees (e.g. ones on a temporarily unavailable mount) when nothing went wrong.
      try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }); _git(repoRoot, ['worktree', 'prune']); } catch (err2) { cleanupErrors.push(`fallback cleanup ${dir}: ${err2.message}`); }
    }
  }
  try { fs.rmSync(base, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }); } catch (err) { cleanupErrors.push(`rm ${base}: ${err.message}`); }
  if (primary) {
    if (cleanupErrors.length > 0) primary.cleanupErrors = cleanupErrors;
    throw primary;
  }
  if (cleanupErrors.length > 0) throw new Error(`withCaseTree: cleanup of the case tree for ${sha} failed: ${cleanupErrors.join('; ')}`);
  return result;
}
