/**
 * @fileoverview A claim whose work is MERGED and whose worktree is clean is finished work, not an overlap
 * (consumer report 2026-11-15, Azure profile: such a claim kept blocking new chips with BLOCKED/exit 3 until a
 * manual `fleet release --id`, while `fleet status` already showed it `[done]`). Merged but dirty still blocks,
 * and the BLOCKED text names the holder as merged and `release` as the remedy.
 */
import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import { git } from './helpers/git.mjs';
import { cleanupFleetRoots, writeFile, addBranch } from './helpers/fleet-repo.mjs';
import { setup } from './helpers/fleet-cli-harness.mjs';

after(cleanupFleetRoots);

/** feat-a claims shared/**, then is squash-merged into main (no PR: the squash patch-id is the evidence). */
function mergedHolder() {
  const s = setup();
  addBranch(s.fx.repo, 'feat-a', { 'shared/a.txt': 'A\n' });
  git(['checkout', '-q', 'feat-a'], s.fx.repo);
  const c = s.f(['claim', '--id', 'feat-a', '--intent', 'work on a', '--paths', 'shared/**', '--json']);
  assert.equal(c.status, 0, c.stdout + c.stderr);
  git(['checkout', '-q', 'main'], s.fx.repo);
  git(['merge', '-q', '--squash', 'feat-a'], s.fx.repo);
  git(['commit', '-q', '-m', 'squash feat-a'], s.fx.repo);
  git(['checkout', '-q', '-b', 'feat-b'], s.fx.repo);
  return s;
}

describe('claim: a merged, clean holder no longer blocks', () => {
  it('is not counted as an overlap, and the note names release', () => {
    const s = mergedHolder();
    const r = s.f(['claim', '--id', 'feat-b', '--intent', 'work on b', '--paths', 'shared/**']);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /^OK for feat-b/m);
    assert.match(r.stdout, /feat-a not counted as an overlap — derived done \(squash-merged as [0-9a-f]{12}\), worktree clean; retire its record: `.* release --id feat-a`/);
  });

  it('merged but with uncommitted work still BLOCKS, and says the holder is merged and how to release it', () => {
    const s = mergedHolder();
    writeFile(s.fx.repo, 'scratch.txt', 'wip\n'); // feat-a's recorded worktree (the main checkout) now holds uncommitted work
    const r = s.f(['claim', '--id', 'feat-b', '--intent', 'work on b', '--paths', 'shared/**']);
    assert.equal(r.status, 3, r.stdout + r.stderr);
    assert.match(r.stdout, /^BLOCKED for feat-b/m);
    assert.match(r.stdout, /the holder's work is squash-merged as [0-9a-f]{12} — worktree has uncommitted changes; if that session is finished, retire its record: `.* release --id feat-a`/);
  });

  it('a holder that is NOT merged still blocks exactly as before (no merged note)', () => {
    const s = setup();
    addBranch(s.fx.repo, 'feat-a', { 'shared/a.txt': 'A\n' });
    git(['checkout', '-q', 'feat-a'], s.fx.repo);
    assert.equal(s.f(['claim', '--id', 'feat-a', '--intent', 'work on a', '--paths', 'shared/**']).status, 0);
    git(['checkout', '-q', '-b', 'feat-b', 'main'], s.fx.repo);
    const r = s.f(['claim', '--id', 'feat-b', '--intent', 'work on b', '--paths', 'shared/**']);
    assert.equal(r.status, 3, r.stdout + r.stderr);
    assert.doesNotMatch(r.stdout, /merged/);
  });
});
