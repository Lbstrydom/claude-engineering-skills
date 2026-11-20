/**
 * @fileoverview The tree a model-eval generation call reads files from. A corpus case is a COMMIT: its diff is extracted from git,
 * but the audit pipeline resolves every file read against `process.cwd()`, so auditing from the fixture checkout showed the model
 * the commit's diff against TODAY's files. 14 of 91 expect_clean findings (2026-11-20) cited code added by a later commit, and a
 * `detect` case sees the defect already fixed. This materialises the case's own tree as a throwaway detached worktree.
 *
 * Cleanup is deliberately ONE step: `git worktree remove --force --force`. Rounds 1-4 of the audit each found a new way a hand-rolled
 * fallback (prune, registration lookup by path) could touch the wrong worktree or hide a failure, so there is none: a removal that
 * fails is REPORTED, and the tree is left exactly where it is, registered and intact, for the operator to remove.
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
// rewrite the files the audit is about to read. (Checkout FILTERS are not disabled: none of the corpus repos names one in
// .gitattributes, so no file is filtered; a future corpus repo that does is a curation constraint.)
const git = (root, args) => execFileSync('git', ['-c', `core.hooksPath=${os.devNull}`, '-C', root, ...args],
  { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024, env: cleanEnv() });

/**
 * Run `fn(dir)` with `dir` a detached checkout of `sha` from `repoRoot`'s repository, then remove it, whether or not `fn` threw.
 * Removal is addressed through `repoRoot`, never through the worktree itself. If removal fails, `fn`'s result is not returned:
 * with a successful `fn` the call throws (naming the repository and the leftover tree); with a failing `fn` the
 * original thrown value is rethrown UNCHANGED (never mutated, never wrapped) and the cleanup failure goes to `_warn`.
 * @template T
 * @param {{repoRoot: string, sha: string}} where
 * @param {(dir: string) => Promise<T>} fn
 * @param {{_git?: typeof git, _warn?: (msg: string) => void}} [deps]
 * @returns {Promise<T>}
 */
export async function withCaseTree({ repoRoot, sha }, fn, { _git = git, _warn = (m) => process.stderr.write(`${m}\n`) } = {}) {
  if (typeof sha !== 'string' || !isSafeGitRevision(sha)) throw new Error(`withCaseTree: "${sha}" is not a safe git revision`);
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'model-eval-tree-'));
  const dir = path.join(base, 'tree');
  let result; let primary; let failed = false; // a thrown value may be falsy: track THAT it threw, not what
  let added = false;
  try {
    _git(repoRoot, ['worktree', 'add', '--detach', '--force', dir, sha]);
    added = true;
    result = await fn(dir);
  } catch (err) { primary = err; failed = true; }

  // Attempted whether or not `add` returned: a git killed between registering and finishing the checkout leaves a registration.
  // Two --force: a locked worktree is still ours to remove. A failed removal is a cleanup failure whenever `add` succeeded (a missing
  // directory proves nothing about the registration); after a failed `add` it is one only if a directory was left behind.
  // The message carries the two paths, not a ready-made shell command: a path is never interpolated into command text.
  let leftover = null;
  try { _git(repoRoot, ['worktree', 'remove', '--force', '--force', dir]); } catch (err) {
    if (added || fs.existsSync(dir)) leftover = `the case tree for ${sha} could not be removed (repository: ${JSON.stringify(repoRoot)}, tree: ${JSON.stringify(dir)}; run 'git worktree remove -f -f' on the tree, or 'git worktree prune' if its directory is gone): ${err.message}`;
  }
  if (!leftover) {
    try { fs.rmSync(base, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }); } catch (err) { leftover = `could not delete ${base}: ${err.message}`; }
  }
  if (leftover) {
    if (!failed) throw new Error(`withCaseTree: ${leftover}`);
    _warn(`withCaseTree: ${leftover}`);
  }
  if (failed) throw primary;
  return result;
}
