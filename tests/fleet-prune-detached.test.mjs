/**
 * @fileoverview `fleet prune` for worktrees no branch names (docs/plans/fleet-hygiene.md §1.1): a detached worktree is removable only
 * when it is clean AND every commit its registration alone can reach is held by a remote-tracking ref; a registration whose
 * directory is gone is only ever LISTED. Each "kept" has a control that goes the other way.
 */
import { after, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { git } from './helpers/git.mjs';
import { cleanupFleetRoots, commitFile, installFakeGh, makeFleetRepo, runFleet, scrubbedEnv } from './helpers/fleet-repo.mjs';
import { fleetDir } from '../scripts/lib/fleet/registry.mjs';
import { listWorktrees } from '../scripts/lib/fleet/git-facts.mjs';
import { applyDetached, planDetached, registrationHistory, renderDetached } from '../scripts/lib/fleet/prune-detached.mjs';

after(cleanupFleetRoots);

const DAY = 86_400_000;
const CFG = { archiveIgnore: ['node_modules/**', '.claude/**'], staleWorktreeDays: 3 };

/** A repo whose main (and a .gitignore) is pushed, plus helpers to make detached worktrees at a given commit. */
function world() {
  const fx = makeFleetRepo();
  fs.writeFileSync(path.join(fx.repo, '.gitignore'), '*.log\n');
  git(['add', '.gitignore'], fx.repo); git(['commit', '-q', '-m', 'ignore logs'], fx.repo); git(['push', '-q', 'origin', 'main'], fx.repo);
  const pushed = git(['rev-parse', 'HEAD'], fx.repo);
  const add = (name, at = pushed) => { const dir = path.join(fx.root, name); git(['worktree', 'add', '-q', '--detach', dir, at], fx.repo); return dir; };
  const ctx = { cwd: fx.repo, dir: fleetDir(fx.repo), config: CFG, env: scrubbedEnv({ FLEET_TELEMETRY: 'off' }), cmd: 'fleet' };
  const plan = ({ now = Date.now() } = {}) => {
    const wt = listWorktrees(fx.repo);
    return planDetached(ctx, { worktrees: wt.worktrees, mainCheckout: fx.repo, here: { ok: false }, staleMs: 3 * DAY, nowMs: now, past: () => false, deadlineAt: null, clock: Date.now });
  };
  const kept = (d, dir) => d.excluded.find((e) => path.resolve(e.path) === path.resolve(dir))?.reason;
  const cand = (d, dir) => d.candidates.find((c) => path.resolve(c.path) === path.resolve(dir));
  const stale = (d, dir) => d.stale.find((c) => path.resolve(c.path) === path.resolve(dir));
  const adminOf = (dir) => path.resolve(fx.repo, git(['rev-parse', '--git-dir'], dir));
  return { fx, ctx, pushed, add, plan, kept, cand, stale, adminOf };
}

describe('detached worktrees: removable only with nothing lost', () => {
  test('a clean detached worktree on a pushed commit is a candidate (control); each way of losing something keeps it, with the reason', () => {
    const w = world();
    const clean = w.add('wt-clean');
    const unpushed = w.add('wt-unpushed');
    commitFile(unpushed, 'u.txt', 'u\n', 'only here');
    const dirty = w.add('wt-dirty');
    fs.writeFileSync(path.join(dirty, 'notes.txt'), 'x\n');
    const ignored = w.add('wt-ignored');
    fs.writeFileSync(path.join(ignored, 'keep.log'), 'only copy\n');
    const locked = w.add('wt-locked');
    git(['worktree', 'lock', locked], w.fx.repo);
    const d = w.plan();
    assert.ok(w.cand(d, clean), 'control: nothing to lose');
    assert.deepEqual(w.cand(d, clean).steps[0].argv.slice(0, 3), ['git', 'worktree', 'remove']);
    assert.equal(path.resolve(w.cand(d, clean).steps[0].argv[3]), path.resolve(clean));
    assert.match(w.kept(d, unpushed), /1 unpushed/);
    assert.match(w.kept(d, dirty), /untracked/);
    assert.match(w.kept(d, ignored), /ignored/);
    assert.match(w.kept(d, locked), /locked/);
    for (const x of [unpushed, dirty, ignored, locked]) assert.equal(w.cand(d, x), undefined, x);
  });

  test('a pre-push sandbox is kept for its own sweep, never raced (control: the same tree under another name is a candidate)', () => {
    const w = world();
    const sandbox = w.add('ces-prepush-0123abcd-4242');
    const ordinary = w.add('plain-name');
    const d = w.plan();
    assert.match(w.kept(d, sandbox), /pre-push sandbox/);
    assert.ok(w.cand(d, ordinary));
  });

  test('a commit the registration alone holds in its reflog keeps it: HEAD pushed but an old reflog id unpushed (control: both pushed)', () => {
    const w = world();
    const moved = w.add('wt-moved');
    const lost = commitFile(moved, 'u.txt', 'u\n', 'unpushed, then abandoned');
    git(['checkout', '-q', '--detach', w.pushed], moved); // HEAD is pushed again; the reflog still names the unpushed commit as an OLD id
    assert.notEqual(git(['rev-parse', 'HEAD'], moved), lost);
    const control = w.add('wt-both-pushed');
    git(['checkout', '-q', '--detach', w.pushed], control);
    const d = w.plan();
    assert.match(w.kept(d, moved), /1 commit\(s\) reachable only through this registration/);
    assert.ok(w.cand(d, control));
  });

  test('the same holds when the reflog has EXPIRED: an unpushed listed HEAD with an empty reflog is kept (control: pushed HEAD, empty reflog)', () => {
    const w = world();
    const a = w.add('wt-empty-log-unpushed');
    commitFile(a, 'u.txt', 'u\n', 'unpushed');
    fs.writeFileSync(path.join(w.adminOf(a), 'logs', 'HEAD'), '');
    const b = w.add('wt-empty-log-pushed');
    fs.writeFileSync(path.join(w.adminOf(b), 'logs', 'HEAD'), '');
    const d = w.plan();
    assert.ok(w.kept(d, a), 'kept');
    assert.equal(w.cand(d, a), undefined);
    assert.ok(w.cand(d, b), 'control');
  });

  test('a per-worktree ref, or an unreadable reflog, keeps it (control: neither)', () => {
    const w = world();
    const bisect = w.add('wt-bisect');
    fs.mkdirSync(path.join(w.adminOf(bisect), 'refs', 'bisect'), { recursive: true });
    fs.writeFileSync(path.join(w.adminOf(bisect), 'refs', 'bisect', 'bad'), `${w.pushed}\n`);
    const garbled = w.add('wt-garbled-log');
    fs.writeFileSync(path.join(w.adminOf(garbled), 'logs', 'HEAD'), 'not a reflog line\n');
    const fine = w.add('wt-fine');
    const d = w.plan();
    assert.match(w.kept(d, bisect), /per-worktree ref/);
    assert.match(w.kept(d, garbled), /malformed/);
    assert.ok(w.cand(d, fine));
  });

  test('paths with a space and a quote are data: the displayed command is quoted and the removal runs as argv', () => {
    const w = world();
    const odd = w.add("sp ace's wt");
    const d = w.plan({ now: Date.now() + 30 * DAY });
    const c = w.cand(d, odd);
    assert.ok(c);
    assert.equal(c.fresh, false, 'a month on, nothing recent');
    assert.ok(/'/.test(c.commands[0]) && c.commands[0].includes('sp ace'), c.commands[0]);
    const a = applyDetached(w.ctx, d, { list: listWorktrees, staleMs: 3 * DAY, clock: () => Date.now() + 30 * DAY });
    assert.equal(a.results[0].status, 'removed', JSON.stringify(a));
    assert.equal(fs.existsSync(odd), false);
  });
});

describe('stale registrations (directory gone): listed only', () => {
  test('a registration whose history is held remotely is LISTED with the manual command; one holding an unpushed commit is kept; none is touched', () => {
    const w = world();
    const gone = w.add('wt-gone');
    const goneUnpushed = w.add('wt-gone-unpushed');
    commitFile(goneUnpushed, 'u.txt', 'u\n', 'only in this registration');
    fs.rmSync(gone, { recursive: true, force: true });
    fs.rmSync(goneUnpushed, { recursive: true, force: true });
    const d = w.plan();
    assert.ok(w.stale(d, gone), 'listed');
    assert.equal(w.stale(d, goneUnpushed), undefined);
    assert.match(w.kept(d, goneUnpushed), /reachable only through this registration/);
    const text = renderDetached(d).join('\n');
    assert.match(text, /git worktree prune/);
    assert.match(text, /repository-wide/);
    // --apply never runs `git worktree prune`: both registrations are still there afterwards.
    const a = applyDetached(w.ctx, d, { list: listWorktrees, staleMs: 3 * DAY });
    assert.deepEqual(a.results, []);
    const listed = listWorktrees(w.fx.repo).worktrees.map((x) => path.resolve(x.path));
    assert.ok(listed.includes(path.resolve(gone)) && listed.includes(path.resolve(goneUnpushed)));
  });
});

describe('stale registration, reflog expired: the listed HEAD is the whole evidence', () => {
  test('directory gone + empty reflog + unpushed HEAD → kept; same with a pushed HEAD → listed (control)', () => {
    const w = world();
    const unpushed = w.add('wt-gone-empty-unpushed');
    commitFile(unpushed, 'u.txt', 'u\n', 'unpushed');
    const admin1 = w.adminOf(unpushed);
    const pushed = w.add('wt-gone-empty-pushed');
    const admin2 = w.adminOf(pushed);
    fs.writeFileSync(path.join(admin1, 'logs', 'HEAD'), '');
    fs.writeFileSync(path.join(admin2, 'logs', 'HEAD'), '');
    fs.rmSync(unpushed, { recursive: true, force: true });
    fs.rmSync(pushed, { recursive: true, force: true });
    const d = w.plan();
    assert.equal(w.stale(d, unpushed), undefined);
    assert.match(w.kept(d, unpushed), /reachable only through this registration/);
    assert.ok(w.stale(d, pushed), 'control');
  });
});

describe('apply re-checks everything at apply time', () => {
  const past = 30 * DAY;
  const planAndApply = (w, mutate, opts = {}) => {
    const d = w.plan({ now: Date.now() + past });
    mutate?.(d);
    return applyDetached(w.ctx, d, { list: listWorktrees, staleMs: 3 * DAY, clock: () => Date.now() + past, ...opts });
  };

  test('unchanged state removes it (control)', () => {
    const w = world();
    const dir = w.add('wt-a');
    const a = planAndApply(w);
    assert.equal(a.counts.removed, 1, JSON.stringify(a));
    assert.equal(fs.existsSync(dir), false);
  });
  test('HEAD moved after planning → skipped', () => {
    const w = world();
    const dir = w.add('wt-a');
    const d = w.plan({ now: Date.now() + past });
    commitFile(dir, 'late.txt', 'l\n', 'after the plan');
    git(['push', '-q', 'origin', 'HEAD:refs/heads/rescue'], dir);
    const a = applyDetached(w.ctx, d, { list: listWorktrees, staleMs: 3 * DAY, clock: () => Date.now() + past });
    assert.match(a.results[0].reason, /HEAD moved/);
    assert.equal(fs.existsSync(dir), true);
  });
  test('an untracked or an ignored file created after planning → skipped', () => {
    for (const [name, file] of [['wt-untracked', 'n.txt'], ['wt-ignored', 'k.log']]) {
      const w = world();
      const dir = w.add(name);
      const d = w.plan({ now: Date.now() + past });
      fs.writeFileSync(path.join(dir, file), 'late\n');
      const a = applyDetached(w.ctx, d, { list: listWorktrees, staleMs: 3 * DAY, clock: () => Date.now() + past });
      assert.match(a.results[0].reason, /changed since it was judged/, name);
      assert.equal(fs.existsSync(dir), true);
    }
  });
  test('an unpushed commit appearing in the reflog after planning (HEAD unchanged) → skipped', () => {
    const w = world();
    const dir = w.add('wt-a');
    const d = w.plan({ now: Date.now() + past });
    commitFile(dir, 'late.txt', 'l\n', 'unpushed after the plan');
    git(['checkout', '-q', '--detach', w.pushed], dir);
    const a = applyDetached(w.ctx, d, { list: listWorktrees, staleMs: 3 * DAY, clock: () => Date.now() + past });
    assert.match(a.results[0].reason, /registration changed since it was judged/);
    assert.equal(fs.existsSync(dir), true);
  });
  test('a registered session on the worktree after planning → skipped; locked after planning → skipped', () => {
    const w = world();
    const dir = w.add('wt-a');
    const d = w.plan({ now: Date.now() + past });
    git(['worktree', 'lock', dir], w.fx.repo);
    assert.match(applyDetached(w.ctx, d, { list: listWorktrees, staleMs: 3 * DAY, clock: () => Date.now() + past }).results[0].reason, /locked/);
  });

  test('freshness, both flag settings: fresh-in-plan is skipped without --include-fresh and removed with it; activity AFTER the plan is skipped even with it', () => {
    const w = world();
    const shown = w.add('wt-fresh-shown');
    const d1 = w.plan(); // now: everything just created is fresh
    assert.equal(w.cand(d1, shown).fresh, true);
    assert.match(applyDetached(w.ctx, d1, { list: listWorktrees, staleMs: 3 * DAY }).results[0].reason, /fresh.*--include-fresh/);
    assert.equal(applyDetached(w.ctx, d1, { includeFresh: true, list: listWorktrees, staleMs: 3 * DAY }).counts.removed, 1);

    const w2 = world();
    const later = w2.add('wt-activity-after');
    const d2 = w2.plan({ now: Date.now() + past }); // idle at plan time
    assert.equal(w2.cand(d2, later).fresh, false);
    const apply = (includeFresh) => applyDetached(w2.ctx, d2, { includeFresh, list: listWorktrees, staleMs: 3 * DAY }); // apply-time clock is real: recent activity
    for (const flag of [false, true]) {
      const r = apply(flag).results[0];
      assert.match(r.reason, flag ? /activity since it was judged/ : /fresh|activity since/, `includeFresh=${flag}`);
    }
    assert.equal(fs.existsSync(later), true);

    const w3 = world();
    const moved = w3.add('wt-fresh-advanced');
    const d3 = w3.plan();
    assert.equal(w3.cand(d3, moved).fresh, true);
    d3.candidates[0].activityAt -= 1000; // the plan saw older activity than now: it advanced since
    assert.match(applyDetached(w3.ctx, d3, { includeFresh: true, list: listWorktrees, staleMs: 3 * DAY }).results[0].reason, /activity since it was judged/);
  });
});

describe('the CLI: prune lists them, --apply never runs `git worktree prune`', () => {
  test('--json carries prune.detached; --apply with --include-fresh removes the candidate; a stale registration is still registered afterwards', () => {
    const w = world();
    const fake = installFakeGh(w.fx.root);
    fake.setState({ list: [], view: {}, merged: [] });
    const env = scrubbedEnv({ FLEET_WORKTREE_ROOT: w.fx.wtRoot, FLEET_TELEMETRY: 'off', ...fake.env }, { prependPath: [fake.bin] });
    const f = (args) => runFleet(args, { cwd: w.fx.repo, env });
    const clean = w.add('wt-clean');
    const gone = w.add('wt-gone');
    fs.rmSync(gone, { recursive: true, force: true });
    const r = f(['prune', '--json']);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.json.prune.detached.candidates.length, 1);
    assert.equal(r.json.prune.detached.stale.length, 1);
    assert.ok(r.json.prune.registered >= 3);
    assert.match(r.json.text, /detached worktrees \(1\)/);
    assert.match(r.json.text, /stale registrations \(1\)/);
    assert.equal(fs.existsSync(clean), true, 'read-only: nothing was removed');
    const skipped = f(['prune', '--apply', '--json']);
    assert.match(JSON.stringify(skipped.json.applied.detached.results), /fresh/);
    assert.equal(fs.existsSync(clean), true);
    const applied = f(['prune', '--apply', '--include-fresh', '--json']);
    assert.equal(applied.status, 0, applied.stderr);
    assert.equal(fs.existsSync(clean), false);
    const still = listWorktrees(w.fx.repo).worktrees.map((x) => path.resolve(x.path));
    assert.ok(still.includes(path.resolve(gone)), 'the stale registration was listed, never pruned');
  });
});

describe('registrationHistory is the one evidence rule', () => {
  test('a registration with no admin dir pointing at it is unverified, never "nothing to lose"', () => {
    const w = world();
    const r = registrationHistory(w.ctx, { path: path.join(w.fx.root, 'never-registered'), head: w.pushed });
    assert.equal(r.ok, false);
    assert.match(r.kept, /not verified/);
  });
});
