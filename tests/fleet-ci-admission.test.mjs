/**
 * @fileoverview The CI-evidence admission test (docs/plans/ci-evidence-oracle.md section 9, decision 9 and Amendment A): the test that would have
 * caught all four audit rounds of #395. It drives the REAL approval and serial entry points (`approveTrain`, `approveSerial`,
 * `approveShipBatch`, `resumeShipBatch`) with the REAL oracle (`assessRequiredCi`, never injected) over a scripted GitHub built on the recorded
 * fixtures' shapes. For EVERY non-permitting row it asserts the exact disposition AND zero `gh pr merge` calls (and, for approve, no plan and no
 * `awaiting-merge`); the positive controls PERMIT and merge exactly once, so an always-refuse implementation fails them.
 */
import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { git } from './helpers/git.mjs';
import { cleanupFleetRoots } from './helpers/fleet-repo.mjs';
import { ok, fast, depsWith, multiFx, trainFx } from './helpers/fleet-serial-fx.mjs';
import { failed, fixture, githubFake, OTHER_HEAD } from './helpers/fleet-github-fake.mjs';
import { approveTrain } from '../scripts/lib/fleet/train-approve.mjs';
import { approveSerial, readSerial, resumeSerial } from '../scripts/lib/fleet/serial.mjs';
import { readTrain } from '../scripts/lib/fleet/registry.mjs';
import { approveShipBatch, resumeShipBatch, writeShipBatch, SHIP_BATCH_SCHEMA } from '../scripts/lib/fleet/ship-batch.mjs';
import { CANONICAL_GRANT } from '../scripts/lib/fleet/coordinator-grant.mjs';
import { assessRequiredCi, decideCiAdmission } from '../scripts/lib/fleet/required-checks.mjs';

after(cleanupFleetRoots);

const APP = 15368;
const REPO = 'o/n';
const fleetDirOf = (repo) => path.join(git(['rev-parse', '--path-format=absolute', '--git-common-dir'], repo), 'fleet');
const tmpDirs = [];
after(() => { for (const d of tmpDirs) fs.rmSync(d, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }); });
const mkTmp = (p) => { const d = fs.mkdtempSync(path.join(os.tmpdir(), p)); tmpDirs.push(d); return d; };

const run = (head, { name = 'ci', status = 'completed', conclusion = 'success', app = APP, id = 1 } = {}) => ({ id, name, status, conclusion: status === 'completed' ? conclusion : null, head_sha: head, app: app === null ? null : { id: app } });
const runsDoc = (head, ...list) => ({ total_count: list.length, check_runs: list.map((r, i) => ({ ...run(head, r), id: i + 1 })) });
const rulesFor = (...ctx) => (ctx.length ? [{ type: 'required_status_checks', parameters: { required_status_checks: ctx.map((context) => ({ context, integration_id: APP })) } }] : []);
const branchDoc = (over = {}) => ({ protected: true, protection: { enabled: false, required_status_checks: { contexts: [], checks: [] } }, ...over });

/**
 * One scripted GitHub for PR `pr` of `REPO`, at `head`. `world.merged` flips when `gh pr merge` runs; `over` replaces endpoint answers (a value, a
 * `{__fail}` or a function of the world, so a row can change the evidence BETWEEN two assessments). The PR document is whatever `world.pr(w)` says.
 */
function github({ head, base, pr = 21, over = {} }) {
  const w = { merged: false, mergedBase: 'main', mergedHead: head, runReads: 0, prHead: head, draft: false, prBase: 'main', state: 'OPEN' };
  const doc = () => ({
    state: w.merged ? 'MERGED' : w.state, isDraft: w.draft, headRefOid: w.merged ? w.mergedHead : w.prHead, baseRefName: w.merged ? w.mergedBase : w.prBase, baseRefOid: base,
    mergeStateStatus: 'CLEAN', mergeCommit: w.merged ? { oid: 'e'.repeat(40) } : null, url: `https://github.com/${REPO}/pull/${pr}`,
  });
  const o = typeof over === 'function' ? over(w) : over; // a function of the world lets a row change the evidence BETWEEN two assessments
  const scenario = {
    pr: o.pr ?? (() => doc()),
    branch: o.branch ?? branchDoc(),
    rules: o.rules ?? rulesFor('ci'),
    checkRuns: o.checkRuns ?? (() => { w.runReads += 1; return runsDoc(head, {}); }),
    statuses: o.statuses ?? [],
  };
  const g = githubFake(scenario, { repo: REPO, head, prNumber: pr, onMerge: () => { w.merged = true; return ok(); } });
  return { w, ...g };
}

const APPROVE = { sleep: () => {}, timings: fast };
const EXPECT_REASON = {
  'stop-run': /CI evidence unknown/, 'refuse-member': /required checks (failed|not-run)|not a merge candidate|draft|closed/, retry: /required checks (pending|missing)|not a merge candidate/,
};

/** The rows. `over` builds the scenario overrides from the head; `disposition` is what the ONE table must say; `reason` what the entry point shows. */
const ROWS = [
  { name: 'classic protection ENABLED with required checks (classic-only)', over: () => ({ branch: branchDoc({ protection: { enabled: true, required_status_checks: { contexts: ['ci'], checks: [] } } }), rules: [] }), disposition: 'stop-run', fault: 'unsupported-classic-protection' },
  { name: 'mixed: a ruleset AND classic protection enabled', over: () => ({ branch: branchDoc({ protection: { enabled: true, required_status_checks: { contexts: ['lint'], checks: [] } } }) }), disposition: 'stop-run', fault: 'unsupported-classic-protection' },
  { name: 'ambiguous 404: the branch read 404s while the rules read would say []', over: () => ({ branch: failed(1, 'gh: Branch not found (HTTP 404)'), rules: [] }), disposition: 'stop-run', fault: 'transport' },
  { name: '403 on the rules', over: () => ({ rules: failed(1, 'HTTP 403') }), disposition: 'stop-run', fault: 'transport' },
  { name: 'incomplete pagination: a page shorter than total_count', over: (h) => ({ checkRuns: { ...runsDoc(h, {}), total_count: 2 } }), disposition: 'stop-run', fault: 'too-many-results' },
  { name: 'a rule type the oracle does not read (workflows)', over: () => ({ rules: [...rulesFor('ci'), { type: 'workflows', parameters: {} }] }), disposition: 'stop-run', fault: 'unsupported-rule-type' },
  { name: 'duplicate runs from the pinned app that disagree', over: (h) => ({ checkRuns: runsDoc(h, { conclusion: 'success' }, { conclusion: 'failure' }) }), disposition: 'stop-run', fault: 'duplicate-conflict' },
  { name: 'a commit status shares the required context', over: () => ({ statuses: [{ id: 1, context: 'ci', state: 'success' }] }), disposition: 'stop-run', fault: 'status-context-present' },
  { name: 'skipped', over: (h) => ({ checkRuns: runsDoc(h, { conclusion: 'skipped' }) }), disposition: 'refuse-member', tag: 'not-run' },
  { name: 'neutral', over: (h) => ({ checkRuns: runsDoc(h, { conclusion: 'neutral' }) }), disposition: 'refuse-member', tag: 'not-run' },
  { name: 'failed', over: (h) => ({ checkRuns: runsDoc(h, { conclusion: 'failure' }) }), disposition: 'refuse-member', tag: 'failed' },
  { name: 'wrong app: a same-name success from another app', over: (h) => ({ checkRuns: runsDoc(h, { app: 999 }) }), disposition: 'retry', tag: 'missing' },
  { name: 'pending', over: (h) => ({ checkRuns: runsDoc(h, { status: 'in_progress' }) }), disposition: 'retry', tag: 'pending' },
];
const POSITIVE = [
  { name: 'ruleset-only, the pinned check passed (the CES shape)', over: () => ({}), tag: 'passed' },
  { name: 'proven-empty: an unprotected branch and no rules (the AIO shape)', over: () => ({ branch: branchDoc({ protected: false }), rules: [], checkRuns: { total_count: 0, check_runs: [] } }), tag: 'none-required' },
];

describe('the table row by row: the REAL oracle gives the stated evidence, and the ONE mapper the stated disposition', () => {
  for (const r of [...ROWS, ...POSITIVE]) {
    it(r.name, () => {
      const head = 'a'.repeat(40);
      const g = github({ head, base: 'b'.repeat(40), over: r.over(head) });
      const e = assessRequiredCi({ repo: REPO, prNumber: 21, expectedBase: 'main', expectedHead: head }, g.deps);
      const d = decideCiAdmission(e);
      assert.equal(d.disposition, r.disposition ?? 'permit', JSON.stringify(e));
      if (r.fault) assert.equal(e.fault?.kind, r.fault);
      if (r.tag) assert.equal(e.tag, r.tag);
    });
  }
  it('config drift: a requiredChecks that disagrees with GitHub is stop-run, and [] is exactly "none"', () => {
    const head = 'a'.repeat(40); const g = github({ head, base: 'b'.repeat(40) });
    const at = (requiredChecks) => decideCiAdmission(assessRequiredCi({ repo: REPO, prNumber: 21, expectedBase: 'main', expectedHead: head, configAssertion: { requiredChecks } }, g.deps));
    assert.equal(at(['ci']).disposition, 'permit');
    assert.equal(at(['ci', 'lint']).disposition, 'stop-run');
    assert.equal(at([]).disposition, 'stop-run');
  });
  it('a missing or non-boolean isDraft is stop-run, never "not a draft"', () => {
    const head = 'a'.repeat(40);
    for (const mut of [(d) => { delete d.isDraft; }, (d) => { d.isDraft = 'false'; }]) {
      const g = github({ head, base: 'b'.repeat(40), over: { pr: () => { const d = { state: 'OPEN', isDraft: false, headRefOid: head, baseRefName: 'main' }; mut(d); return d; } } });
      assert.equal(decideCiAdmission(assessRequiredCi({ repo: REPO, prNumber: 21, expectedBase: 'main', expectedHead: head }, g.deps)).disposition, 'stop-run');
    }
  });
});

describe('the proven-empty path re-validates eligibility too (it returns none-required only after the FINAL PR read)', () => {
  const emptyOver = (w, mutate) => ({ branch: branchDoc({ protected: false }), rules: () => { mutate(w); return []; }, checkRuns: { total_count: 0, check_runs: [] } });
  for (const [name, mutate, code] of [['a draft', (w) => { w.draft = true; }, 'draft'], ['a retarget', (w) => { w.prBase = 'develop'; }, 'retargeted'], ['the PR closed', (w) => { w.state = 'CLOSED'; }, 'closed'], ['a head move', (w) => { w.prHead = OTHER_HEAD; }, 'head-moved']]) {
    it(`${name} appearing during the branch and rules reads is ineligible ${code}, never none-required`, () => {
      const head = 'a'.repeat(40);
      const g = github({ head, base: 'b'.repeat(40), over: (w) => emptyOver(w, mutate) });
      const e = assessRequiredCi({ repo: REPO, prNumber: 21, expectedBase: 'main', expectedHead: head }, g.deps);
      assert.deepEqual([e.tag, e.code], ['ineligible', code]);
      assert.notEqual(decideCiAdmission(e).disposition, 'permit');
    });
  }
  it('through the serial runner: zero merges when the PR turns draft during the proven-empty assessment', () => {
    const { fx, tested, base, trainId } = trainFx();
    const g = github({ head: tested, base, over: (w) => emptyOver(w, (x) => { x.draft = true; }) });
    const r = approveSerial({ cwd: fx.repo, trainId, deps: depsWith(g.gh), ...APPROVE, timeoutMs: 40 });
    assert.equal(g.merges.length, 0);
    assert.equal(r.ok, false);
  });
});

describe('land approve (pr mode): only a permit prints a plan; every other row refuses with NO plan and NO awaiting-merge', () => {
  const approve = (over, config) => {
    const { fx, tested, base, trainId } = trainFx();
    const g = github({ head: tested, base, over: (w) => over(tested, w) });
    const r = approveTrain({ cwd: fx.repo, trainId, deps: depsWith(g.gh), ...(config ? { requiredChecks: config } : {}) });
    return { r, g, phase: readTrain(fleetDirOf(fx.repo), trainId).train.phase, tested };
  };
  for (const row of ROWS) {
    it(`${row.name} -> refused, no plan, train not awaiting-merge, zero merges`, () => {
      const { r, g, phase } = approve(row.over);
      assert.equal(r.ok, false, JSON.stringify(r).slice(0, 300));
      assert.equal(r.plan, undefined);
      assert.notEqual(phase, 'awaiting-merge');
      assert.equal(g.merges.length, 0);
      assert.match(r.reason, EXPECT_REASON[row.disposition]);
    });
  }
  for (const row of POSITIVE) {
    it(`control: ${row.name} -> the plan, awaiting-merge, with the point-in-time note, and still zero merges (approve never executes)`, () => {
      const { r, g, phase, tested } = approve(row.over);
      assert.equal(r.ok, true, JSON.stringify(r).slice(0, 300));
      assert.equal(r.plan.length, 1);
      assert.ok(r.plan[0].command.includes(tested));
      assert.equal(phase, 'awaiting-merge');
      assert.match(r.ciEvidence, /point-in-time/);
      assert.equal(g.merges.length, 0);
    });
  }
  it('config drift refuses; the SAME config cannot rescue an unreadable inventory', () => {
    assert.equal(approve(() => ({}), ['ci', 'lint']).r.ok, false);
    const rescued = approve(() => ({ rules: failed(1, 'HTTP 502') }), ['ci']);
    assert.equal(rescued.r.ok, false);
    assert.match(rescued.r.reason, /CI evidence unknown \(transport/);
  });
  it('a missing isDraft refuses', () => {
    const { r } = approve((h) => ({ pr: () => ({ state: 'OPEN', headRefOid: h, baseRefName: 'main', baseRefOid: null, url: `https://github.com/${REPO}/pull/21` }) }));
    assert.equal(r.ok, false);
  });
});

describe('land --approve --serial (plain): the oracle gates the merge, and ZERO merge calls for every non-permit', () => {
  const serial = (over, opts = {}) => {
    const { fx, tested, base, trainId } = trainFx();
    const g = github({ head: tested, base, over: typeof over === 'function' ? (w) => over(tested, w) : over });
    const r = approveSerial({ cwd: fx.repo, trainId, deps: depsWith(g.gh), ...APPROVE, timeoutMs: 40, ...opts });
    return { r, g, fx, trainId, tested, record: () => readSerial(fleetDirOf(fx.repo), trainId).run };
  };
  for (const row of ROWS) {
    it(`${row.name} -> ${row.disposition}, zero merges`, () => {
      const { r, g } = serial(row.over);
      assert.equal(g.merges.length, 0);
      assert.equal(r.ok, false, JSON.stringify(r).slice(0, 300));
      assert.equal(r.resumable, true);
      assert.match(r.reason, row.disposition === 'refuse-member' ? /required checks/ : row.disposition === 'stop-run' ? /CI evidence unknown/ : /required checks (pending|missing)/);
    });
  }
  for (const row of POSITIVE) {
    it(`control: ${row.name} -> merges exactly once, pinned to the evidence head, then verifies the merge`, () => {
      const { r, g, tested } = serial(row.over);
      assert.equal(r.ok, true, JSON.stringify(r).slice(0, 300));
      assert.equal(g.merges.length, 1);
      assert.equal(g.merges[0][g.merges[0].indexOf('--match-head-commit') + 1], tested);
    });
  }
  it('head moved mid-observation (the PR re-pushed between the wait loop and the merge site) -> no merge', () => {
    const { r, g } = serial((h, w) => ({ checkRuns: () => { w.runReads += 1; if (w.runReads >= 2) w.prHead = OTHER_HEAD; return runsDoc(h, {}); } }));
    assert.equal(r.ok, false);
    assert.equal(g.merges.length, 0);
  });
  it('STALE GREEN: green at the wait loop, red at the merge-site re-assessment -> no merge (a recorded green is never replayed)', () => {
    let reads = 0;
    const { r, g } = serial((h) => ({ checkRuns: () => { reads += 1; return reads >= 2 ? runsDoc(h, { conclusion: 'failure' }) : runsDoc(h, {}); } }));
    assert.equal(g.merges.length, 0);
    assert.equal(r.ok, false);
    assert.match(r.reason, /required checks failed/);
    assert.ok(reads >= 2, 'the merge site re-assessed');
  });
  it('a resume after a stop re-assesses: green recorded earlier, red now -> no merge', () => {
    let red = false;
    const first = serial((h) => ({ checkRuns: () => (red ? runsDoc(h, { conclusion: 'failure' }) : runsDoc(h, { status: 'in_progress' })) }));
    assert.equal(first.g.merges.length, 0);
    red = true;
    const g2 = github({ head: first.tested, base: 'b'.repeat(40), over: { checkRuns: () => runsDoc(first.tested, { conclusion: 'failure' }) } });
    const r2 = resumeSerial({ cwd: first.fx.repo, trainId: first.trainId, deps: depsWith(g2.gh), sleep: () => {}, timings: fast });
    assert.equal(r2.ok, false);
    assert.equal(g2.merges.length, 0);
  });
  it('a draft or a retarget appearing between the wait loop and the merge site -> no merge (Amendment A item 1)', () => {
    for (const mut of [(w) => { w.draft = true; }, (w) => { w.prBase = 'develop'; }]) {
      const { r, g } = serial((h, w) => ({ checkRuns: () => { w.runReads += 1; if (w.runReads >= 2) mut(w); return runsDoc(h, {}); } }));
      assert.equal(g.merges.length, 0);
      assert.equal(r.ok, false);
    }
  });
  it('unchanged between the two assessments -> exactly one merge, pinned to the FRESH head (the control for the rows above)', () => {
    const { r, g, tested } = serial((h, w) => ({ checkRuns: () => { w.runReads += 1; return runsDoc(h, {}); } }));
    assert.equal(r.ok, true);
    assert.equal(g.merges.length, 1);
    assert.equal(g.merges[0][g.merges[0].indexOf('--match-head-commit') + 1], tested);
    assert.ok(g.w.runReads >= 3, 'wait loop, merge site and post-merge each read the runs');
  });
});

describe('post-merge verification (Amendment A item 2): each check holds on the positive row and halts the run when broken', () => {
  /** `after(w, head)` mutates the world once the merge ran, so the fresh post-merge reads see it. */
  const verify = (after_) => {
    const { fx, tested, base, trainId } = trainFx();
    const g = github({ head: tested, base });
    const gh = (args) => { const res = g.gh(args); if (args[1] === 'merge') after_(g.w, tested); return res; };
    const r = approveSerial({ cwd: fx.repo, trainId, deps: depsWith(gh), ...APPROVE });
    return { r, g };
  };
  it('everything holds -> landed', () => {
    const { r, g } = verify(() => {});
    assert.equal(r.ok, true);
    assert.equal(g.merges.length, 1);
  });
  it('merged into ANOTHER base -> merged-unverified, a loud stop, not success', () => {
    const { r } = verify((w) => { w.mergedBase = 'develop'; });
    assert.equal(r.ok, false);
    assert.match(r.reason, /merged-unverified.*merged into develop, not main/);
  });
  it('merged at ANOTHER head -> merged-unverified', () => {
    const { r } = verify((w) => { w.mergedHead = OTHER_HEAD; });
    assert.equal(r.ok, false);
    assert.match(r.reason, /merged-unverified.*merged at head/);
  });
  it('the required check is SKIPPED when read after the merge -> merged-unverified', () => {
    const { fx, tested, base, trainId } = trainFx();
    const g = github({ head: tested, base, over: { checkRuns: () => (g.w.merged ? runsDoc(tested, { conclusion: 'skipped' }) : runsDoc(tested, {})) } });
    const r = approveSerial({ cwd: fx.repo, trainId, deps: depsWith(g.gh), ...APPROVE });
    assert.equal(r.ok, false);
    assert.match(r.reason, /merged-unverified.*required checks not-run/);
  });
  it('a run STILL PENDING after the merge is not proven either -> merged-unverified (the verification contract is "success now")', () => {
    const { fx, tested, base, trainId } = trainFx();
    const g = github({ head: tested, base, over: { checkRuns: () => (g.w.merged ? runsDoc(tested, { status: 'in_progress' }) : runsDoc(tested, {})) } });
    const r = approveSerial({ cwd: fx.repo, trainId, deps: depsWith(g.gh), ...APPROVE });
    assert.equal(r.ok, false);
    assert.match(r.reason, /merged-unverified.*pending/);
  });
});

describe('a merge queue is NOT built: a base whose rules carry merge_queue stops the run with zero merges (the unchanged behaviour, pinned)', () => {
  it('plain serial', () => {
    const { fx, tested, base, trainId } = trainFx();
    const g = github({ head: tested, base, over: { rules: [...rulesFor('ci'), { type: 'merge_queue', parameters: {} }] } });
    const r = approveSerial({ cwd: fx.repo, trainId, deps: depsWith(g.gh), ...APPROVE });
    assert.equal(r.ok, false);
    assert.equal(g.merges.length, 0);
    assert.match(r.reason, /unsupported-rule-type|merge_queue/);
  });
});

describe('ship-batch (the policy serial runner), with the REAL oracle', () => {
  /** A built train, the write-once record, a valid grant, and a scripted GitHub over EVERY member PR. */
  function batch(n, over = {}) {
    const { fx, members, trainId } = multiFx(n, { messages: Array.from({ length: n }, (_, i) => `feat: the thing ${i + 1}\n\nAI-Skill: ship\nAI-Gate: converged`) });
    const dir = fleetDirOf(fx.repo);
    const train = readTrain(dir, trainId).train;
    const grantFile = path.join(mkTmp('grant-'), 'CLAUDE.md');
    fs.writeFileSync(grantFile, `# rules\n\n${CANONICAL_GRANT.replace('Since <DATE>:', 'Since 2026-11-18:')}\n`);
    writeShipBatch(dir, {
      schemaVersion: SHIP_BATCH_SCHEMA, trainId, grantVersion: 'v1', checkedAt: new Date().toISOString(), base: 'main', remote: train.destination.remote, candidateTree: train.candidate.tree,
      members: members.map((m) => ({ id: m.id, repo: REPO, prNumber: m.pr, oid: m.head, tree: m.tree, worktree: fx.repo })), excluded: [],
    });
    const shipBatch = { grantFile, checkChild: () => ({ ok: true, reasons: [], envelope: {} }) };
    const baseOid = train.destination.expectedOid;
    // One fake per member PR (each has its own head), dispatched by PR number; a merge makes that member's PR MERGED.
    const fakes = new Map(members.map((m) => [m.pr, github({ head: m.head, base: baseOid, pr: m.pr, over: typeof over === 'function' ? (w) => over(m, w) : over })]));
    const all = [];
    const first = fakes.get(members[0].pr);
    const gh = (args) => {
      if (args[0] === 'pr') { const f = fakes.get(Number(args[2])); if (!f) return { ok: false, status: 1, stdout: '', stderr: 'no such pr', reason: 'x' }; if (args[1] === 'merge') all.push(args); return f.gh(args); }
      if (args[0] === 'api') { const m = members.find((x) => args[1].includes(x.head)); return (m ? fakes.get(m.pr) : first).gh(args); } // runs and statuses are per head; the branch and rules reads are alike
      return { ok: false, status: 1, stdout: '', stderr: `unexpected ${args.join(' ')}`, reason: 'unexpected' };
    };
    return { fx, members, trainId, dir, shipBatch, gh, merges: all, fakes };
  }
  const mk = (b) => ({ cwd: b.fx.repo, dir: b.dir, trainId: b.trainId, deps: { ...depsWith(b.gh), shipBatch: b.shipBatch }, serialOpts: { sleep: () => {}, timings: fast, timeoutMs: 40 } });
  for (const row of ROWS) {
    it(`${row.name} -> approveShipBatch makes zero merges and the run does not report success`, () => {
      const b = batch(1, (m, w) => row.over(m.head, w));
      const r = approveShipBatch(mk(b));
      assert.equal(b.merges.length, 0);
      assert.equal(r.ok, false, String(r.text).slice(0, 300));
      const rec = readSerial(b.dir, b.trainId).run;
      assert.ok(!rec.steps.some((s) => s.outcome?.status === 'landed'));
      const o = rec.steps[0].outcome;
      if (row.disposition === 'stop-run') { assert.equal(rec.outcome?.status, 'stopped'); assert.match(rec.outcome.reason, /CI evidence unknown|rules-unreadable/, 'a policy run reads the rules itself first (merge-queue exclusion): an unreadable rules answer is a run stop there too'); assert.ok(o === null || o === undefined, 'a RUN stop records nothing against the member'); }
      else if (row.disposition === 'refuse-member') assert.deepEqual([o.status, o.code], ['refused', 'checks-failed']);
      else assert.deepEqual([o.status, o.code], ['not-run', 'checks-pending']);
    });
  }
  it('STALE GREEN across a resume: first approve stops on pending, the resume sees red -> no merge', () => {
    let red = false;
    const b = batch(1, (m) => ({ checkRuns: () => (red ? runsDoc(m.head, { conclusion: 'failure' }) : runsDoc(m.head, { status: 'in_progress' })) }));
    approveShipBatch(mk(b));
    red = true;
    const r = resumeShipBatch(mk(b));
    assert.equal(b.merges.length, 0);
    assert.equal(r.ok, false);
  });
});
