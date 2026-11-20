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

const git = (root, args) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024 });

/**
 * Run `fn(dir)` with `dir` a detached checkout of `sha` from `repoRoot`'s repository, then remove it, whether or not `fn` threw.
 * Removal is addressed through `repoRoot`, never through the worktree itself: a worktree already deregistered would otherwise
 * resolve `-C <dir>` to the parent repository.
 * @template T
 * @param {{repoRoot: string, sha: string}} where
 * @param {(dir: string) => Promise<T>} fn
 * @returns {Promise<T>}
 */
export async function withCaseTree({ repoRoot, sha }, fn) {
  if (typeof sha !== 'string' || !isSafeGitRevision(sha)) throw new Error(`withCaseTree: "${sha}" is not a safe git revision`);
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'model-eval-tree-'));
  const dir = path.join(base, 'tree');
  try {
    git(repoRoot, ['worktree', 'add', '--detach', '--force', dir, sha]);
    return await fn(dir);
  } finally {
    try { git(repoRoot, ['worktree', 'remove', '--force', dir]); } catch { /* a failed add leaves nothing registered */ }
    try { git(repoRoot, ['worktree', 'prune']); } catch { /* best effort */ }
    try { fs.rmSync(base, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }); } catch { /* best effort */ }
  }
}
