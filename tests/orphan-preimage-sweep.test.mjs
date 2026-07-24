/**
 * @fileoverview Tier-1 tests for sweepStaleOrphanPreimages — the self-healing
 * guard for preimage worktrees orphaned by a hard-killed audit run. A stale
 * `orphan-preimage-*` dir is a full repo copy in os.tmpdir(): it poisons
 * temp-dir sibling scans (blocked a push via shared-cloud-config's
 * resolveSourceRepo once) and stays registered as a LOCKED git worktree.
 * Invariants: age-gated (fresh = possibly live → kept), worktree-aware
 * removal (metadata pruned, not just the dir), never throws into the audit.
 */

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

import { sweepStaleOrphanPreimages } from '../scripts/lib/audit/diff-scope-resolver.mjs';
import { retrySync } from '../scripts/lib/retry-transient-fs.mjs';
import { gitFixtureEnv } from './helpers/fixtures.mjs';

const git = (cwd, ...args) => execFileSync('git', args, { cwd, stdio: ['ignore', 'pipe', 'pipe'], env: gitFixtureEnv() });

let repo;      // a real throwaway git repo (worktree source)
let tmpHome;   // stand-in for os.tmpdir() so the sweep never touches the real one

function backdate(p, hours) {
  const t = new Date(Date.now() - hours * 3600_000);
  fs.utimesSync(p, t, t);
}

before(() => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'sweep-test-home-'));
  repo = fs.mkdtempSync(path.join(os.tmpdir(), 'sweep-test-repo-'));
  git(repo, 'init', '-q');
  git(repo, 'config', 'user.email', 't@t');
  git(repo, 'config', 'user.name', 't');
  fs.writeFileSync(path.join(repo, 'a.txt'), 'x');
  git(repo, 'add', 'a.txt');
  git(repo, 'commit', '-qm', 'init');
});

after(() => {
  try { git(repo, 'worktree', 'prune'); } catch { /* ignore */ }
  fs.rmSync(tmpHome, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  fs.rmSync(repo, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
});

describe('sweepStaleOrphanPreimages', () => {
  test('removes a STALE registered worktree (dir gone + metadata pruned), keeps a FRESH one', () => {
    const stale = path.join(tmpHome, 'orphan-preimage-stale1');
    const fresh = path.join(tmpHome, 'orphan-preimage-fresh1');
    git(repo, 'worktree', 'add', '--detach', '--quiet', stale, 'HEAD');
    git(repo, 'worktree', 'add', '--detach', '--quiet', fresh, 'HEAD');
    backdate(stale, 2); // > 1h default gate

    const r = sweepStaleOrphanPreimages({ repoPath: repo, env: gitFixtureEnv(), tmpDir: tmpHome });

    assert.deepEqual(r.swept, [stale]);
    assert.equal(r.kept, 1, 'the fresh (possibly live) worktree is left alone');
    assert.equal(fs.existsSync(stale), false, 'stale worktree dir removed');
    assert.equal(fs.existsSync(fresh), true, 'fresh worktree untouched');
    const list = git(repo, 'worktree', 'list').toString();
    assert.doesNotMatch(list, /orphan-preimage-stale1/, 'worktree metadata pruned');
    assert.match(list, /orphan-preimage-fresh1/);
    // cleanup the fresh one for later tests
    git(repo, 'worktree', 'remove', '--force', fresh);
  });

  test('removes a stale UNREGISTERED dir too (fs fallback when git does not know it)', () => {
    const rogue = path.join(tmpHome, 'orphan-preimage-rogue');
    fs.mkdirSync(rogue, { recursive: true });
    fs.writeFileSync(path.join(rogue, 'AGENTS.md'), '# sentinel bait'); // the poisoning shape
    backdate(rogue, 2);

    const r = sweepStaleOrphanPreimages({ repoPath: repo, env: gitFixtureEnv(), tmpDir: tmpHome });

    assert.ok(r.swept.includes(rogue));
    assert.equal(fs.existsSync(rogue), false);
  });

  test('ignores non-matching names, plain files, and a missing tmp dir — never throws', () => {
    const other = path.join(tmpHome, 'some-other-dir');
    fs.mkdirSync(other, { recursive: true });
    backdate(other, 5);
    const asFile = path.join(tmpHome, 'orphan-preimage-not-a-dir');
    fs.writeFileSync(asFile, 'x');
    backdate(asFile, 5);

    const r = sweepStaleOrphanPreimages({ repoPath: repo, env: gitFixtureEnv(), tmpDir: tmpHome });
    assert.deepEqual(r.swept, []);
    assert.equal(fs.existsSync(other), true);
    assert.equal(fs.existsSync(asFile), true);

    assert.doesNotThrow(() => sweepStaleOrphanPreimages({ repoPath: repo, env: gitFixtureEnv(), tmpDir: path.join(tmpHome, 'nope') }));
    retrySync(() => fs.rmSync(asFile, { force: true }));
    fs.rmSync(other, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  });

  test('reconciles a DANGLING registration whose dir already vanished (locked, no age gate)', () => {
    // Reproduce the accumulation bug: a killed audit left a registered,
    // "initializing"-locked worktree; the temp dir was later deleted out from
    // under git. The fs scan can't see it (no dir) and `git worktree prune`
    // skips it because it's locked — so it must be reconciled from the
    // registration list, unlocked, and pruned regardless of age.
    const dangling = path.join(tmpHome, 'orphan-preimage-dangling1');
    git(repo, 'worktree', 'add', '--detach', '--quiet', dangling, 'HEAD');
    git(repo, 'worktree', 'lock', '--reason', 'initializing', dangling);
    fs.rmSync(dangling, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
    assert.equal(fs.existsSync(dangling), false, 'precondition: dir is gone but registration survives');
    // A plain prune must NOT clear it (locked) — proving the gap the fix closes.
    git(repo, 'worktree', 'prune');
    assert.match(git(repo, 'worktree', 'list').toString(), /orphan-preimage-dangling1/,
      'plain prune leaves the locked dangling registration — the bug');

    const r = sweepStaleOrphanPreimages({ repoPath: repo, env: gitFixtureEnv(), tmpDir: tmpHome });

    // path format from `git worktree list --porcelain` is git-normalised
    // (forward slashes), so assert on outcome + a nonzero count rather than an
    // exact string — the count is what audit-clean surfaces.
    assert.ok(r.swept.length >= 1, 'sweep surfaces a nonzero worktree count');
    assert.ok(r.swept.some((p) => p.includes('orphan-preimage-dangling1')), 'the dangling one is reported');
    assert.doesNotMatch(git(repo, 'worktree', 'list').toString(), /orphan-preimage-dangling1/,
      'dangling registration is now pruned');
  });

  test('leaves a NON-orphan worktree with a missing dir alone (targeted, does not blanket-unlock)', () => {
    const other = path.join(tmpHome, 'some-worktree-notours');
    git(repo, 'worktree', 'add', '--detach', '--quiet', other, 'HEAD');
    git(repo, 'worktree', 'lock', '--reason', 'busy', other);
    fs.rmSync(other, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });

    const r = sweepStaleOrphanPreimages({ repoPath: repo, env: gitFixtureEnv(), tmpDir: tmpHome });

    assert.equal(r.swept.includes(other), false, 'a non orphan-preimage worktree is untouched');
    assert.match(git(repo, 'worktree', 'list').toString(), /some-worktree-notours/,
      'still locked + registered — we never blanket-unlock');
    // cleanup
    git(repo, 'worktree', 'unlock', other);
    git(repo, 'worktree', 'prune');
  });

  test('maxAgeMs is honored (a 36s-old dir sweeps under a 1s gate, kept under the 1h default)', () => {
    const d = path.join(tmpHome, 'orphan-preimage-now');
    fs.mkdirSync(d, { recursive: true });
    backdate(d, 0.01); // ~36s old — beyond a 1s gate, well inside the 1h default
    const kept = sweepStaleOrphanPreimages({ repoPath: repo, env: gitFixtureEnv(), tmpDir: tmpHome });
    assert.equal(kept.swept.includes(d), false, 'default 1h gate keeps it');
    const r = sweepStaleOrphanPreimages({ repoPath: repo, env: gitFixtureEnv(), tmpDir: tmpHome, maxAgeMs: 1000 });
    assert.ok(r.swept.includes(d));
    assert.equal(fs.existsSync(d), false);
  });
});
