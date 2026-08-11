/**
 * @fileoverview The canonical guard-A/guard-B argument bundle for ship-commit
 * CLI fixtures.
 *
 * Plan: docs/plans/worktree-identity-guards.md §5 (Phase 3).
 *
 * WHY THIS EXISTS. Three CLI suites (`ship-commit-cli`, `-pathspec`,
 * `-no-tests`) each drive the real binary, and each needed the same two things
 * once the guards landed: a complete identity bundle, and a declared `--path`
 * scope. Each grew its own copy. The audit flagged it as systemic and it is —
 * the risk is not duplication for its own sake but SILENT DIVERGENCE: three
 * copies of "what a valid identity expectation looks like" can drift apart, and
 * the suite whose copy drifts stops testing the guard it appears to test while
 * staying green.
 *
 * So the bundle is defined once, here, and the suites keep only the assertions
 * that are genuinely theirs.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { gitFixtureEnv } from './fixtures.mjs';

/**
 * The identity bundle guard B requires, read LIVE from the fixture repo.
 *
 * Computed rather than hardcoded because these fixtures mint a fresh repo per
 * test — a pinned sha would never match. An unborn HEAD deliberately returns
 * `[]`: that is guard B's one documented skip, and passing an expectation there
 * would assert a binding that cannot exist.
 *
 * @param {string} cwd repo to read the identity from
 * @returns {string[]} `--expect-head <sha>` plus a ref disposition, or `[]`
 */
export function identityArgs(cwd) {
  const run = (args) => spawnSync('git', args, { cwd, encoding: 'utf-8', env: gitFixtureEnv() });
  const h = run(['rev-parse', '--verify', '--quiet', 'HEAD']);
  const head = h.status === 0 ? (h.stdout || '').trim() : '';
  if (!head) return [];
  // `symbolic-ref`, NOT `rev-parse --abbrev-ref`: the latter returns the literal
  // string `HEAD` on a detached checkout, indistinguishable from a branch named
  // `HEAD`. The production oracle reads it the same way, so the bundle a test
  // builds matches the one the CLI compares against.
  const b = run(['symbolic-ref', '--quiet', '--short', 'HEAD']);
  const branch = b.status === 0 ? (b.stdout || '').trim() : '';
  return branch
    ? ['--expect-head', head, '--expect-branch', branch]
    : ['--expect-head', head, '--expect-detached'];
}

/**
 * The `--path` scope guard A requires, for whichever file the suite stages.
 *
 * Only emitted when the file is actually present: the "nothing staged" rows must
 * still reach their own exit-1 error rather than a `--path` input rejection.
 *
 * @param {string} cwd repo root
 * @param {string} rel repo-relative file the suite stages (e.g. `work.txt`)
 * @returns {string[]}
 */
export function scopeArgs(cwd, rel) {
  return fs.existsSync(path.join(cwd, rel)) ? ['--path', rel] : [];
}

/**
 * Both halves together — the common case.
 *
 * @param {string} cwd repo root
 * @param {string} [rel='work.txt'] the staged file to scope to
 * @returns {string[]}
 */
export function guardArgs(cwd, rel = 'work.txt') {
  return [...identityArgs(cwd), ...scopeArgs(cwd, rel)];
}

/**
 * Create a temp git repo with this repo's canonical fixture config.
 *
 * The three real-repository ship-commit suites each hand-rolled `init` +
 * `user.email` + `user.name` + `commit.gpgsign false`. That part has no
 * legitimate variation between them, and the audit found it had ALREADY
 * diverged (one suite omitted `gpgsign`, which fails on a machine with signing
 * configured globally). What deliberately stays per-suite is what each fixture
 * needs BEYOND a repo — a skills/ mirror, a seed commit, a particular staged
 * state — because forcing those into one helper would couple suites that test
 * different things.
 *
 * @param {string} prefix mkdtemp prefix
 * @returns {string} absolute path to the new repo
 */
export function initTempRepo(prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const run = (args) => {
    const r = spawnSync('git', args, { cwd: dir, encoding: 'utf-8', env: gitFixtureEnv() });
    if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed in fixture: ${r.stderr || r.stdout}`);
    return r;
  };
  run(['init', '-q', '-b', 'main']);
  run(['config', 'user.email', 'test@example.com']);
  run(['config', 'user.name', 'Test']);
  // Not cosmetic: a machine with commit.gpgsign=true globally makes every
  // fixture commit prompt or fail, which reads as a broken suite.
  run(['config', 'commit.gpgsign', 'false']);
  return dir;
}

/**
 * Best-effort teardown that NAMES what it could not remove.
 *
 * Retry-hardened per the repo's Windows EPERM/EBUSY convention, but a failure
 * that survives the retries leaves a real temp directory behind — swallowing it
 * turns a disk leak into a mystery.
 *
 * @param {string} dir
 */
export function cleanupTempRepo(dir) {
  try {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  } catch (e) {
    process.stderr.write(`  [cleanup] could not remove ${dir} (${e?.code || e?.message}) — residual temp dir left behind\n`);
  }
}
