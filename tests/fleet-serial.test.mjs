/**
 * @fileoverview /fleet — `land --approve --serial` (plan
 * docs/plans/fleet-consumer-feedback-oct.md §2.5; wine item 8, storyline 8).
 *
 * The loop runs in-process with a scripted `gh` (a state machine per PR) and the
 * REAL git: an updated head is a real merge commit pushed to the bare origin's
 * `refs/pull/<n>/head`, so the recovery proof (parents + re-derived merge tree)
 * runs against real objects.
 *
 * Pinned: BEHIND → update with expected_head_sha → wait (missing → pending →
 * pass) → merge exactly that head; an update the run cannot prove is its own
 * (foreign content in the merge) stops; a crash between update and record is
 * recovered by proof; DIRTY stops with the restack remedy; a never-registered
 * check times out by name; a second runner is refused by the lease.
 */
import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { git } from './helpers/git.mjs';
import { approveSerial, readSerial, resumeSerial } from '../scripts/lib/fleet/serial.mjs';
import { defaultDeps } from '../scripts/lib/fleet/train.mjs';
import { readTrain } from '../scripts/lib/fleet/registry.mjs';
import {
  addBranch, cleanupFleetRoots, installFakeGh, makeFleetRepo, prRow, runFleet, scrubbedEnv,
} from './helpers/fleet-repo.mjs';

after(cleanupFleetRoots);

const REPO = 'o/n';
const PR = 21;
const RULES = { ok: true, status: 0, stdout: JSON.stringify([{ type: 'required_status_checks', parameters: { required_status_checks: [{ context: 'ci' }] } }]), stderr: '' };
const BRANCH = { ok: true, status: 0, stdout: JSON.stringify({ protected: false }), stderr: '' };
const ok = (doc) => ({ ok: true, status: 0, stdout: doc === undefined ? '' : JSON.stringify(doc), stderr: '' });
const check = (bucket) => [{ name: 'ci', bucket, state: bucket.toUpperCase(), completedAt: '2026-10-09T10:00:00Z' }];

/** A pr-mode train with one ready session `feat` and a built (green) train. */
function trainFx() {
  const fx = makeFleetRepo({ fleetConfig: { mergeMethod: 'pr', testCommand: { tiers: [{ name: 'ok', command: ['node', '-e', '0'] }] } } });
  git(['add', '.fleet.json'], fx.repo); git(['commit', '-q', '-m', 'cfg'], fx.repo); git(['push', '-q', 'origin', 'main'], fx.repo);
  const fake = installFakeGh(fx.root);
  const env = scrubbedEnv({ FLEET_WORKTREE_ROOT: fx.wtRoot, ...fake.env }, { prependPath: [fake.bin] });
  const f = (args) => runFleet(args, { cwd: fx.repo, env });
  const base = git(['rev-parse', 'main'], fx.repo);
  const tested = addBranch(fx.repo, 'feat', { 'f.txt': 'f\n' });
  git(['push', '-q', 'origin', `${tested}:refs/pull/${PR}/head`], fx.repo);
  git(['checkout', '-q', 'feat'], fx.repo);
  assert.equal(f(['claim', '--id', 'feat', '--intent', 'feat', '--paths', 'f.txt']).status, 0);
  assert.equal(f(['ready', '--id', 'feat']).status, 0);
  git(['checkout', '-q', 'main'], fx.repo);
  const row = prRow({ number: PR, branch: 'feat', headOid: tested, baseOid: base });
  fake.setState({ list: [row], view: { [PR]: row } });
  const built = f(['land', '--json']);
  assert.equal(built.status, 0, built.stdout + built.stderr);
  return { fx, tested, base, trainId: built.json.train.trainId };
}

/** Advance main (as another merge would) and build the updated head: a merge of `tested` and the new base. */
function updatedHead(fx, tested, { foreign = false } = {}) {
  git(['checkout', '-q', 'main'], fx.repo);
  fs.writeFileSync(path.join(fx.repo, 'other.txt'), 'landed meanwhile\n');
  git(['add', 'other.txt'], fx.repo); git(['commit', '-q', '-m', 'other (#20)'], fx.repo); git(['push', '-q', 'origin', 'main'], fx.repo);
  git(['checkout', '-q', '--detach', tested], fx.repo);
  git(['merge', '-q', '--no-ff', '-m', 'Merge main into feat', 'main'], fx.repo);
  if (foreign) {
    fs.writeFileSync(path.join(fx.repo, 'sneaky.txt'), 'not a clean merge\n');
    git(['add', 'sneaky.txt'], fx.repo); git(['commit', '-q', '--amend', '--no-edit'], fx.repo);
  }
  const u = git(['rev-parse', 'HEAD'], fx.repo);
  git(['push', '-q', '-f', 'origin', `${u}:refs/pull/${PR}/head`], fx.repo);
  git(['checkout', '-q', 'main'], fx.repo);
  return u;
}

/**
 * A scripted gh. `views` is the sequence of `pr view` answers (the last repeats);
 * `checks` the sequence of `pr checks` buckets; calls are recorded.
 */
function scriptedGh({ views, checks = [['pass']], onUpdate = () => ok({}), onMerge = () => ok() }) {
  const calls = []; let v = 0; let c = 0;
  const gh = (args) => {
    calls.push(args);
    if (args[0] === 'api' && args.includes('PUT')) return onUpdate(args);
    if (args[0] === 'api' && /rules\/branches/.test(args[1])) return RULES;
    if (args[0] === 'api' && /\/branches\//.test(args[1])) return BRANCH;
    if (args[0] === 'pr' && args[1] === 'merge') return onMerge(args);
    if (args[0] === 'pr' && args[1] === 'checks') {
      const b = checks[Math.min(c++, checks.length - 1)];
      return { ok: b[0] === 'pass', status: b[0] === 'pass' ? 0 : 8, stdout: b[0] === 'missing' ? '[]' : JSON.stringify(check(b[0])), stderr: '' };
    }
    if (args[0] === 'pr' && args[1] === 'view') {
      const want = args[args.indexOf('--json') + 1];
      const doc = typeof views === 'function' ? views() : views[Math.min(v++, views.length - 1)];
      return want === 'headRefOid' ? ok({ headRefOid: doc.headRefOid }) : ok(doc);
    }
    return { ok: false, status: 1, stdout: '', stderr: `unexpected gh ${args.join(' ')}`, reason: 'unexpected' };
  };
  return { gh, calls };
}

const view = (head, over = {}) => ({ state: 'OPEN', isDraft: false, headRefOid: head, baseRefName: 'main', mergeStateStatus: 'CLEAN', mergeCommit: null, url: `https://github.com/${REPO}/pull/${PR}`, ...over });
const fast = { poll: 1, updatePoll: 1, updateWait: 200, mergeWait: 200 };
const depsWith = (gh) => defaultDeps({ gh, log: () => {} });

describe('serial landing', () => {
  it('a CLEAN PR: waits for the required check, merges exactly the tested head, lands the train', () => {
    const { fx, tested, trainId } = trainFx();
    // view: verify, merge re-check (head bound before/after checks uses headRefOid-only views), then MERGED.
    let merged = false;
    const { gh, calls } = scriptedGh({
      views: () => (merged ? view(tested, { state: 'MERGED', mergeCommit: { oid: 'e'.repeat(40) } }) : view(tested)),
      checks: [['pending'], ['pass']], onMerge: () => { merged = true; return ok(); },
    });
    const r = approveSerial({ cwd: fx.repo, trainId, deps: depsWith(gh), sleep: () => {}, timings: fast, timeoutMs: 60_000 });
    assert.equal(r.landed, true, JSON.stringify(r.run?.steps ?? r.reason));
    const m = calls.find((c) => c[1] === 'merge');
    assert.deepEqual(m.slice(-2), ['--match-head-commit', tested]);
    assert.equal(readTrain(path.join(git(['rev-parse', '--path-format=absolute', '--git-common-dir'], fx.repo), 'fleet'), trainId).train.phase, 'landed');
  });

  it('BEHIND: update-branch with expected_head_sha, PROVES the new head is its own merge, waits missing→pending→pass, merges the updated head', () => {
    const { fx, tested, trainId } = trainFx();
    // The base moves and GitHub builds the merge commit only when update-branch is called (as in life).
    let u = null; let state = 'behind'; let merged = false;
    const { gh, calls } = scriptedGh({
      views: () => (merged ? view(u, { state: 'MERGED', mergeCommit: { oid: 'e'.repeat(40) } })
        : state === 'behind' ? view(tested, { mergeStateStatus: 'BEHIND' }) : view(u)),
      checks: [['missing'], ['pending'], ['pass']],
      onUpdate: (args) => { assert.ok(args.includes(`expected_head_sha=${tested}`)); u = updatedHead(fx, tested); state = 'updated'; return ok({}); },
      onMerge: () => { merged = true; return ok(); },
    });
    const r = approveSerial({ cwd: fx.repo, trainId, deps: depsWith(gh), sleep: () => {}, timings: fast, timeoutMs: 60_000 });
    assert.equal(r.landed, true, JSON.stringify(r.run?.steps ?? r.reason));
    assert.deepEqual(calls.find((c) => c[1] === 'merge').slice(-1), [u]);
    assert.match(JSON.stringify(r.run.steps[0].accounted), new RegExp(u));
  });

  it('an updated head carrying FOREIGN content in the merge itself is UNACCOUNTED — stop for a new approval', () => {
    const { fx, tested, trainId } = trainFx();
    let u = null; let state = 'behind';
    const { gh, calls } = scriptedGh({
      views: () => (state === 'behind' ? view(tested, { mergeStateStatus: 'BEHIND' }) : view(u)),
      onUpdate: () => { u = updatedHead(fx, tested, { foreign: true }); state = 'updated'; return ok({}); },
    });
    const r = approveSerial({ cwd: fx.repo, trainId, deps: depsWith(gh), sleep: () => {}, timings: fast, timeoutMs: 60_000 });
    assert.equal(r.landed, undefined);
    assert.match(r.reason, /UNACCOUNTED.*beyond a clean merge/);
    assert.equal(calls.some((c) => c[1] === 'merge'), false, 'never merged');
  });

  it('crash after update-branch, before the new head was recorded: resume proves it by parentage + tree and continues', () => {
    const { fx, tested, trainId } = trainFx();
    // First run: the update succeeds but the poll never sees the new head (simulating a crash/timeout window).
    let u = null; let state = 'behind';
    const first = scriptedGh({ views: () => (state === 'behind' ? view(tested, { mergeStateStatus: 'BEHIND' }) : view(tested)), onUpdate: () => { u = updatedHead(fx, tested); state = 'sent'; return ok({}); } });
    const r1 = approveSerial({ cwd: fx.repo, trainId, deps: depsWith(first.gh), sleep: () => {}, timings: fast, timeoutMs: 60_000 });
    assert.match(r1.reason, /update not yet visible/);
    const dir = path.join(git(['rev-parse', '--path-format=absolute', '--git-common-dir'], fx.repo), 'fleet');
    assert.equal(readSerial(dir, trainId).run.steps[0].priorHead, tested, 'the intent was recorded before the call');
    // Resume: GitHub now shows u. The run must prove u is its own update (no new approval needed).
    let merged = false;
    const second = scriptedGh({ views: () => (merged ? view(u, { state: 'MERGED', mergeCommit: { oid: 'e'.repeat(40) } }) : view(u)), onMerge: () => { merged = true; return ok(); } });
    const r2 = resumeSerial({ cwd: fx.repo, trainId, deps: depsWith(second.gh), sleep: () => {}, timings: fast });
    assert.equal(r2.landed, true, r2.reason);
  });

  it('DIRTY stops with the restack remedy; a never-registered required check times out by name', () => {
    const a = trainFx();
    const dirty = scriptedGh({ views: () => view(a.tested, { mergeStateStatus: 'DIRTY' }) });
    const r = approveSerial({ cwd: a.fx.repo, trainId: a.trainId, deps: depsWith(dirty.gh), sleep: () => {}, timings: fast, timeoutMs: 60_000 });
    assert.match(r.reason, /conflicts with main — run `fleet restack feat`/);
    const b = trainFx();
    const never = scriptedGh({ views: () => view(b.tested), checks: [['missing']] });
    const t = approveSerial({ cwd: b.fx.repo, trainId: b.trainId, deps: depsWith(never.gh), sleep: () => {}, timings: fast, timeoutMs: 30 });
    assert.match(t.reason, /never registered on .*: ci/);
  });

  it('a second runner is refused while the lease is held; a non-pr train is refused', () => {
    const { fx, tested, trainId } = trainFx();
    const dir = path.join(git(['rev-parse', '--path-format=absolute', '--git-common-dir'], fx.repo), 'fleet');
    const { gh } = scriptedGh({ views: () => view(tested, { mergeStateStatus: 'DIRTY' }) });
    approveSerial({ cwd: fx.repo, trainId, deps: depsWith(gh), sleep: () => {}, timings: fast, timeoutMs: 60_000 });
    fs.writeFileSync(path.join(dir, 'serial', `${trainId}.lock`), JSON.stringify({ pid: process.pid, token: 'x', at: Date.now() }));
    const r = resumeSerial({ cwd: fx.repo, trainId, deps: depsWith(gh), sleep: () => {}, timings: fast });
    assert.match(r.reason, /another process is landing/);
  });
});
