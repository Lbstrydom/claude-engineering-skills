/**
 * @fileoverview /fleet CLI end to end — manifest-driven recovery (confirm,
 * reconcile, abandon) when .fleet.json is malformed or edited mid-train. Split
 * from tests/fleet-cli.test.mjs for wall time; harness:
 * tests/helpers/fleet-cli-harness.mjs.
 */
import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import { git } from './helpers/git.mjs';
import { cleanupFleetRoots, prRow, writeFile } from './helpers/fleet-repo.mjs';
import { OK_TIER, fleetDirOf, land, readyBranch, sessionRec, setup } from './helpers/fleet-cli-harness.mjs';
import { readTrain } from '../scripts/lib/fleet/registry.mjs';
import { approveTrain } from '../scripts/lib/fleet/train-approve.mjs';
import { defaultDeps } from '../scripts/lib/fleet/train.mjs';

after(cleanupFleetRoots);

describe('manifest-driven recovery works with a malformed .fleet.json', () => {
  const cfg = { mergeMethod: 'direct-squash', testCommand: { tiers: [OK_TIER] } };
  const corrupt = (s) => writeFile(s.fx.repo, '.fleet.json', '{ this is not json');

  it('control: a config-driven verb fails (exit 1) on the malformed file', () => {
    const s = setup({ fleetConfig: cfg });
    corrupt(s);
    assert.equal(s.f(['status']).status, 1);
  });

  it('--abandon succeeds', () => {
    const s = setup({ fleetConfig: cfg });
    readyBranch(s, 'feat-a', { 'a.txt': 'A\n' });
    const t = land(s).json.train;
    corrupt(s);
    const r = s.f(['land', '--abandon', t.trainId, '--json']);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.equal(readTrain(fleetDirOf(s.fx), t.trainId).train.phase, 'abandoned');
  });

  it('--reconcile succeeds (push-pending -> approved, remote untouched)', () => {
    const s = setup({ fleetConfig: cfg });
    readyBranch(s, 'feat-a', { 'a.txt': 'A\n' });
    const t = land(s).json.train;
    try { approveTrain({ cwd: s.fx.repo, trainId: t.trainId, deps: defaultDeps({ log: () => {}, hooks: { afterPushPending: () => { throw new Error('simulated crash'); } } }) }); } catch (e) { assert.match(e.message, /simulated crash/); }
    corrupt(s);
    const r = s.f(['land', '--reconcile', t.trainId, '--json']);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.equal(r.json.reconciled, 'approved');
  });

  it('--confirm succeeds and lands the train + writes the done cache (base branch comes from the manifest)', () => {
    const s = setup({ fleetConfig: { mergeMethod: 'pr', testCommand: { tiers: [OK_TIER] } }, gh: true });
    const base = git(['rev-parse', 'main'], s.fx.repo);
    const oid = readyBranch(s, 'feat-a', { 'a.txt': 'A\n' });
    const row = prRow({ number: 11, branch: 'feat-a', headOid: oid, baseOid: base });
    s.fake.setState({ list: [row], view: { 11: row } });
    const t = land(s).json.train;
    assert.equal(s.f(['land', '--approve', t.trainId]).status, 0);
    corrupt(s);
    s.fake.setState({ list: [row], view: { 11: { ...row, state: 'MERGED', mergeCommit: { oid: 'c'.repeat(40) } } } });
    const r = s.f(['land', '--confirm', t.trainId, '--json']);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.equal(sessionRec(s.fx, 'feat-a').state, 'done');
  });
});
