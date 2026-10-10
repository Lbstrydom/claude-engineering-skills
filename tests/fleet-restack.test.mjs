/**
 * @fileoverview /fleet — `restack` (plan docs/plans/fleet-consumer-feedback-oct.md
 * §2.5, storyline item 3).
 *
 * Pinned: only the branch's OWN commits are replayed (a squash-merged parent's
 * commits are inferred from the merged PR head and left out); construct /
 * validate / publish are separate; a mismatch never replaces the source; a
 * checked-out branch is never moved by fleet; a real conflict leaves nothing
 * behind; no consumer hook runs.
 */
import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { git } from './helpers/git.mjs';
import {
  cleanupFleetRoots, commitFile, installFakeGh, makeFleetRepo, runFleet, scrubbedEnv, writeFile,
} from './helpers/fleet-repo.mjs';

after(cleanupFleetRoots);

const setup = (fleetConfig = null) => {
  const fx = makeFleetRepo({ files: { 'base.txt': Array.from({ length: 12 }, (_, i) => `line ${i + 1}`).join('\n') + '\n', 'docs/log.md': '# log\n' }, fleetConfig });
  if (fleetConfig) { git(['add', '.fleet.json'], fx.repo); git(['commit', '-q', '-m', 'cfg'], fx.repo); git(['push', '-q', 'origin', 'main'], fx.repo); }
  const fake = installFakeGh(fx.root);
  const env = scrubbedEnv({ FLEET_WORKTREE_ROOT: fx.wtRoot, ...fake.env }, { prependPath: [fake.bin] });
  const f = (args, cwd = fx.repo) => runFleet(args, { cwd, env });
  const rev = (r) => git(['rev-parse', r], fx.repo);
  const exists = (r) => { try { git(['rev-parse', '--verify', '--quiet', r], fx.repo); return true; } catch { return false; } };
  const registered = () => git(['worktree', 'list', '--porcelain'], fx.repo).split('\n').filter((l) => l.startsWith('worktree ')).length;
  return { fx, fake, f, rev, exists, registered };
};

/** parent (2 commits) → child (1 commit), parent squash-merged into main as PR #40. */
const stacked = (s) => {
  const { repo } = s.fx;
  git(['checkout', '-q', '-b', 'parent'], repo);
  commitFile(repo, 'p1.txt', 'p1\n'); commitFile(repo, 'p2.txt', 'p2\n');
  const parentTip = s.rev('parent');
  git(['checkout', '-q', '-b', 'child'], repo);
  commitFile(repo, 'c.txt', 'child\n');
  git(['checkout', '-q', 'main'], repo);
  git(['merge', '--squash', 'parent'], repo); git(['commit', '-q', '-m', 'parent (#40)'], repo);
  s.fake.setState({ list: [], merged: [{ number: 40, headRefName: 'parent', headRefOid: parentTip, mergedAt: '2026-10-09T10:00:00Z', mergeCommit: { oid: s.rev('main') }, url: 'https://github.com/o/n/pull/40', baseRefName: 'main', isCrossRepository: false }] });
  return parentTip;
};

describe('fleet restack — review fixes (C3-R1)', () => {
  it('run from a SUBDIRECTORY, the patch check still covers the whole repo (H3)', () => {
    const s = setup();
    const { repo } = s.fx;
    fs.mkdirSync(path.join(repo, 'sub'));
    commitFile(repo, 'sub/keep.txt', 'k\n');
    git(['push', '-q', 'origin', 'main'], repo);
    git(['checkout', '-q', '-b', 'wide'], repo);
    commitFile(repo, 'base.txt', fs.readFileSync(path.join(repo, 'base.txt'), 'utf8').replace('line 10', 'line 10 (wide)'));
    git(['checkout', '-q', 'main'], repo);
    commitFile(repo, 'base.txt', fs.readFileSync(path.join(repo, 'base.txt'), 'utf8').replace('line 8', 'line 8 (main)'));
    const r = s.f(['restack', 'wide'], path.join(repo, 'sub'));
    assert.equal(r.status, 3, r.stdout + r.stderr);
    assert.match(r.stdout, /patch-id DIFFERS/, 'a change outside sub/ is still compared');
  });
  it('the CLOSEST merged ancestor is the parent, whatever the merge times say (H4)', () => {
    const s = setup();
    const { repo } = s.fx;
    git(['checkout', '-q', '-b', 'g1'], repo); commitFile(repo, 'g1.txt', '1\n'); const g1 = s.rev('g1');
    git(['checkout', '-q', '-b', 'g2'], repo); commitFile(repo, 'g2.txt', '2\n'); const g2 = s.rev('g2');
    git(['checkout', '-q', '-b', 'leaf'], repo); commitFile(repo, 'leaf.txt', 'l\n');
    git(['checkout', '-q', 'main'], repo);
    git(['merge', '--squash', 'g2'], repo); git(['commit', '-q', '-m', 'g1+g2 (#51)'], repo);
    const row = (n, head, at) => ({ number: n, headRefName: `g${n}`, headRefOid: head, mergedAt: at, mergeCommit: { oid: s.rev('main') }, url: `https://github.com/o/n/pull/${n}`, baseRefName: 'main', isCrossRepository: false });
    // g1 merged LATER than g2 (a re-merge), but g2 is the closer ancestor of leaf.
    s.fake.setState({ list: [], merged: [row(50, g1, '2026-10-09T12:00:00Z'), row(51, g2, '2026-10-09T10:00:00Z')] });
    const r = s.f(['restack', 'leaf', '--json']);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.equal(r.json.from, g2);
  });
  it('a TRUNCATED merged-PR list cannot prove the ancestor it found is the closest (C3-R2-H1)', async () => {
    const { inferFrom } = await import('../scripts/lib/fleet/restack.mjs');
    const git = (args) => (args[0] === 'merge-base' ? { ok: true, status: 0, stdout: '' } : { ok: true, status: 0, stdout: '3\n' });
    const r = inferFrom({ git, cwd: '.', oldTip: 'f'.repeat(40), merged: { queried: true, complete: false, reason: 'truncated at 100', prs: [{ number: 1, headOid: 'a'.repeat(40), isCrossRepository: false }] } });
    assert.equal(r.kind, 'unknown');
  });
  it('merged-PR evidence unavailable ⇒ refuse rather than guess a range; --from overrides (H7)', () => {
    const s = setup();
    stacked(s);
    s.fake.setState({ list: [], mergedFail: 'HTTP 502' });
    const r = s.f(['restack', 'child']);
    assert.equal(r.status, 3);
    assert.match(r.stdout, /cannot tell which of child's commits are its own.*--from/);
    assert.equal(s.f(['restack', 'child', '--from', 'parent']).status, 0);
  });
});

describe('fleet restack', () => {
  it('replays ONLY the child\'s own commit onto main (parent inferred from merged PR #40); patch EQUAL; source unchanged', () => {
    const s = setup();
    const parentTip = stacked(s);
    const before = s.rev('child');
    const wts = s.registered();
    const r = s.f(['restack', 'child', '--json']);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.equal(r.json.from, parentTip);
    assert.equal(r.json.equal, true);
    assert.equal(s.rev('child'), before, 'the source branch is untouched');
    assert.equal(git(['rev-list', '--count', 'main..child-restack'], s.fx.repo), '1', 'one commit: the child\'s own');
    assert.equal(git(['rev-parse', 'child-restack^'], s.fx.repo), s.rev('main'));
    assert.equal(s.registered(), wts, 'the throwaway worktree is gone');
    assert.match(r.stdout, /patch-id EQUAL/);
  });

  it('--replace on a branch checked out nowhere moves it by compare-and-swap', () => {
    const s = setup();
    stacked(s);
    const r = s.f(['restack', 'child', '--replace', '--json']);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.equal(s.rev('child'), r.json.candidate);
    assert.equal(s.exists('refs/heads/child-restack'), false);
  });

  it('--replace on a CHECKED-OUT branch never moves it: writes -restack and prints the reset to run', () => {
    const s = setup();
    stacked(s);
    const wt = path.join(s.fx.root, 'wt-child');
    git(['worktree', 'add', '-q', wt, 'child'], s.fx.repo);
    const before = s.rev('child');
    const r = s.f(['restack', 'child', '--replace']);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.equal(s.rev('child'), before);
    assert.equal(s.exists('refs/heads/child-restack'), true);
    assert.match(r.stdout, /git reset --keep child-restack/);
  });

  it('patch DIFFERS (base changed lines inside the hunk context) → only -restack-mismatch, never a replace, exit 3', () => {
    const s = setup();
    const { repo } = s.fx;
    git(['checkout', '-q', '-b', 'near'], repo);
    const body = fs.readFileSync(path.join(repo, 'base.txt'), 'utf8').replace('line 6', 'line 6 (near)');
    commitFile(repo, 'base.txt', body);
    git(['checkout', '-q', 'main'], repo);
    commitFile(repo, 'base.txt', fs.readFileSync(path.join(repo, 'base.txt'), 'utf8').replace('line 4', 'line 4 (main)'));
    const before = s.rev('near');
    const r = s.f(['restack', 'near', '--replace']);
    assert.equal(r.status, 3, r.stdout + r.stderr);
    assert.match(r.stdout, /patch-id DIFFERS/);
    assert.equal(s.rev('near'), before, '--replace ignored on a mismatch');
    assert.equal(s.exists('refs/heads/near-restack-mismatch'), true);
  });

  it('a real conflict aborts, writes nothing, leaves no worktree', () => {
    const s = setup();
    const { repo } = s.fx;
    git(['checkout', '-q', '-b', 'clash'], repo);
    commitFile(repo, 'base.txt', 'clash\n');
    git(['checkout', '-q', 'main'], repo);
    commitFile(repo, 'base.txt', 'main\n');
    const wts = s.registered();
    const r = s.f(['restack', 'clash']);
    assert.equal(r.status, 3);
    assert.match(r.stdout, /conflicting files: base\.txt/);
    assert.equal(s.exists('refs/heads/clash-restack'), false);
    assert.equal(s.registered(), wts);
  });

  it('an append-only conflict is merged keeping both sides, disclosed, and excluded from the patch check', () => {
    const s = setup({ appendOnlyGlobs: ['docs/**'] });
    const { repo } = s.fx;
    git(['checkout', '-q', '-b', 'notes'], repo);
    commitFile(repo, 'docs/log.md', '# log\n- notes\n');
    git(['checkout', '-q', 'main'], repo);
    commitFile(repo, 'docs/log.md', '# log\n- main\n');
    const r = s.f(['restack', 'notes', '--json']);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.deepEqual(r.json.unioned, ['docs/log.md']);
    const body = git(['show', 'notes-restack:docs/log.md'], repo);
    assert.match(body, /- main/); assert.match(body, /- notes/);
  });

  it('no consumer hook runs while replaying', () => {
    const s = setup();
    stacked(s);
    const hooks = path.join(s.fx.root, 'hooks');
    fs.mkdirSync(hooks);
    const marker = path.join(s.fx.root, 'hook-ran');
    fs.writeFileSync(path.join(hooks, 'post-commit'), `#!/bin/sh\necho ran > "${marker.replace(/\\/g, '/')}"\n`, { mode: 0o755 });
    git(['config', 'core.hooksPath', hooks], s.fx.repo);
    assert.equal(s.f(['restack', 'child']).status, 0);
    assert.equal(fs.existsSync(marker), false);
  });

  it('a branch with nothing of its own after the inferred parent is refused', () => {
    const s = setup();
    stacked(s);
    assert.equal(s.f(['restack', 'parent']).status, 3);
  });
});
