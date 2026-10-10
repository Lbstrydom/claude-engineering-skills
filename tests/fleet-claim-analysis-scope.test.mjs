/**
 * @fileoverview /fleet — session-only verbs no longer diff every untracked branch.
 * Plan: docs/plans/fleet-claim-analysis-scope.md.
 *
 * `claim`, `add`, `ready` and `start` compare only against REGISTERED sessions
 * (`othersFor`), yet `gatherFacts` ran one `git diff` per branch ahead of base —
 * ~60 calls per claim in a repo with ~60 stale branches. `gatherFacts({untracked:false})`
 * skips them and records each as `{queried:false, reason}` (never an empty change set).
 *
 * The CLI tests count REAL git invocations with GIT_TRACE (which `sanitizeGitEnv`
 * keeps: it strips only repo-local variables), and each has a control that runs the
 * same repo through a verb that still analyses everything.
 */
import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { git } from './helpers/git.mjs';
import { gatherFacts, selectBranchesToAnalyse } from '../scripts/lib/fleet/facts.mjs';
import {
  addBranch, cleanupFleetRoots, makeFleetRepo, runFleet, scrubbedEnv,
} from './helpers/fleet-repo.mjs';

after(cleanupFleetRoots);

const branches = (list) => ({ queried: true, branches: list.map(([name, ahead, tipTime = 0]) => ({ name, ahead, tipTime, oid: `oid-${name}` })) });
const reg = (sessions) => ({ sessions, complete: true });
const sess = (id, branch, kind = 'branch') => ({ id, state: 'working', source: { kind, branch, prNumber: kind === 'pr' ? 7 : null } });

describe('selectBranchesToAnalyse', () => {
  const b = branches([['main', 0], ['mine', 2], ['u1', 3], ['u2', 1], ['prb', 4], ['merged', 0]]);
  const registry = reg([sess('mine', 'mine'), sess('pr-7', 'prb', 'pr')]);

  it('untracked:false keeps every registered session branch (a PR session\'s too) and lists the skipped ones', () => {
    const r = selectBranchesToAnalyse({ registry, branches: b, base: 'main', untracked: false });
    assert.deepEqual([...r.analyse].sort(), ['mine', 'prb']);
    assert.deepEqual(r.skippedUntracked.sort(), ['u1', 'u2']);
    assert.equal(r.names.has('prb'), true, 'the PR session\'s local branch stays a candidate, so its evidence path is unchanged');
  });
  it('control: the default analyses every branch ahead of base, skipping nothing', () => {
    const r = selectBranchesToAnalyse({ registry, branches: b, base: 'main' });
    assert.deepEqual([...r.analyse].sort(), ['mine', 'prb', 'u1', 'u2']);
    assert.deepEqual(r.skippedUntracked, []);
  });
  it('maxBranches still puts registered sessions first and lists the overflow', () => {
    const r = selectBranchesToAnalyse({ registry, branches: branches([['main', 0], ['mine', 1, 1], ['u1', 1, 9], ['u2', 1, 5]]), base: 'main', maxBranches: 2 });
    assert.deepEqual([...r.analyse].sort(), ['mine', 'u1']);
    assert.deepEqual(r.branchesNotAnalysed, { count: 1, names: ['u2'] });
  });
});

describe('gatherFacts({untracked:false}) over a real repo', () => {
  const scene = () => {
    const fx = makeFleetRepo();
    for (let i = 0; i < 5; i += 1) addBranch(fx.repo, `stale-${i}`, { [`s${i}.txt`]: `${i}\n` });
    return fx;
  };
  it('skipped branches are recorded as NOT QUERIED, never as an empty change set', () => {
    const fx = scene();
    const f = gatherFacts({ cwd: fx.repo, config: { baseBranch: 'main' }, now: new Date(), env: scrubbedEnv(), prs: false, patches: false, worktrees: false, untracked: false });
    for (let i = 0; i < 5; i += 1) {
      const c = f.changed[`stale-${i}`];
      assert.equal(c.queried, false);
      assert.match(c.reason, /not requested/);
    }
  });
  it('control: the default analyses all five', () => {
    const fx = scene();
    const f = gatherFacts({ cwd: fx.repo, config: { baseBranch: 'main' }, now: new Date(), env: scrubbedEnv(), prs: false, patches: false, worktrees: false });
    for (let i = 0; i < 5; i += 1) assert.deepEqual(f.changed[`stale-${i}`].files, [`s${i}.txt`]);
  });
});

describe('fleet CLI — git calls made by claim (GIT_TRACE)', () => {
  const STALE = 8;
  const setup = () => {
    const fx = makeFleetRepo();
    for (let i = 0; i < STALE; i += 1) addBranch(fx.repo, `stale-${i}`, { [`s${i}.txt`]: `${i}\n` });
    addBranch(fx.repo, 'a', { 'a/x.txt': 'x\n' });
    const trace = path.join(fx.root, 'git-trace.log');
    // FLEET_CACHE=off: these tests COUNT git processes, which the commit-id cache exists to avoid.
    const env = scrubbedEnv({ FLEET_WORKTREE_ROOT: fx.wtRoot, FLEET_CACHE: 'off' });
    const f = (args, traced = false) => {
      if (traced) fs.writeFileSync(trace, '');
      return runFleet(args, { cwd: fx.repo, env: traced ? { ...env, GIT_TRACE: trace } : env });
    };
    const diffs = () => fs.readFileSync(trace, 'utf8').split('\n').filter((l) => /built-in: git diff --name-only/.test(l)).length;
    git(['checkout', '-q', 'a'], fx.repo);
    // a declares docs/** but CHANGED a/x.txt, so a block on a/x.txt can only come from its changed files.
    assert.equal(f(['claim', '--id', 'a', '--intent', 'feature a', '--paths', 'docs/**']).status, 0);
    git(['checkout', '-q', 'main'], fx.repo);
    return { f, diffs };
  };

  it(`a claim diffs only the registered session's branch, not the ${STALE} untracked ones`, () => {
    const s = setup();
    const r = s.f(['claim', '--id', 'b', '--intent', 'feature b', '--paths', 'b/**'], true);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    // The claim gate diffs the registered session a; the checkpoint footer `claim` prints (fleet next) then
    // diffs each REGISTERED session once (a, b). None of the untracked branches is ever diffed.
    assert.equal(s.diffs(), 3, 'claim: session a; footer: sessions a and b — never the untracked ones');
  });
  it(`control: status still diffs every branch (the probe can see ${STALE + 1} diffs)`, () => {
    const s = setup();
    assert.equal(s.f(['status'], true).status, 0);
    assert.equal(s.diffs(), STALE + 1);
  });
  it('the claim gate still sees the registered session\'s changed files (blocks on a real overlap)', () => {
    const s = setup();
    const r = s.f(['claim', '--id', 'c', '--intent', 'feature c', '--paths', 'a/x.txt']);
    assert.equal(r.status, 3, r.stdout);
    assert.match(r.stdout, /a: files — files a\/x\.txt/);
  });
});
