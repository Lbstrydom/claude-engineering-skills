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
import crypto from 'node:crypto';
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

/** Run git in `dir` and return raw bytes (paths are bytes, not necessarily UTF-8). */
const gitBytes = (dir, args) => execFileSync('git', [...GIT_CONFIG, '-C', dir, ...args], { stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 256 * 1024 * 1024, env: cleanEnv() });

/** The id git gives a blob: sha1("blob <length>\0" + bytes). Computed here, so no path is ever handed back to git to interpret. */
export const gitBlobId = (bytes) => crypto.createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');

/**
 * The blob id of a FILE, hashed incrementally from an open descriptor: a large committed file is never held whole in memory (nor limited by
 * Node's buffer size), the git header comes from the size at open, and a file that changes size while being read throws.
 * @param {string|Buffer} file  a path (a Buffer carries a non-UTF-8 name unchanged)
 */
export function gitBlobIdOfFile(file) {
  const fd = fs.openSync(file, 'r');
  try {
    const size = fs.fstatSync(fd).size;
    const h = crypto.createHash('sha1').update(`blob ${size}\0`);
    const chunk = Buffer.allocUnsafe(1 << 20);
    let total = 0;
    for (let n = fs.readSync(fd, chunk, 0, chunk.length, null); n > 0; n = fs.readSync(fd, chunk, 0, chunk.length, null)) { h.update(chunk.subarray(0, n)); total += n; }
    if (total !== size) throw new Error(`file changed size while being read (${size} -> ${total})`);
    return h.digest('hex');
  } finally { fs.closeSync(fd); }
}

/**
 * The audit reads the checked-out FILES while its diff describes the commit's BLOBS. A smudge filter, `ident`, a working-tree-encoding
 * or an eol attribute makes them differ, and no list of attribute names can be complete (a filter may even be NAMED "unset"). So this
 * does not ask what could transform the checkout: it checks whether it DID. Each regular file is read here (streamed) and hashed as a git
 * blob, then compared with the blob id the index holds; any mismatch REFUSES the case before the audit reads anything. Reading and
 * hashing in-process (not `hash-object --stdin-paths`) is deliberate: that interface reinterprets names (a leading quote is C-unquoted, a
 * trailing CR is stripped, LF splits a path), and four audit rounds found a new way each, so no path is ever handed back to git.
 * Symlinks and submodules are skipped (their content is a link target / another repository). Only SHA-1 repositories are verifiable.
 */
function assertTreeMatchesCommit(dir, sha) {
  let listing;
  try { listing = gitBytes(dir, ['ls-files', '-s', '-z']); } catch (err) { throw new Error(`withCaseTree: could not list ${sha}'s files to verify the checkout: ${err.message}`); }
  const bad = [];
  let start = 0;
  while (start < listing.length) {
    let end = listing.indexOf(0, start);
    if (end < 0) end = listing.length;
    const tab = listing.indexOf(9, start);
    if (tab < 0 || tab > end) throw new Error(`withCaseTree: unreadable index entry while verifying ${sha}`);
    const [mode, oid] = listing.subarray(start, tab).toString('latin1').split(' ');
    const name = listing.subarray(tab + 1, end);
    start = end + 1;
    if (mode !== '100644' && mode !== '100755') continue;
    if (oid.length !== 40) throw new Error(`withCaseTree: ${sha} is not a SHA-1 repository; its checkout cannot be verified`);
    let id;
    try { id = gitBlobIdOfFile(Buffer.concat([Buffer.from(`${dir}${path.sep}`), name])); } catch (err) { bad.push(`${name.toString('utf8')} (unreadable: ${err?.code ?? err?.message})`); continue; } // refused, but NAMED as unreadable, not as a transformation
    if (id !== oid) bad.push(name.toString('utf8'));
  }
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
