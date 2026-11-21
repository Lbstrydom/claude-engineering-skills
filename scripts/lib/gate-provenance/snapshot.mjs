/**
 * @fileoverview The trusted execution boundary for gate provenance (the verification-lessons plan, section 2.2).
 *
 * Overlaying base CONFIG onto the PR tree is not enough: the code of the gate and everything it imports would still come
 * from the PR. So the verdict run uses an exact PR snapshot - a detached worktree of the head sha, so HEAD, the index and
 * `git ls-files` are those of the PR - with the PROTECTED set swapped for the base version (see protected-set.mjs for the
 * one model: registry entries + import closure + spawned helper scripts + install inputs).
 *
 * `git checkout <base> -- <protected>` writes AND stages them, so a protected file the PR deleted is restored and tracked.
 * A protected path ABSENT at the base (the PR added it) is removed from the worktree and the index. Dependencies come from
 * a SEPARATE detached worktree of the base installed with `npm ci --ignore-scripts` (or a caller-supplied base install),
 * linked in as node_modules: no manifest, lockfile or npm config from the PR reaches the install.
 *
 * The SHADOW run gets its own clean detached worktree of the resolved head - never the caller working tree, which may be
 * dirty or on another commit - with the same node_modules link.
 *
 * @module scripts/lib/gate-provenance/snapshot
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync, execFileSync } from 'node:child_process';
import { sanitizeGitEnv } from '../git-env-sanitize.mjs';
import { isSafeGitRevision } from '../vcs.mjs';
import { expandRegistry, gateEntryPoints, parseRegistry, REGISTRY_PATH } from './registry.mjs';
import { protectedClosure } from './protected-set.mjs';

/** Install inputs: protected whether or not the registry names them, because they decide what the gates run ON. */
export const INSTALL_INPUTS = Object.freeze(['package.json', 'package-lock.json', '.npmrc']);

const rmDir = (p) => fs.rmSync(p, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });

/** Run git in `cwd`; throws on a non-zero exit. */
export function git(cwd, args, { input } = {}) {
  return execFileSync('git', args, {
    cwd, encoding: 'utf8', input, maxBuffer: 256 * 1024 * 1024,
    stdio: ['pipe', 'pipe', 'pipe'], env: sanitizeGitEnv(cwd),
  });
}

/** `git ls-tree -r --name-only -z <rev>` as a sorted list. Throws when the rev does not resolve. */
export function lsTree(repoRoot, rev) {
  if (!isSafeGitRevision(rev)) throw new Error(`unsafe revision: ${JSON.stringify(rev)}`);
  return git(repoRoot, ['ls-tree', '-r', '--name-only', '-z', rev]).split('\0').filter(Boolean).sort();
}

/** Content of `file` at `rev`. THROWS on a read failure: absence is decided by ls-tree, never inferred from an error. */
export function showAt(repoRoot, rev, file) {
  try { return git(repoRoot, ['show', `${rev}:${file}`]); } catch (e) {
    const err = new Error(`git show ${rev}:${file} failed: ${String(e.message).split('\n')[0]}`);
    err.code = 'GIT_READ_FAILED';
    throw err;
  }
}

/**
 * One side of the diff: its tracked-file inventory, cached content reader and parsed registry. `read` returns null ONLY for
 * a path the tree confirms absent; a read failure on a present path throws (the caller reports it as unmeasured).
 */
export function loadSide(repoRoot, rev, { show = showAt } = {}) {
  const files = lsTree(repoRoot, rev);
  const set = new Set(files);
  const cache = new Map();
  const read = (p) => {
    if (!set.has(p)) return null;
    if (!cache.has(p)) cache.set(p, show(repoRoot, rev, p));
    return cache.get(p);
  };
  const parsed = parseRegistry(read(REGISTRY_PATH));
  return { rev, files, set, read, registry: parsed.ok ? parsed.registry : null, registryError: parsed.ok ? null : parsed.error };
}

/**
 * The protected set and its two inventories, computed explicitly (and printed by the runner).
 * @returns {{protectedPaths: string[], restore: string[], remove: string[], closure: string[], helpers: string[], unresolved: object[]}}
 */
export function computeProtected(baseSide, headSide) {
  const entryPoints = gateEntryPoints(baseSide.registry).filter((p) => baseSide.set.has(p));
  const closure = protectedClosure({ entryPoints, repoFiles: baseSide.set, readFile: baseSide.read });
  const registered = new Set([
    ...expandRegistry(baseSide.registry, baseSide.files).keys(),
    ...(headSide.registry ? expandRegistry(headSide.registry, headSide.files).keys() : []),
  ]);
  const wanted = new Set([...registered, ...closure.files, ...INSTALL_INPUTS, REGISTRY_PATH]);
  const protectedPaths = [...wanted].sort();
  return {
    protectedPaths,
    restore: protectedPaths.filter((p) => baseSide.set.has(p)),
    remove: protectedPaths.filter((p) => !baseSide.set.has(p) && headSide.set.has(p)),
    closure: closure.files,
    helpers: closure.helpers,
    unresolved: closure.unresolved,
  };
}

/** Default dependency install: `npm ci --ignore-scripts` in the base worktree. Returns `{ok, reason?}`. */
export function npmCiIgnoreScripts(dir) {
  const r = spawnSync('npm', ['ci', '--ignore-scripts', '--no-audit', '--no-fund'], {
    cwd: dir, encoding: 'utf8', shell: process.platform === 'win32', timeout: 10 * 60 * 1000,
  });
  if (r.status === 0) return { ok: true };
  const tail = (r.stderr || '').trim().split('\n').slice(-3).join(' | ');
  return { ok: false, reason: `npm ci --ignore-scripts exited ${r.status ?? r.signal}: ${tail}` };
}

/**
 * Build the verdict snapshot AND a clean shadow worktree. The caller MUST call `cleanup()` (in a finally).
 *
 * @param {object} args
 * @param {string} args.repoRoot
 * @param {string} args.base sha
 * @param {string} args.head sha
 * @param {boolean} [args.install] false = no dependency install, `nodeModules: unmeasured`
 * @param {(dir: string) => {ok: boolean, reason?: string}} [args.installDeps] injected installer (tests)
 * @param {string} [args.baseInstallDir] an existing, trusted base install to link instead of installing again
 * @returns {{dir: string, shadowDir: string, nodeModules: string, nodeModulesReason?: string, inventories: object, cleanup: () => void}}
 */
export function buildSnapshot({ repoRoot, base, head, install = true, installDeps = npmCiIgnoreScripts, baseInstallDir, baseSide, headSide, prot }) {
  for (const r of [base, head]) if (!isSafeGitRevision(r)) throw new Error(`unsafe revision: ${JSON.stringify(r)}`);
  const bs = baseSide ?? loadSide(repoRoot, base);
  const hs = headSide ?? loadSide(repoRoot, head);
  const protectedSet = prot ?? computeProtected(bs, hs);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gate-prov-'));
  const worktrees = [];
  const cleanup = () => {
    for (const wt of [...worktrees].reverse()) {
      try { fs.unlinkSync(path.join(wt, 'node_modules')); } catch { /* absent or not a link */ }
      try { git(repoRoot, ['worktree', 'remove', '--force', wt]); } catch { /* pruned below */ }
    }
    try { git(repoRoot, ['worktree', 'prune']); } catch { /* best effort */ }
    try { rmDir(tmp); } catch { /* best effort */ }
  };
  try {
    const dir = path.join(tmp, 'head');
    const shadowDir = path.join(tmp, 'shadow');
    git(repoRoot, ['worktree', 'add', '--detach', dir, head]);
    worktrees.push(dir);
    git(repoRoot, ['worktree', 'add', '--detach', shadowDir, head]);
    worktrees.push(shadowDir);
    // `checkout <base> -- <paths>` writes AND stages: a path the PR deleted comes back tracked.
    if (protectedSet.restore.length) {
      git(dir, ['checkout', base, '--pathspec-from-file=-', '--pathspec-file-nul'], { input: `${protectedSet.restore.join('\0')}\0` });
    }
    // A protected path the base never had is removed from index AND disk: the verdict run sees only the base set.
    if (protectedSet.remove.length) {
      git(dir, ['rm', '--cached', '--quiet', '--ignore-unmatch', '--pathspec-from-file=-', '--pathspec-file-nul'], { input: `${protectedSet.remove.join('\0')}\0` });
      for (const p of protectedSet.remove) { try { fs.unlinkSync(path.join(dir, p)); } catch { /* already gone */ } }
    }
    let nodeModules = 'unmeasured';
    let nodeModulesReason = 'dependency install skipped';
    if (install) {
      let installDir = baseInstallDir;
      let r = { ok: true };
      if (!installDir) {
        installDir = path.join(tmp, 'base');
        git(repoRoot, ['worktree', 'add', '--detach', installDir, base]);
        worktrees.push(installDir);
        r = installDeps(installDir);
      }
      const nm = path.join(installDir, 'node_modules');
      if (r.ok && fs.existsSync(nm)) {
        fs.symlinkSync(nm, path.join(dir, 'node_modules'), 'junction');
        fs.symlinkSync(nm, path.join(shadowDir, 'node_modules'), 'junction');
        nodeModules = 'linked';
        nodeModulesReason = undefined;
      } else nodeModulesReason = r.reason ?? 'install produced no node_modules';
    }
    return {
      dir, shadowDir, nodeModules, nodeModulesReason, cleanup,
      inventories: {
        base: { sha: base, registered: expandRegistry(bs.registry, bs.files).size },
        head: { sha: head, registered: hs.registry ? expandRegistry(hs.registry, hs.files).size : 0 },
        protectedPaths: protectedSet.protectedPaths, restored: protectedSet.restore, removed: protectedSet.remove,
        closureFiles: protectedSet.closure.length, helperScripts: protectedSet.helpers, unresolvedImports: protectedSet.unresolved.length,
      },
    };
  } catch (e) {
    cleanup();
    throw e;
  }
}

/** Run one gate: `node <argv...>` in `cwd`. Reports the exit and the tail of output; never throws. */
export function runGate({ cwd, argv, timeoutMs = 5 * 60 * 1000 }) {
  const r = spawnSync(process.execPath, argv, { cwd, encoding: 'utf8', timeout: timeoutMs, env: sanitizeGitEnv(cwd), maxBuffer: 64 * 1024 * 1024 });
  const tail = (s) => (s || '').trim().split('\n').slice(-3).join(' | ').slice(0, 400);
  return { exit: r.status ?? (r.signal ? `signal:${r.signal}` : 'error'), stderrTail: tail(r.stderr), stdoutTail: tail(r.stdout) };
}
