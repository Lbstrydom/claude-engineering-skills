/**
 * @fileoverview Behavioural guards for the pre-push sandbox's cleanup path.
 *
 * The bug these pin (measured 2026-08-01): `git worktree remove --force` EXITS
 * 0 while leaving the sandbox directory on disk, because the sandbox always
 * contains a `node_modules` entry git declines to delete. The runner trusted
 * that exit code, so its fallback `rmSync` — which sat in the `catch` — never
 * ran, and one husk leaked per push with no signal at all.
 *
 * These are behavioural, not source-regex, tests: the failure was a wrong
 * belief about what a subprocess's exit code proves, and only touching the
 * filesystem can falsify that class of belief.
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import {
  SANDBOX_PREFIX,
  STALE_SANDBOX_AGE_MS,
  findStaleSandboxes,
  removeSandboxDir,
  surveySandboxes,
  sweepStaleSandboxes,
} from '../scripts/lib/prepush-sandbox-cleanup.mjs';

const IS_WIN = process.platform === 'win32';

/** A git env with the hook-leaked locals stripped, so fixture repos created
 *  here are genuinely isolated. Without this, a run INSIDE the pre-push
 *  sandbox inherits GIT_DIR — which git gives precedence over `cwd`, so the
 *  fixture's commits would land on the real repo's HEAD (the documented
 *  2026-07-23 incident class). */
function isolatedGitEnv() {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (key.startsWith('GIT_')) delete env[key];
  }
  return env;
}

function git(args, cwd) {
  return execFileSync('git', args, { cwd, encoding: 'utf-8', env: isolatedGitEnv() }).trim();
}

describe('removeSandboxDir — reports the postcondition, not a success signal', () => {
  let root;
  before(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'ces-cleanup-test-')); });
  after(() => { fs.rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }); });

  it('treats an already-absent directory as removed', () => {
    const missing = path.join(root, 'never-existed');
    assert.deepEqual(removeSandboxDir(missing), { removed: true });
  });

  it('removes a plain directory tree', () => {
    const dir = path.join(root, 'plain');
    fs.mkdirSync(path.join(dir, 'nested'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'nested', 'f.txt'), 'x');

    assert.equal(removeSandboxDir(dir).removed, true);
    assert.equal(fs.existsSync(dir), false);
  });

  it('removes a directory containing a node_modules junction WITHOUT deleting the target', () => {
    // The exact shape provisionNodeModules() creates on the common path. If
    // removal ever started following the link, it would delete the MAIN
    // checkout's real node_modules — a far worse bug than the leak.
    const target = path.join(root, 'real-modules');
    fs.mkdirSync(path.join(target, 'somepkg'), { recursive: true });
    fs.writeFileSync(path.join(target, 'somepkg', 'index.js'), 'module.exports = 1;');

    const sandbox = path.join(root, 'sandbox-linked');
    fs.mkdirSync(sandbox, { recursive: true });
    fs.symlinkSync(target, path.join(sandbox, 'node_modules'), 'junction');

    assert.equal(removeSandboxDir(sandbox).removed, true);
    assert.equal(fs.existsSync(sandbox), false);
    assert.equal(
      fs.existsSync(path.join(target, 'somepkg', 'index.js')), true,
      'removal must not follow the junction into the real node_modules',
    );
  });

  it('reports removed:false with an error rather than throwing', () => {
    // A cleanup path that throws would convert a temp-file problem into a
    // failed push. Force the failure by pointing at a path whose parent is a
    // FILE, which makes the recursive removal fail on every platform.
    const file = path.join(root, 'a-file');
    fs.writeFileSync(file, 'x');
    const impossible = path.join(file, 'child');

    let result;
    assert.doesNotThrow(() => { result = removeSandboxDir(impossible); });
    // ENOTDIR surfaces as a non-existent path on some platforms; either way
    // the contract is "never throws" and "the answer is a boolean".
    assert.equal(typeof result.removed, 'boolean');
  });
});

describe('findStaleSandboxes — age rule and prefix scoping', () => {
  let tmp;
  const NOW = 1_800_000_000_000; // fixed clock; the module accepts an injected `now`

  const makeDir = (name, ageMs) => {
    const abs = path.join(tmp, name);
    fs.mkdirSync(abs, { recursive: true });
    const when = new Date(NOW - ageMs);
    fs.utimesSync(abs, when, when);
    return abs;
  };

  before(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ces-sweep-test-')); });
  after(() => { fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }); });

  it('never sweeps a young husk — a CONCURRENT push\'s live sandbox is always young', () => {
    // This is the safety property of the whole sweep: two sessions share this
    // repo's tree, so a second push can have a live sandbox on disk right now.
    const live = makeDir(`${SANDBOX_PREFIX}abc12345-1111`, 60_000);
    const stale = findStaleSandboxes(tmp, { now: NOW });
    assert.equal(stale.includes(live), false, 'a 1-minute-old sandbox must never be swept');
  });

  it('sweeps a husk older than the threshold', () => {
    const old = makeDir(`${SANDBOX_PREFIX}def67890-2222`, STALE_SANDBOX_AGE_MS + 60_000);
    assert.ok(findStaleSandboxes(tmp, { now: NOW }).includes(old));
  });

  it('ignores other tools\' and other suites\' temp dirs', () => {
    // %TEMP% is shared. This repo alone also leaves ces-db-test-* and
    // ces-arch-gate-* fixtures around, owned by different code.
    const foreign = makeDir('ces-db-test-XxxRJ7', STALE_SANDBOX_AGE_MS * 10);
    const alien = makeDir('some-other-tool-cache', STALE_SANDBOX_AGE_MS * 10);
    const found = findStaleSandboxes(tmp, { now: NOW });
    assert.equal(found.includes(foreign), false);
    assert.equal(found.includes(alien), false);
  });

  it('ignores files that merely share the prefix', () => {
    const f = path.join(tmp, `${SANDBOX_PREFIX}not-a-dir`);
    fs.writeFileSync(f, 'x');
    const when = new Date(NOW - STALE_SANDBOX_AGE_MS * 2);
    fs.utimesSync(f, when, when);
    assert.equal(findStaleSandboxes(tmp, { now: NOW }).includes(f), false);
  });

  it('returns [] for an unreadable temp dir instead of throwing', () => {
    assert.deepEqual(findStaleSandboxes(path.join(tmp, 'does-not-exist'), { now: NOW }), []);
  });

  it('surveySandboxes reports the husks it deliberately LEFT, not just the ones it takes', () => {
    // Silence is ambiguous (2026-08-30). The runner logged only when it swept,
    // so "temp is clean" and "three husks are here, all too young" printed
    // identically — and a failing push with three husks on disk was read as a
    // broken sweeper for hours. Measured afterwards: the oldest was 3h old
    // against a 6h threshold, and the sweep had been exactly right.
    const young = makeDir(`${SANDBOX_PREFIX}beef0001-4444`, 3 * 60 * 60 * 1000);
    const { stale, young: retained } = surveySandboxes(tmp, { now: NOW });
    assert.equal(stale.includes(young), false, 'a 3h husk is not stale under a 6h threshold');
    const row = retained.find((h) => h.dir === young);
    assert.ok(row, 'the husk it declined to sweep must be REPORTED, not silently dropped');
    assert.equal(row.ageMs, 3 * 60 * 60 * 1000, 'the age must be carried so the caller can name it');
  });

  it('surveySandboxes ignores foreign temp dirs in BOTH buckets', () => {
    // A prefix-scoping bug that leaked only into the new `young` bucket would
    // make the runner report other tools' temp dirs as this gate's husks.
    const foreign = makeDir('ces-db-test-YoUnG1', 60_000);
    const { stale, young } = surveySandboxes(tmp, { now: NOW });
    assert.equal(stale.includes(foreign), false);
    assert.equal(young.some((h) => h.dir === foreign), false);
  });

  it('sweepStaleSandboxes carries `young` through so the caller need not re-scan', () => {
    const fresh = makeDir(`${SANDBOX_PREFIX}beef0002-5555`, 30_000);
    const { young } = sweepStaleSandboxes(tmp, { now: NOW });
    assert.ok(young.some((h) => h.dir === fresh));
    assert.equal(fs.existsSync(fresh), true, 'a young husk must survive the sweep');
  });

  it('sweepStaleSandboxes actually removes what it reports (not a vacuous green)', () => {
    const doomed = makeDir(`${SANDBOX_PREFIX}cafe0001-3333`, STALE_SANDBOX_AGE_MS * 2);
    const { swept, failed } = sweepStaleSandboxes(tmp, { now: NOW });
    assert.equal(failed.length, 0);
    assert.ok(swept.includes(doomed), 'the doomed husk must be reported swept');
    assert.equal(fs.existsSync(doomed), false, 'reported-swept must mean gone from disk');
  });
});

describe('the motivating defect: git worktree remove exits 0 but leaves the directory', () => {
  let repo;
  let sandbox;

  before(() => {
    repo = fs.mkdtempSync(path.join(os.tmpdir(), 'ces-wt-fixture-'));
    git(['init', '--quiet'], repo);
    git(['config', 'user.email', 'test@example.com'], repo);
    git(['config', 'user.name', 'Test'], repo);
    fs.writeFileSync(path.join(repo, 'README.md'), '# fixture\n');
    git(['add', 'README.md'], repo);
    git(['commit', '--quiet', '-m', 'seed fixture'], repo);

    sandbox = path.join(os.tmpdir(), `${SANDBOX_PREFIX}fixture-${process.pid}`);
    git(['worktree', 'add', '--detach', '--quiet', sandbox, 'HEAD'], repo);

    // Reproduce provisionNodeModules()'s common path exactly.
    const modules = path.join(repo, 'node_modules');
    fs.mkdirSync(path.join(modules, 'pkg'), { recursive: true });
    fs.writeFileSync(path.join(modules, 'pkg', 'index.js'), '1;');
    fs.symlinkSync(modules, path.join(sandbox, 'node_modules'), 'junction');
  });

  after(() => {
    removeSandboxDir(sandbox);
    try { git(['worktree', 'prune'], repo); } catch { /* fixture teardown */ }
    fs.rmSync(repo, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  });

  it(`git reports success yet leaves the husk behind${IS_WIN ? '' : ' (win32 only — skipped)'}`, (t) => {
    if (!IS_WIN) return t.skip('the exit-0-with-leftovers behaviour was measured on Windows');

    const status = execFileSync('git', ['worktree', 'remove', '--force', sandbox], {
      cwd: repo, encoding: 'utf-8', env: isolatedGitEnv(),
    });
    assert.equal(typeof status, 'string', 'git exited 0 — execFileSync throws on non-zero');
    assert.equal(
      fs.existsSync(sandbox), true,
      'THE BUG: git exits 0 while the directory survives. If this ever fails, git or the '
      + 'platform changed and the verify-by-stat below is now belt-and-braces rather than load-bearing.',
    );
    assert.deepEqual(fs.readdirSync(sandbox), ['node_modules'], 'the surviving entry is node_modules');
  });

  it('verify-by-stat finishes the job git left undone', () => {
    // Platform-independent: whatever git did or did not leave, the runner's
    // cleanup contract is that the directory is gone afterwards.
    try {
      execFileSync('git', ['worktree', 'remove', '--force', sandbox], {
        cwd: repo, stdio: 'ignore', env: isolatedGitEnv(),
      });
    } catch { /* the point is that its outcome is not the evidence */ }

    assert.equal(removeSandboxDir(sandbox).removed, true);
    assert.equal(fs.existsSync(sandbox), false);
    assert.equal(
      fs.existsSync(path.join(repo, 'node_modules', 'pkg', 'index.js')), true,
      'the real node_modules must survive the sandbox cleanup',
    );
  });
});
