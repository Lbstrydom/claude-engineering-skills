/**
 * @fileoverview The trusted execution boundary for gate provenance (the verification-lessons plan, section 2.2).
 *
 * Overlaying base CONFIG onto the PR tree is not enough: the code of the gate and everything it imports would still come
 * from the PR. So the verdict run uses an exact PR snapshot - a detached worktree of the head sha, so HEAD, the index and
 * `git ls-files` are those of the PR - with the PROTECTED set swapped for the base version:
 *
 *   protected = registered files (base and head registries) + the import closure of each registered gate entry point,
 *               derived from the BASE by the sync walker (never a hand list) + the install inputs.
 *
 * `git checkout <base> -- <protected>` writes AND stages them, so a protected file the PR deleted is restored and tracked.
 * A protected path ABSENT at the base (the PR added it) is removed from the worktree and the index, so the verdict run sees
 * exactly the base protected set. Dependencies come from a SEPARATE detached worktree of the base installed with
 * `npm ci --ignore-scripts`, linked in as node_modules: no manifest, lockfile or npm config from the PR reaches the install.
 *
 * @module scripts/lib/gate-provenance/snapshot
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync, execFileSync } from 'node:child_process';
import { collectImportClosure } from '../module-graph.mjs';
import { sanitizeGitEnv } from '../git-env-sanitize.mjs';
import { isSafeGitRevision } from '../vcs.mjs';
import { expandRegistry, gateEntryPoints, parseRegistry, REGISTRY_PATH } from './registry.mjs';

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

/** Content of `file` at `rev`, or null when absent there. */
export function showAt(repoRoot, rev, file) {
  try { return git(repoRoot, ['show', `${rev}:${file}`]); } catch { return null; }
}

/** One side of the diff: its tracked-file inventory, cached content reader and parsed registry. */
export function loadSide(repoRoot, rev) {
  const files = lsTree(repoRoot, rev);
  const set = new Set(files);
  const cache = new Map();
  const read = (p) => {
    if (!set.has(p)) return null;
    if (!cache.has(p)) cache.set(p, showAt(repoRoot, rev, p));
    return cache.get(p);
  };
  const parsed = parseRegistry(read(REGISTRY_PATH));
  return { rev, files, set, read, registry: parsed.ok ? parsed.registry : null, registryError: parsed.ok ? null : parsed.error };
}

/**
 * The protected set and its two inventories, computed explicitly (and printed by the runner).
 * @returns {{protectedPaths: string[], restore: string[], remove: string[], closure: string[], unresolved: object[]}}
 */
export function computeProtected(baseSide, headSide) {
  const entryPoints = gateEntryPoints(baseSide.registry).filter((p) => baseSide.set.has(p));
  const closure = collectImportClosure({ entryPoints, repoFiles: baseSide.set, readFile: baseSide.read });
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
 * Build the verdict snapshot. The caller MUST call `cleanup()` (in a finally).
 *
 * @param {object} args
 * @param {string} args.repoRoot
 * @param {string} args.base sha
 * @param {string} args.head sha
 * @param {boolean} [args.install] false = no dependency install, `nodeModules: unmeasured`
 * @param {(dir: string) => {ok: boolean, reason?: string}} [args.installDeps] injected installer (tests)
 * @returns {{dir: string, nodeModules: string, nodeModulesReason?: string, inventories: object, cleanup: () => void}}
 */
export function buildSnapshot({ repoRoot, base, head, install = true, installDeps = npmCiIgnoreScripts, baseSide, headSide }) {
  for (const r of [base, head]) if (!isSafeGitRevision(r)) throw new Error(`unsafe revision: ${JSON.stringify(r)}`);
  const bs = baseSide ?? loadSide(repoRoot, base);
  const hs = headSide ?? loadSide(repoRoot, head);
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
    git(repoRoot, ['worktree', 'add', '--detach', dir, head]);
    worktrees.push(dir);
    const prot = computeProtected(bs, hs);
    // `checkout <base> -- <paths>` writes AND stages: a path the PR deleted comes back tracked.
    if (prot.restore.length) {
      git(dir, ['checkout', base, '--pathspec-from-file=-', '--pathspec-file-nul'], { input: `${prot.restore.join('\0')}\0` });
    }
    // A protected path the base never had is removed from index AND disk: the verdict run sees only the base set.
    if (prot.remove.length) {
      git(dir, ['rm', '--cached', '--quiet', '--ignore-unmatch', '--pathspec-from-file=-', '--pathspec-file-nul'], { input: `${prot.remove.join('\0')}\0` });
      for (const p of prot.remove) { try { fs.unlinkSync(path.join(dir, p)); } catch { /* already gone */ } }
    }
    let nodeModules = 'unmeasured';
    let nodeModulesReason = 'dependency install skipped';
    if (install) {
      const baseWt = path.join(tmp, 'base');
      git(repoRoot, ['worktree', 'add', '--detach', baseWt, base]);
      worktrees.push(baseWt);
      const r = installDeps(baseWt);
      if (r.ok && fs.existsSync(path.join(baseWt, 'node_modules'))) {
        fs.symlinkSync(path.join(baseWt, 'node_modules'), path.join(dir, 'node_modules'), 'junction');
        nodeModules = 'linked';
        nodeModulesReason = undefined;
      } else nodeModulesReason = r.reason ?? 'install produced no node_modules';
    }
    return {
      dir, nodeModules, nodeModulesReason, cleanup,
      inventories: {
        base: { sha: base, registered: expandRegistry(bs.registry, bs.files).size },
        head: { sha: head, registered: hs.registry ? expandRegistry(hs.registry, hs.files).size : 0 },
        protectedPaths: prot.protectedPaths, restored: prot.restore, removed: prot.remove,
        closureFiles: prot.closure.length, unresolvedImports: prot.unresolved.length,
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
