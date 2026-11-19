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
import { listWorktrees, runGit } from '../scripts/lib/fleet/git-facts.mjs';
import { transact } from '../scripts/lib/fleet/registry.mjs';
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

describe('stale registrations (directory gone): registration only, nothing judged', () => {
  const rmGone = (dir) => fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  test('every registration whose directory is gone is LISTED and counted, whatever it holds; no removal command is printed; none is touched', () => {
    const w = world();
    const gone = w.add('wt-gone');
    const goneUnpushed = w.add('wt-gone-unpushed');
    commitFile(goneUnpushed, 'u.txt', 'u\n', 'only in this registration');
    rmGone(gone); rmGone(goneUnpushed);
    const d = w.plan();
    assert.ok(w.stale(d, gone) && w.stale(d, goneUnpushed), 'both listed, neither judged');
    assert.equal(d.excluded.length, 0, 'nothing is "kept": that would imply it was examined');
    const text = renderDetached(d).join('\n');
    assert.match(text, /registration only, nothing judged/);
    assert.doesNotMatch(text, /git worktree prune/, 'never printed, not even to say it is withheld');
    assert.doesNotMatch(text, /held by a remote-tracking ref|safe/i);
    // --apply never runs `git worktree prune`: both registrations are still there afterwards.
    const a = applyDetached(w.ctx, d, { list: listWorktrees, staleMs: 3 * DAY });
    assert.deepEqual(a.results, []);
    const listed = listWorktrees(w.fx.repo).worktrees.map((x) => path.resolve(x.path));
    assert.ok(listed.includes(path.resolve(gone)) && listed.includes(path.resolve(goneUnpushed)));
  });

  test('a locked registration whose directory is gone is still listed and counted', () => {
    const w = world();
    const dir = w.add('wt-gone-locked');
    git(['worktree', 'lock', dir], w.fx.repo);
    rmGone(dir);
    assert.ok(w.stale(w.plan(), dir));
  });

  test('a registration whose directory is gone is listed even when it had a branch checked out', () => {
    const w = world();
    const dir = path.join(w.fx.root, 'wt-attached');
    git(['worktree', 'add', '-q', '-b', 'attached', dir, w.pushed], w.fx.repo);
    rmGone(dir);
    assert.ok(w.stale(w.plan(), dir));
  });

  test('a spent budget does not change it: nothing is judged, so nothing is unjudged either', () => {
    const w = world();
    const gone = w.add('wt-gone');
    rmGone(gone);
    const wt = listWorktrees(w.fx.repo);
    const d = planDetached(w.ctx, { worktrees: wt.worktrees, mainCheckout: w.fx.repo, here: { ok: false }, staleMs: 3 * DAY, nowMs: Date.now(), past: () => true, deadlineAt: 0, clock: Date.now });
    assert.deepEqual([d.stale.length, d.excluded.length, d.unjudged], [1, 0, 0]);
  });
});

describe('registration evidence beyond the reflog (audit R1)', () => {
  const rmGone = (dir) => fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });

  test("H7/H10: a commit only this worktree's FETCH_HEAD names keeps it; an empty FETCH_HEAD does not (control)", () => {
    const w = world();
    const fetched = w.add('wt-fetch-head');
    const orphan = commitFile(fetched, 'o.txt', 'o\n', 'fetched, then dropped');
    git(['checkout', '-q', '--detach', w.pushed], fetched);
    const admin = w.adminOf(fetched);
    fs.writeFileSync(path.join(admin, 'logs', 'HEAD'), '');
    fs.writeFileSync(path.join(admin, 'FETCH_HEAD'), `${orphan}\t\t'x' of origin\n`);
    const control = w.add('wt-fetch-head-empty');
    fs.writeFileSync(path.join(w.adminOf(control), 'FETCH_HEAD'), '');
    fs.writeFileSync(path.join(w.adminOf(control), 'logs', 'HEAD'), '');
    const d = w.plan();
    assert.match(w.kept(d, fetched), /reachable only through this registration/);
    assert.ok(w.cand(d, control));
  });

  test('R2 H2: a repository whose ref storage is not "files" is kept as unverified, never read as "no reflog" (control: files)', () => {
    const w = world();
    const dir = w.add('wt-a');
    const wt = listWorktrees(w.fx.repo).worktrees.find((x) => path.resolve(x.path) === path.resolve(dir));
    const stub = (format) => (args, cwd, o) => (args[0] === 'config' && args.includes('extensions.refstorage') ? { ok: Boolean(format), stdout: `${format}\n`, stderr: '', status: format ? 0 : 1 } : runGit(args, cwd, o));
    assert.equal(registrationHistory(w.ctx, wt, { git: stub('files') }).ok, true);
    assert.equal(registrationHistory(w.ctx, wt, { git: stub('') }).ok, true, 'unset = files');
    const r = registrationHistory(w.ctx, wt, { git: stub('reftable') });
    assert.equal(r.ok, false);
    assert.match(r.kept, /ref storage is reftable/);
  });

  test('R3 H1/H3: a failing `git config` is "format unknown" (kept), only exit 1 means unset (control)', () => {
    const w = world();
    const dir = w.add('wt-a');
    const wt = listWorktrees(w.fx.repo).worktrees.find((x) => path.resolve(x.path) === path.resolve(dir));
    const failing = (status) => (args, cwd, o) => (args[0] === 'config' ? { ok: false, stdout: '', stderr: 'boom', status, reason: 'boom' } : runGit(args, cwd, o));
    assert.equal(registrationHistory(w.ctx, wt, { git: failing(1) }).ok, true, 'exit 1 = unset');
    const r = registrationHistory(w.ctx, wt, { git: failing(128) });
    assert.equal(r.ok, false);
    assert.match(r.kept, /ref storage format could not be read/);
  });

  test('R3 M3: an id that is not a commit (a blob in FETCH_HEAD) keeps it; a missing object keeps it; control: a commit id passes', () => {
    const w = world();
    const blob = git(['rev-parse', 'HEAD:a.txt'], w.fx.repo);
    const mk = (name, line) => {
      const dir = w.add(name);
      fs.writeFileSync(path.join(w.adminOf(dir), 'logs', 'HEAD'), '');
      fs.writeFileSync(path.join(w.adminOf(dir), 'FETCH_HEAD'), `${line}\n`);
      return dir;
    };
    const asBlob = mk('wt-blob', `${blob}\t\tx`);
    const missing = mk('wt-missing', `${'1'.repeat(40)}\t\tx`);
    const asCommit = mk('wt-commit', `${w.pushed}\t\tx`);
    const d = w.plan();
    assert.match(w.kept(d, asBlob), /missing or is not a commit/);
    assert.match(w.kept(d, missing), /missing or is not a commit/);
    assert.ok(w.cand(d, asCommit), 'control');
  });

  test('R3 M1: an oversized FETCH_HEAD is kept as unverified, not read', () => {
    const w = world();
    const dir = w.add('wt-big');
    fs.writeFileSync(path.join(w.adminOf(dir), 'FETCH_HEAD'), `${w.pushed}\t\tx\n`.repeat(30_000));
    assert.match(w.kept(w.plan(), dir), /FETCH_HEAD is larger than/);
  });

  test('R3 H2/M2: a worktree a fleet session registered is not a candidate at PLANNING (control: another session elsewhere)', () => {
    const w = world();
    const dir = w.add('wt-owned');
    const other = w.add('wt-free');
    const iso = (ms) => new Date(ms).toISOString();
    const session = (id, worktree) => ({
      schemaVersion: 1, rev: 1, id, source: { kind: 'branch', branch: id, repo: null, prNumber: null, headRepo: null, headRef: id, baseRef: 'main' },
      worktree, intent: 'x', paths: [], state: 'working', gen: 1, startOid: '0'.repeat(40), waitingOn: [], ready: null, knownOverlaps: [],
      leaseExpiresAt: iso(Date.now() + 3_600_000), updatedAt: iso(Date.now()), createdAt: iso(Date.now()),
    });
    transact(w.ctx.dir, (t) => { t.writeSession(session('owner', dir)); });
    const d = w.plan();
    assert.match(w.kept(d, dir), /registered to session owner/);
    assert.equal(w.cand(d, dir), undefined);
    assert.ok(w.cand(d, other), 'control');
  });

  test('M2: a git call that runs into the budget inside the history check is UNJUDGED, never kept (control: budget left → kept with its reason)', () => {
    const w = world();
    const dir = w.add('wt-a');
    const wt = () => listWorktrees(w.fx.repo);
    const plan = (git, past) => planDetached(w.ctx, { worktrees: wt().worktrees, mainCheckout: w.fx.repo, here: { ok: false }, staleMs: 3 * DAY, nowMs: Date.now(), past, deadlineAt: null, clock: Date.now, git });
    let spent = false;
    const failing = (args, cwd, o) => (args[0] === 'config' && args.includes('extensions.refstorage') ? (spent = true, { ok: false, stdout: '', stderr: 'timeout', status: 128, reason: 'timed out' }) : runGit(args, cwd, o));
    const d = plan(failing, () => spent);
    assert.deepEqual([d.excluded.length, d.candidates.length, d.unjudged], [0, 0, 1]);
    const control = plan((args, cwd, o) => (args[0] === 'config' && args.includes('extensions.refstorage') ? { ok: false, stdout: '', stderr: 'x', status: 128, reason: 'x' } : runGit(args, cwd, o)), () => false);
    assert.match(w.kept(control, dir), /ref storage format could not be read/);
    assert.equal(control.unjudged, 0);
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
  test('locked after planning → skipped', () => {
    const w = world();
    const dir = w.add('wt-a');
    const d = w.plan({ now: Date.now() + past });
    git(['worktree', 'lock', dir], w.fx.repo);
    assert.match(applyDetached(w.ctx, d, { list: listWorktrees, staleMs: 3 * DAY, clock: () => Date.now() + past }).results[0].reason, /locked/);
  });
  test('R2 M1: a session registered on the worktree after planning → skipped (control: another session elsewhere does not block)', () => {
    const w = world();
    const dir = w.add('wt-a');
    const iso = (ms) => new Date(ms).toISOString();
    const session = (id, worktree) => ({
      schemaVersion: 1, rev: 1, id, source: { kind: 'branch', branch: id, repo: null, prNumber: null, headRepo: null, headRef: id, baseRef: 'main' },
      worktree, intent: 'x', paths: [], state: 'working', gen: 1, startOid: '0'.repeat(40), waitingOn: [], ready: null, knownOverlaps: [],
      leaseExpiresAt: iso(Date.now() + 3_600_000), updatedAt: iso(Date.now()), createdAt: iso(Date.now()),
    });
    const d = w.plan({ now: Date.now() + past });
    transact(w.ctx.dir, (t) => { t.writeSession(session('elsewhere', path.join(w.fx.root, 'somewhere-else'))); });
    const apply = () => applyDetached(w.ctx, d, { list: listWorktrees, staleMs: 3 * DAY, clock: () => Date.now() + past });
    transact(w.ctx.dir, (t) => { t.writeSession(session('mine', dir)); });
    const a = apply();
    assert.match(a.results[0].reason, /a session has registered this worktree/);
    assert.equal(fs.existsSync(dir), true);
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
    fs.rmSync(gone, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
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
