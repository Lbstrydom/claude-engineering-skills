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
const GIT_CONFIG = ['-c', `core.hooksPath=${os.devNull}`, '-c', 'core.autocrlf=false', '-c', 'core.eol=lf'];
const git = (root, args) => execFileSync('git', [...GIT_CONFIG, '-C', root, ...args],
  { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024, env: cleanEnv() });

/** Run git in `dir` with raw bytes in and out (paths are bytes, not necessarily UTF-8) and an optional stdin. */
const gitBytes = (dir, args, input) => execFileSync('git', [...GIT_CONFIG, '-C', dir, ...args], { input, stdio: ['pipe', 'pipe', 'pipe'], maxBuffer: 256 * 1024 * 1024, env: cleanEnv() });

/**
 * The audit reads the checked-out FILES while its diff describes the commit's BLOBS. A smudge filter, `ident`, a working-tree-encoding
 * or an eol attribute makes them differ, and no list of attribute names can be complete (a filter may even be NAMED "unset"). So this
 * does not ask what could transform the checkout: it checks whether it DID. Every regular file's raw bytes (hash-object --no-filters)
 * are compared with the blob id the index holds for it; any mismatch REFUSES the case before the audit reads anything. Symlinks and
 * submodules are skipped (their content is a link target / another repository). Paths travel as bytes through stdin, so no
 * command-line length limit applies and non-UTF-8 names survive.
 */
function assertTreeMatchesCommit(dir, sha) {
  let listing;
  try { listing = gitBytes(dir, ['ls-files', '-s', '-z']); } catch (err) { throw new Error(`withCaseTree: could not list ${sha}'s files to verify the checkout: ${err.message}`); }
  const files = [];
  let start = 0;
  while (start < listing.length) {
    let end = listing.indexOf(0, start);
    if (end < 0) end = listing.length;
    const tab = listing.indexOf(9, start);
    if (tab < 0 || tab > end) throw new Error(`withCaseTree: unreadable index entry while verifying ${sha}`);
    const [mode, oid] = listing.subarray(start, tab).toString('latin1').split(' ');
    const name = listing.subarray(tab + 1, end);
    if (mode === '100644' || mode === '100755') {
      if (name.includes(10)) throw new Error(`withCaseTree: ${sha} has a path containing a newline; its checkout cannot be verified`);
      files.push({ oid, name });
    }
    start = end + 1;
  }
  if (files.length === 0) return;
  let hashed;
  try {
    const input = Buffer.concat(files.flatMap((f) => [f.name, Buffer.from('\n')]));
    hashed = gitBytes(dir, ['hash-object', '--no-filters', '--stdin-paths'], input).toString('latin1').split('\n').filter(Boolean);
  } catch (err) { throw new Error(`withCaseTree: could not hash the checked-out files of ${sha}: ${err.message}`); }
  if (hashed.length !== files.length) throw new Error(`withCaseTree: hashed ${hashed.length} of ${files.length} files of ${sha}; the checkout cannot be verified`);
  const bad = files.filter((f, i) => hashed[i] !== f.oid).map((f) => f.name.toString('utf8'));
  if (bad.length > 0) throw new Error(`withCaseTree: refusing to audit ${sha}: its checkout differs from the commit's blobs (a filter, ident, encoding or eol attribute is transforming it), so the files read would not be what the diff describes: ${bad.slice(0, 5).join(', ')}${bad.length > 5 ? `, and ${bad.length - 5} more` : ''}`);
}

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
  try {
    _git(repoRoot, ['worktree', 'add', '--detach', '--force', dir, sha]);
    // The tree is checked out, but nothing has READ it yet: a checkout that differs from the commit's blobs refuses the case here, and the common cleanup below removes it.
    assertTreeMatchesCommit(dir, sha);
    result = await fn(dir);
  } catch (err) { primary = err; failed = true; }

  // Attempted whether or not `add` returned: a git killed between registering and finishing the checkout leaves a registration.
  // Two --force: a locked worktree is still ours to remove. ANY failed removal is reported (after a failed `add` it is a warning next to
  // the add error): neither the add result nor a missing directory proves the registration is gone. The message carries the two paths,
  // not a ready-made shell command (a path is never interpolated into command text) and never suggests the repository-wide prune.
  let leftover = null;
  try { _git(repoRoot, ['worktree', 'remove', '--force', '--force', dir]); } catch (err) {
    leftover = `the case tree for ${sha} could not be removed (repository: ${JSON.stringify(repoRoot)}, tree: ${JSON.stringify(dir)}; find it in 'git worktree list' and remove only that entry with 'git worktree remove -f -f'): ${err.message}`;
  }
  // Nothing recoverable lives in `base` when the tree directory is gone (a failed add): remove it even though the removal is reported.
  if (!leftover || !fs.existsSync(dir)) {
    try { fs.rmSync(base, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }); } catch (err) { leftover = `could not delete ${base}: ${err.message}`; }
  }
  if (leftover) {
    if (!failed) throw new Error(`withCaseTree: ${leftover}`);
    _warn(`withCaseTree: ${leftover}`);
  }
  if (failed) throw primary;
  return result;
}
