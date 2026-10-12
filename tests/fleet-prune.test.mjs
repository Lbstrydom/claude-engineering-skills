/**
 * @fileoverview `fleet prune` — lists only branches/worktrees whose removal loses
 * nothing, proven from merged evidence + archive evidence, and runs nothing.
 */
import { after, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

import { git } from './helpers/git.mjs';
import { addBranch, cleanupFleetRoots, commitFile, installFakeGh, makeFleetRepo, runFleet, scrubbedEnv } from './helpers/fleet-repo.mjs';
import { fleetDir } from '../scripts/lib/fleet/registry.mjs';
import { applyPrune, planPrune } from '../scripts/lib/fleet/prune.mjs';
import { gatherFacts } from '../scripts/lib/fleet/facts.mjs';

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
    // Every branch delete is bound to the judged commit: git refuses it once the branch moved.
    assert.equal(byBranch['landed-plain'].commands.at(-1), `git update-ref -d refs/heads/landed-plain ${git(['rev-parse', 'landed-plain'], repo)}`);
    assert.equal(byBranch['ff-merged'].commands.at(-1), `git update-ref -d refs/heads/ff-merged ${git(['rev-parse', 'ff-merged'], repo)}`);
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

  test('the remote delete is offered only when the remote tip is covered by the proven local tip (R1-H1)', () => {
    const fx = makeFleetRepo();
    const fake = installFakeGh(fx.root);
    const env = scrubbedEnv({ FLEET_TELEMETRY: 'off', ...fake.env }, { prependPath: [fake.bin] });
    const { repo } = fx;
    const tip = (ref) => git(['rev-parse', ref], repo);
    // same: origin/<b> IS the landed tip
    addBranch(repo, 'same', { 'a.txt': 'A1\n' });
    squashInto(repo, 'same', 'same (#1)');
    git(['update-ref', 'refs/remotes/origin/same', tip('same')], repo);
    // behind: origin/<b> is an ancestor of the landed tip (pushed, then one more local commit)
    addBranch(repo, 'behind', { 'b.txt': 'B1\n' });
    const pushed = tip('behind');
    git(['switch', '-q', 'behind'], repo); commitFile(repo, 'b.txt', 'B2\n', 'more'); git(['switch', '-q', 'main'], repo);
    squashInto(repo, 'behind', 'behind (#2)');
    git(['update-ref', 'refs/remotes/origin/behind', pushed], repo);
    // moved-on: origin/<b> carries a commit the landed tip does not (pushed from elsewhere after landing)
    addBranch(repo, 'moved-on', { 'c.txt': 'C1\n' });
    squashInto(repo, 'moved-on', 'moved-on (#3)');
    git(['switch', '-q', '-c', 'scratch', 'moved-on'], repo); commitFile(repo, 'c.txt', 'C2 — only on the remote\n', 'remote-only');
    git(['update-ref', 'refs/remotes/origin/moved-on', tip('scratch')], repo);
    git(['switch', '-q', 'main'], repo); git(['branch', '-q', '-D', 'scratch'], repo);

    const r = runFleet(['prune', '--json'], { cwd: repo, env });
    assert.equal(r.status, 0, r.stderr);
    const by = Object.fromEntries(r.json.prune.candidates.map((c) => [c.branch, c]));
    assert.match(by.same.remote, new RegExp(`git push '?--force-with-lease=refs/heads/same:${tip('same')}'? origin --delete same`));
    assert.match(by.behind.remote, new RegExp(`git push '?--force-with-lease=refs/heads/behind:${pushed}'? origin --delete behind`));
    assert.equal(by['moved-on'].remote, null, 'the remote holds a commit nothing proved landed');
    assert.match(by['moved-on'].remoteNote, /not covered by the landed tip/);
    assert.match(by['moved-on'].commands.join('\n'), /git update-ref -d refs\/heads\/moved-on /, 'the LOCAL branch is still removable');
  });

  test('the printed remote delete is leased: it works as printed, and refuses once the remote moved (R1-H1/H5)', () => {
    const fx = makeFleetRepo();
    const fake = installFakeGh(fx.root);
    const env = scrubbedEnv({ FLEET_TELEMETRY: 'off', ...fake.env }, { prependPath: [fake.bin] });
    const { repo } = fx;
    const bare = path.join(fx.root, 'origin.git');
    git(['init', '-q', '--bare', bare], fx.root);
    git(['remote', 'set-url', 'origin', bare], repo);
    for (const b of ['ok-gone', 'moved-after']) {
      addBranch(repo, b, { [`${b}.txt`]: '1\n' });
      git(['push', '-q', 'origin', b], repo);
      squashInto(repo, b, `${b} (#1)`);
    }
    const r = runFleet(['prune', '--json'], { cwd: repo, env });
    assert.equal(r.status, 0, r.stderr);
    const by = Object.fromEntries(r.json.prune.candidates.map((c) => [c.branch, c]));
    // Someone pushes to moved-after AFTER the plan was printed (our origin/moved-after is now stale).
    const other = path.join(fx.root, 'other');
    git(['clone', '-q', bare, other], fx.root);
    git(['switch', '-q', 'moved-after'], other);
    commitFile(other, 'late.txt', 'pushed after the plan\n', 'late');
    git(['push', '-q', 'origin', 'moved-after'], other);
    // The printed command is shell-quoted (renderCommand); none of these args contain spaces.
    const exec = (cmd) => git(cmd.split(' ').slice(1).map((a) => a.replace(/^'(.*)'$/, '$1')), repo);
    exec(by['ok-gone'].remote);
    assert.equal(git(['ls-remote', bare, 'refs/heads/ok-gone'], repo), '', 'the judged remote branch was deleted');
    assert.throws(() => exec(by['moved-after'].remote), /stale info|rejected/, 'the lease refuses a remote that moved since it was judged');
    assert.notEqual(git(['ls-remote', bare, 'refs/heads/moved-after'], repo), '', 'and the moved branch survives');
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

  test('the read-only listing says how to run exactly what it printed', () => {
    const fx = makeFleetRepo();
    const fake = installFakeGh(fx.root);
    const env = scrubbedEnv({ FLEET_TELEMETRY: 'off', ...fake.env }, { prependPath: [fake.bin] });
    addBranch(fx.repo, 'done', { 'a.txt': 'A1\n' });
    squashInto(fx.repo, 'done', 'done (#1)');
    const r = runFleet(['prune'], { cwd: fx.repo, env });
    assert.match(r.stdout, /prune --apply/);
    assert.match(r.stdout, /--remote/);
  });
});

describe('fleet prune --apply', () => {
  const setup = (fleetConfig = null) => {
    const fx = makeFleetRepo(fleetConfig ? { fleetConfig } : {});
    const fake = installFakeGh(fx.root);
    // Ten days ahead: these fixtures are created seconds ago, and --apply skips anything FRESH (tested below).
    const env = scrubbedEnv({ FLEET_WORKTREE_ROOT: fx.wtRoot, FLEET_TELEMETRY: 'off', FLEET_NOW: new Date(Date.now() + 10 * 86_400_000).toISOString(), ...fake.env }, { prependPath: [fake.bin] });
    return { fx, env, f: (args) => runFleet(args, { cwd: fx.repo, env }) };
  };
  const branches = (repo) => git(['branch', '--format=%(refname:short)'], repo).split('\n').filter(Boolean);

  test('runs exactly the printed local list and nothing the plan kept', () => {
    const { fx, f } = setup({ archiveIgnore: ['node_modules/**', '.claude/**'] });
    const { repo } = fx;
    addBranch(repo, 'landed-plain', { 'a.txt': 'A1\n' }); squashInto(repo, 'landed-plain', 'landed-plain (#1)');
    addBranch(repo, 'landed-wt', { 'b.txt': 'B1\n' }); squashInto(repo, 'landed-wt', 'landed-wt (#2)');
    const wtClean = path.join(fx.root, 'wt-clean');
    git(['worktree', 'add', '-q', wtClean, 'landed-wt'], repo);
    addBranch(repo, 'landed-dirty', { 'c.txt': 'C1\n' }); squashInto(repo, 'landed-dirty', 'landed-dirty (#3)');
    const wtDirty = path.join(fx.root, 'wt-dirty');
    git(['worktree', 'add', '-q', wtDirty, 'landed-dirty'], repo);
    fs.writeFileSync(path.join(wtDirty, 'notes.txt'), 'unsaved thoughts\n');
    git(['branch', 'ff-merged', 'main'], repo);
    git(['branch', 'in-use', 'main'], repo);
    const wtLocked = path.join(fx.root, 'wt-locked');
    git(['worktree', 'add', '-q', wtLocked, 'in-use'], repo);
    git(['worktree', 'lock', wtLocked], repo);
    addBranch(repo, 'unmerged', { 'd.txt': 'D1\n' });
    commitFile(repo, 'z.txt', 'z\n', 'move main on');

    const r = f(['prune', '--apply', '--json']);
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(r.json.applied.counts, { removed: 3, skipped: 0, failed: 0, remoteDeleted: 0 });
    const left = branches(repo);
    for (const gone of ['landed-plain', 'landed-wt', 'ff-merged']) assert.ok(!left.includes(gone), `${gone} was removed`);
    for (const kept of ['landed-dirty', 'in-use', 'unmerged', 'main']) assert.ok(left.includes(kept), `${kept} survives`);
    assert.equal(fs.existsSync(wtClean), false, 'the clean worktree went with its branch');
    assert.ok(fs.existsSync(path.join(wtDirty, 'notes.txt')), 'the worktree holding unsaved files is untouched');
    assert.ok(fs.existsSync(wtLocked), 'the locked worktree is untouched');

    // Idempotent: a second run has nothing left to prove removable, and says so without erroring.
    const again = f(['prune', '--apply', '--json']);
    assert.equal(again.status, 0, again.stderr);
    assert.equal(again.json.applied.counts.removed, 0);
  });

  test('--remote without --apply is an argv error, and nothing is removed', () => {
    const { fx, f } = setup();
    addBranch(fx.repo, 'done', { 'a.txt': 'A1\n' }); squashInto(fx.repo, 'done', 'done (#1)');
    const r = f(['prune', '--remote']);
    assert.equal(r.status, 2);
    assert.match(r.stderr, /--remote only applies with --apply/);
    assert.ok(branches(fx.repo).includes('done'));
  });

  // A bare origin with each branch pushed BEFORE it is squash-merged, so origin/<b> is the landed tip.
  const withOrigin = (names) => {
    const s = setup();
    const { repo } = s.fx;
    const bare = path.join(s.fx.root, 'origin.git');
    git(['init', '-q', '--bare', bare], s.fx.root);
    git(['remote', 'set-url', 'origin', bare], repo);
    for (const b of names) {
      addBranch(repo, b, { [`${b}.txt`]: '1\n' });
      git(['push', '-q', 'origin', b], repo);
      squashInto(repo, b, `${b} (#1)`);
    }
    return { ...s, bare, remoteHas: (b) => git(['ls-remote', bare, `refs/heads/${b}`], repo) !== '' };
  };

  test('without --remote the remote branch is never touched', () => {
    const { f, fx, remoteHas } = withOrigin(['r-keep']);
    const r = f(['prune', '--apply', '--json']);
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(r.json.applied.counts, { removed: 1, skipped: 0, failed: 0, remoteDeleted: 0 });
    assert.ok(!branches(fx.repo).includes('r-keep'));
    assert.ok(remoteHas('r-keep'), 'the remote branch survives a local-only apply');
  });

  test('--remote deletes the judged remote branch (leased), and a remote that is already gone counts as done', () => {
    const { f, fx, bare, remoteHas } = withOrigin(['r-del', 'r-gone']);
    // r-gone was deleted on the remote after our last fetch, so origin/r-gone is stale.
    git(['--git-dir', bare, 'update-ref', '-d', 'refs/heads/r-gone'], fx.root);
    const r = f(['prune', '--apply', '--remote', '--json']);
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(r.json.applied.counts, { removed: 2, skipped: 0, failed: 0, remoteDeleted: 1 });
    const by = Object.fromEntries(r.json.applied.results.map((x) => [x.branch, x.remote.status]));
    assert.deepEqual(by, { 'r-del': 'deleted', 'r-gone': 'already-gone' });
    assert.equal(remoteHas('r-del'), false);
  });

  test('a remote that moved since the last fetch is refused by the lease: the local branch still goes, the run exits non-zero', () => {
    const { f, fx, bare, remoteHas } = withOrigin(['moved-after']);
    const other = path.join(fx.root, 'other');
    git(['clone', '-q', bare, other], fx.root);
    git(['switch', '-q', 'moved-after'], other);
    commitFile(other, 'late.txt', 'pushed after the last fetch\n', 'late');
    git(['push', '-q', 'origin', 'moved-after'], other);
    const r = f(['prune', '--apply', '--remote', '--json']);
    assert.equal(r.status, 1, 'a failed removal is exit 1, not a quiet 0');
    assert.equal(r.json.applied.counts.failed, 1);
    assert.equal(r.json.applied.results[0].remote.status, 'failed');
    assert.ok(!branches(fx.repo).includes('moved-after'));
    assert.ok(remoteHas('moved-after'), 'the commit pushed after the judgement survives');
  });

  // The plan is judged earlier than it is applied; these drive applyPrune with a hand-built plan to
  // move the world in between.
  describe('guards between the judgement and the removal', () => {
    const ctxFor = (repo) => ({ cwd: repo, dir: fleetDir(repo) });
    const cand = (repo, branch, extra = {}) => ({
      branch, oid: git(['rev-parse', branch], repo), steps: [{ kind: 'branch', argv: ['git', 'branch', '-D', branch] }], remoteStep: null, ...extra,
    });
    const plan = (...candidates) => ({ candidates, excluded: [], notJudged: [] });

    test('a tip that moved since it was judged is skipped, not deleted', () => {
      const { fx } = setup();
      const { repo } = fx;
      addBranch(repo, 'busy', { 'a.txt': 'A1\n' });
      const c = cand(repo, 'busy');
      git(['switch', '-q', 'busy'], repo); commitFile(repo, 'a.txt', 'A2 — a session pushed on\n', 'more'); git(['switch', '-q', 'main'], repo);
      const a = applyPrune(ctxFor(repo), plan(c));
      assert.equal(a.results[0].status, 'skipped');
      assert.match(a.results[0].reason, /tip moved/);
      assert.ok(branches(repo).includes('busy'));
    });

    test('a branch a session registered since the judgement is skipped', () => {
      const { fx, f } = setup();
      const { repo } = fx;
      addBranch(repo, 'claimed', { 'a.txt': 'A1\n' });
      const c = cand(repo, 'claimed');
      git(['switch', '-q', 'claimed'], repo);
      assert.equal(f(['claim', '--id', 'claimed', '--intent', 'x', '--paths', 'a.txt']).status, 0);
      git(['switch', '-q', 'main'], repo);
      const a = applyPrune(ctxFor(repo), plan(c));
      assert.match(a.results[0].reason, /registered this branch/);
      assert.ok(branches(repo).includes('claimed'));
    });

    test('a checkout that appeared (or moved) since the judgement is re-read under the lock and the branch is skipped', () => {
      const { fx } = setup();
      const { repo } = fx;
      addBranch(repo, 'gets-checked-out', { 'a.txt': 'A1\n' });
      const c = cand(repo, 'gets-checked-out', { worktree: null });
      git(['worktree', 'add', '-q', path.join(fx.root, 'wt-late'), 'gets-checked-out'], repo); // a session starts on it
      const a = applyPrune(ctxFor(repo), plan(c));
      assert.equal(a.results[0].status, 'skipped');
      assert.match(a.results[0].reason, /checkouts changed/);
      assert.ok(branches(repo).includes('gets-checked-out'));
      // control: with no checkout appearing, the same hand-built plan removes it
      addBranch(repo, 'stays-alone', { 'b.txt': 'B1\n' });
      assert.equal(applyPrune(ctxFor(repo), plan(cand(repo, 'stays-alone', { worktree: null }))).results[0].status, 'removed');
    });

    test('the worktree loss evidence is re-read under the lock: ignored data that appeared since the plan skips it', () => {
      const { fx } = setup();
      const { repo } = fx;
      git(['branch', 'wt-branch', 'main'], repo);
      const wt = path.join(fx.root, 'wt-re');
      git(['worktree', 'add', '-q', wt, 'wt-branch'], repo);
      const c = cand(repo, 'wt-branch', { worktree: wt, steps: [{ kind: 'worktree', argv: ['git', 'worktree', 'remove', wt] }, { kind: 'branch', argv: ['git', 'update-ref', '-d', 'refs/heads/wt-branch', git(['rev-parse', 'wt-branch'], repo)] }] });
      const dirtyNow = () => ({ risks: { staged: [], unstaged: [], untracked: [], ignored: ['build/'], unpushed: [] }, unverified: [] });
      const a = applyPrune(ctxFor(repo), plan(c), { report: dirtyNow });
      assert.equal(a.results[0].status, 'skipped');
      assert.match(a.results[0].reason, /worktree changed since it was judged \(1 ignored\)/);
      assert.ok(fs.existsSync(wt), 'the worktree is kept');
      const clean = () => ({ risks: { staged: [], unstaged: [], untracked: [], ignored: [], unpushed: [] }, unverified: [] });
      assert.equal(applyPrune(ctxFor(repo), plan(c), { report: clean }).results[0].status, 'removed', 'control: unchanged evidence removes it');
    });

    test('a candidate with no recorded tip fails closed', () => {
      const { fx } = setup();
      addBranch(fx.repo, 'untipped', { 'a.txt': 'A1\n' });
      const a = applyPrune(ctxFor(fx.repo), plan(cand(fx.repo, 'untipped', { oid: null })));
      assert.match(a.results[0].reason, /tip was not recorded/);
      assert.ok(branches(fx.repo).includes('untipped'));
    });

    test('a failing worktree removal stops that candidate: its branch is not deleted afterwards', () => {
      const { fx } = setup();
      const { repo } = fx;
      addBranch(repo, 'wt-fails', { 'a.txt': 'A1\n' });
      const c = cand(repo, 'wt-fails', { steps: [
        { kind: 'worktree', argv: ['git', 'worktree', 'remove', path.join(fx.root, 'nowhere')] },
        { kind: 'branch', argv: ['git', 'branch', '-D', 'wt-fails'] },
      ] });
      const calls = [];
      const git_ = (args, cwd) => { calls.push(args.slice(0, 2).join(' ')); return args[0] === 'worktree' ? { ok: false, reason: 'git worktree exited 128: boom' } : { ok: true }; };
      const a = applyPrune(ctxFor(repo), plan(c), { git: git_ });
      assert.equal(a.results[0].status, 'failed');
      assert.match(a.results[0].reason, /boom/);
      assert.deepEqual(calls, ['worktree remove'], 'the branch delete never ran');
      assert.equal(a.counts.failed, 1);
    });
  });
});

describe('fleet prune — cluster B additions (plan §2.6 x, y; the removal binding)', () => {
  const setupB = ({ future = true } = {}) => {
    const fx = makeFleetRepo({ fleetConfig: { archiveIgnore: ['node_modules/**', '.claude/**'] } });
    const fake = installFakeGh(fx.root);
    const env = scrubbedEnv({ FLEET_WORKTREE_ROOT: fx.wtRoot, FLEET_TELEMETRY: 'off', ...(future ? { FLEET_NOW: new Date(Date.now() + 10 * 86_400_000).toISOString() } : {}), ...fake.env }, { prependPath: [fake.bin] });
    return { fx, f: (args) => runFleet(args, { cwd: fx.repo, env }) };
  };

  test('--apply skips a FRESH candidate (just created, no claim) and says why; --include-fresh removes it (control)', () => {
    const { fx, f } = setupB({ future: false });
    git(['branch', 'just-started', 'main'], fx.repo);
    const dry = f(['prune', '--json']).json.prune.candidates.find((c) => c.branch === 'just-started');
    assert.equal(dry.fresh, true);
    const r = f(['prune', '--apply', '--json']);
    assert.equal(r.status, 0, r.stderr);
    const res = r.json.applied.results.find((x) => x.branch === 'just-started');
    assert.deepEqual([res.status, /fresh/.test(res.reason)], ['skipped', true]);
    assert.ok(git(['branch', '--list', 'just-started'], fx.repo));
    const r2 = f(['prune', '--apply', '--include-fresh', '--json']);
    assert.equal(r2.json.applied.results.find((x) => x.branch === 'just-started').status, 'removed');
    assert.equal(f(['prune', '--include-fresh']).status, 2, '--include-fresh without --apply is an argv error');
  });

  test('a removed branch takes its branch.<name> config with it (as branch -d did); no section, no step (control)', () => {
    const { fx, f } = setupB();
    addBranch(fx.repo, 'tracked-up', { 't.txt': 't\n' }); squashInto(fx.repo, 'tracked-up', 'tracked-up (#1)');
    git(['config', 'branch.tracked-up.remote', 'origin'], fx.repo);
    git(['config', 'branch.tracked-up.merge', 'refs/heads/tracked-up'], fx.repo);
    addBranch(fx.repo, 'no-config', { 'n.txt': 'n\n' }); squashInto(fx.repo, 'no-config', 'no-config (#2)');
    const p = f(['prune', '--json']).json.prune;
    assert.equal(p.candidates.find((c) => c.branch === 'tracked-up').commands.at(-1), 'git config --remove-section branch.tracked-up');
    assert.deepEqual(p.candidates.find((c) => c.branch === 'no-config').steps.map((s) => s.kind), ['branch'], 'no section: no config step');
    assert.equal(f(['prune', '--apply', '--json']).status, 0);
    // `config --get-regexp` exits 1 when nothing matches: that IS "the section is gone".
    const gone = () => { try { execFileSync('git', ['config', '--get-regexp', '^branch\\.tracked-up\\.'], { cwd: fx.repo, stdio: 'ignore' }); return false; } catch (e) { return e.status === 1; } };
    assert.equal(gone(), true);
  });

  test('config cleanup matches the EXACT subsection: removing "foo" never claims "foo.bar"\'s config; the summary names what was removed', () => {
    const { fx, f } = setupB();
    addBranch(fx.repo, 'foo', { 'f.txt': 'f\n' }); squashInto(fx.repo, 'foo', 'foo (#1)');
    addBranch(fx.repo, 'foo.bar', { 'fb.txt': 'unmerged work\n' }); // unmerged: never a candidate itself
    git(['config', 'branch.foo.bar.remote', 'origin'], fx.repo); // belongs to branch "foo.bar", not "foo"
    const foo = f(['prune', '--json']).json.prune.candidates.find((c) => c.branch === 'foo');
    assert.deepEqual(foo.steps.map((s) => s.kind), ['branch'], 'no config step for "foo"');
    addBranch(fx.repo, 'with-up', { 'w.txt': 'w\n' }); squashInto(fx.repo, 'with-up', 'with-up (#2)');
    git(['config', 'branch.with-up.remote', 'origin'], fx.repo);
    const r = f(['prune', '--apply']);
    assert.equal(r.status, 0, r.stdout);
    assert.match(r.stdout, /with-up: removed \(branch \+ its config\)/);
    assert.match(r.stdout, /foo: removed \(branch\)/);
    assert.equal(git(['config', 'branch.foo.bar.remote'], fx.repo), 'origin', 'the other branch\'s config survives');
  });

  test('a branch checked out in TWO worktrees is kept (update-ref -d would not refuse it the way branch -d did)', () => {
    const { fx, f } = setupB();
    git(['branch', 'twice', 'main'], fx.repo);
    git(['worktree', 'add', '-q', path.join(fx.root, 'wt-one'), 'twice'], fx.repo);
    git(['worktree', 'add', '-q', '--force', path.join(fx.root, 'wt-two'), 'twice'], fx.repo);
    const p = f(['prune', '--json']).json.prune;
    assert.ok(!p.candidates.some((c) => c.branch === 'twice'));
    assert.match(p.excluded.find((e) => e.branch === 'twice').reason, /checked out in 2 worktrees/);
  });

  test('a branch created moments ago on an OLD commit is fresh (its reflog, not its tip time); control: an old reflog reads idle', () => {
    const { fx, f } = setupB({ future: false });
    // main ends in a year-old commit, so a branch cut from it has a year-old tip.
    const yearOld = execFileSync('git', ['commit-tree', 'main^{tree}', '-p', 'main', '-m', 'year-old'], {
      cwd: fx.repo, encoding: 'utf8', env: { ...process.env, GIT_COMMITTER_DATE: '2025-01-01T00:00:00Z', GIT_AUTHOR_DATE: '2025-01-01T00:00:00Z' },
    }).trim();
    git(['update-ref', 'refs/heads/main', yearOld], fx.repo);
    git(['branch', 'new-on-old', 'main'], fx.repo);
    const judge = () => f(['prune', '--json']).json.prune.candidates.find((x) => x.branch === 'new-on-old');
    assert.equal(judge().fresh, true, 'the reflog was written seconds ago');
    // control: age the branch's reflog and loose ref files — now nothing says it is recent
    const common = git(['rev-parse', '--path-format=absolute', '--git-common-dir'], fx.repo);
    const longAgo = new Date('2025-01-02T00:00:00Z');
    for (const p of [path.join(common, 'logs', 'refs', 'heads', 'new-on-old'), path.join(common, 'refs', 'heads', 'new-on-old')]) if (fs.existsSync(p)) fs.utimesSync(p, longAgo, longAgo);
    assert.equal(judge().fresh, false);
  });

  test('the printed branch delete is bound to the judged commit: it refuses once the branch moved', () => {
    const { fx, f } = setupB();
    addBranch(fx.repo, 'bound', { 'a.txt': 'A1\n' }); squashInto(fx.repo, 'bound', 'bound (#1)');
    const cand = f(['prune', '--json']).json.prune.candidates.find((c) => c.branch === 'bound');
    assert.match(cand.commands.at(-1), /^git update-ref -d refs\/heads\/bound [0-9a-f]{40}$/);
    const argv = cand.steps.at(-1).argv; // the structured step the printed command renders — executed as-is, no shell splitting
    git(['switch', '-q', 'bound'], fx.repo); commitFile(fx.repo, 'a.txt', 'A2\n', 'later'); git(['switch', '-q', 'main'], fx.repo);
    assert.throws(() => git(argv.slice(1), fx.repo), /cannot lock ref|but expected|is at/);
    assert.ok(git(['branch', '--list', 'bound'], fx.repo), 'the moved branch survives the printed delete');
  });

  test('a worktree whose HEAD is not the judged tip is kept, not removed (control: the same worktree at the judged tip is a candidate)', () => {
    const fx = makeFleetRepo({ fleetConfig: { archiveIgnore: ['node_modules/**', '.claude/**'] } });
    git(['branch', 'at-base', 'main'], fx.repo);
    git(['worktree', 'add', '-q', path.join(fx.root, 'wt-at-base'), 'at-base'], fx.repo);
    const ctx = { cwd: fx.repo, config: { baseBranch: 'main', archiveIgnore: ['node_modules/**', '.claude/**'], staleWorktreeDays: 3 }, now: new Date(), env: scrubbedEnv({ FLEET_TELEMETRY: 'off' }), cmd: 'fleet' };
    const facts = gatherFacts({ cwd: fx.repo, config: ctx.config, now: ctx.now, env: ctx.env, prs: false });
    facts.prs = { queried: true, complete: true, prs: [] }; // no open PRs: the hide rule's precondition
    const judge = (f) => planPrune(ctx, { facts: f });
    assert.ok(judge(facts).candidates.some((c) => c.branch === 'at-base'), 'control: HEAD is the judged tip');
    // The branch was judged at an older commit (captured before the checkout moved on): not covered.
    const stale = structuredClone(facts);
    const rec = stale.branches.branches.find((b) => b.name === 'at-base');
    rec.oid = git(['commit-tree', `${rec.oid}^{tree}`, '-m', 'elsewhere'], fx.repo);
    const p = judge(stale);
    assert.ok(!p.candidates.some((c) => c.branch === 'at-base'));
    assert.match(p.excluded.find((e) => e.branch === 'at-base').reason, /HEAD .* is not the judged tip/);
  });

  test('every run ends with the desktop session-list check, dry run and apply', () => {
    const { fx, f } = setupB();
    addBranch(fx.repo, 'done', { 'a.txt': 'A1\n' }); squashInto(fx.repo, 'done', 'done (#1)');
    assert.match(f(['prune']).stdout.trimEnd(), /confirm in the desktop session list.*$/);
    assert.match(f(['prune', '--apply']).stdout, /desktop session list.*required agent step/);
  });

  test('orphan directories: empty gets a plain rmdir; node_modules-only and files say "look"; worktree entries and links are never listed as removable', () => {
    const { fx, f } = setupB();
    const root = path.join(fx.repo, '.claude', 'worktrees');
    fs.mkdirSync(path.join(root, 'empty-one'), { recursive: true });
    fs.mkdirSync(path.join(root, 'deps-only', 'node_modules', 'x'), { recursive: true });
    fs.writeFileSync(path.join(root, 'deps-only', 'node_modules', 'x', 'i.js'), '');
    fs.mkdirSync(path.join(root, 'has-files'), { recursive: true });
    fs.writeFileSync(path.join(root, 'has-files', 'notes.md'), 'keep me\n');
    const target = path.join(fx.root, 'precious'); fs.mkdirSync(target); fs.writeFileSync(path.join(target, 'p.txt'), 'p');
    fs.symlinkSync(target, path.join(root, 'a-link'), 'junction');
    git(['worktree', 'add', '-q', path.join(root, 'real-wt'), '-b', 'real-wt', 'main'], fx.repo);
    const o = f(['prune', '--json']).json.prune.orphans;
    const by = Object.fromEntries(o.dirs.map((d) => [path.basename(d.path), d]));
    assert.equal(by['empty-one'].kind, 'empty');
    assert.match(by['empty-one'].command, /^rmdir /);
    assert.deepEqual([by['deps-only'].kind, by['deps-only'].command], ['ignored-only', undefined], 'no recursive command is printed');
    assert.deepEqual([by['has-files'].kind, by['has-files'].command], ['holds', undefined]);
    assert.equal(by['a-link'].kind, 'link');
    assert.equal(by['real-wt'], undefined, 'a git worktree list entry is never an orphan');
    assert.ok(fs.existsSync(path.join(target, 'p.txt')), 'the link target is untouched');
    const text = f(['prune']).stdout;
    assert.match(text, /orphan directories/);
    assert.ok(fs.existsSync(path.join(root, 'empty-one')), 'nothing is removed');
  });

  test('a branch whose upstream is gone shows the hint and is not thereby a candidate', () => {
    const { fx, f } = setupB();
    addBranch(fx.repo, 'gone-up', { 'g.txt': 'g\n' });
    git(['push', '-q', '-u', 'origin', 'gone-up'], fx.repo);
    git(['push', '-q', 'origin', '--delete', 'gone-up'], fx.repo);
    git(['fetch', '-q', '--prune', 'origin'], fx.repo);
    const p = f(['prune', '--json']).json.prune;
    assert.ok(p.upstreamGone.includes('gone-up'));
    assert.ok(!p.candidates.some((c) => c.branch === 'gone-up'), 'a deleted remote is not evidence of landing');
    assert.match(f(['prune']).stdout, /upstream gone \(1\).*gone-up/);
  });
});
