/**
 * @fileoverview Registration binding (docs/plans/fleet-unclaimed-work-and-switch-friction.md §2.4 a, b, j, u; Cluster C):
 * `claim --worktree`, the id ≠ bound-branch warning, `add` recording the worktree, `release` resolving it, and the
 * `ready` warning for commits no remote ref holds.
 */
import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { git } from './helpers/git.mjs';
import { cleanupFleetRoots, commitFile, makeFleetRepo, runFleet, scrubbedEnv, tmpRoot } from './helpers/fleet-repo.mjs';
import { fleetDir, readSessions } from '../scripts/lib/fleet/registry.mjs';
import { unpushedCount } from '../scripts/lib/fleet/commands.mjs';

after(cleanupFleetRoots);

// The host writes .claude/settings.local.json into new worktrees; a real repo declares it disposable.
const REPO = { fleetConfig: { archiveIgnore: ['node_modules/**', '.claude/**'] } };
const envOf = () => scrubbedEnv({ FLEET_TELEMETRY: 'off' });
const addWorktree = (fx, name) => {
  const wt = path.join(tmpRoot('binding-wt-'), name);
  git(['worktree', 'add', '-q', '-b', name, wt, 'main'], fx.repo);
  return wt;
};
const session = (fx, id) => readSessions(fleetDir(fx.repo)).sessions.find((s) => s.id === id);
const same = (a, b) => path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();

describe('release resolves an adopted session\'s worktree (a: the false CLEAN)', () => {
  it('an adopted branch with PUSHED commits and one untracked file in its worktree is AT RISK, never CLEAN', () => {
    const fx = makeFleetRepo(REPO);
    const env = envOf();
    const wt = addWorktree(fx, 'adopted');
    commitFile(wt, 'a.txt', 'adopted work\n');
    git(['push', '-q', 'origin', 'adopted'], wt);
    assert.equal(runFleet(['add', 'adopted'], { cwd: fx.repo, env }).status, 0);
    fs.writeFileSync(path.join(wt, 'unsaved.md'), 'not committed\n');
    const r = runFleet(['release', '--id', 'adopted'], { cwd: fx.repo, env });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /AT RISK/);
    assert.match(r.stdout, /unsaved\.md/);
  });
  it('control: the same adopted branch with a clean worktree is CLEAN', () => {
    const fx = makeFleetRepo(REPO);
    const env = envOf();
    const wt = addWorktree(fx, 'adopted-clean');
    commitFile(wt, 'a.txt', 'adopted work\n');
    git(['push', '-q', 'origin', 'adopted-clean'], wt);
    assert.equal(runFleet(['add', 'adopted-clean'], { cwd: fx.repo, env }).status, 0);
    assert.match(runFleet(['release', '--id', 'adopted-clean'], { cwd: fx.repo, env }).stdout, /CLEAN/);
  });
});

describe('release never fails after its state change committed', () => {
  it('a malformed .fleet.json: the release lands (exit 0, state done) and the report says archiveIgnore was not read', () => {
    const fx = makeFleetRepo(REPO);
    const env = envOf();
    const wt = addWorktree(fx, 'cfg-broken');
    commitFile(wt, 'cfg-broken.txt', 'cfg\n');
    git(['push', '-q', 'origin', 'cfg-broken'], wt);
    assert.equal(runFleet(['add', 'cfg-broken'], { cwd: fx.repo, env }).status, 0);
    fs.writeFileSync(path.join(fx.repo, '.fleet.json'), '{ not json');
    const r = runFleet(['release', '--id', 'cfg-broken'], { cwd: fx.repo, env });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /released: cfg-broken \(done\)/);
    assert.match(r.stdout, /NOT VERIFIED: archiveIgnore not read/);
    assert.equal(session(fx, 'cfg-broken').state, 'done');
  });
});

describe('add records the branch\'s worktree (b)', () => {
  it('a branch checked out in a worktree is adopted WITH that worktree; one with no worktree records none (control)', () => {
    const fx = makeFleetRepo(REPO);
    const env = envOf();
    const wt = addWorktree(fx, 'has-wt');
    commitFile(wt, 'h.txt', 'h\n');
    assert.equal(runFleet(['add', 'has-wt'], { cwd: fx.repo, env }).status, 0);
    assert.ok(same(session(fx, 'has-wt').worktree, wt));
    git(['branch', 'no-wt', 'main'], fx.repo);
    git(['checkout', '-q', 'no-wt'], fx.repo); commitFile(fx.repo, 'n.txt', 'n\n'); git(['checkout', '-q', 'main'], fx.repo);
    assert.equal(runFleet(['add', 'no-wt'], { cwd: fx.repo, env }).status, 0);
    assert.equal(session(fx, 'no-wt').worktree, null);
  });
});

describe('claim binds the right branch (j) and --worktree (a)', () => {
  it('a claim whose id differs from the branch it binds WARNS; a matching one does not (control)', () => {
    const fx = makeFleetRepo(REPO);
    const env = envOf();
    const wt = addWorktree(fx, 'feature-x');
    const wrong = runFleet(['claim', '--id', 'feature-x', '--intent', 'x', '--paths', 'x.txt'], { cwd: fx.repo, env });
    assert.equal(wrong.status, 0, wrong.stdout);
    assert.match(wrong.stdout, /warning: claim id feature-x is not its bound branch main/);
    assert.equal(session(fx, 'feature-x').source.branch, 'main', 'without --worktree the cwd\'s branch is still what gets bound');
    assert.ok(wt);
    const matching = addWorktree(fx, 'match-me');
    const right = runFleet(['claim', '--intent', 'm', '--paths', 'm.txt'], { cwd: matching, env });
    assert.equal(right.status, 0, right.stdout);
    assert.doesNotMatch(right.stdout, /is not its bound branch/, 'control: id = bound branch');
  });
  it('--worktree binds THAT worktree\'s branch and path, from anywhere in the repo', () => {
    const fx = makeFleetRepo(REPO);
    const env = envOf();
    const wt = addWorktree(fx, 'bound-here');
    const r = runFleet(['claim', '--worktree', wt, '--intent', 'bound', '--paths', 'b.txt'], { cwd: fx.repo, env });
    assert.equal(r.status, 0, r.stdout);
    const s = session(fx, 'bound-here');
    assert.ok(s, 'the id defaults to the worktree\'s branch');
    assert.equal(s.source.branch, 'bound-here');
    assert.ok(same(s.worktree, wt));
    assert.doesNotMatch(r.stdout, /is not its bound branch/);
  });
  it('--worktree refuses a path that is not a listed worktree of this repo (control: a listed one is accepted above)', () => {
    const fx = makeFleetRepo(REPO);
    const env = envOf();
    const stranger = tmpRoot('binding-not-a-wt-');
    const r = runFleet(['claim', '--worktree', stranger, '--id', 'x', '--intent', 'x', '--paths', 'x.txt'], { cwd: fx.repo, env });
    assert.equal(r.status, 2, r.stdout + r.stderr);
    assert.match(r.stderr, /not a listed worktree of this repo/);
  });
  it('--worktree on a DETACHED worktree needs --id and binds no branch (warned)', () => {
    const fx = makeFleetRepo(REPO);
    const env = envOf();
    const wt = path.join(tmpRoot('binding-det-'), 'det');
    git(['worktree', 'add', '-q', '--detach', wt, 'main'], fx.repo);
    const noId = runFleet(['claim', '--worktree', wt, '--intent', 'd', '--paths', 'd.txt'], { cwd: fx.repo, env });
    assert.equal(noId.status, 2);
    assert.match(noId.stderr, /detached.*--id/);
    const withId = runFleet(['claim', '--worktree', wt, '--id', 'det-work', '--intent', 'd', '--paths', 'd.txt'], { cwd: fx.repo, env });
    assert.equal(withId.status, 0, withId.stdout);
    assert.match(withId.stdout, /warning: .*detached.*binds no branch/);
    assert.equal(session(fx, 'det-work').source.branch, null);
  });
  it('an adopted session is never filled with a worktree holding ANOTHER branch (adopt A, claim with B\'s worktree)', () => {
    const fx = makeFleetRepo(REPO);
    const env = envOf();
    git(['branch', 'branch-a', 'main'], fx.repo); // A: adopted with no worktree checked out
    assert.equal(runFleet(['add', 'branch-a'], { cwd: fx.repo, env }).status, 0);
    assert.equal(session(fx, 'branch-a').worktree, null);
    const wtB = addWorktree(fx, 'branch-b');
    const r = runFleet(['claim', '--id', 'branch-a', '--worktree', wtB, '--intent', 'a', '--paths', 'a.txt'], { cwd: fx.repo, env });
    assert.equal(r.status, 2, r.stdout + r.stderr);
    assert.match(r.stderr, /has branch-b checked out, but branch-a is bound to branch branch-a/);
    assert.equal(session(fx, 'branch-a').worktree, null, 'nothing written');
    const det = path.join(tmpRoot('binding-det-a-'), 'det');
    git(['worktree', 'add', '-q', '--detach', det, 'main'], fx.repo);
    const d = runFleet(['claim', '--id', 'branch-a', '--worktree', det, '--intent', 'a', '--paths', 'a.txt'], { cwd: fx.repo, env });
    assert.equal(d.status, 2, 'a detached worktree is not branch-a\'s either');
    // control: the worktree that HAS branch-a checked out fills it
    const wtA = path.join(tmpRoot('binding-wt-a-'), 'a');
    git(['worktree', 'add', '-q', wtA, 'branch-a'], fx.repo);
    assert.equal(runFleet(['claim', '--id', 'branch-a', '--worktree', wtA, '--intent', 'a', '--paths', 'a.txt'], { cwd: fx.repo, env }).status, 0);
    assert.ok(same(session(fx, 'branch-a').worktree, wtA));
  });
  it('a claim that ALREADY has its worktree is checked too: once that worktree holds another branch, --worktree refuses', () => {
    const fx = makeFleetRepo(REPO);
    const env = envOf();
    const wt = addWorktree(fx, 'keeps-wt');
    assert.equal(runFleet(['claim', '--intent', 'k', '--paths', 'k.txt'], { cwd: wt, env }).status, 0);
    const again = runFleet(['claim', '--id', 'keeps-wt', '--worktree', wt, '--intent', 'k2'], { cwd: fx.repo, env });
    assert.equal(again.status, 0, `control: same worktree, same branch: ${again.stderr}`);
    git(['checkout', '-q', '-b', 'switched-away'], wt);
    const r = runFleet(['claim', '--id', 'keeps-wt', '--worktree', wt, '--intent', 'k3'], { cwd: fx.repo, env });
    assert.equal(r.status, 2, r.stdout + r.stderr);
    assert.match(r.stderr, /has switched-away checked out, but keeps-wt is bound to branch keeps-wt/);
  });
  it('warnings describe the RETAINED binding: updating a claim from another directory does not warn about the cwd\'s branch', () => {
    const fx = makeFleetRepo(REPO);
    const env = envOf();
    const wt = addWorktree(fx, 'retained');
    assert.equal(runFleet(['claim', '--intent', 'r', '--paths', 'r.txt'], { cwd: wt, env }).status, 0);
    const upd = runFleet(['claim', '--id', 'retained', '--intent', 'updated from main'], { cwd: fx.repo, env });
    assert.equal(upd.status, 0, upd.stderr);
    assert.match(upd.stdout, /updated retained/);
    assert.doesNotMatch(upd.stdout, /is not its bound branch/, 'the record stays bound to retained');
    assert.equal(session(fx, 'retained').source.branch, 'retained');
  });
  it('an adopted session with no worktree is FILLED once by --worktree, never re-pointed', () => {
    const fx = makeFleetRepo(REPO);
    const env = envOf();
    const wt = addWorktree(fx, 'fill-me');
    commitFile(wt, 'f.txt', 'f\n');
    // adopted with no worktree recorded: simulate a pre-change record by clearing it
    assert.equal(runFleet(['add', 'fill-me'], { cwd: fx.repo, env }).status, 0);
    const dir = path.join(fleetDir(fx.repo), 'sessions');
    const file = fs.readdirSync(dir).map((n) => path.join(dir, n)).find((p) => JSON.parse(fs.readFileSync(p, 'utf8')).id === 'fill-me');
    const rec = JSON.parse(fs.readFileSync(file, 'utf8')); rec.worktree = null; fs.writeFileSync(file, JSON.stringify(rec, null, 2));
    assert.equal(runFleet(['claim', '--worktree', wt, '--intent', 'fill', '--paths', 'f.txt'], { cwd: fx.repo, env }).status, 0);
    assert.ok(same(session(fx, 'fill-me').worktree, wt), 'filled');
    const other = addWorktree(fx, 'elsewhere');
    git(['checkout', '-q', '--detach'], other); // free the branch name is not needed: same branch cannot be checked out twice
    const again = runFleet(['claim', '--worktree', other, '--id', 'fill-me', '--intent', 'fill', '--paths', 'f.txt'], { cwd: fx.repo, env });
    assert.equal(again.status, 2, again.stdout);
    assert.match(again.stderr, /already bound to/);
    assert.ok(same(session(fx, 'fill-me').worktree, wt), 'never re-pointed');
  });
});

describe('ready warns when the branch holds commits no remote ref holds (u)', () => {
  it('unpushed commits warn; once pushed, silent (control)', () => {
    const fx = makeFleetRepo(REPO);
    const env = envOf();
    const wt = addWorktree(fx, 'push-me');
    assert.equal(runFleet(['claim', '--intent', 'p', '--paths', 'p.txt'], { cwd: wt, env }).status, 0);
    commitFile(wt, 'p.txt', 'p\n');
    const r = runFleet(['ready'], { cwd: wt, env });
    assert.equal(r.status, 0, r.stdout);
    assert.match(r.stdout, /warning: 1 commit\(s\) on push-me are held by no remote ref — push your branch/);
    git(['push', '-q', 'origin', 'push-me'], wt);
    const pushed = runFleet(['ready'], { cwd: wt, env }).stdout;
    assert.doesNotMatch(pushed, /held by no remote ref/);
    assert.doesNotMatch(pushed, /could not check/, 'a measured 0 is silent');
  });
  it('a count that could not be taken is said, never read as "all pushed"; a measured count is not (control)', () => {
    const failing = () => ({ ok: false, stdout: '', reason: 'timed out' });
    assert.deepEqual(unpushedCount('.', 'b', { git: failing }), { ok: false, reason: 'git rev-list failed: timed out' });
    assert.deepEqual(unpushedCount('.', 'b', { git: () => ({ ok: true, stdout: 'garbage\n' }) }).ok, false);
    assert.deepEqual(unpushedCount('.', 'b', { git: () => ({ ok: true, stdout: '0\n' }) }), { ok: true, count: 0 });
  });
});
