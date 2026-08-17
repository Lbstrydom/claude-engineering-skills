/**
 * @fileoverview Create / verify / remove a detached worktree pinned at an
 * explicit commit, for the duration of a spend-bearing run.
 *
 * Plan: `docs/plans/pinned-revision-fixture.md`. Every non-obvious step here is
 * a measured requirement, not a preference — see the per-function notes.
 *
 * @module scripts/lib/pinned-worktree/manage
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { findNodeModules } from '../node-modules-resolver.mjs';
import { dependencySetChanged } from '../dependency-identity.mjs';
import { canonicalizeEol } from '../file-io.mjs';
import { fixturePath, resolveMainRoot, defaultFixtureRoot } from './paths.mjs';

const IS_WIN = process.platform === 'win32';
const NPM = IS_WIN ? 'npm.cmd' : 'npm';

/**
 * @param {string[]} args @param {string} [cwd]
 *
 * stderr is CAPTURED, not inherited. `removeFixture` deliberately tolerates a
 * failing `git worktree remove` and reports it in its own words, so letting
 * git's raw `fatal: … is not a working tree` reach the terminal on a
 * *successful* idempotent removal trains the reader to ignore output — the
 * opposite of what a spend-bearing tool needs. Captured text is still available
 * on `err.stderr` for the messages that quote it.
 */
function git(args, cwd) {
  return execFileSync('git', args, { cwd, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
}

/**
 * Run one git command with ALL hooks suppressed.
 *
 * **Why** (plan §2 Decision 6). `.githooks/post-checkout` fires on
 * `git worktree add`, prints "Claude configured for &lt;name&gt;" and writes a
 * `.claude/settings.local.json` carrying `additionalDirectories` and
 * `enableAllProjectMcpServers`. This fixture is meant to serve Codex CLI,
 * Copilot, Cursor and Windsurf equally, and none of them should inherit a
 * Claude-specific side effect from creating one.
 *
 * `-c core.hooksPath=<empty dir>` was chosen over the two alternatives after
 * testing all three: editing the hook to detect worktrees changes behaviour for
 * every existing caller to serve one new one, and `--no-checkout` does not help
 * because the hook fires on the subsequent checkout anyway. This is scoped to a
 * single invocation and leaves repo config untouched.
 *
 * Verified: with suppression, `.claude/settings.local.json` is ABSENT after
 * `worktree add`; without it, the file is written.
 *
 * @param {string[]} args
 * @param {string} [cwd]
 */
function gitNoHooks(args, cwd) {
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'pwt-nohooks-'));
  try {
    return git(['-c', `core.hooksPath=${empty}`, ...args], cwd);
  } finally {
    try { fs.rmSync(empty, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }); } catch { /* best effort */ }
  }
}

/**
 * Resolve a user-supplied revision to a full 40-char sha, ONCE.
 *
 * The pin must be a concrete commit, never a branch name: a worktree checked
 * out on a branch follows that branch, which reintroduces the concurrent-session
 * race through a different door. Resolving once and recording the result is
 * what lets `verify` answer "did anything move?" against the pin rather than
 * against whatever `HEAD` means at verification time.
 *
 * @param {string} rev
 * @param {string} cwd
 * @returns {string}
 */
export function resolveRevision(rev, cwd) {
  const sha = git(['rev-parse', '--verify', `${rev}^{commit}`], cwd);
  if (!/^[0-9a-f]{40}$/.test(sha)) {
    throw new Error(`pinned-worktree: ${JSON.stringify(rev)} did not resolve to a commit sha (got ${JSON.stringify(sha)})`);
  }
  return sha;
}

/**
 * Provision `node_modules` in the fixture.
 *
 * **Reuses, rather than re-implements** (plan §Neighbourhood). `findNodeModules`
 * resolves the tree the way NODE does — not as `<repoRoot>/node_modules`, which
 * is absent in every worktree — and `dependencySetChanged` decides whether a
 * link is honest, failing CLOSED. Both are the modules `prepush-check.mjs`
 * already depends on for the same question.
 *
 * A junction is ~instant and correct whenever the pinned revision's dependency
 * set matches the checkout that owns the modules. When it does not, linking
 * would run the pinned code against the wrong dependency tree, so we install.
 *
 * `'junction'` is Windows-only and needs no elevation; other platforms ignore
 * the type and create a directory symlink. Windows requires an ABSOLUTE target,
 * which `findNodeModules` already returns.
 *
 * `--ignore-scripts`: the `prepare` lifecycle runs `install-git-hooks.mjs`,
 * which writes `core.hooksPath` — config shared with the main checkout, so
 * letting it run from a fixture could repoint the real repo's hooks.
 *
 * @param {string} fixture
 * @param {string} mainRoot
 * @param {{forceInstall?: boolean}} [opts]
 * @returns {{mode: 'linked'|'installed', target: string|null, reason: string}}
 */
export function provisionNodeModules(fixture, mainRoot, opts = {}) {
  const mainModules = findNodeModules(mainRoot);
  const modulesOwner = mainModules ? path.dirname(mainModules) : mainRoot;
  const readOrNull = (p) => { try { return fs.readFileSync(p, 'utf8'); } catch { return null; } };
  const deps = dependencySetChanged(
    readOrNull(path.join(modulesOwner, 'package.json')),
    readOrNull(path.join(fixture, 'package.json')),
  );
  let lockChanged = deps.changed;
  let reason = deps.changed ? deps.reason : 'dependency set unchanged';
  if (!lockChanged) {
    try {
      // CANONICALISE EOL BEFORE COMPARING. Measured 2026-08-18: with
      // `core.autocrlf=true` — the Git-for-Windows installer's SYSTEM-level
      // default, so it is set on machines whose user and global configs are
      // both empty — a fresh worktree checkout gets CRLF while the main
      // working tree holds LF. The same committed `package-lock.json` then
      // measured 59 bytes against 63, the compare said "differs", and every
      // single `create` paid a full `npm ci` for a dependency set that had not
      // moved. This repo's `.gitattributes eol=lf` hides it HERE; a consumer
      // repo without one is bitten on every fixture.
      //
      // Canonicalising is correct rather than merely convenient: the question
      // asked is "is the dependency tree the same?", and a line ending is not
      // dependency-relevant. (Contrast the rule's other half — never
      // canonicalise where the exact bytes ARE the contract.)
      const lockMain = canonicalizeEol(fs.readFileSync(path.join(modulesOwner, 'package-lock.json')));
      const lockFixture = canonicalizeEol(fs.readFileSync(path.join(fixture, 'package-lock.json')));
      if (!lockMain.equals(lockFixture)) {
        lockChanged = true;
        reason = 'package-lock.json differs between the pinned revision and the modules owner';
      }
    } catch {
      lockChanged = true; // can't prove they match → install rather than assume
      reason = 'package-lock.json unreadable in one of the two checkouts';
    }
  }

  if (!opts.forceInstall && !lockChanged && mainModules) {
    try {
      fs.symlinkSync(mainModules, path.join(fixture, 'node_modules'), 'junction');
      return { mode: 'linked', target: mainModules, reason };
    } catch (err) {
      reason = `link failed (${err.message}) — installing instead`;
    }
  }
  if (!mainModules && !opts.forceInstall) reason = `no node_modules found at or above ${mainRoot}`;

  const r = execFileSync(NPM, ['ci', '--ignore-scripts', '--no-audit', '--no-fund'], {
    cwd: fixture, encoding: 'utf-8', shell: IS_WIN,
  });
  return { mode: 'installed', target: null, reason: opts.forceInstall ? 'install forced by --install' : reason, stdout: r };
}

/**
 * Create the fixture: detached worktree at the pinned sha, plus `node_modules`.
 *
 * Does NOT run the credential preflight — the caller does, so that a refusal
 * can report against the fixture's OWN resolved environment (the env the run
 * will actually see), not the main checkout's.
 *
 * @param {{name: string, rev: string, root?: string, cwd?: string, forceInstall?: boolean}} args
 */
export function createFixture({ name, rev, root, cwd = process.cwd(), forceInstall = false }) {
  const mainRoot = resolveMainRoot(cwd);
  const fixtureRoot = root ? path.resolve(root) : defaultFixtureRoot(mainRoot);
  const dir = fixturePath(fixtureRoot, name);
  if (fs.existsSync(dir)) {
    throw new Error(
      `pinned-worktree: ${dir} already exists. Use \`verify\` to inspect it, or \`remove\` first — `
      + 'refusing to reuse a directory whose revision this command did not pin.',
    );
  }
  const sha = resolveRevision(rev, cwd);
  fs.mkdirSync(fixtureRoot, { recursive: true });
  gitNoHooks(['worktree', 'add', '--detach', dir, sha], cwd);
  const modules = provisionNodeModules(dir, mainRoot, { forceInstall });
  return { name, dir, sha, mainRoot, fixtureRoot, modules };
}

/**
 * Re-assert every property the fixture is supposed to have.
 *
 * The three git properties are checked SEPARATELY because they fail
 * independently: a fixture can be detached but at the wrong commit, or at the
 * right commit but with a dirty tree that changes what the run reads.
 *
 * @param {{dir: string, expectedSha?: string|null}} args
 */
export function verifyFixture({ dir, expectedSha = null }) {
  const checks = [];
  const add = (name, ok, detail) => checks.push({ name, ok, detail });

  if (!fs.existsSync(dir)) {
    add('exists', false, `${dir} does not exist`);
    return { ok: false, dir, checks };
  }
  add('exists', true, dir);

  // Detached: `symbolic-ref -q HEAD` EXITS NON-ZERO when detached, so a
  // successful call is the failure case here.
  let detached = true;
  let branch = null;
  try {
    branch = git(['symbolic-ref', '-q', 'HEAD'], dir);
    detached = false;
  } catch { detached = true; }
  add('detached', detached, detached
    ? 'HEAD is detached — the pin cannot follow a branch'
    : `HEAD is on ${branch} — a branch checkout follows other sessions' commits, which is the race this fixture exists to prevent`);

  const head = git(['rev-parse', 'HEAD'], dir);
  add('pinned', expectedSha ? head === expectedSha : true,
    expectedSha && head !== expectedSha ? `HEAD ${head} != pinned ${expectedSha}` : head);

  const dirty = git(['status', '--porcelain'], dir);
  add('clean', dirty === '', dirty === '' ? 'working tree clean' : `${dirty.split('\n').length} modified path(s)`);

  // node_modules must RESOLVE, not merely exist — a dangling link passes an
  // existsSync check and fails every subprocess the run spawns.
  const nm = path.join(dir, 'node_modules');
  let modulesOk = false;
  let modulesDetail = 'absent';
  try {
    const st = fs.lstatSync(nm);
    const linked = st.isSymbolicLink();
    const target = linked ? fs.readlinkSync(nm) : nm;
    modulesOk = fs.existsSync(path.join(target, '.package-lock.json')) || fs.existsSync(target);
    modulesDetail = linked ? `link -> ${target}` : 'real directory';
  } catch (err) { modulesDetail = `unreadable (${err.code || err.message})`; }
  add('node_modules', modulesOk, modulesDetail);

  return { ok: checks.every((c) => c.ok), dir, head, checks };
}

/**
 * Remove the fixture, reconciling registry and disk.
 *
 * **Written for a world where the two disagree, because they measurably do.**
 * Reproduced 2026-08-17/18:
 *
 *   - `fs.rmSync(recursive)` over a tree containing a `node_modules` junction
 *     fails `EBUSY` and leaves BOTH the junction and its parent behind. It does
 *     NOT follow the junction (the target survived), but it does not clean up
 *     either.
 *   - `git worktree remove` can fail with `Permission denied` and **still
 *     deregister** the worktree: a second call reports "is not a working tree"
 *     while the directory is still on disk.
 *
 * That pair is the mechanism behind the 11 orphaned directories under
 * `.claude/worktrees/` (3 registered), each containing nothing but a dangling
 * junction. So: unlink first, tolerate git's failure, prune, then reconcile
 * whatever is left.
 *
 * The unlink is guarded by `isSymbolicLink()` and never recurses. The failure
 * mode being defended against is deleting the MAIN checkout's `node_modules`
 * through the link — `fs.rmSync` does not do that, but the guard does not rely
 * on that behaviour.
 *
 * Idempotent: removing an already-removed fixture is a success.
 *
 * @param {{dir: string, cwd?: string}} args
 */
export function removeFixture({ dir, cwd = process.cwd() }) {
  const steps = [];
  const nm = path.join(dir, 'node_modules');

  try {
    const st = fs.lstatSync(nm);
    if (st.isSymbolicLink()) {
      fs.unlinkSync(nm);
      steps.push('unlinked node_modules link');
    } else {
      // A REAL directory: leave it to the recursive delete below. Never unlink
      // or recurse into something that might not be ours to follow.
      steps.push('node_modules is a real directory — left for the recursive delete');
    }
  } catch (err) {
    if (err.code !== 'ENOENT') steps.push(`node_modules lstat failed (${err.code}) — continuing`);
  }

  try {
    git(['worktree', 'remove', '--force', dir], cwd);
    steps.push('git worktree remove succeeded');
  } catch (err) {
    // Deliberately tolerated: git deregisters even when the delete fails, so
    // the reconcile below is what actually guarantees the end state.
    steps.push(`git worktree remove failed (${String(err.stderr || err.message).trim().split('\n').pop()}) — reconciling`);
  }

  try { git(['worktree', 'prune'], cwd); steps.push('pruned the worktree registry'); } catch { /* best effort */ }

  if (fs.existsSync(dir)) {
    // maxRetries/retryDelay per the repo-wide rmSync hardening convention
    // (tests/rmsync-retry-guard.test.mjs) — EBUSY here is exactly the transient
    // this fixture measured, so a single-shot delete is the wrong instrument.
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
    steps.push('removed the leftover directory from disk');
  }
  const gone = !fs.existsSync(dir);
  return { ok: gone, dir, steps };
}
