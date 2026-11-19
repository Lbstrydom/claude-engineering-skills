/**
 * @fileoverview Shared fixtures for the serial-landing suites: a pr-mode fleet train
 * with one ready session, an updated-head builder, and a scripted `gh`. Used by
 * tests/fleet-serial.test.mjs and tests/ship-train-recovery.test.mjs, so the two
 * cannot drift on how a serial landing is staged.
 *
 * @module tests/helpers/fleet-serial-fx
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { git } from './git.mjs';
import { defaultDeps } from '../../scripts/lib/fleet/train.mjs';
import { evidenceFromBucket, ev } from './fleet-ci-evidence-fx.mjs';
import { addBranch, installFakeGh, makeFleetRepo, prRow, runFleet, scrubbedEnv } from './fleet-repo.mjs';

export const REPO = 'o/n';
export const PR = 21;
export const ok = (doc) => ({ ok: true, status: 0, stdout: doc === undefined ? '' : JSON.stringify(doc), stderr: '' });

/** A pr-mode train with one ready session `feat` and a built (green) train. */
export function trainFx({ message } = {}) {
  const fx = makeFleetRepo({ fleetConfig: { mergeMethod: 'pr', testCommand: { tiers: [{ name: 'ok', command: ['node', '-e', '0'] }] } } });
  git(['add', '.fleet.json'], fx.repo); git(['commit', '-q', '-m', 'cfg'], fx.repo); git(['push', '-q', 'origin', 'main'], fx.repo);
  const fake = installFakeGh(fx.root);
  const env = scrubbedEnv({ FLEET_WORKTREE_ROOT: fx.wtRoot, ...fake.env }, { prependPath: [fake.bin] });
  const f = (args) => runFleet(args, { cwd: fx.repo, env });
  const base = git(['rev-parse', 'main'], fx.repo);
  const tested = addBranch(fx.repo, 'feat', { 'f.txt': 'f\n' }, message);
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
export function updatedHead(fx, tested, { foreign = false } = {}) {
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
 * A scripted gh. `views` is the sequence of `pr view` answers (the last repeats); `checks` the sequence of buckets ONE CI ASSESSMENT consumes
 * each (the last repeats); calls are recorded. `gh.assessCi` is the oracle seam the serial mechanics suites inject (`depsWith` carries it): it
 * derives evidence from the PR view last served and the next bucket, so these suites test the RUNNER's reaction to evidence. The real oracle's reads
 * are tested in fleet-assess-required-ci.test.mjs and driven through the real entry points in fleet-ci-admission.test.mjs.
 */
export function scriptedGh({ views, checks = [['pass']], onUpdate = () => ok({}), onMerge = () => ok() }) {
  const calls = []; let v = 0; let c = 0; let last = null;
  const gh = (args) => {
    calls.push(args);
    if (args[0] === 'api' && args.includes('PUT')) return onUpdate(args);
    if (args[0] === 'api' && /rules\/branches/.test(args[1])) return ok([]);
    if (args[0] === 'pr' && args[1] === 'merge') return onMerge(args);
    if (args[0] === 'pr' && args[1] === 'view') {
      const want = args[args.indexOf('--json') + 1];
      const doc = typeof views === 'function' ? views() : views[Math.min(v++, views.length - 1)];
      last = doc;
      return want === 'headRefOid' ? ok({ headRefOid: doc.headRefOid }) : ok(doc);
    }
    return { ok: false, status: 1, stdout: '', stderr: `unexpected gh ${args.join(' ')}`, reason: 'unexpected' };
  };
  gh.assessCi = ({ expectedBase, expectedHead, phase }) => {
    const bucket = checks[Math.min(c++, checks.length - 1)][0];
    const doc = last ?? (typeof views === 'function' ? views() : views[0]);
    if (phase === 'post-merge') { // the merged PR: the same view, now MERGED, with the scripted checks
      if (String(doc.state).toUpperCase() !== 'MERGED') return ev.ineligible('not-merged');
      return doc.baseRefName === expectedBase && doc.headRefOid === expectedHead ? evidenceFromBucket('pass', expectedHead) : ev.ineligible('head-moved', doc.headRefOid);
    }
    if (String(doc.state).toUpperCase() === 'MERGED') return ev.ineligible('merged');
    if (String(doc.state).toUpperCase() !== 'OPEN') return ev.ineligible('closed');
    if (doc.isDraft === true) return ev.ineligible('draft');
    if (doc.baseRefName !== expectedBase) return ev.ineligible('retargeted');
    if (doc.headRefOid !== expectedHead) return ev.ineligible('head-moved', doc.headRefOid);
    return evidenceFromBucket(bucket, expectedHead);
  };
  return { gh, calls };
}

export const view = (head, over = {}) => ({ state: 'OPEN', isDraft: false, headRefOid: head, baseRefName: 'main', mergeStateStatus: 'CLEAN', mergeCommit: null, url: `https://github.com/${REPO}/pull/${PR}`, ...over });
export const fast = { poll: 1, updatePoll: 1, updateWait: 200, mergeWait: 200 };
/** Deps over a scripted gh; its `assessCi` (when it has one) is the oracle seam the run asks. */
export const depsWith = (gh) => defaultDeps({ gh, log: () => {}, ...(gh.assessCi ? { assessCi: gh.assessCi } : {}) });

/**
 * A pr-mode train over `n` ready sessions `m1..mn` (PRs 21..), each adding its own file, so the claims are path-disjoint (as
 * `fleet claim` requires) and the built train has `n` sources in landing order. Returns what a ship-batch test needs.
 */
export function multiFx(n, { messages = [] } = {}) {
  const fx = makeFleetRepo({ fleetConfig: { mergeMethod: 'pr', testCommand: { tiers: [{ name: 'ok', command: ['node', '-e', '0'] }] } } });
  git(['add', '.fleet.json'], fx.repo); git(['commit', '-q', '-m', 'cfg'], fx.repo); git(['push', '-q', 'origin', 'main'], fx.repo);
  const fake = installFakeGh(fx.root);
  const env = scrubbedEnv({ FLEET_WORKTREE_ROOT: fx.wtRoot, ...fake.env }, { prependPath: [fake.bin] });
  const f = (args) => runFleet(args, { cwd: fx.repo, env });
  const base = git(['rev-parse', 'main'], fx.repo);
  const members = [];
  for (let k = 1; k <= n; k += 1) {
    const id = `m${k}`; const pr = PR + k - 1;
    const head = addBranch(fx.repo, id, { [`f${k}.txt`]: `f${k}\n` }, messages[k - 1]);
    git(['push', '-q', 'origin', `${head}:refs/pull/${pr}/head`], fx.repo);
    git(['push', '-q', 'origin', `${head}:refs/heads/${id}`], fx.repo); // the branch itself: a rollup member is admitted by its remote branch tip
    git(['checkout', '-q', id], fx.repo);
    assert.equal(f(['claim', '--id', id, '--intent', id, '--paths', `f${k}.txt`]).status, 0);
    assert.equal(f(['ready', '--id', id]).status, 0);
    git(['checkout', '-q', 'main'], fx.repo);
    members.push({ id, pr, head, tree: git(['rev-parse', `${head}^{tree}`], fx.repo) });
  }
  const rows = members.map((m) => prRow({ number: m.pr, branch: m.id, headOid: m.head, baseOid: base }));
  fake.setState({ list: rows, view: Object.fromEntries(rows.map((r) => [r.number, r])) });
  const built = f(['land', '--json']);
  assert.equal(built.status, 0, built.stdout + built.stderr);
  return { fx, base, members, trainId: built.json.train.trainId };
}
