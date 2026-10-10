/**
 * @fileoverview /fleet — required checks must have RUN (plan
 * docs/plans/fleet-consumer-feedback-oct.md §2.2, wine-cellar-app item 7).
 *
 * wine #802 merged three seconds after ready on draft-time SKIPPED checks:
 * GitHub (and fleet's old rollup) counted a skipped check as passing. Pinned:
 * the inventory is ASKED, never inferred; a required check observed as skipped
 * is `not-run`, one never observed is `missing`; the observation is bound to a
 * head; pr-mode approval refuses a draft and a not-run/failed required check, and
 * WAITs on missing/pending/unknown.
 */
import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import { git } from './helpers/git.mjs';
import {
  describeVerdict, observeRequiredChecks, parseBranchProtection, parseChecksJson, parseRulesInventory, requiredChecksVerdict, requiredInventory,
} from '../scripts/lib/fleet/required-checks.mjs';
import { prWarnings, summariseChecks } from '../scripts/lib/fleet/gh-facts.mjs';
import { parseFleetConfig } from '../scripts/lib/fleet/config.mjs';
import {
  addBranch, cleanupFleetRoots, installFakeGh, makeFleetRepo, prRow, runFleet, scrubbedEnv,
} from './helpers/fleet-repo.mjs';

after(cleanupFleetRoots);

const H = 'a'.repeat(40);
const inv = (names, source = 'rules-api') => ({ source, names });
const c = (name, bucket, completedAt = '2026-10-09T10:00:00Z') => ({ name, bucket, state: bucket.toUpperCase(), completedAt });

describe('requiredChecksVerdict — the ONE predicate', () => {
  const v = (names, observed, headBound = true) => requiredChecksVerdict({ inventory: inv(names), observed, headBound });
  it('every required check observed passing → pass', () => assert.equal(v(['ci', 'lint'], [c('ci', 'pass'), c('lint', 'pass'), c('other', 'fail')]).verdict, 'pass'));
  it('a required check observed SKIPPED → not-run (the #802 defect)', () => {
    const r = v(['ci'], [c('ci', 'skipping')]);
    assert.deepEqual([r.verdict, r.names['not-run']], ['not-run', ['ci']]);
  });
  it('a required check never observed → missing, never "not required"', () => assert.deepEqual(v(['ci', 'e2e'], [c('ci', 'pass')]).names.missing, ['e2e']));
  it('pending / fail / cancel', () => {
    assert.equal(v(['ci'], [c('ci', 'pending')]).verdict, 'pending');
    assert.equal(v(['ci'], [c('ci', 'fail')]).verdict, 'failed');
    assert.equal(v(['ci'], [c('ci', 'cancel')]).verdict, 'failed');
  });
  it('the latest run of a name wins; an in-flight re-run is pending', () => {
    assert.equal(v(['ci'], [c('ci', 'skipping', '2026-10-09T09:00:00Z'), c('ci', 'pass', '2026-10-09T10:00:00Z')]).verdict, 'pass');
    assert.equal(v(['ci'], [c('ci', 'pass'), { name: 'ci', bucket: 'pending', state: 'IN_PROGRESS', completedAt: null }]).verdict, 'pending');
  });
  it('unbound head or unknown inventory → unknown; an EXPLICIT empty inventory → none-required', () => {
    assert.equal(v(['ci'], [c('ci', 'pass')], false).verdict, 'unknown');
    assert.equal(requiredChecksVerdict({ inventory: { source: 'unknown', names: [] }, observed: [], headBound: true }).verdict, 'unknown');
    assert.equal(requiredChecksVerdict({ inventory: inv([], 'config'), observed: [], headBound: true }).verdict, 'none-required');
  });
  it('describeVerdict names the blocking checks', () => assert.equal(describeVerdict(v(['a', 'b', 'c'], [c('a', 'skipping'), c('b', 'pending')])), 'not-run: a; missing: c; pending: b'));
});

describe('inventory — asked, never inferred', () => {
  const rules = (contexts) => JSON.stringify([{ type: 'pull_request' }, { type: 'required_status_checks', parameters: { required_status_checks: contexts.map((context) => ({ context })) } }]);
  const branch = (contexts, isProtected = true) => JSON.stringify(isProtected ? { protected: true, protection: { required_status_checks: { contexts } } } : { protected: false });
  // A gh stub answering the two inventory endpoints (rulesets, branch) by path; null = HTTP 403.
  const gh = (rulesOut, branchOut) => (args) => {
    const out = /rules\/branches/.test(args[1]) ? rulesOut : branchOut;
    return out === null ? { ok: false, status: 1, stdout: '', stderr: '', reason: 'HTTP 403' } : { ok: true, status: 0, stdout: out, stderr: '', reason: null };
  };
  it('parses required_status_checks contexts; a malformed nested rule is a parse failure, not an empty list (C1-M4)', () => {
    assert.deepEqual(parseRulesInventory(rules(['ci', 'lint'])), { ok: true, names: ['ci', 'lint'] });
    assert.equal(parseRulesInventory(JSON.stringify([{ type: 'required_status_checks', parameters: { required_status_checks: {} } }])).ok, false);
  });
  it('classic protection: contexts, unprotected = empty, protected-but-unreadable = failure', () => {
    assert.deepEqual(parseBranchProtection(branch(['build'])), { ok: true, names: ['build'] });
    assert.deepEqual(parseBranchProtection(branch([], false)), { ok: true, names: [] });
    assert.equal(parseBranchProtection(JSON.stringify({ protected: true })).ok, false);
  });
  it('the inventory is the union of rulesets, classic protection and config (C1-H6)', () => {
    assert.deepEqual(requiredInventory('.', { repo: 'o/n', base: 'main', configured: ['e2e'], gh: gh(rules(['ci']), branch(['build'])) }), { source: 'github+config', names: ['build', 'ci', 'e2e'] });
    assert.deepEqual(requiredInventory('.', { repo: 'o/n', base: 'main', gh: gh(rules(['ci']), branch([], false)) }), { source: 'github', names: ['ci'] });
  });
  it('a ruleset answer alone is NOT the whole inventory when branch protection is unreadable', () => {
    const r = requiredInventory('.', { repo: 'o/n', base: 'main', gh: gh(rules(['ci']), null) });
    assert.equal(r.source, 'unknown'); assert.match(r.reason, /branch protection not readable/);
  });
  it('nothing required anywhere and no config → unknown, never "none"; explicit config [] → none required', () => {
    const r = requiredInventory('.', { repo: 'o/n', base: 'main', gh: gh('[]', branch([], false)) });
    assert.equal(r.source, 'unknown'); assert.match(r.reason, /requiredChecks/);
    assert.deepEqual(requiredInventory('.', { repo: 'o/n', base: 'main', configured: [], gh: gh('[]', branch([], false)) }), { source: 'github+config', names: [] });
    assert.equal(requiredInventory('.', { repo: 'o/n', base: 'main', configured: ['ci'], gh: gh(null, null) }).source, 'config');
  });
  it('a config that failed to load is unknown, never "not declared" (C1-H8/H11)', () => {
    const r = requiredInventory('.', { repo: 'o/n', base: 'main', configError: 'invalid fleet config', gh: gh(rules(['ci']), branch([], false)) });
    assert.equal(r.source, 'unknown'); assert.match(r.reason, /could not be loaded/);
  });
  it('config schema: requiredChecks absent stays absent; [] is kept', () => {
    assert.equal('requiredChecks' in parseFleetConfig({}).value, false);
    assert.deepEqual(parseFleetConfig({ requiredChecks: [] }).value.requiredChecks, []);
  });
});

describe('observeRequiredChecks — head binding and gh exit codes', () => {
  const runner = ({ heads, checks, checksStatus = 8 }) => {
    let i = 0;
    return (args) => {
      if (args[1] === 'view') return { ok: true, status: 0, stdout: JSON.stringify({ headRefOid: heads[Math.min(i++, heads.length - 1)] }), stderr: '' };
      return { ok: checksStatus === 0, status: checksStatus, stdout: JSON.stringify(checks), stderr: '', reason: `gh exited ${checksStatus}` };
    };
  };
  it('exit 8 (pending) with JSON is parsed, not read as a failure', () => {
    const r = observeRequiredChecks('.', { pr: 1, repo: 'o/n', inventory: inv(['ci']), gh: runner({ heads: [H, H], checks: [c('ci', 'pending')] }) });
    assert.deepEqual([r.complete, r.verdict, r.headOid], [true, 'pending', H]);
  });
  it('a head that moves during the observation → unknown', () => {
    const r = observeRequiredChecks('.', { pr: 1, repo: 'o/n', inventory: inv(['ci']), gh: runner({ heads: [H, 'b'.repeat(40)], checks: [c('ci', 'pass')], checksStatus: 0 }) });
    assert.deepEqual([r.complete, r.verdict], [false, 'unknown']);
    assert.match(r.reason, /moved/);
  });
  it('an unexpected head is refused before observing', () => {
    const r = observeRequiredChecks('.', { pr: 1, repo: 'o/n', inventory: inv(['ci']), expectHead: 'c'.repeat(40), gh: runner({ heads: [H], checks: [] }) });
    assert.equal(r.verdict, 'unknown');
  });
  it('malformed checks JSON is never a pass', () => assert.equal(parseChecksJson('[{"bucket":1}]').ok, false));
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

describe('pr-mode approve — the gate on a real train', () => {
  const setup = () => {
    const fx = makeFleetRepo({ fleetConfig: { mergeMethod: 'pr', testCommand: { tiers: [{ name: 'ok', command: ['node', '-e', '0'] }] } } });
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
    const rules = {
      'GET repos/o/n/rules/branches/main': { body: [{ type: 'required_status_checks', parameters: { required_status_checks: [{ context: 'ci' }] } }] },
      'GET repos/o/n/branches/main': { body: { protected: false } },
    };
    const state = (over = {}) => ({ list: [row], view: { 21: row }, api: rules, ...over });
    fake.setState(state());
    const built = f(['land', '--json']);
    assert.equal(built.status, 0, built.stdout + built.stderr);
    return { f, fake, state, row, trainId: built.json.train.trainId };
  };

  it('a required check SKIPPED on the head → approval refused, naming it', () => {
    const s = setup();
    s.fake.setState(s.state({ checks: { 21: { rows: [c('ci', 'skipping')], exit: 0 } } }));
    const ap = s.f(['land', '--approve', s.trainId, '--json']);
    assert.equal(ap.status, 3, ap.stdout);
    assert.match(ap.json.reason, /required checks not-run: ci/);
  });
  it('a DRAFT PR → refused with the ready-then-run remedy', () => {
    const s = setup();
    s.fake.setState(s.state({ view: { 21: { ...s.row, isDraft: true } }, checks: { 21: { rows: [c('ci', 'pass')] } } }));
    const ap = s.f(['land', '--approve', s.trainId, '--json']);
    assert.equal(ap.status, 3);
    assert.match(ap.json.reason, /DRAFT/);
  });
  it('pending → the plan is emitted with a WAIT on that merge; pass → no WAIT (control)', () => {
    const s = setup();
    s.fake.setState(s.state({ checks: { 21: { rows: [c('ci', 'pending')], exit: 8 } } }));
    const ap = s.f(['land', '--approve', s.trainId, '--json']);
    assert.equal(ap.status, 0, ap.stdout);
    assert.match(ap.json.plan[0].wait, /pending/);
    assert.match(ap.json.text, /WAIT \(feat\)/);
    const s2 = setup();
    s2.fake.setState(s2.state({ checks: { 21: { rows: [c('ci', 'pass')] } } }));
    const ok = s2.f(['land', '--approve', s2.trainId, '--json']);
    assert.equal(ok.status, 0);
    assert.equal(ok.json.plan[0].wait, undefined);
  });
});
