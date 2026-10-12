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
import { hooksPathDependents, hooksPathRefusals, isWithin, realpathLenient } from '../scripts/lib/fleet/hooks-path-guard.mjs';
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
    assert.match(v.dependents[0].remedy, /^git -C .*B.* config --worktree core\.hooksPath .*\.githooks$/);
    t.pointB(path.join(t.A, '.githooks'));
    assert.equal(t.verdict().dependents.length, 1, 'an absolute path into A is the same dependency');
    t.pointB(t.A);
    assert.equal(t.verdict().dependents.length, 1, 'hooksPath = A itself counts');
    t.repointB();
    v = t.verdict();
    assert.deepEqual([v.ok, v.dependents, v.unreadable], [true, [], []], 'control: re-pointed at the main checkout, removing A is safe');
    assert.equal(t.verdict(t.B).ok, true, 'and B\'s own hooksPath never blocks removing B');
  });

  it('a dangling hooksPath into A (the directory not created yet) is still a dependency', () => {
    const t = twoWorktrees();
    t.pointB(path.join(t.A, 'not-yet', 'hooks'));
    assert.equal(t.verdict().dependents.length, 1);
  });

  it('an inherited repo-level value into A makes EVERY other worktree a dependent, and the remedy is --local on the main checkout', () => {
    const t = twoWorktrees();
    git(['config', '--local', 'core.hooksPath', path.join(t.A, '.githooks')], t.fx.repo);
    const v = t.verdict();
    assert.deepEqual(v.dependents.map((d) => d.scope), ['local', 'local'], 'the main checkout and B both inherit it');
    const refusals = hooksPathRefusals(v, t.A);
    assert.equal(refusals.filter((l) => l.startsWith('re-point first:')).length, 1);
    assert.match(refusals.find((l) => l.startsWith('re-point first:')), /config --local core\.hooksPath/);
    assert.ok(!/ {2}· {2}/.test(refusals.find((l) => l.startsWith('re-point first:'))), 'one shared remedy, not one per worktree');
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

  it('isWithin / realpathLenient: a sibling sharing a name prefix is not inside', () => {
    const root = tmpRoot('hooks-paths-');
    fs.mkdirSync(path.join(root, 'A')); fs.mkdirSync(path.join(root, 'AB'));
    const real = (p) => realpathLenient(p).path;
    assert.equal(isWithin(real(path.join(root, 'AB', 'h')), real(path.join(root, 'A'))), false);
    assert.equal(isWithin(real(path.join(root, 'A', 'x', 'y')), real(path.join(root, 'A'))), true);
    assert.equal(isWithin(real(path.join(root, 'A')), real(path.join(root, 'A'))), true);
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
