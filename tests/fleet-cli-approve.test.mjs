/**
 * @fileoverview /fleet CLI end to end — approve's re-verification and refusals,
 * and reconciling a crash between push-pending and landed from the remote's
 * truth. Split from tests/fleet-cli.test.mjs for wall time; harness:
 * tests/helpers/fleet-cli-harness.mjs.
 */
import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { git } from './helpers/git.mjs';
import { cleanupFleetRoots, commitFile, writeFile } from './helpers/fleet-repo.mjs';
import { OK_TIER, fleetDirOf, land, readyBranch, sessionRec, setup } from './helpers/fleet-cli-harness.mjs';
import { readTrain } from '../scripts/lib/fleet/registry.mjs';
import { approveTrain } from '../scripts/lib/fleet/train-approve.mjs';
import { defaultDeps, withTrainLock } from '../scripts/lib/fleet/train.mjs';

after(cleanupFleetRoots);

// ───────────────────────────────────────────────────────────────────────────
describe('approve: re-verification and refusals', () => {
  const cfg = { mergeMethod: 'direct-squash', testCommand: { tiers: [OK_TIER] } };
  function built(over = {}) {
    const s = setup({ fleetConfig: cfg, ...over });
    readyBranch(s, 'feat-a', { 'a.txt': 'A\n' });
    readyBranch(s, 'feat-b', { 'b.txt': 'B\n' });
    const t = land(s).json.train;
    assert.equal(t.result, 'green');
    return { s, t, approve: (x = []) => s.f(['land', '--approve', t.trainId, '--json', ...x]), originMain: () => git(['--git-dir', s.fx.origin, 'rev-parse', 'main'], s.fx.root) };
  }

  it('base moved (local main advanced) -> refused, naming what moved; nothing pushed', () => {
    const { s, t, approve, originMain } = built();
    commitFile(s.fx.repo, 'moved.txt', 'x\n');
    const r = approve();
    assert.equal(r.status, 3);
    assert.match(r.json.reason, /local base moved/);
    assert.notEqual(originMain(), t.candidate.oid);
  });

  it('a source head moved -> refused naming the source', () => {
    const { s, approve } = built();
    git(['checkout', '-q', 'feat-a'], s.fx.repo);
    commitFile(s.fx.repo, 'more.txt', 'x\n');
    git(['checkout', '-q', 'main'], s.fx.repo);
    const r = approve();
    assert.equal(r.status, 3);
    assert.match(r.json.reason, /source feat-a: head moved/);
  });

  it('the remote ref moved -> refused (and build a new train)', () => {
    const { s, approve } = built();
    const other = path.join(s.fx.root, 'other');
    git(['clone', '-q', s.fx.origin, other], s.fx.root);
    git(['config', 'user.email', 'o@o'], other); git(['config', 'user.name', 'O'], other);
    commitFile(other, 'someone-else.txt', 'x\n');
    git(['push', '-q', 'origin', 'main'], other);
    const r = approve();
    assert.equal(r.status, 3);
    assert.match(r.json.reason, /remote refs\/heads\/main moved/);
  });

  it('remote unreachable (same URL, gone) -> refused, never proceeded on stale local knowledge', () => {
    const { s, approve } = built();
    const gone = `${s.fx.origin}.moved`;
    fs.renameSync(s.fx.origin, gone);
    const r = approve();
    assert.equal(r.status, 3);
    assert.match(r.json.reason, /remote unreachable/);
    fs.renameSync(gone, s.fx.origin);
  });

  it('a pushurl change between build and approve -> refused; a fetch URL change -> refused', () => {
    const { s, approve } = built();
    git(['remote', 'set-url', '--push', 'origin', path.join(s.fx.root, 'elsewhere.git')], s.fx.repo);
    const r = approve();
    assert.equal(r.status, 3);
    assert.match(r.json.reason, /push URL changed/);
    git(['config', '--unset-all', 'remote.origin.pushurl'], s.fx.repo);
    git(['remote', 'set-url', 'origin', `${s.fx.origin}/`], s.fx.repo);
    assert.match(approve().json.reason, /fetch URL changed/);
  });

  it('two push URLs at BUILD time -> the train is refused', () => {
    const s = setup({ fleetConfig: cfg });
    readyBranch(s, 'feat-a', { 'a.txt': 'A\n' });
    git(['remote', 'set-url', '--add', '--push', 'origin', s.fx.origin], s.fx.repo);
    git(['remote', 'set-url', '--add', '--push', 'origin', path.join(s.fx.root, 'second.git')], s.fx.repo);
    const r = land(s);
    assert.equal(r.status, 3);
    assert.match(r.json.reason, /2 push URLs/);
  });

  it('.fleet.json edited between test and approve: the MANIFEST\'s mergeMethod still wins', () => {
    const { s, t, approve, originMain } = built();
    writeFile(s.fx.repo, '.fleet.json', JSON.stringify({ mergeMethod: 'pr', testCommand: 'false', baseBranch: 'develop' }));
    const r = approve();
    assert.equal(r.status, 0, r.stdout);
    assert.equal(r.json.mode, 'direct-squash', 'the recorded method, not the edited config');
    assert.equal(originMain(), t.candidate.oid);
  });

  it('abandoned and conflict trains are refused; abandon is legal from tested and removes the worktree', () => {
    const { s, t, approve } = built();
    const ab = s.f(['land', '--abandon', t.trainId, '--json']);
    assert.equal(ab.status, 0, ab.stdout);
    assert.equal(fs.existsSync(t.worktree), false);
    assert.equal(approve().status, 3);
    assert.match(approve().json.reason, /train is abandoned/);
    assert.equal(s.f(['land', '--abandon', t.trainId]).status, 3, 'abandoning twice is refused');
    assert.equal(sessionRec(s.fx, 'feat-a').state, 'ready', 'the train never touched the sessions');
  });

  it('reconcile and confirm do not apply to a tested train', () => {
    const { s, t } = built();
    assert.match(s.f(['land', '--reconcile', t.trainId, '--json']).json.reason, /nothing to reconcile/);
    assert.match(s.f(['land', '--confirm', t.trainId, '--json']).json.reason, /not awaiting-merge|--confirm applies only/);
  });

  it('concurrent land operations are refused by the exclusive trains/.lock (not queued, not proceeded)', () => {
    const { s, t } = built();
    const inner = withTrainLock(fleetDirOf(s.fx), () => approveTrain({ cwd: s.fx.repo, trainId: t.trainId, deps: defaultDeps({ log: () => {} }) }));
    assert.equal(inner.ok, false);
    assert.match(inner.reason, /trains\/\.lock/);
    assert.equal(readTrain(fleetDirOf(s.fx), t.trainId).train.phase, 'tested', 'nothing happened');
    assert.equal(s.f(['land', '--approve', t.trainId]).status, 0, 'the lock was released afterwards');
  });

  it('the push is issued to the recorded pushUrl (asserted on the emitted git argv)', () => {
    const { s, t } = built();
    const calls = [];
    const real = defaultDeps({ log: () => {} });
    const deps = { ...real, git: (args, cwd, o) => { calls.push(args); return real.git(args, cwd, o); } };
    const r = approveTrain({ cwd: s.fx.repo, trainId: t.trainId, deps });
    assert.equal(r.ok, true, JSON.stringify(r));
    const push = calls.find((a) => a[0] === 'push');
    assert.equal(push[1], t.destination.pushUrl);
    assert.notEqual(push[1], 'origin');
    assert.equal(push[2], `${t.candidate.oid}:refs/heads/main`);
    assert.equal(push[3], `--force-with-lease=refs/heads/main:${t.destination.expectedOid}`);
  });
});

// ───────────────────────────────────────────────────────────────────────────
describe('crash between push-pending and landed -> reconcile from the remote\'s truth', () => {
  const cfg = { mergeMethod: 'direct-squash', testCommand: { tiers: [OK_TIER] } };
  function built() {
    const s = setup({ fleetConfig: cfg });
    readyBranch(s, 'feat-a', { 'a.txt': 'A\n' });
    const t = land(s).json.train;
    const crashApprove = (hooks, git2) => {
      const real = defaultDeps({ log: () => {} });
      try { approveTrain({ cwd: s.fx.repo, trainId: t.trainId, deps: { ...real, hooks, ...(git2 ? { git: git2(real) } : {}) } }); } catch (e) { assert.match(e.message, /simulated crash/); }
    };
    return { s, t, crashApprove, phase: () => readTrain(fleetDirOf(s.fx), t.trainId).train.phase };
  }

  it('killed BEFORE the push: push-pending -> abandon REFUSED -> reconcile returns to approved (remote == expectedOid) -> re-approvable', () => {
    const { s, t, crashApprove, phase } = built();
    crashApprove({ afterPushPending: () => { throw new Error('simulated crash'); } });
    assert.equal(phase(), 'push-pending');
    const ab = s.f(['land', '--abandon', t.trainId, '--json']);
    assert.equal(ab.status, 3);
    assert.match(ab.json.reason, /push-pending/);
    assert.equal(s.f(['land', '--approve', t.trainId]).status, 3, 'push-pending is not approvable until reconciled');
    const rec = s.f(['land', '--reconcile', t.trainId, '--json']);
    assert.equal(rec.status, 0, rec.stdout);
    assert.equal(rec.json.reconciled, 'approved');
    assert.equal(phase(), 'approved');
    assert.equal(readTrain(fleetDirOf(s.fx), t.trainId).train.reconciledFrom, 'push-pending');
    const again = s.f(['land', '--approve', t.trainId, '--json']);
    assert.equal(again.status, 0, again.stdout);
    assert.equal(git(['--git-dir', s.fx.origin, 'rev-parse', 'main'], s.fx.root), t.candidate.oid);
  });

  it('killed AFTER the real push: reconcile records landed (remote == candidate)', () => {
    const { s, t, crashApprove, phase } = built();
    crashApprove({}, (real) => (args, cwd, o) => { const r = real.git(args, cwd, o); if (args[0] === 'push') throw new Error('simulated crash'); return r; });
    assert.equal(phase(), 'push-pending');
    assert.equal(git(['--git-dir', s.fx.origin, 'rev-parse', 'main'], s.fx.root), t.candidate.oid, 'the push really happened');
    const rec = s.f(['land', '--reconcile', t.trainId, '--json']);
    assert.equal(rec.json.reconciled, 'landed');
    assert.equal(phase(), 'landed');
    assert.equal(sessionRec(s.fx, 'feat-a').state, 'done');
  });

  it('remote moved to something else: reconcile -> diverged naming both OIDs; abandon IS allowed from diverged', () => {
    const { s, t, crashApprove, phase } = built();
    crashApprove({ afterPushPending: () => { throw new Error('simulated crash'); } });
    const other = path.join(s.fx.root, 'other');
    git(['clone', '-q', s.fx.origin, other], s.fx.root);
    git(['config', 'user.email', 'o@o'], other); git(['config', 'user.name', 'O'], other);
    commitFile(other, 'x.txt', 'x\n'); git(['push', '-q', 'origin', 'main'], other);
    const theirs = git(['rev-parse', 'HEAD'], other);
    const rec = s.f(['land', '--reconcile', t.trainId, '--json']);
    assert.equal(rec.status, 3);
    assert.equal(rec.json.reconciled, 'diverged');
    assert.ok(rec.json.reason.includes(theirs.slice(0, 12)) && rec.json.reason.includes(t.candidate.oid.slice(0, 12)));
    assert.equal(phase(), 'diverged');
    assert.equal(s.f(['land', '--approve', t.trainId]).status, 3);
    assert.equal(s.f(['land', '--abandon', t.trainId]).status, 0);
    assert.equal(phase(), 'abandoned');
  });
});
