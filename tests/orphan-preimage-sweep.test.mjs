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

const git = (cwd, ...args) => execFileSync('git', args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });

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
  fs.rmSync(tmpHome, { recursive: true, force: true });
  fs.rmSync(repo, { recursive: true, force: true });
});

describe('sweepStaleOrphanPreimages', () => {
  test('removes a STALE registered worktree (dir gone + metadata pruned), keeps a FRESH one', () => {
    const stale = path.join(tmpHome, 'orphan-preimage-stale1');
    const fresh = path.join(tmpHome, 'orphan-preimage-fresh1');
    git(repo, 'worktree', 'add', '--detach', '--quiet', stale, 'HEAD');
    git(repo, 'worktree', 'add', '--detach', '--quiet', fresh, 'HEAD');
    backdate(stale, 2); // > 1h default gate

    const r = sweepStaleOrphanPreimages({ repoPath: repo, tmpDir: tmpHome });

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

    const r = sweepStaleOrphanPreimages({ repoPath: repo, tmpDir: tmpHome });

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

    const r = sweepStaleOrphanPreimages({ repoPath: repo, tmpDir: tmpHome });
    assert.deepEqual(r.swept, []);
    assert.equal(fs.existsSync(other), true);
    assert.equal(fs.existsSync(asFile), true);

    assert.doesNotThrow(() => sweepStaleOrphanPreimages({ repoPath: repo, tmpDir: path.join(tmpHome, 'nope') }));
    fs.rmSync(asFile, { force: true });
    fs.rmSync(other, { recursive: true, force: true });
  });

  test('maxAgeMs is honored (a 36s-old dir sweeps under a 1s gate, kept under the 1h default)', () => {
    const d = path.join(tmpHome, 'orphan-preimage-now');
    fs.mkdirSync(d, { recursive: true });
    backdate(d, 0.01); // ~36s old — beyond a 1s gate, well inside the 1h default
    const kept = sweepStaleOrphanPreimages({ repoPath: repo, tmpDir: tmpHome });
    assert.equal(kept.swept.includes(d), false, 'default 1h gate keeps it');
    const r = sweepStaleOrphanPreimages({ repoPath: repo, tmpDir: tmpHome, maxAgeMs: 1000 });
    assert.ok(r.swept.includes(d));
    assert.equal(fs.existsSync(d), false);
  });
});
