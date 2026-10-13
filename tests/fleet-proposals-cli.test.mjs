/**
 * @fileoverview `fleet propose` / `proposal` / `proposals` and their surfaces, through the REAL CLI in throwaway
 * repos (docs/plans/fleet-proposals-queue.md, Tier 2): a record outlives its worktree, the status/next lines, the
 * archive-check reminder that never changes the verdict, and every path that must read UNMEASURED rather than zero.
 */
import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { git } from './helpers/git.mjs';
import { addBranch, cleanupFleetRoots, makeFleetRepo, runFleet, runFleetAsync, scrubbedEnv } from './helpers/fleet-repo.mjs';

after(cleanupFleetRoots);

const env = (extra = {}) => scrubbedEnv({ FLEET_TELEMETRY: 'off', ...extra });
const NEW = ['--what', 'prune count is stale', '--where', 'scripts/lib/fleet/prune.mjs', '--why', 'it reads a 24h cache'];
const propose = (fx, cwd, extra = [], e = env()) => runFleet(['propose', ...NEW, ...extra], { cwd: cwd ?? fx.repo, env: e });
const idOf = (r) => /recorded (p-\d{14}-[0-9a-f]{4})/.exec(r.stdout)?.[1];
const claimMain = (fx, e = env()) => assert.equal(runFleet(['claim', '--id', 'main', '--intent', 'coordinate', '--paths', 'a.txt'], { cwd: fx.repo, env: e }).status, 0);
const proposalsDir = (fx) => path.join(fx.repo, '.git', 'fleet', 'proposals');

function worktree(fx, name) {
  const dir = path.join(fx.root, `wt-${name}`);
  git(['worktree', 'add', '-q', '-b', name, dir, 'main'], fx.repo);
  return dir;
}

describe('a proposal outlives the worktree that wrote it', () => {
  it('written from worktree A, listed from worktree B, still listed after A is removed', () => {
    const fx = makeFleetRepo();
    const a = worktree(fx, 'feat-a');
    const b = worktree(fx, 'feat-b');
    const r = propose(fx, a, ['--theme', 'fleet-docs', '--evidence', 'status.md line 12']);
    assert.equal(r.status, 0, r.stderr);
    const id = idOf(r);
    assert.ok(id, r.stdout);
    assert.ok(fs.existsSync(path.join(proposalsDir(fx), `${id}.json`)), 'under <git-common-dir>/fleet/proposals/');
    const fromB = runFleet(['proposals'], { cwd: b, env: env() });
    assert.match(fromB.stdout, new RegExp(`theme: fleet-docs \\(1\\)[\\s\\S]*${id}  pending  \\(0d, by feat-a\\)  prune count is stale`));
    assert.match(fromB.stdout, /evidence: status\.md line 12/);
    git(['worktree', 'remove', '--force', a], fx.repo);
    const after = runFleet(['proposals', '--json'], { cwd: b, env: env() });
    assert.equal(after.json.proposals.records.length, 1, 'the record is not lost with its worktree');
    assert.equal(after.json.proposals.records[0].originator.id, 'feat-a');
  });

  it('two sessions proposing at once both land (the registry lock serialises them)', async () => {
    const fx = makeFleetRepo();
    const [x, y] = [worktree(fx, 'feat-x'), worktree(fx, 'feat-y')];
    const [rx, ry] = await Promise.all([
      runFleetAsync(['propose', ...NEW, '--theme', 't'], { cwd: x, env: env() }),
      runFleetAsync(['propose', ...NEW, '--theme', 't'], { cwd: y, env: env() }),
    ]);
    assert.deepEqual([rx.status, ry.status], [0, 0]);
    assert.notEqual(idOf(rx), idOf(ry));
    assert.equal(runFleet(['proposals', '--json'], { cwd: fx.repo, env: env() }).json.proposals.records.length, 2);
  });
});

describe('argv and refusals', () => {
  it('propose needs what/where/why and refuses unknown flags and bad --blocked-by (exit 2)', () => {
    const fx = makeFleetRepo();
    for (const args of [['--where', 'x', '--why', 'y'], ['--what', 'x', '--why', 'y'], ['--what', 'x', '--where', 'y'], [...NEW, '--bogus', '1'], [...NEW, '--blocked-by', 'two words'], [...NEW, '--theme', 'Bad Theme']]) {
      const r = runFleet(['propose', ...args], { cwd: fx.repo, env: env() });
      assert.equal(r.status, 2, `${args.join(' ')} -> ${r.stdout}${r.stderr}`);
    }
    assert.equal(fs.existsSync(proposalsDir(fx)), false, 'control: nothing was written by any refused call');
  });
  it('proposal needs exactly one outcome flag with a value; an unknown id and a final record are refused (exit 3)', () => {
    const fx = makeFleetRepo();
    const id = idOf(propose(fx));
    const run = (...a) => runFleet(['proposal', ...a, '--id', 'coord'], { cwd: fx.repo, env: env() });
    assert.equal(run(id).status, 2, 'no outcome flag');
    assert.equal(run(id, '--queued', 'a', '--declined', 'b').status, 2, 'two outcome flags');
    assert.equal(run(id, '--declined', '   ').status, 2, 'an empty reason');
    assert.equal(run(id, '--done', 'fixed it').status, 3, 'done needs a PR reference');
    assert.equal(run('p-20200101000000-0000', '--queued', 'x').status, 3, 'unknown id');
    assert.equal(run('nope', '--queued', 'x').status, 3, 'not an id');
    assert.equal(run(id, '--declined', 'duplicate of another').status, 0);
    const again = run(id, '--queued', 'second thoughts');
    assert.equal(again.status, 3);
    assert.match(again.stdout, /already declined/);
  });
});

describe('outcomes never delete', () => {
  it('queued -> folded -> done: history grows, the file moves to closed/, default listing hides it, --all shows it', () => {
    const fx = makeFleetRepo();
    const id = idOf(propose(fx));
    const run = (...a) => runFleet(['proposal', id, ...a, '--id', 'coord'], { cwd: fx.repo, env: env() });
    assert.equal(run('--queued', 'waiting for a worker slot').status, 0);
    assert.equal(run('--folded', 'CES: theme session').status, 0);
    const d = run('--done', '#241');
    assert.equal(d.status, 0, d.stdout + d.stderr);
    assert.match(d.stdout, /is now done: #241/);
    assert.equal(fs.existsSync(path.join(proposalsDir(fx), `${id}.json`)), false);
    const closed = fs.readdirSync(path.join(proposalsDir(fx), 'closed'));
    assert.equal(closed.length, 1);
    assert.match(runFleet(['proposals'], { cwd: fx.repo, env: env() }).stdout, /no open proposals/);
    const all = runFleet(['proposals', '--all', '--json'], { cwd: fx.repo, env: env() }).json.proposals.records;
    assert.deepEqual(all.map((p) => [p.id, p.state, p.history.map((h) => h.state)]), [[id, 'done', ['pending', 'queued', 'folded', 'done']]]);
  });
});

describe('surfaces: status, next, archive-check', () => {
  it('status and next print N pending, oldest Xd, and flag pending more than 3 days (clock pinned)', () => {
    const fx = makeFleetRepo();
    propose(fx, undefined, [], env({ FLEET_NOW: '2026-10-01T10:00:00Z' }));
    propose(fx, undefined, [], env({ FLEET_NOW: '2026-10-04T10:00:00Z' }));
    const e = env({ FLEET_NOW: '2026-10-05T10:00:00Z' });
    claimMain(fx, e);
    const st = runFleet(['status', '--json'], { cwd: fx.repo, env: e });
    assert.equal(st.json.status.proposals.pending, 2);
    assert.equal(st.json.status.proposals.oldestPendingDays, 4);
    assert.equal(st.json.status.proposals.stalePending, 1);
    const human = runFleet(['status'], { cwd: fx.repo, env: e }).stdout;
    assert.match(human, /^proposals: 2 pending, oldest 4d — 1 pending more than 3d: triage with `.*proposals`$/m);
    const nx = runFleet(['next', '--id', 'main'], { cwd: fx.repo, env: e });
    assert.match(nx.stdout, /FYI for the user\/coordinator, not an action for this session: proposals: 2 pending, oldest 4d/);
    assert.equal(nx.status, 0);
  });

  it('an empty queue is a measured zero on status and silent on next (control for the unmeasured test)', () => {
    const fx = makeFleetRepo();
    claimMain(fx);
    assert.match(runFleet(['status'], { cwd: fx.repo, env: env() }).stdout, /^proposals: none pending$/m);
    assert.doesNotMatch(runFleet(['next', '--id', 'main'], { cwd: fx.repo, env: env() }).stdout, /proposals/);
  });

  it('a store that cannot be read prints unmeasured on status AND next, never none/zero', () => {
    const fx = makeFleetRepo();
    claimMain(fx);
    propose(fx);
    fs.rmSync(proposalsDir(fx), { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
    fs.writeFileSync(proposalsDir(fx), 'a file where the directory should be');
    const st = runFleet(['status', '--json'], { cwd: fx.repo, env: env() });
    assert.equal(st.json.status.proposals.state, 'unmeasured');
    const human = runFleet(['status'], { cwd: fx.repo, env: env() }).stdout;
    assert.match(human, /^proposals: unmeasured \(/m);
    assert.doesNotMatch(human, /proposals: none pending/);
    const nx = runFleet(['next', '--id', 'main'], { cwd: fx.repo, env: env() }).stdout;
    assert.match(nx, /proposals: unmeasured \(/);
    const listing = runFleet(['proposals'], { cwd: fx.repo, env: env() });
    assert.notEqual(listing.status, 0, 'the listing fails rather than printing an empty queue');
  });

  it('a corrupt record is named, and the counts become lower bounds', () => {
    const fx = makeFleetRepo();
    propose(fx);
    fs.writeFileSync(path.join(proposalsDir(fx), 'p-20261001100000-dead.json'), '{ broken');
    const human = runFleet(['status'], { cwd: fx.repo, env: env() }).stdout;
    assert.match(human, /^proposals: ≥1 pending, oldest ≥0d — 1 record\(s\) unreadable; `.*proposals` names them$/m);
    assert.match(runFleet(['proposals'], { cwd: fx.repo, env: env() }).stdout, /p-20261001100000-dead\.json: unreadable/);
  });

  it('a store holding only corrupt records is never reported as an empty queue', () => {
    const fx = makeFleetRepo();
    fs.mkdirSync(proposalsDir(fx), { recursive: true });
    fs.writeFileSync(path.join(proposalsDir(fx), 'p-20261001100000-dead.json'), '{ broken');
    const out = runFleet(['proposals'], { cwd: fx.repo, env: env() }).stdout;
    assert.doesNotMatch(out, /^no open proposals$/m);
    assert.match(out, /the queue's actual contents are unknown/);
    assert.match(out, /p-20261001100000-dead\.json: unreadable/);
  });

  it('archive-check says an incomplete read may have missed attribution', () => {
    const fx = makeFleetRepo();
    const a = worktree(fx, 'feat-a');
    assert.equal(runFleet(['claim', '--id', 'feat-a', '--intent', 'work for feat-a', '--paths', 'feat-a.txt'], { cwd: a, env: env() }).status, 0);
    propose(fx, a);
    fs.writeFileSync(path.join(proposalsDir(fx), 'p-20261001100000-dead.json'), '{ broken');
    const out = runFleet(['archive-check', 'feat-a'], { cwd: fx.repo, env: env() }).stdout;
    assert.match(out, /open proposals you originated \(≥1 awaiting/);
    assert.match(out, /1 record\(s\) unreadable, so attribution may be incomplete/);
  });

  it('archive-check lists the proposals the session originated, not another session\'s, and leaves the verdict alone', () => {
    const fx = makeFleetRepo();
    const a = worktree(fx, 'feat-a');
    const b = worktree(fx, 'feat-b');
    for (const [wt, id] of [[a, 'feat-a'], [b, 'feat-b']]) {
      assert.equal(runFleet(['claim', '--id', id, '--intent', `work for ${id}`, '--paths', `${id}.txt`], { cwd: wt, env: env() }).status, 0);
    }
    const before = runFleet(['archive-check', 'feat-a', '--json'], { cwd: fx.repo, env: env() });
    assert.equal(before.json.archive.proposals.open.length, 0, 'control: nothing to list yet');
    const mine = idOf(propose(fx, a));
    propose(fx, b);
    const r = runFleet(['archive-check', 'feat-a'], { cwd: fx.repo, env: env() });
    assert.match(r.stdout, /open proposals you originated \(1 awaiting an outcome/);
    assert.ok(r.stdout.includes(mine));
    assert.equal((r.stdout.match(/p-\d{14}-[0-9a-f]{4}/g) ?? []).length, 1, "feat-b's proposal is not listed");
    const after = runFleet(['archive-check', 'feat-a', '--json'], { cwd: fx.repo, env: env() });
    assert.equal(after.json.archive.verdict, before.json.archive.verdict, 'a proposal never changes the verdict');
    assert.equal(after.status, before.status);
    runFleet(['proposal', mine, '--declined', 'triaged', '--id', 'coord'], { cwd: fx.repo, env: env() });
    assert.doesNotMatch(runFleet(['archive-check', 'feat-a'], { cwd: fx.repo, env: env() }).stdout, /open proposals you originated/);
  });
});

describe('blockedBy is rechecked against facts and labelled, nothing more', () => {
  it('a branch blocker: waiting while unmerged, resolved once merged into main (nothing is promoted or changed)', () => {
    const fx = makeFleetRepo();
    addBranch(fx.repo, 'blocker-branch', { 'blocker.txt': 'x\n' });
    const id = idOf(propose(fx, undefined, ['--blocked-by', 'blocker-branch']));
    const waiting = runFleet(['proposals'], { cwd: fx.repo, env: env() }).stdout;
    assert.match(waiting, /blocked by: waiting on branch blocker-branch$/m);
    git(['merge', '-q', '--no-ff', '-m', 'merge blocker', 'blocker-branch'], fx.repo);
    const resolved = runFleet(['proposals', '--json'], { cwd: fx.repo, env: env() });
    assert.equal(resolved.json.proposals.records[0].blocker.state, 'resolved');
    assert.match(runFleet(['proposals'], { cwd: fx.repo, env: env() }).stdout, /blocked by: resolved: branch blocker-branch merged into main — the blocker is clear; ready to schedule/);
    assert.equal(resolved.json.proposals.records[0].state, 'pending', 'the state did not change by itself');
    assert.equal(runFleet(['proposals', '--json'], { cwd: fx.repo, env: env() }).json.proposals.records[0].id, id);
  });
  it('a branch that no longer exists is "gone", not "merged"; a PR blocker with no gh is unknown, not resolved', () => {
    const fx = makeFleetRepo();
    propose(fx, undefined, ['--blocked-by', 'never-existed']);
    propose(fx, undefined, ['--blocked-by', '#41']);
    const out = runFleet(['proposals'], { cwd: fx.repo, env: env() }).stdout;
    assert.match(out, /blocked by: blocker branch never-existed is gone/);
    assert.match(out, /blocked by: unknown \(gh not installed\)/);
    assert.doesNotMatch(out, /ready to schedule/);
  });
});
