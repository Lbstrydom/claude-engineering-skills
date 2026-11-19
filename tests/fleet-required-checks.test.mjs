/**
 * @fileoverview /fleet — required checks must have RUN (plan
 * docs/plans/fleet-consumer-feedback-oct.md §2.2, wine-cellar-app item 7).
 *
 * wine #802 merged three seconds after ready on draft-time SKIPPED checks:
 * GitHub (and fleet's old rollup) counted a skipped check as passing. Pinned:
 * the inventory is ASKED, never inferred; a required check observed as skipped
 * is `not-run`, one never observed is `missing`; the observation is bound to a
 * head; pr-mode approval refuses a draft and anything but a `permit` from the one
 * CI-evidence oracle (pending, missing and unknown included: no plan is printed on
 * a check that has not passed). The disposition table is pinned at the end.
 */
import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import { git } from './helpers/git.mjs';
import {
  CI_DISPOSITIONS, CI_EVIDENCE_TAGS, CI_FAULT_KINDS, CI_INELIGIBLE_CODES, decideCiAdmission, describeEvidence,
} from '../scripts/lib/fleet/required-checks.mjs';
import { prWarnings, summariseChecks } from '../scripts/lib/fleet/gh-facts.mjs';
import { parseFleetConfig } from '../scripts/lib/fleet/config.mjs';
import {
  addBranch, cleanupFleetRoots, installFakeGh, makeFleetRepo, prRow, runFleet, scrubbedEnv,
} from './helpers/fleet-repo.mjs';

after(cleanupFleetRoots);


describe('.fleet.json requiredChecks is an ASSERTION: absent stays absent, [] is kept', () => {
  it('config schema: requiredChecks absent stays absent; [] is kept', () => {
    assert.equal('requiredChecks' in parseFleetConfig({}).value, false);
    assert.deepEqual(parseFleetConfig({ requiredChecks: [] }).value.requiredChecks, []);
  });
});

describe('rollup + PR warnings', () => {
  it('the skipped count covers the whole rollup, even after a failure (C1-L1)', () => {
    assert.deepEqual(summariseChecks([{ conclusion: 'FAILURE' }, { conclusion: 'SKIPPED' }]), { state: 'failure', total: 2, skipped: 1 });
  });
  it('a skipped check is counted, not folded silently into success', () => {
    assert.deepEqual(summariseChecks([{ status: 'COMPLETED', conclusion: 'SUCCESS' }, { status: 'COMPLETED', conclusion: 'SKIPPED' }]), { state: 'success', total: 2, skipped: 1 });
    assert.deepEqual(summariseChecks([{ status: 'COMPLETED', conclusion: 'SUCCESS' }]), { state: 'success', total: 1 });
  });
  it('draft + auto-merge warns; a hung green CLEAN auto-merge warns after 15 min; a fresh one does not (control)', () => {
    const now = Date.parse('2026-10-09T12:00:00Z');
    assert.match(prWarnings({ number: 5, isDraft: true, autoMerge: true }, now)[0], /DRAFT with auto-merge/);
    const hung = { number: 6, isDraft: false, autoMerge: true, mergeState: 'CLEAN', checks: { state: 'success' }, updatedAt: '2026-10-09T11:00:00Z' };
    assert.match(prWarnings(hung, now)[0], /may be hung/);
    assert.deepEqual(prWarnings({ ...hung, updatedAt: '2026-10-09T11:55:00Z' }, now), []);
    assert.deepEqual(prWarnings({ ...hung, checks: { state: 'success', skipped: 1 } }, now), [], 'a rollup with skipped checks never earns a re-arm suggestion (C1-R3-H1)');
    assert.match(prWarnings(hung, now)[0], /--required/);
    assert.deepEqual(prWarnings({ number: 7, isDraft: false, autoMerge: false }, now), []);
  });
});

describe('pr-mode approve — the gate on a real train (the REAL oracle, through the real CLI and a scripted gh)', () => {
  const APP = 15368;
  const run = (name, conclusion = 'success', status = 'completed', app = APP) => ({ id: 1, name, status, conclusion: status === 'completed' ? conclusion : null, head_sha: null, app: { id: app } });
  const setup = (fleetConfigExtra = {}) => {
    const fx = makeFleetRepo({ fleetConfig: { mergeMethod: 'pr', testCommand: { tiers: [{ name: 'ok', command: ['node', '-e', '0'] }] }, ...fleetConfigExtra } });
    git(['add', '.fleet.json'], fx.repo); git(['commit', '-q', '-m', 'cfg'], fx.repo); git(['push', '-q', 'origin', 'main'], fx.repo);
    const fake = installFakeGh(fx.root);
    const env = scrubbedEnv({ FLEET_WORKTREE_ROOT: fx.wtRoot, ...fake.env }, { prependPath: [fake.bin] });
    const f = (args) => runFleet(args, { cwd: fx.repo, env });
    const base = git(['rev-parse', 'main'], fx.repo);
    const oid = addBranch(fx.repo, 'feat', { 'f.txt': 'f\n' });
    git(['checkout', '-q', 'feat'], fx.repo);
    assert.equal(f(['claim', '--id', 'feat', '--intent', 'feat', '--paths', 'f.txt']).status, 0);
    assert.equal(f(['ready', '--id', 'feat']).status, 0);
    git(['checkout', '-q', 'main'], fx.repo);
    const row = prRow({ number: 21, branch: 'feat', headOid: oid, baseOid: base });
    const api = (over = {}) => ({
      'GET repos/o/n/branches/main': { body: { protected: true, protection: { enabled: false, required_status_checks: { contexts: [], checks: [] } } } },
      'GET repos/o/n/rules/branches/main?per_page=100': { body: [{ type: 'required_status_checks', parameters: { required_status_checks: [{ context: 'ci', integration_id: APP }] } }] },
      [`GET repos/o/n/commits/${oid}/check-runs?filter=latest&per_page=100`]: { body: { total_count: 1, check_runs: [{ ...run('ci'), head_sha: oid }] } },
      [`GET repos/o/n/commits/${oid}/statuses?per_page=100`]: { body: [] },
      ...over,
    });
    const runs = (...list) => ({ body: { total_count: list.length, check_runs: list.map((r, i) => ({ ...r, id: i + 1, head_sha: oid })) } });
    const state = (over = {}) => ({ list: [row], view: { 21: row }, api: api(), ...over });
    fake.setState(state());
    const built = f(['land', '--json']);
    assert.equal(built.status, 0, built.stdout + built.stderr);
    return { f, fake, state, api, runs, oid, row, trainId: built.json.train.trainId };
  };
  const approve = (s) => s.f(['land', '--approve', s.trainId, '--json']);

  it('a required check SKIPPED on the head → approval refused, naming it (the #802 defect), and no plan', () => {
    const s = setup();
    s.fake.setState(s.state({ api: s.api({ [`GET repos/o/n/commits/${s.oid}/check-runs?filter=latest&per_page=100`]: s.runs(run('ci', 'skipped')) }) }));
    const ap = approve(s);
    assert.equal(ap.status, 3, ap.stdout);
    assert.match(ap.json.reason, /required checks not-run: ci/);
    assert.equal(ap.json.plan, undefined);
  });
  it('a DRAFT PR → refused with the ready-then-run remedy', () => {
    const s = setup();
    s.fake.setState(s.state({ view: { 21: { ...s.row, isDraft: true } } }));
    const ap = approve(s);
    assert.equal(ap.status, 3);
    assert.match(ap.json.reason, /DRAFT/);
  });
  it('an absent isDraft refuses (never "not a draft")', () => {
    const s = setup();
    const { isDraft, ...noDraft } = s.row;
    s.fake.setState(s.state({ view: { 21: noDraft } }));
    const ap = approve(s);
    assert.equal(ap.status, 3, ap.stdout);
    assert.match(ap.json.reason, /isDraft is missing or not a boolean/);
  });
  it('pending now REFUSES the approve: no plan, no WAIT line, approve again when green (it used to print a runnable plan)', () => {
    const s = setup();
    s.fake.setState(s.state({ api: s.api({ [`GET repos/o/n/commits/${s.oid}/check-runs?filter=latest&per_page=100`]: s.runs(run('ci', null, 'in_progress')) }) }));
    const ap = approve(s);
    assert.equal(ap.status, 3, ap.stdout);
    assert.match(ap.json.reason, /required checks pending.*not green yet: approve again/);
    assert.equal(ap.json.plan, undefined);
    assert.doesNotMatch(ap.stdout, /WAIT/);
  });
  it('pass → the plan, with the point-in-time note naming --serial as the gated executor (control)', () => {
    const s = setup();
    const ok = approve(s);
    assert.equal(ok.status, 0, ok.stdout);
    assert.equal(ok.json.plan[0].wait, undefined);
    assert.match(ok.json.ciEvidence, /point-in-time/);
    assert.match(ok.json.ciEvidence, /--serial/);
  });
  it('a proven-empty inventory (unprotected branch, no rules) is none-required: the plan (a consumer may require nothing)', () => {
    const s = setup();
    s.fake.setState(s.state({ api: s.api({ 'GET repos/o/n/branches/main': { body: { protected: false, protection: { enabled: false, required_status_checks: { contexts: [], checks: [] } } } }, 'GET repos/o/n/rules/branches/main?per_page=100': { body: [] } }) }));
    assert.equal(approve(s).status, 0);
  });
  it('an UNREADABLE inventory refuses, and a configured requiredChecks that agrees with GitHub cannot rescue it (the 90c60bf2 hole)', () => {
    const s = setup({ requiredChecks: ['ci'] });
    s.fake.setState(s.state({ api: s.api({ 'GET repos/o/n/rules/branches/main?per_page=100': { fail: 'HTTP 502' } }) }));
    const ap = approve(s);
    assert.equal(ap.status, 3, ap.stdout);
    assert.match(ap.json.reason, /CI evidence unknown \(transport/);
    assert.equal(ap.json.plan, undefined);
  });
  it('config that disagrees with GitHub (a stale requiredChecks) refuses with the diff', () => {
    const s = setup({ requiredChecks: ['ci', 'lint'] });
    const ap = approve(s);
    assert.equal(ap.status, 3, ap.stdout);
    assert.match(ap.json.reason, /config-drift: .*configured but not required by GitHub \[lint\]/);
  });
});

// ---- the CI-evidence contract: tags, fault kinds and the ONE disposition table (docs/plans/ci-evidence-oracle.md §2.2) -------------

describe('decideCiAdmission — one fixed table over a closed tag set', () => {
  const sample = (tag) => ({ tag, code: tag === 'ineligible' ? 'draft' : undefined, fault: tag === 'unknown' ? { kind: 'transport', detail: 'x' } : undefined });
  const EXPECT = { passed: 'permit', 'none-required': 'permit', failed: 'refuse-member', 'not-run': 'refuse-member', missing: 'retry', pending: 'retry', ineligible: 'refuse-member', unknown: 'stop-run' };

  it('covers EVERY tag exactly once, and the expectation table names no tag the contract lacks', () => {
    assert.deepEqual(Object.keys(EXPECT).sort(), [...CI_EVIDENCE_TAGS].sort());
    for (const tag of CI_EVIDENCE_TAGS) assert.equal(decideCiAdmission(sample(tag)).disposition, EXPECT[tag], tag);
    assert.equal(new Set(CI_EVIDENCE_TAGS).size, CI_EVIDENCE_TAGS.length);
  });
  it('permit is a positive allowlist: only passed and none-required permit, whatever else the evidence carries', () => {
    const permitting = CI_EVIDENCE_TAGS.filter((t) => decideCiAdmission(sample(t)).disposition === 'permit');
    assert.deepEqual(permitting.sort(), ['none-required', 'passed']);
    for (const bad of [undefined, null, {}, 'passed', 42, { tag: 'PASSED' }, { tag: 'green' }, { tag: '' }, { disposition: 'permit' }, { tag: 'passed-ish' }]) {
      const d = decideCiAdmission(bad);
      assert.equal(d.disposition, 'stop-run', JSON.stringify(bad));
      assert.equal(d.fault.kind, 'unexpected-tag');
    }
  });
  it('ineligible: head-moved retries, every other recognised code refuses the member, an unrecognised code stops the run', () => {
    for (const code of CI_INELIGIBLE_CODES) assert.equal(decideCiAdmission({ tag: 'ineligible', code }).disposition, code === 'head-moved' ? 'retry' : 'refuse-member', code);
    assert.equal(decideCiAdmission({ tag: 'ineligible', code: 'surprise' }).disposition, 'stop-run');
    assert.equal(decideCiAdmission({ tag: 'ineligible' }).disposition, 'stop-run');
  });
  it('unknown is always a run stop and keeps a recognised fault kind; an unrecognised kind becomes unexpected-tag, never a pass', () => {
    for (const kind of CI_FAULT_KINDS) {
      const d = decideCiAdmission({ tag: 'unknown', fault: { kind, detail: 'd' } });
      assert.deepEqual([d.disposition, d.fault.kind], ['stop-run', kind]);
    }
    assert.equal(decideCiAdmission({ tag: 'unknown', fault: { kind: 'made-up' } }).fault.kind, 'unexpected-tag');
    assert.equal(decideCiAdmission({ tag: 'unknown' }).disposition, 'stop-run');
  });
  it('malformed evidence and hostile tag values never throw: stop-run with a safe diagnostic (code audit R1 M2, M4)', () => {
    const cyc = {}; cyc.self = cyc;
    for (const bad of [{ tag: 10n }, { tag: cyc }, { tag: Symbol('x') }, { tag: 'ineligible', code: 10n }, { tag: 'unknown', names: { failed: 'ci' }, fault: { kind: 'transport', detail: cyc } },
      JSON.parse('{"tag":"unknown","fault":{"kind":"transport","detail":{"toString":null,"valueOf":null}}}')]) {
      const d = decideCiAdmission(bad);
      assert.equal(d.disposition, 'stop-run');
      assert.ok(describeEvidence(bad, d).length > 5);
    }
    for (const bad of [{ tag: 'ineligible', code: 10n }, { tag: 'unknown', fault: { kind: 'transport', detail: 'line one\nline two\u001b[31m' } }, { tag: 'failed', names: { failed: ['a\nb\r\u0007c'] } }]) {
      const d = decideCiAdmission(bad);
      assert.doesNotThrow(() => JSON.stringify(d), 'the decision is always serialisable');
      assert.ok(!/[\u0000-\u001f\u007f]/.test(describeEvidence(bad, d)), 'a diagnostic is ONE line without control characters');
    }
    assert.match(describeEvidence({ tag: 'failed', names: { failed: ['full-suite', 'lint-checks', 'a-much-longer-required-check-name'] } }), /failed: full-suite, lint-checks, a-much-longer-required-check-name$/, 'names are never truncated by their position (code audit R4 H1)');
    assert.ok(describeEvidence({ tag: 'failed', names: { failed: 'ci' } }).length > 5, 'a names list that is not an array is ignored, not thrown on');
    assert.ok(describeEvidence({ tag: 'failed', names: { failed: [10n, cyc] } }).length > 5);
  });
  it('the dispositions it can return are exactly the closed set', () => {
    const seen = new Set([...CI_EVIDENCE_TAGS.map((t) => decideCiAdmission(sample(t)).disposition), decideCiAdmission(null).disposition]);
    assert.deepEqual([...seen].sort(), [...CI_DISPOSITIONS].sort());
  });
  it('describeEvidence never returns an empty line and names the fault of an unknown', () => {
    for (const tag of CI_EVIDENCE_TAGS) assert.ok(describeEvidence(sample(tag)).length > 10, tag);
    assert.match(describeEvidence({ tag: 'unknown', fault: { kind: 'config-drift', detail: 'a vs b' } }), /config-drift: a vs b/);
    assert.match(describeEvidence({ tag: 'failed', names: { failed: ['ci', 'lint'] } }), /failed: ci, lint/);
  });
});
