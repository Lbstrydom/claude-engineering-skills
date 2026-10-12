/**
 * @fileoverview The hooks-path guard on `fleet archive` and `fleet prune --apply` (incident 2026-10-12: three
 * worktrees' `core.hooksPath` pointed into a worktree that was then removed, so git silently ran no pre-push hook
 * and a PR was pushed ungated).
 *
 * Every refusal is a red-then-green pair on a real two-worktree fixture: B's hooksPath points into A, so removing A
 * must refuse; with B re-pointed at the main checkout, the same removal proceeds. A config git cannot read refuses.
 */
import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { git } from './helpers/git.mjs';
import { addBranch, cleanupFleetRoots, installFakeGh, makeFleetRepo, runFleet, scrubbedEnv, tmpRoot } from './helpers/fleet-repo.mjs';
import { hooksLocation, hooksPathDependents, hooksPathRefusals, isWithin, realpathLenient, remedyFor, traversedEntries } from '../scripts/lib/fleet/hooks-path-guard.mjs';
import { applyArchive, planArchive } from '../scripts/lib/fleet/archive.mjs';
import { applyPrune } from '../scripts/lib/fleet/prune.mjs';
import { resolveArchiveTarget } from '../scripts/lib/fleet/lifecycle.mjs';
import { listWorktrees, runGit } from '../scripts/lib/fleet/git-facts.mjs';
import { fleetDir } from '../scripts/lib/fleet/registry.mjs';

after(cleanupFleetRoots);

const IGNORE = ['node_modules/**', '.claude/**'];
const FUTURE = () => new Date(Date.now() + 10 * 86_400_000); // past the fresh window for worktrees made seconds ago

/** A fleet repo with two linked worktrees A and B (each on its own branch at main) and per-worktree config on. */
function twoWorktrees() {
  const fx = makeFleetRepo({ fleetConfig: { archiveIgnore: IGNORE } });
  const root = tmpRoot('hooks-wt-');
  const A = path.join(root, 'A'); const B = path.join(root, 'B');
  git(['worktree', 'add', '-q', '-b', 'wt-a', A, 'main'], fx.repo);
  git(['worktree', 'add', '-q', '-b', 'wt-b', B, 'main'], fx.repo);
  git(['config', 'extensions.worktreeConfig', 'true'], fx.repo);
  fs.mkdirSync(path.join(A, '.githooks'), { recursive: true });
  fs.mkdirSync(path.join(fx.repo, '.githooks'), { recursive: true });
  const ctx = { cwd: fx.repo, dir: fleetDir(fx.repo), env: scrubbedEnv({ FLEET_TELEMETRY: 'off' }), now: FUTURE(), config: { baseBranch: 'main', archiveIgnore: IGNORE, staleWorktreeDays: 3 }, cmd: 'fleet' };
  const pointB = (value) => git(['-C', B, 'config', '--worktree', 'core.hooksPath', value], fx.repo);
  const repointB = () => pointB(path.join(fx.repo, '.githooks'));
  const corruptB = () => fs.writeFileSync(path.join(git(['-C', B, 'rev-parse', '--absolute-git-dir'], fx.repo), 'config.worktree'), '[core\n');
  const verdict = (target = A) => hooksPathDependents(target, listWorktrees(fx.repo).worktrees);
  return { fx, A, B, ctx, pointB, repointB, corruptB, verdict };
}

describe('hooksPathDependents', () => {
  it('B\'s worktree-scope hooksPath inside A (relative or absolute) makes B a dependent of A; re-pointed, none (red then green)', () => {
    const t = twoWorktrees();
    t.pointB('../A/.githooks'); // relative: git resolves it against B's top level, where it runs hooks
    let v = t.verdict();
    assert.equal(v.ok, false);
    assert.deepEqual(v.dependents.map((d) => [path.basename(d.worktree), d.scope, d.value]), [['B', 'worktree', '../A/.githooks']]);
    assert.match(v.dependents[0].remedy, /^git -C .*B.* config --worktree core\.hooksPath /);
    // The re-point target is the main checkout's OWN hooks directory (here git's default: nothing configured), not a guess.
    const mainHooks = path.join(fs.realpathSync.native(path.join(t.fx.repo, '.git')), 'hooks');
    assert.ok(v.dependents[0].remedy.replace(/'/g, '').includes(`core.hooksPath ${mainHooks}  # the hooks directory the main checkout itself uses`), v.dependents[0].remedy);
    t.pointB(path.join(t.A, '.githooks'));
    assert.equal(t.verdict().dependents.length, 1, 'an absolute path into A is the same dependency');
    t.pointB(t.A);
    assert.equal(t.verdict().dependents.length, 1, 'hooksPath = A itself counts');
    t.repointB();
    v = t.verdict();
    assert.deepEqual([v.ok, v.dependents, v.unreadable], [true, [], []], 'control: re-pointed at the main checkout, removing A is safe');
    assert.equal(t.verdict(t.B).ok, true, 'and B\'s own hooksPath never blocks removing B');
  });

  it('the remedy target is where the main checkout\'s hooks RESOLVE (a trailing .. included), and only when that exists', () => {
    const t = twoWorktrees();
    t.pointB('../A/.githooks');
    fs.mkdirSync(path.join(t.fx.repo, '.githooks', 'sub'), { recursive: true });
    git(['config', '--worktree', 'core.hooksPath', path.join(t.fx.repo, '.githooks', 'sub', '..')], t.fx.repo);
    const expected = fs.realpathSync.native(path.join(t.fx.repo, '.githooks'));
    const remedy = t.verdict().dependents[0].remedy.replace(/'/g, '');
    assert.ok(remedy.includes(`core.hooksPath ${expected}  #`), remedy);
    // a main hooks directory that does not exist is no target: nothing would run there either
    git(['config', '--worktree', 'core.hooksPath', path.join(t.fx.repo, 'no-such-hooks')], t.fx.repo);
    assert.match(t.verdict().dependents[0].remedy, /move or re-install/);
    // nor is one that resolves to a FILE
    fs.writeFileSync(path.join(t.fx.repo, 'hooks-file'), 'not a directory\n');
    git(['config', '--worktree', 'core.hooksPath', path.join(t.fx.repo, 'hooks-file')], t.fx.repo);
    assert.match(t.verdict().dependents[0].remedy, /move or re-install/);
  });

  it('a hooks directory OUTSIDE A whose individual hook is a link into A is a dependency; an unreadable hooks directory refuses', () => {
    const t = twoWorktrees();
    const shared = path.join(tmpRoot('hooks-shared-'), 'hooks');
    fs.mkdirSync(shared, { recursive: true });
    fs.mkdirSync(path.join(t.A, '.githooks', 'pre-push'), { recursive: true });
    t.pointB(shared);
    assert.equal(t.verdict().ok, true, 'control: a plain shared hooks directory does not depend on A');
    // A directory junction stands in for a hook link: a file symlink needs privilege on win32, and the walk treats both alike.
    fs.symlinkSync(path.join(t.A, '.githooks', 'pre-push'), path.join(shared, 'pre-push'), 'junction');
    const v = t.verdict();
    assert.equal(v.dependents.length, 1, JSON.stringify(v));
    assert.match(v.dependents[0].via, /pre-push$/);
    const eacces = Object.assign(new Error('denied'), { code: 'EACCES' });
    const blind = hooksPathDependents(t.A, listWorktrees(t.fx.repo).worktrees, { readdir: () => { throw eacces; } });
    assert.ok(blind.unreadable.some((u) => /cannot be walked \(EACCES\)/.test(u.reason)), JSON.stringify(blind));
  });

  it('a dangling hooksPath into A (the directory not created yet) is still a dependency', () => {
    const t = twoWorktrees();
    t.pointB(path.join(t.A, 'not-yet', 'hooks'));
    assert.equal(t.verdict().dependents.length, 1);
  });

  it('an inherited repo-level value into A makes EVERY other worktree a dependent, and no directory is guessed as the remedy', () => {
    const t = twoWorktrees();
    git(['config', '--local', 'core.hooksPath', path.join(t.A, '.githooks')], t.fx.repo);
    const v = t.verdict();
    assert.deepEqual(v.dependents.map((d) => d.scope), ['local', 'local'], 'the main checkout and B both inherit it');
    const refusals = hooksPathRefusals(v, t.A);
    assert.equal(refusals.filter((l) => l.startsWith('re-point first:')).length, 1);
    const line = refusals.find((l) => l.startsWith('re-point first:'));
    assert.match(line, /move or re-install/, 'the main checkout depends too, so there is no known-good directory to point at');
    assert.ok(!line.includes('config --local core.hooksPath'), 'and no guessed command is printed');
    assert.ok(!/ {2}· {2}/.test(line), 'one shared remedy, not one per worktree');
    // control: B's own worktree value overrides the inherited one, but the main checkout still depends
    t.repointB();
    assert.deepEqual(t.verdict().dependents.map((d) => path.basename(d.worktree)), [path.basename(t.fx.repo)]);
  });

  it('fails CLOSED when a worktree\'s config cannot be read', () => {
    const t = twoWorktrees();
    t.corruptB();
    const v = t.verdict();
    assert.equal(v.ok, false);
    assert.equal(v.dependents.length, 0);
    assert.equal(v.unreadable.length, 1);
    assert.match(v.unreadable[0].reason, /could not be read/);
    assert.match(hooksPathRefusals(v, t.A)[0], /cannot rule out a hooks dependency/);
  });

  it('a worktree whose directory is gone is skipped (no hook can run there); one that only errors is not', () => {
    const t = twoWorktrees();
    t.pointB('../A/.githooks');
    const wts = listWorktrees(t.fx.repo).worktrees.map((w) => (path.basename(w.path) === 'B' ? { ...w, missing: true } : w));
    assert.equal(hooksPathDependents(t.A, wts).ok, true);
    const erroring = (args, cwd, o) => (path.basename(cwd) === 'B' ? { ok: false, status: null, stdout: '', stderr: '', reason: 'git config timed out' } : runGit(args, cwd, o));
    assert.equal(hooksPathDependents(t.A, listWorktrees(t.fx.repo).worktrees, { git: erroring }).unreadable.length, 1);
  });

  it('isWithin compares path COMPONENTS: a name-prefix sibling is outside, a child named ..hooks is inside, the parent is outside', () => {
    const root = tmpRoot('hooks-paths-');
    fs.mkdirSync(path.join(root, 'A')); fs.mkdirSync(path.join(root, 'AB'));
    const real = (p) => realpathLenient(p).path;
    const A = real(path.join(root, 'A'));
    assert.equal(isWithin(real(path.join(root, 'AB', 'h')), A), false);
    assert.equal(isWithin(real(path.join(root, 'A', 'x', 'y')), A), true);
    assert.equal(isWithin(A, A), true);
    assert.equal(isWithin(path.join(A, '..hooks'), A), true, 'a child whose name starts with two dots is inside');
    assert.equal(isWithin(path.join(A, '..hooks', 'pre-push'), A), true);
    assert.equal(isWithin(path.dirname(A), A), false, 'the parent is outside');
  });

  it('a hooks path that passes THROUGH a link inside A to a directory outside it is a dependency; the target reached directly is not', () => {
    const t = twoWorktrees();
    const shared = path.join(tmpRoot('hooks-shared-'), 'hooks');
    fs.mkdirSync(shared, { recursive: true });
    fs.symlinkSync(shared, path.join(t.A, 'linked-hooks'), 'junction'); // a junction on win32 (no privilege needed), a symlink elsewhere
    t.pointB(path.join(t.A, 'linked-hooks'));
    const v = t.verdict();
    assert.equal(v.dependents.length, 1, JSON.stringify(v));
    assert.match(v.dependents[0].via, /linked-hooks$/);
    t.pointB(shared);
    assert.equal(t.verdict().ok, true, 'control: pointing at the shared directory itself does not depend on A');
  });

  it('traversedEntries: POSIX resolves .. AFTER the symlink before it; win32 collapses it lexically first', () => {
    // /w/B/link -> /w/A/sub. On POSIX /w/B/link/../hooks is /w/A/hooks; the Win32 API makes the same string /w/B/hooks.
    const key = (p) => p.replace(/\\/g, '/').replace(/^[A-Za-z]:/, '');
    const fakeFs = (links) => ({ lstat: (p) => ({ isSymbolicLink: () => Object.hasOwn(links, key(p)) }), readlink: (p) => links[key(p)] });
    const posix = traversedEntries('/w/B/link/../hooks', { ...fakeFs({ '/w/B/link': '/w/A/sub' }), platform: 'linux' });
    assert.deepEqual(posix, { entries: ['/w', '/w/B', '/w/B/link', '/w', '/w/A', '/w/A/sub', '/w/A/hooks'], resolved: '/w/A/hooks' });
    const win = traversedEntries('C:\\w\\B\\link\\..\\hooks', { ...fakeFs({ '/w/B/link': 'C:\\w\\A\\sub' }), platform: 'win32' });
    assert.deepEqual(win, { entries: ['C:\\w', 'C:\\w\\B', 'C:\\w\\B\\hooks'], resolved: 'C:\\w\\B\\hooks' });
    // a relative link target resolves against the link's directory; past a missing entry the rest is joined lexically
    const enoent = Object.assign(new Error('absent'), { code: 'ENOENT' });
    const rel = traversedEntries('/w/B/l2/x', { lstat: (p) => { if (p === '/w/A/gone') throw enoent; return { isSymbolicLink: () => p === '/w/B/l2' }; }, readlink: () => '../A/gone', platform: 'linux' });
    assert.deepEqual(rel.entries, ['/w', '/w/B', '/w/B/l2', '/w', '/w/B', '/w/A', '/w/A/gone', '/w/A/gone/x'], 'the target /w/B/../A/gone is walked from the root again');
    assert.equal(rel.resolved, '/w/A/gone/x');
    // a trailing .. ends one level ABOVE the last entry walked, so the endpoint is returned separately from the walk
    const trailing = traversedEntries('/w/h/sub/..', { lstat: () => ({ isSymbolicLink: () => false }), platform: 'linux' });
    assert.deepEqual([trailing.entries.at(-1), trailing.resolved], ['/w/h/sub', '/w/h']);
    assert.throws(() => traversedEntries('/loop', { lstat: () => ({ isSymbolicLink: () => true }), readlink: () => '/loop', platform: 'linux' }), /symlinks/);
    const eacces = Object.assign(new Error('denied'), { code: 'EACCES' });
    assert.throws(() => traversedEntries('/w/x', { lstat: () => { throw eacces; }, platform: 'linux' }), /denied/, 'only absence is tolerated');
  });

  it('hooksLocation asks git: an unset value is the default hooks directory (scope default), not skipped', () => {
    const t = twoWorktrees();
    const loc = hooksLocation(t.B);
    assert.equal(loc.ok, true, loc.reason);
    assert.equal(loc.scope, 'default');
    assert.equal(path.basename(loc.resolved), 'hooks');
    assert.equal(path.basename(path.dirname(loc.resolved)), '.git', 'the common dir, shared by every worktree');
  });

  it('remedyFor never rewrites configuration shared with other repositories', () => {
    for (const scope of ['global', 'system']) {
      const r = remedyFor({ worktree: '/w/B', scope }, '/w/main', '/w/main/.githooks');
      assert.ok(r.startsWith('git -C /w/main config --local core.hooksPath /w/main/.githooks '), r);
      assert.ok(!r.includes(`config --${scope}`), r);
    }
    assert.ok(remedyFor({ worktree: '/w/B', scope: 'worktree' }, '/w/main', '/t').startsWith('git -C /w/B config --worktree core.hooksPath /t  # '));
    assert.match(remedyFor({ worktree: '/w/B', scope: 'local' }, '/w/main', null), /^move or re-install/, 'no target, no command');
  });
});

describe('fleet archive — hooks-path guard', () => {
  it('refuses archiving A while B runs hooks from inside it (dry run and --apply alike); re-pointed, it archives (red then green)', () => {
    const t = twoWorktrees();
    t.pointB('../A/.githooks');
    const plan = () => planArchive(t.ctx, resolveArchiveTarget(t.ctx, t.A));
    const red = plan();
    const slashed = (p) => p.replace(/\\/g, '/');
    assert.ok(red.refusals.some((r) => /runs its git hooks from inside/.test(r) && slashed(r).includes(slashed(t.B))), red.refusals.join('\n'));
    assert.ok(red.refusals.some((r) => /re-point first: git -C .* config --worktree core\.hooksPath/.test(r)));
    const cli = runFleet(['archive', t.A, '--apply', '--json'], { cwd: t.fx.repo, env: scrubbedEnv({ FLEET_TELEMETRY: 'off', FLEET_NOW: FUTURE().toISOString() }) });
    assert.notEqual(cli.status, 0, '--apply refuses');
    assert.match(cli.json.reason, /runs its git hooks from inside/);
    assert.ok(fs.existsSync(t.A), 'A is kept');
    t.repointB();
    const green = plan();
    assert.deepEqual(green.refusals, []);
    const r = applyArchive(t.ctx, green);
    assert.equal(r.status, 'archived', r.reason);
    assert.equal(fs.existsSync(t.A), false);
  });

  it('a hooksPath pointed into A AFTER the plan aborts the removal under the lock; the worktree and tag are kept', () => {
    const t = twoWorktrees();
    const p = planArchive(t.ctx, resolveArchiveTarget(t.ctx, t.A));
    assert.deepEqual(p.refusals, []);
    let done = false;
    const raceAfterTag = (args, cwd, o) => { const r = runGit(args, cwd, o); if (!done && args.includes('tag')) { done = true; t.pointB('../A/.githooks'); } return r; };
    const r = applyArchive(t.ctx, p, { git: raceAfterTag });
    assert.equal(r.status, 'aborted');
    assert.match(r.reason, /runs its git hooks from inside/);
    assert.ok(fs.existsSync(t.A));
  });

  it('refuses when another worktree\'s config cannot be read (fail closed)', () => {
    const t = twoWorktrees();
    t.corruptB();
    const p = planArchive(t.ctx, resolveArchiveTarget(t.ctx, t.A));
    assert.ok(p.refusals.some((r) => /cannot rule out a hooks dependency/.test(r)), p.refusals.join('\n'));
  });
});

describe('fleet prune — hooks-path guard', () => {
  const pruneEnv = (fx) => {
    const fake = installFakeGh(fx.root);
    return scrubbedEnv({ FLEET_WORKTREE_ROOT: fx.wtRoot, FLEET_TELEMETRY: 'off', FLEET_NOW: FUTURE().toISOString(), ...fake.env }, { prependPath: [fake.bin] });
  };

  it('the dry run keeps a merged worktree another worktree runs hooks from, and says how to fix it; re-pointed, it is a candidate (red then green)', () => {
    const t = twoWorktrees();
    addBranch(t.fx.repo, 'wt-b-work', { 'b-only.txt': 'b\n' }); // B's branch has work, so only A (ahead 0) is a merged candidate
    git(['-C', t.B, 'switch', '-q', 'wt-b-work'], t.fx.repo);
    git(['branch', '-D', 'wt-b'], t.fx.repo);
    t.pointB('../A/.githooks');
    const env = pruneEnv(t.fx);
    const red = runFleet(['prune', '--json'], { cwd: t.fx.repo, env });
    assert.equal(red.status, 0, red.stderr);
    assert.ok(!red.json.prune.candidates.some((c) => c.branch === 'wt-a'));
    const kept = red.json.prune.excluded.find((e) => e.branch === 'wt-a');
    assert.ok(kept, JSON.stringify(red.json.prune.excluded));
    assert.match(kept.reason, /runs its git hooks from inside/);
    assert.match(kept.reason, /config --worktree core\.hooksPath/);
    const redApply = runFleet(['prune', '--apply', '--json'], { cwd: t.fx.repo, env });
    assert.ok(fs.existsSync(t.A), `--apply removes nothing it excluded: ${redApply.stdout}`);
    t.repointB();
    const green = runFleet(['prune', '--apply', '--json'], { cwd: t.fx.repo, env });
    assert.equal(green.status, 0, green.stdout);
    assert.ok(green.json.applied.results.some((x) => x.branch === 'wt-a' && x.status === 'removed'), green.stdout);
    assert.equal(fs.existsSync(t.A), false);
  });

  describe('re-checked under the lock (a hand-built plan, the world moved since)', () => {
    const cand = (t) => ({
      branch: 'wt-a', worktree: t.A, oid: git(['rev-parse', 'wt-a'], t.fx.repo), remoteStep: null,
      steps: [{ kind: 'worktree', argv: ['git', 'worktree', 'remove', t.A] }, { kind: 'branch', argv: ['git', 'update-ref', '-d', 'refs/heads/wt-a', git(['rev-parse', 'wt-a'], t.fx.repo)] }],
    });
    const clean = () => ({ risks: { staged: [], unstaged: [], untracked: [], ignored: [], unpushed: [] }, unverified: [] });
    const apply = (t) => applyPrune({ cwd: t.fx.repo, dir: fleetDir(t.fx.repo) }, { candidates: [cand(t)], excluded: [], notJudged: [] }, { report: clean });

    it('a hooksPath pointed into the worktree since the plan skips it; re-pointed, the same plan removes it', () => {
      const t = twoWorktrees();
      t.pointB('../A/.githooks');
      const red = apply(t).results[0];
      assert.equal(red.status, 'skipped');
      assert.match(red.reason, /runs its git hooks from inside/);
      assert.ok(fs.existsSync(t.A));
      t.repointB();
      assert.equal(apply(t).results[0].status, 'removed');
      assert.equal(fs.existsSync(t.A), false);
    });

    it('an unreadable config skips it (fail closed)', () => {
      const t = twoWorktrees();
      t.corruptB();
      const r = apply(t).results[0];
      assert.equal(r.status, 'skipped');
      assert.match(r.reason, /cannot rule out a hooks dependency/);
      assert.ok(fs.existsSync(t.A));
    });
  });
});
