/**
 * @fileoverview /fleet CLI — status facts: PR-backed sessions without a local
 * branch, base freshness upstream, PR evidence freshness and the overlap join,
 * and gatherFacts options for a read-only caller. Split from
 * tests/fleet-cli.test.mjs for wall time; harness: tests/helpers/fleet-cli-harness.mjs.
 */
import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { git } from './helpers/git.mjs';
import { addBranch, cleanupFleetRoots, commitFile, makeFleetRepo, prRow, writeFile } from './helpers/fleet-repo.mjs';
import { readyBranch, setup } from './helpers/fleet-cli-harness.mjs';
import { buildStatusFrom, gatherFacts, resolveUpstream, statusChecks } from '../scripts/lib/fleet/facts.mjs';

after(cleanupFleetRoots);

describe('status: PR-backed sessions without a local branch, and base freshness upstream', () => {
  it('a PR session with no local branch says changed files were NOT queried; after ready (materialised) they are read', () => {
    const s = setup({ gh: true });
    const base = git(['rev-parse', 'main'], s.fx.repo);
    const oid = addBranch(s.fx.repo, 'pr-branch', { 'p.txt': 'p\n' });
    git(['push', '-q', 'origin', `${oid}:refs/pull/7/head`], s.fx.repo);
    git(['branch', '-D', 'pr-branch'], s.fx.repo);
    s.fake.setState({ list: [prRow({ number: 7, branch: 'pr-branch', headOid: oid, baseOid: base })] });
    assert.equal(s.f(['add', '#7']).status, 0);
    const before = s.f(['status']);
    assert.match(before.stdout, /changed files not queried \(PR #7 is not materialised locally/);
    assert.equal(s.f(['ready', '--id', 'pr-7']).status, 0);
    const after = s.f(['status', '--json']);
    assert.doesNotMatch(after.stdout, /changed files not queried/);
    assert.deepEqual(after.json.status.items.find((i) => i.id === 'pr-7').changedFiles, ['p.txt']);
  });

  it('resolveUpstream: an open train\'s destination remote, then the configured upstream, then origin', () => {
    const fx = makeFleetRepo();
    assert.deepEqual(resolveUpstream(fx.repo, 'main', []), { upstream: 'origin/main', source: 'upstream' });
    git(['remote', 'rename', 'origin', 'up'], fx.repo);
    assert.deepEqual(resolveUpstream(fx.repo, 'main', []), { upstream: 'up/main', source: 'upstream' }, 'a base tracking a non-origin remote');
    const train = { phase: 'tested', createdAt: '2026-01-01T00:00:00Z', destination: { remote: 'mirror', ref: 'refs/heads/main' } };
    assert.deepEqual(resolveUpstream(fx.repo, 'main', [train]), { upstream: 'mirror/main', source: 'train' });
    assert.equal(resolveUpstream(fx.repo, 'main', [{ ...train, phase: 'landed' }]).source, 'upstream', 'a finished train no longer decides');
    git(['branch', '--unset-upstream', 'main'], fx.repo);
    assert.deepEqual(resolveUpstream(fx.repo, 'main', []), { upstream: 'origin/main', source: 'origin' });
  });

  it('end to end: status measures freshness against the non-origin upstream', () => {
    const s = setup();
    git(['remote', 'rename', 'origin', 'up'], s.fx.repo);
    const other = path.join(s.fx.root, 'other');
    git(['clone', '-q', s.fx.origin, other], s.fx.root);
    git(['config', 'user.email', 'o@o'], other); git(['config', 'user.name', 'O'], other);
    commitFile(other, 'theirs.txt', 'x\n'); git(['push', '-q', 'origin', 'main'], other);
    git(['fetch', '-q', 'up'], s.fx.repo);
    assert.match(s.f(['status']).stdout, /up\/main/);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// Audit round 3
describe('round 3: PR evidence freshness and ONE overlap join', () => {
  /** A tracked, branchless fork PR #9 changing shared.txt, materialised (ready), plus the fake-gh row to re-point. */
  function forkPr(extraFiles = {}) {
    const s = setup({ gh: true });
    const base = git(['rev-parse', 'main'], s.fx.repo);
    const oid = addBranch(s.fx.repo, 'fork-src', { 'shared.txt': 'from the fork\n', ...extraFiles });
    git(['push', '-q', 'origin', `${oid}:refs/pull/9/head`], s.fx.repo);
    git(['branch', '-D', 'fork-src'], s.fx.repo);
    const row = { ...prRow({ number: 9, branch: 'fork-src', headOid: oid, baseOid: base }), isCrossRepository: true };
    s.fake.setState({ list: [row] });
    assert.equal(s.f(['add', '#9']).status, 0);
    assert.equal(s.f(['ready', '--id', 'pr-9']).status, 0);
    return { s, oid, row };
  }
  const item = (st, id) => st.json.status.items.find((i) => i.id === id);

  it('H1: a materialised ref that is STALE against the PR head is not used - it is reported (A != B)', () => {
    const { s, oid, row } = forkPr();
    readyBranch(s, 'local-b', { 'shared.txt': 'local\n' });
    const fresh = s.f(['status', '--json']);
    assert.deepEqual(item(fresh, 'pr-9').changedFiles, ['shared.txt'], 'control: ref == PR head, evidence used');
    const B = 'b'.repeat(40);
    s.fake.setState({ list: [{ ...row, headRefOid: B }] });
    const stale = s.f(['status', '--json']);
    assert.deepEqual(item(stale, 'pr-9').changedFiles, [], 'stale evidence is NOT used');
    assert.deepEqual(item(stale, 'pr-9').overlaps, []);
    assert.ok(stale.stdout.includes(`materialised ref is stale (${oid.slice(0, 12)} != ${B.slice(0, 12)})`), stale.stdout);
  });

  it('H1: with PRs not queried (gh unusable) the head cannot be verified, so the ref evidence is not used either', () => {
    const { s } = forkPr();
    s.fake.setState({ authFail: true });
    const r = s.f(['status', '--json']);
    assert.deepEqual(item(r, 'pr-9').changedFiles, []);
    assert.match(r.stdout, /the PR head cannot be verified: PRs not queried/);
  });

  it('H2: a branchless tracked fork PR and an UNREGISTERED local branch both changing shared.txt overlap in BOTH directions', () => {
    const { s } = forkPr();
    addBranch(s.fx.repo, 'unreg', { 'shared.txt': 'unregistered\n' });
    const r = s.f(['status', '--json']);
    const pr = item(r, 'pr-9'); const un = item(r, 'unreg');
    assert.equal(un.tracked, false);
    assert.deepEqual(pr.overlaps.map((o) => [o.with, o.via, o.files, o.known]), [['unreg', ['files'], ['shared.txt'], false]]);
    assert.deepEqual(un.overlaps.map((o) => [o.with, o.via, o.files, o.known]), [['pr-9', ['files'], ['shared.txt'], false]]);
    assert.equal(pr.branch, null, 'the join stand-in never leaks into the output');
  });

  it('regression: registered-vs-registered overlap output is unchanged (one entry each way, no duplicates)', () => {
    const s = setup();
    readyBranch(s, 'alpha', { 'x.txt': 'a\n' }, { paths: 'alpha/**' });
    readyBranch(s, 'beta', { 'x.txt': 'b\n' }, { paths: 'beta/**' });
    const r = s.f(['status', '--json']);
    assert.deepEqual(item(r, 'alpha').overlaps, [{ with: 'beta', via: ['files'], files: ['x.txt'], known: false }]);
    assert.deepEqual(item(r, 'beta').overlaps, [{ with: 'alpha', via: ['files'], files: ['x.txt'], known: false }]);
  });
});

describe('gatherFacts options for a read-only caller (dashboard Home)', () => {
  it('checks:false makes statusChecks skip the consumer hook; the default runs it (positive control)', () => {
    const s = setup({ fleetConfig: { checks: [{ name: 'mark', script: 'hook.mjs', runner: ['node'], runIn: ['status'], severity: 'warn' }] } });
    const marker = path.join(s.fx.root, 'hook-ran.txt');
    writeFile(s.fx.repo, 'hook.mjs', `let b='';process.stdin.on('data',d=>b+=d);process.stdin.on('end',()=>{process.getBuiltinModule('node:fs').writeFileSync(${JSON.stringify(marker)},'ran');process.stdout.write('{"schemaVersion":1,"findings":[]}');});`);
    const config = s.config();
    const args = { cwd: s.fx.repo, config, now: new Date(), env: s.env, prs: false };

    const skipped = gatherFacts({ ...args, checks: false });
    assert.deepEqual(skipped.checks, { queried: false, reason: 'not requested' });
    const none = statusChecks({ cwd: s.fx.repo, config, status: buildStatusFrom(skipped), facts: skipped });
    assert.deepEqual(none, { results: [], findings: [] });
    assert.equal(fs.existsSync(marker), false, 'checks:false must never spawn the hook');

    const facts = gatherFacts(args);
    assert.equal('checks' in facts, false, 'the default facts object is unchanged');
    const ran = statusChecks({ cwd: s.fx.repo, config, status: buildStatusFrom(facts), facts });
    assert.equal(ran.results.length, 1);
    assert.equal(fs.existsSync(marker), true, 'positive control: without checks:false the hook DOES run');
  });

  it('maxBranches bounds the per-branch git calls and LISTS the overflow (never silently skipped)', () => {
    const s = setup();
    for (let i = 1; i <= 6; i += 1) addBranch(s.fx.repo, `feat-${i}`, { [`f${i}.txt`]: `${i}\n` });
    const args = { cwd: s.fx.repo, config: s.config(), now: new Date(), env: s.env, prs: false };

    const unbounded = gatherFacts(args);
    assert.equal(Object.keys(unbounded.changed).length, 6);
    assert.equal('branchesNotAnalysed' in unbounded, false, 'default facts are unchanged');

    const capped = gatherFacts({ ...args, maxBranches: 4 });
    assert.equal(Object.keys(capped.changed).length, 4, 'one changedFiles call per analysed branch only');
    assert.equal(Object.keys(capped.patchIds).length, 4);
    assert.equal(capped.branchesNotAnalysed.count, 2);
    assert.equal(capped.branchesNotAnalysed.names.length, 2);
    for (const n of capped.branchesNotAnalysed.names) assert.equal(n in capped.changed, false);
    assert.equal(capped.branches.branches.filter((b) => b.name.startsWith('feat-')).length, 6, 'the branches are still listed');

    const exact = gatherFacts({ ...args, maxBranches: 6 });
    assert.equal('branchesNotAnalysed' in exact, false, 'a cap that is not exceeded reports nothing');
  });

  it('M2: a materialised PR ref counts against maxBranches; the overflow is listed as not analysed (never silently analysed past the budget)', () => {
    const s = setup({ gh: true });
    const base = git(['rev-parse', 'main'], s.fx.repo);
    const oid = addBranch(s.fx.repo, 'fork-src', { 'p.txt': 'p\n' });
    git(['push', '-q', 'origin', `${oid}:refs/pull/9/head`], s.fx.repo);
    git(['branch', '-D', 'fork-src'], s.fx.repo);
    s.fake.setState({ list: [{ ...prRow({ number: 9, branch: 'fork-src', headOid: oid, baseOid: base }), isCrossRepository: true }] });
    assert.equal(s.f(['add', '#9']).status, 0);
    assert.equal(s.f(['ready', '--id', 'pr-9']).status, 0);
    const args = { cwd: s.fx.repo, config: s.config(), now: new Date(), env: s.env };

    const open = gatherFacts(args);
    assert.deepEqual(open.changed['pr:9'].files, ['p.txt'], 'positive control: unbounded, the PR ref IS analysed');

    const capped = gatherFacts({ ...args, maxBranches: 0 });
    assert.equal(capped.changed['pr:9'], undefined, 'the budget covers the PR-backed loop too');
    assert.deepEqual(capped.branchesNotAnalysed, { count: 1, names: ['pr:9'] });
    assert.ok(capped.findings.some((f) => /maxBranches budget is spent/.test(f.message)));
  });
});
