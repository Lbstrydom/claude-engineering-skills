/**
 * @fileoverview `fleet prune` — lists only branches/worktrees whose removal loses
 * nothing, proven from merged evidence + archive evidence, and runs nothing.
 */
import { after, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { git } from './helpers/git.mjs';
import { addBranch, cleanupFleetRoots, commitFile, installFakeGh, makeFleetRepo, runFleet, scrubbedEnv } from './helpers/fleet-repo.mjs';

after(cleanupFleetRoots);

const squashInto = (repo, branch, msg) => { git(['merge', '--squash', branch], repo); git(['commit', '-q', '-m', msg], repo); };

describe('fleet prune', () => {
  test('lists landed / merged branches with the right delete, keeps everything it cannot prove, runs nothing', () => {
    // archiveIgnore declares host-written settings (the desktop app copies .claude/settings.local.json into
    // new worktrees) disposable — the documented way; without it prune rightly keeps such a worktree.
    const fx = makeFleetRepo({ fleetConfig: { archiveIgnore: ['node_modules/**', '.claude/**'] } });
    const fake = installFakeGh(fx.root);
    const env = scrubbedEnv({ FLEET_WORKTREE_ROOT: fx.wtRoot, FLEET_TELEMETRY: 'off', ...fake.env }, { prependPath: [fake.bin] });
    const f = (args) => runFleet(args, { cwd: fx.repo, env });
    const { repo } = fx;

    // landed: squash-merged into main, no worktree → -D
    addBranch(repo, 'landed-plain', { 'a.txt': 'A1\n' });
    squashInto(repo, 'landed-plain', 'landed-plain (#1)');
    // landed with a CLEAN worktree → worktree remove + -D
    addBranch(repo, 'landed-wt', { 'b.txt': 'B1\n' });
    squashInto(repo, 'landed-wt', 'landed-wt (#2)');
    const wtClean = path.join(fx.root, 'wt-clean');
    git(['worktree', 'add', '-q', wtClean, 'landed-wt'], repo);
    // landed with a worktree holding an untracked file → kept, says why
    addBranch(repo, 'landed-dirty', { 'c.txt': 'C1\n' });
    squashInto(repo, 'landed-dirty', 'landed-dirty (#3)');
    const wtDirty = path.join(fx.root, 'wt-dirty');
    git(['worktree', 'add', '-q', wtDirty, 'landed-dirty'], repo);
    fs.writeFileSync(path.join(wtDirty, 'notes.txt'), 'unsaved thoughts\n');
    // merged by fast-forward (ahead 0) → -d
    git(['branch', 'ff-merged', 'main'], repo);
    // merged but its worktree is LOCKED (in use) → kept
    git(['branch', 'in-use', 'main'], repo);
    const wtLocked = path.join(fx.root, 'wt-locked');
    git(['worktree', 'add', '-q', wtLocked, 'in-use'], repo);
    git(['worktree', 'lock', wtLocked], repo);
    // unmerged work → not a candidate at all
    addBranch(repo, 'unmerged', { 'd.txt': 'D1\n' });
    // a registered session on a landed branch → not a candidate
    addBranch(repo, 'session-landed', { 'e.txt': 'E1\n' });
    squashInto(repo, 'session-landed', 'session-landed (#5)');
    git(['switch', '-q', 'session-landed'], repo);
    assert.equal(f(['claim', '--id', 'session-landed', '--intent', 'x', '--paths', 'e.txt']).status, 0);
    git(['switch', '-q', 'main'], repo);
    commitFile(repo, 'z.txt', 'z\n', 'move main on');

    const before = git(['branch', '--list'], repo);
    const r = f(['prune', '--json']);
    assert.equal(r.status, 0, r.stderr);
    const p = r.json.prune;
    const byBranch = Object.fromEntries(p.candidates.map((c) => [c.branch, c]));
    assert.deepEqual(Object.keys(byBranch).sort(), ['ff-merged', 'landed-plain', 'landed-wt']);
    assert.match(byBranch['landed-plain'].commands.join('\n'), /git branch -D landed-plain/);
    assert.match(byBranch['ff-merged'].commands.join('\n'), /git branch -d ff-merged/, 'ahead 0: git\'s own safe delete');
    assert.match(byBranch['landed-wt'].commands[0], /git worktree remove .*wt-clean/);
    assert.match(byBranch['landed-wt'].via, /squash/);
    const kept = Object.fromEntries(p.excluded.map((e) => [e.branch, e.reason]));
    assert.match(kept['landed-dirty'], /1 untracked/);
    assert.match(kept['in-use'], /locked/);
    assert.equal(byBranch.unmerged, undefined);
    assert.equal(byBranch['session-landed'], undefined);
    assert.equal(git(['branch', '--list'], repo), before, 'read-only: no branch was deleted');
    assert.ok(fs.existsSync(wtClean), 'read-only: no worktree was removed');

    // The printed commands actually work, and remove only what was listed.
    for (const cmd of byBranch['landed-wt'].commands) {
      const argv = cmd.split(' ');
      git(argv.slice(1), repo);
    }
    assert.equal(fs.existsSync(wtClean), false);
    assert.ok(!git(['branch', '--list'], repo).includes('landed-wt'));
  });

  test('text output says nothing was removed, and names why a branch was kept', () => {
    const fx = makeFleetRepo();
    const fake = installFakeGh(fx.root);
    const env = scrubbedEnv({ FLEET_TELEMETRY: 'off', ...fake.env }, { prependPath: [fake.bin] });
    addBranch(fx.repo, 'done', { 'a.txt': 'A1\n' });
    squashInto(fx.repo, 'done', 'done (#1)');
    const r = runFleet(['prune'], { cwd: fx.repo, env });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /read-only: nothing was removed/);
    assert.match(r.stdout, /done — landed/);
  });

  test('without a readable PR list, nothing is judged removable', () => {
    const fx = makeFleetRepo();
    addBranch(fx.repo, 'done', { 'a.txt': 'A1\n' });
    squashInto(fx.repo, 'done', 'done (#1)');
    // No fake gh on PATH: the open-PR list cannot be read, so "no open PR" is unproven.
    const r = runFleet(['prune', '--json'], { cwd: fx.repo, env: scrubbedEnv({ FLEET_TELEMETRY: 'off' }) });
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(r.json.prune.candidates, []);
    assert.match(r.json.prune.notJudged.join(' '), /open-PR list/);
  });
});
