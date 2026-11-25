/**
 * @fileoverview Two `/fleet` defects a VS Code host smoke run found (2026-11-24):
 *
 *   1. `git status` probes timed out at 5000 ms and a broad `fleet status` did not return. A timeout must read as
 *      UNMEASURED (never clean), the per-call timeout is an operator knob (`FLEET_GIT_STATUS_TIMEOUT_MS`), the two
 *      worktree sweeps share ONE budget, a read-only probe never rewrites the index (`GIT_OPTIONAL_LOCKS=0`), and
 *      prune's hooks-path guard reads each worktree once, under the status budget (it was N×M unbounded calls).
 *   2. A claim refused for an identical intent alone said "overlapping live work" over disjoint paths: the header
 *      now names the session and says "identical intent".
 */
import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

import { git } from './helpers/git.mjs';
import { cleanupFleetRoots, commitFile, makeFleetRepo, runFleet, scrubbedEnv } from './helpers/fleet-repo.mjs';
import { CLEAN_PROBE, GIT_STATUS_TIMEOUT_ENV, cleanProbeBounds, probeWorktrees, worktreeStatus } from '../scripts/lib/fleet/worktree-status.mjs';
import { runGit } from '../scripts/lib/fleet/git-facts.mjs';
import { buildStatusFrom, gatherFacts, probeSessionWorktrees } from '../scripts/lib/fleet/facts.mjs';
import { planPrune } from '../scripts/lib/fleet/prune.mjs';
import { fleetDir } from '../scripts/lib/fleet/registry.mjs';
import { decideClaim } from '../scripts/lib/fleet/overlap.mjs';
import { renderClaimVerdict } from '../scripts/lib/fleet/render.mjs';

after(cleanupFleetRoots);

describe('git status probe bounds (FLEET_GIT_STATUS_TIMEOUT_MS)', () => {
  it('unset, empty, zero, negative or non-numeric => the defaults (never 0, which spawnSync reads as no timeout)', () => {
    for (const v of [undefined, '', '0', '-5', 'abc', '12ms', '1.5']) {
      const b = cleanProbeBounds(v === undefined ? {} : { [GIT_STATUS_TIMEOUT_ENV]: v });
      assert.deepEqual([b.timeoutMs, b.deadlineMs, b.maxCandidates, b.configured], [CLEAN_PROBE.timeoutMs, CLEAN_PROBE.deadlineMs, CLEAN_PROBE.maxCandidates, false], `value ${JSON.stringify(v)}`);
    }
  });
  it('a positive integer sets the per-call timeout; the deadline grows to admit at least one probe', () => {
    assert.deepEqual(cleanProbeBounds({ [GIT_STATUS_TIMEOUT_ENV]: '2000' }), { timeoutMs: 2000, maxCandidates: CLEAN_PROBE.maxCandidates, deadlineMs: CLEAN_PROBE.deadlineMs, configured: true });
    assert.equal(cleanProbeBounds({ [GIT_STATUS_TIMEOUT_ENV]: '40000' }).deadlineMs, 40000);
    assert.equal(cleanProbeBounds({ [GIT_STATUS_TIMEOUT_ENV]: '2147483647' }).timeoutMs, 2147483647, 'the largest timer value is accepted');
  });
  it('a value the timer cannot hold (> 2^31-1 ms) => the defaults, never an unbounded or throwing probe', () => {
    for (const v of ['2147483648', '4294967296', '99999999999999']) assert.equal(cleanProbeBounds({ [GIT_STATUS_TIMEOUT_ENV]: v }).configured, false, v);
  });
  it('the exported defaults read the environment (worktreeStatus, probeWorktrees)', () => {
    const prior = process.env[GIT_STATUS_TIMEOUT_ENV];
    process.env[GIT_STATUS_TIMEOUT_ENV] = '4321';
    try {
      const seen = [];
      const git = (args, cwd, o) => { seen.push(o.timeoutMs); return { ok: true, stdout: '' }; };
      worktreeStatus('/wt/a', { git });
      probeWorktrees(['/wt/b'], { git });
      assert.deepEqual(seen, [4321, 4321]);
    } finally { if (prior === undefined) delete process.env[GIT_STATUS_TIMEOUT_ENV]; else process.env[GIT_STATUS_TIMEOUT_ENV] = prior; }
  });
  it('each probe gets the per-call timeout clipped to the budget left, so a sweep ends within its deadline', () => {
    let t = 0;
    const handed = [];
    probeWorktrees(['/a', '/b', '/c'], { clock: () => t, bounds: CLEAN_PROBE, deadlineAt: 12_000, probe: (d, o) => { handed.push(o.timeoutMs); t += o.timeoutMs; return { queried: false, reason: 'git status timed out' }; } });
    assert.deepEqual(handed, [5000, 5000, 2000], 'the last probe gets only the 2000 ms left, not a full 5000');
    assert.ok(t <= 12_000);
  });
  it('a timed-out probe is unmeasured and names the knob; another failure passes through unchanged', () => {
    const timedOut = worktreeStatus('/wt/a', { git: () => ({ ok: false, reason: 'git status timed out after 5000ms' }) });
    assert.equal(timedOut.queried, false);
    assert.match(timedOut.reason, /timed out after 5000ms — unmeasured, not clean \(set FLEET_GIT_STATUS_TIMEOUT_MS/);
    const other = worktreeStatus('/wt/a', { git: () => ({ ok: false, reason: 'git status exited 128: not a repo' }) });
    assert.equal(other.reason, 'git status exited 128: not a repo');
  });
  it('two sweeps sharing ONE deadline: the second pays nothing once the first spent it (control: own deadline probes)', () => {
    let t = 0;
    const clock = () => t;
    const probe = () => { t += 6000; return { queried: false, reason: 'git status timed out after 5000ms' }; };
    const deadlineAt = CLEAN_PROBE.deadlineMs;
    const first = probeWorktrees(['/a', '/b', '/c', '/d'], { clock, probe, deadlineAt });
    assert.equal(Object.values(first).filter((r) => /timed out/.test(r.reason)).length, 3, 'deadline + one timeout: 0, 6, 12 probed, 18 > 15 not');
    let calls = 0;
    const second = probeWorktrees(['/e', '/f'], { clock, probe: (d) => { calls += 1; return probe(d); }, deadlineAt });
    assert.equal(calls, 0, 'the shared budget is spent: no further git status');
    for (const r of Object.values(second)) { assert.equal(r.queried, false); assert.match(r.reason, /deadline .* unmeasured, not clean/); }
    // Control: without the shared deadline the second sweep starts its own budget and probes again.
    calls = 0;
    probeWorktrees(['/e', '/f'], { clock, probe: (d) => { calls += 1; return probe(d); } });
    assert.equal(calls, 2);
  });
});

describe('runGit never takes an optional lock (a read-only probe must not rewrite the index)', () => {
  it('status through runGit leaves .git/index byte-identical; control: plain git status rewrites it', () => {
    const fx = makeFleetRepo();
    const index = path.join(fx.repo, '.git', 'index');
    const touch = () => { const f = path.join(fx.repo, 'a.txt'); const when = new Date(Date.now() + 5000 + Math.random() * 1e6); fs.utimesSync(f, when, when); };
    const hash = () => crypto.createHash('sha256').update(fs.readFileSync(index)).digest('hex');
    touch();
    const before = hash();
    assert.equal(runGit(['status', '--porcelain'], fx.repo).ok, true);
    assert.equal(hash(), before, 'runGit status did not refresh-and-write the index');
    const env = { ...process.env }; delete env.GIT_OPTIONAL_LOCKS;
    spawnSync('git', ['status', '--porcelain'], { cwd: fx.repo, env, encoding: 'utf-8' });
    assert.notEqual(hash(), before, 'control: an ordinary git status DOES rewrite the index after a stat change');
  });
});

describe('a status item whose uncommitted probe did not answer', () => {
  it('says its uncommitted files were not measured (control: a measured probe adds no note)', () => {
    const fx = makeFleetRepo();
    const wt = path.join(fx.root, 'wt-s');
    git(['worktree', 'add', '-q', '-b', 'sess', wt, 'main'], fx.repo);
    commitFile(wt, 'a.txt', 'a2\n', 'sess work');
    const env = scrubbedEnv({ FLEET_TELEMETRY: 'off' });
    const claim = runFleet(['claim', '--id', 'sess', '--intent', 'session work', '--paths', 'a.txt', '--worktree', wt], { cwd: fx.repo, env });
    assert.equal(claim.status, 0, claim.stdout + claim.stderr);
    const facts = gatherFacts({ cwd: fx.repo, config: { baseBranch: 'main' }, now: new Date(), env, prs: false });
    assert.equal(facts.uncommitted.sess?.queried, true, 'precondition: the real probe measured the session worktree');
    const item = (f) => buildStatusFrom(f).items.find((i) => i.id === 'sess');
    assert.equal(item(facts).notes.some((n) => /uncommitted files not measured/.test(n)), false);
    const reason = 'git status timed out after 5000ms — unmeasured, not clean (set FLEET_GIT_STATUS_TIMEOUT_MS to allow longer)';
    const timedOut = { ...facts, uncommitted: { sess: { queried: false, files: [], worktree: wt, reason } } };
    assert.ok(item(timedOut).notes.includes(`uncommitted files not measured (${reason}): overlaps with them are unknown`), JSON.stringify(item(timedOut).notes));
  });
  it('an unreadable worktree list makes every live session UNMEASURED, never absent (control: terminal sessions are left out)', () => {
    const registry = { sessions: [{ id: 's1', state: 'working', source: { branch: 's1' }, worktree: '/wt/s1' }, { id: 's2', state: 'done', source: { branch: 's2' } }] };
    const out = probeSessionWorktrees({ registry, worktreeList: { queried: false, reason: 'git worktree list timed out after 15000ms' } });
    assert.deepEqual(out, { s1: { queried: false, files: [], worktree: '/wt/s1', reason: 'worktree list not read (git worktree list timed out after 15000ms)' } });
  });
});

describe('prune reads each worktree hooks location once, through the budgeted git', () => {
  it('two candidates, four worktrees: one core.hooksPath read per other worktree, all via the injected git', () => {
    const fx = makeFleetRepo({ fleetConfig: { archiveIgnore: ['node_modules/**', '.claude/**'] } });
    for (const b of ['at-base-1', 'at-base-2']) { git(['branch', b, 'main'], fx.repo); git(['worktree', 'add', '-q', path.join(fx.root, `wt-${b}`), b], fx.repo); }
    git(['worktree', 'add', '-q', '-b', 'busy', path.join(fx.root, 'wt-busy'), 'main'], fx.repo);
    commitFile(path.join(fx.root, 'wt-busy'), 'b.txt', 'b2\n', 'busy work');
    const ctx = { cwd: fx.repo, dir: fleetDir(fx.repo), config: { baseBranch: 'main', archiveIgnore: ['node_modules/**', '.claude/**'], staleWorktreeDays: 3 }, now: new Date(), env: scrubbedEnv({ FLEET_TELEMETRY: 'off' }), cmd: 'fleet' };
    const facts = gatherFacts({ cwd: fx.repo, config: ctx.config, now: ctx.now, env: ctx.env, prs: false });
    facts.prs = { queried: true, complete: true, prs: [] };
    const reads = new Map();
    const counting = (args, cwd, opts) => {
      if (args.includes('core.hooksPath')) reads.set(path.resolve(cwd).toLowerCase(), (reads.get(path.resolve(cwd).toLowerCase()) ?? 0) + 1);
      return runGit(args, cwd, opts);
    };
    const plan = planPrune(ctx, { facts, git: counting });
    assert.deepEqual(plan.candidates.map((c) => c.branch).sort(), ['at-base-1', 'at-base-2'], JSON.stringify(plan.excluded));
    assert.equal(reads.size, 4, `main + 3 linked worktrees, each read: ${JSON.stringify([...reads])}`);
    assert.deepEqual([...reads.values()], [1, 1, 1, 1], 'each worktree read ONCE, not once per candidate');
    // The budget runs out DURING a hooks read: that candidate is not judged — never removable, never "no dependents".
    let t = 0;
    let cut = false;
    const cutting = (args, cwd, opts) => {
      if (args.includes('core.hooksPath') && !cut) { cut = true; t = 1e9; return { ok: false, status: null, stdout: '', reason: 'git config timed out after 10ms' }; }
      return runGit(args, cwd, opts);
    };
    const short = planPrune(ctx, { facts, git: cutting, deadlineAt: 1e6, clock: () => t });
    assert.equal(cut, true, 'precondition: a hooks read was cut short');
    assert.equal(short.candidates.some((c) => c.worktree), false, JSON.stringify(short.candidates));
    assert.ok(short.unjudged >= 2, `both worktree candidates unjudged (got ${short.unjudged})`);
    assert.equal(short.excluded.some((e) => /hooks/.test(e.reason)), false, 'counted unjudged, not refused with a hooks reason');
  });
});

describe('identical-intent refusal names the session and the cause', () => {
  const others = (paths) => [{ session: { id: 'smoke-a', intent: 'Smoke  test', paths, state: 'working', knownOverlaps: [] }, live: true, changedFiles: [], uncommittedFiles: [] }];
  const claim = { id: 'smoke-b', intent: 'smoke test', paths: ['scratch/b/claim.txt'], knownOverlaps: [] };
  it('intent alone: BLOCKED, "identical intent to live session smoke-a (declared paths do not overlap)", with the way out', () => {
    const v = decideClaim({ claim, mode: 'new', others: others(['scratch/a/claim.txt']), complete: true });
    assert.equal(v.verdict, 'blocked', 'identical intent is a designed conflict (plan §admission), even over disjoint paths');
    const text = renderClaimVerdict(v, { id: 'smoke-b', cmd: 'fleet' });
    assert.match(text, /^BLOCKED for smoke-b: identical intent to live session smoke-a \(declared paths do not overlap\) — stop and report/);
    assert.match(text, /smoke-a: intent — identical intent \(no path or file overlap\)/);
    assert.match(text, /re-claim once with an --intent that names what is yours; if it is the same work, stop and report: smoke-a already holds it/);
    assert.doesNotMatch(text, /overlapping live work/);
  });
  it('control: paths AND intent keep the overlap header and no intent-only advice', () => {
    const v = decideClaim({ claim, mode: 'new', others: others(['scratch/b/**']), complete: true });
    const text = renderClaimVerdict(v, { id: 'smoke-b', cmd: 'fleet' });
    assert.match(text, /^BLOCKED for smoke-b: overlapping live work — stop and report/);
    assert.match(text, /smoke-a: paths\+intent — .*identical intent(?! \()/);
    assert.doesNotMatch(text, /re-claim once/);
  });
});
