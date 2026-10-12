/**
 * @fileoverview /fleet CLI end to end — the non-squash merge methods: pr mode
 * (emits a plan, observes via gh) and direct-merge (--no-ff, structurally
 * verified). Split from tests/fleet-cli.test.mjs for wall time; harness:
 * tests/helpers/fleet-cli-harness.mjs.
 */
import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { git } from './helpers/git.mjs';
import { addBranch, cleanupFleetRoots, prRow } from './helpers/fleet-repo.mjs';
import { OK_TIER, fleetDirOf, land, originLog, readyBranch, sessionRec, setup } from './helpers/fleet-cli-harness.mjs';
import { readTrain } from '../scripts/lib/fleet/registry.mjs';
import { PR_APPROVE_FIELDS } from '../scripts/lib/fleet/train-approve.mjs';
import { PR_VIEW_FIELDS } from '../scripts/lib/fleet/gh-facts.mjs';

after(cleanupFleetRoots);

// ───────────────────────────────────────────────────────────────────────────
describe('pr mode: emits a plan, observes via gh', () => {
  const cfg = { mergeMethod: 'pr', testCommand: { tiers: [OK_TIER] } };

  function prFx() {
    const s = setup({ fleetConfig: cfg, gh: true });
    const base = git(['rev-parse', 'main'], s.fx.repo);
    const oidA = readyBranch(s, 'feat-a', { 'a.txt': 'A\n' });
    const oidB = readyBranch(s, 'feat-b', { 'b.txt': 'B\n' });
    const rows = [prRow({ number: 11, branch: 'feat-a', headOid: oidA, baseOid: base }), prRow({ number: 12, branch: 'feat-b', headOid: oidB, baseOid: base })];
    const view = Object.fromEntries(rows.map((r) => [r.number, r]));
    const state = { list: rows, view };
    s.fake.setState(state);
    return { s, base, oidA, oidB, rows, state, set: (v) => s.fake.setState({ ...state, view: v }) };
  }

  it('approve EMITS the ordered gh merge plan and leaves the train awaiting-merge — never landed, never executed', () => {
    const { s, oidA, oidB } = prFx();
    const built = land(s);
    assert.equal(built.status, 0, built.stdout + built.stderr);
    const t = built.json.train;
    assert.equal(t.mergeMethod, 'pr');
    assert.deepEqual(t.sources.map((x) => x.prNumber).sort(), [11, 12]);
    assert.equal(t.sources[0].baseRefOid, t.destination.expectedOid);
    const ap = s.f(['land', '--approve', t.trainId, '--json']);
    assert.equal(ap.status, 0, ap.stdout + ap.stderr);
    assert.equal(ap.json.train.phase, 'awaiting-merge');
    assert.equal(ap.json.landed, false);
    const cmds = ap.json.plan.map((p) => p.command.join(' '));
    assert.equal(cmds.length, 2);
    for (const [i, id] of t.sources.map((x) => x.id).entries()) {
      const oid = id === 'feat-a' ? oidA : oidB;
      assert.match(cmds[i], new RegExp(`^gh pr merge ${id === 'feat-a' ? 11 : 12} -R o/n --squash --match-head-commit ${oid}$`));
    }
    assert.match(ap.json.text, /each merge triggers its own post-merge run|NOTHING was executed/);
    assert.equal(s.fake.calls().some((c) => c[1] === 'merge'), false, 'fleet never ran gh pr merge');
    assert.equal(git(['--git-dir', s.fx.origin, 'rev-parse', 'main'], s.fx.root), t.destination.expectedOid, 'nothing was pushed');
    assert.equal(sessionRec(s.fx, 'feat-a').state, 'ready', 'not done: printing commands is never landing');
    assert.equal(s.f(['land', '--abandon', t.trainId, '--json']).status, 3, 'abandon refused in awaiting-merge');
  });

  it('every gh --json field fleet requests is a member of the recorded real field list', () => {
    const recorded = JSON.parse(fs.readFileSync(path.resolve('tests/fixtures/fleet/gh-pr-view-fields.json'), 'utf8'));
    const fields = recorded.view;
    for (const f of [...PR_APPROVE_FIELDS, ...PR_VIEW_FIELDS]) assert.ok(fields.includes(f), `${f} is a real gh pr view field`);
    const { s } = prFx();
    const t = land(s).json.train;
    s.f(['land', '--approve', t.trainId]);
    s.f(['land', '--confirm', t.trainId]);
    for (const c of s.fake.calls()) {
      const i = c.indexOf('--json');
      const known = c[0] === 'pr' && c[1] === 'checks' ? recorded.checks : fields;
      if (i >= 0) for (const f of c[i + 1].split(',')) assert.ok(known.includes(f), `${f} requested via gh ${c.slice(0, 2).join(' ')}`);
    }
  });

  it('--confirm with a fake gh reporting ONE of two PRs merged: still awaiting-merge', () => {
    const { s, rows, oidA, set } = prFx();
    const t = land(s).json.train;
    s.f(['land', '--approve', t.trainId]);
    set({ 11: { ...rows[0], state: 'MERGED', mergeCommit: { oid: 'c'.repeat(40) } }, 12: rows[1] });
    const c = s.f(['land', '--confirm', t.trainId, '--json']);
    assert.equal(c.status, 3);
    assert.equal(c.json.landed, false);
    assert.deepEqual(c.json.confirmations.map((x) => x.status).sort(), ['merged', 'open']);
    assert.equal(readTrain(fleetDirOf(s.fx), t.trainId).train.phase, 'awaiting-merge');
    void oidA;
  });

  it('--confirm: a PR merged into a DIFFERENT base, or with a CHANGED head, is merged-unexpected and the train stays awaiting-merge', () => {
    const { s, rows, set } = prFx();
    const t = land(s).json.train;
    s.f(['land', '--approve', t.trainId]);
    set({ 11: { ...rows[0], state: 'MERGED', baseRefName: 'release', mergeCommit: { oid: 'c'.repeat(40) } }, 12: { ...rows[1], state: 'MERGED', headRefOid: 'd'.repeat(40), mergeCommit: { oid: 'e'.repeat(40) } } });
    const c = s.f(['land', '--confirm', t.trainId, '--json']);
    assert.equal(c.status, 3);
    assert.deepEqual(c.json.confirmations.map((x) => x.status), ['merged-unexpected', 'merged-unexpected']);
    assert.match(c.json.reason, /MERGED UNEXPECTEDLY/);
    assert.equal(readTrain(fleetDirOf(s.fx), t.trainId).train.phase, 'awaiting-merge');
  });

  it('--confirm: a PR belonging to another repo does not count as merged', () => {
    const { s, rows, set } = prFx();
    const t = land(s).json.train;
    s.f(['land', '--approve', t.trainId]);
    set({ 11: { ...rows[0], state: 'MERGED', url: 'https://github.com/evil/fork/pull/11', mergeCommit: { oid: 'c'.repeat(40) } }, 12: { ...rows[1], state: 'MERGED', mergeCommit: { oid: 'e'.repeat(40) } } });
    const c = s.f(['land', '--confirm', t.trainId, '--json']);
    assert.equal(c.json.confirmations.find((x) => x.prNumber === 11).status, 'merged-unexpected');
  });

  it('--confirm with every PR observed merged as tested -> landed, sessions done', () => {
    const { s, rows, set } = prFx();
    const t = land(s).json.train;
    s.f(['land', '--approve', t.trainId]);
    set({ 11: { ...rows[0], state: 'MERGED', mergeCommit: { oid: 'c'.repeat(40) } }, 12: { ...rows[1], state: 'MERGED', mergeCommit: { oid: 'e'.repeat(40) } } });
    const c = s.f(['land', '--confirm', t.trainId, '--json']);
    assert.equal(c.status, 0, c.stdout + c.stderr);
    assert.equal(c.json.train.phase, 'landed');
    assert.equal(sessionRec(s.fx, 'feat-a').state, 'done');
    assert.equal(fs.existsSync(t.worktree), false);
  });

  it('approve re-checks each PR: a PR whose base moved (baseRefOid) or head changed is refused', () => {
    const { s, rows, set, base } = prFx();
    const t = land(s).json.train;
    set({ 11: { ...rows[0], baseRefOid: 'f'.repeat(40) }, 12: rows[1] });
    const r = s.f(['land', '--approve', t.trainId, '--json']);
    assert.equal(r.status, 3);
    assert.match(r.json.reason, /baseRefOid/);
    set({ 11: { ...rows[0], headRefOid: 'a'.repeat(40) }, 12: rows[1] });
    assert.match(s.f(['land', '--approve', t.trainId, '--json']).json.reason, /head moved/);
    set({});
    assert.match(s.f(['land', '--approve', t.trainId, '--json']).json.reason, /cannot be verified/);
    void base;
  });

  it('a branch-only source makes pr-mode construction REFUSE, naming it', () => {
    const s = setup({ fleetConfig: cfg, gh: true });
    readyBranch(s, 'feat-a', { 'a.txt': 'A\n' });
    const r = land(s);
    assert.equal(r.status, 3);
    assert.match(r.json.reason, /feat-a has no open PR — open a PR, or set mergeMethod to a direct mode/);
  });

  it('mixed baseRefs refuse construction', () => {
    const { s, rows, state } = prFx();
    s.fake.setState({ ...state, list: [rows[0], { ...rows[1], baseRefName: 'release' }] });
    const r = land(s);
    assert.equal(r.status, 3);
    assert.match(r.json.reason, /mixed targets/);
  });

  it('a PR baseRefOid that differs from the remote base refuses construction', () => {
    const { s, rows, state } = prFx();
    s.fake.setState({ ...state, list: [{ ...rows[0], baseRefOid: 'f'.repeat(40) }, rows[1]] });
    assert.match(land(s).json.reason, /does not equal the remote base/);
  });

  it('a pr-kind session (add #PR) is materialised via refs/pull/<n>/head, and a head mismatch is refused', () => {
    const s = setup({ fleetConfig: { mergeMethod: 'direct-squash', testCommand: { tiers: [OK_TIER] } }, gh: true });
    const base = git(['rev-parse', 'main'], s.fx.repo);
    const oid = addBranch(s.fx.repo, 'pr-src', { 'p.txt': 'p\n' });
    git(['push', '-q', 'origin', `${oid}:refs/pull/21/head`], s.fx.repo);
    git(['branch', '-D', 'pr-src'], s.fx.repo);
    s.fake.setState({ list: [prRow({ number: 21, branch: 'pr-src', headOid: oid, baseOid: base })] });
    assert.equal(s.f(['add', '#21']).status, 0);
    const rd = s.f(['ready', '--id', 'pr-21', '--json']);
    assert.equal(rd.status, 0, rd.stdout + rd.stderr);
    assert.equal(git(['rev-parse', 'refs/fleet/pr/21'], s.fx.repo), oid);
    const t = land(s);
    assert.equal(t.status, 0, t.stdout + t.stderr);
    assert.equal(s.f(['land', '--approve', t.json.train.trainId]).status, 0);
    assert.ok(originLog(s.fx).includes('work on pr-src'));
    // a PR whose headRefOid differs from the fetched head
    const s2 = setup({ gh: true });
    const base2 = git(['rev-parse', 'main'], s2.fx.repo);
    const oid2 = addBranch(s2.fx.repo, 'pr2', { 'q.txt': 'q\n' });
    git(['push', '-q', 'origin', `${oid2}:refs/pull/5/head`], s2.fx.repo);
    s2.fake.setState({ list: [prRow({ number: 5, branch: 'pr2', headOid: 'a'.repeat(40), baseOid: base2 })] });
    assert.equal(s2.f(['add', '#5']).status, 0);
    const r = s2.f(['ready', '--id', 'pr-5', '--json']);
    assert.equal(r.status, 3);
    assert.match(r.json.reason, /differs from expected/);
  });
});

// ───────────────────────────────────────────────────────────────────────────
describe('direct-merge: --no-ff merge commits, structurally verified', () => {
  it('a green --no-ff train and a green squash train are BOTH approvable (the first-parent-count check, not reachability)', () => {
    for (const method of ['direct-merge', 'direct-squash']) {
      const s = setup({ fleetConfig: { mergeMethod: method, testCommand: { tiers: [OK_TIER] } } });
      readyBranch(s, 'feat-a', { 'a.txt': 'A\n' });
      readyBranch(s, 'feat-b', { 'b.txt': 'B\n' });
      const t = land(s).json.train;
      const ap = s.f(['land', '--approve', t.trainId, '--json']);
      assert.equal(ap.status, 0, `${method}: ${ap.stdout}`);
      const parents = git(['--git-dir', s.fx.origin, 'rev-list', '--first-parent', '--parents', '-n', '1', 'main'], s.fx.root).split(' ').length - 1;
      assert.equal(parents, 1 + (method === 'direct-merge' ? 1 : 0), `${method}: merge commits have two parents`);
    }
  });
});
