/**
 * @fileoverview The pure member-outcome model (docs/plans/ship-batch-member-outcomes.md §2.1-§2.3, §2.7-§2.8, §9 unit tests).
 * @module tests/fleet-member-outcome
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  FAULTS, OutcomeSchema, PolicySchema, classifyMerged, combinationOf, summariseRun, validatePolicyRun, verdictOf,
} from '../scripts/lib/fleet/member-outcome.mjs';

const o = (c) => c.repeat(40);
const T = '2026-11-18T10:00:00.000Z';
const OUT = (over = {}) => ({ status: 'landed', code: 'merged', verdict: 'verified', mergeOid: o('a'), parent: o('b'), chainIndex: 1, attribution: 'this-run', gate: 'passed', ...over });
const step = (id, over = {}) => ({ id, prNumber: 1, repo: 'o/n', testedOid: o('1'), step: 'pending', head: o('1'), accounted: [o('1')], updates: 0, priorHead: null, mergedOid: null, note: null, at: T, ...over });
const sbPolicy = (ids, chain = [o('b')]) => ({ name: 'ship-batch', grantVersion: 1, remote: 'origin', candidateTree: o('7'), baseChain: chain, members: Object.fromEntries(ids.map((i) => [i, { tree: o('7'), worktree: null }])), excluded: [] });
const run = (steps, policy, extra = {}) => ({ schemaVersion: 1, trainId: 't-20260101000000-aaaa', startedAt: T, updatedAt: T, timeoutMs: 1000, base: 'main', remote: 'origin', steps, policy, outcome: null, ...extra });

describe('FAULTS', () => {
  it('every row has a closed scope; a member row names a status and a code that its union variant accepts', () => {
    for (const [kind, row] of Object.entries(FAULTS)) {
      assert.ok(['member', 'run'].includes(row.scope), kind);
      if (row.scope === 'member') {
        assert.ok(['refused', 'not-run'].includes(row.status), kind);
        const probe = { status: row.status, code: row.code, reason: 'x' };
        assert.equal(OutcomeSchema.safeParse(probe).success, true, `${kind} -> ${row.status}/${row.code} is not a legal outcome`);
      }
    }
  });
  it('a merge request that was not observed is never member-scoped (R1-H1)', () => assert.equal(FAULTS['merge-unconfirmed'].scope, 'run'));
});

describe('OutcomeSchema: a discriminated union with per-variant evidence', () => {
  it('accepts one valid outcome per status', () => {
    for (const x of [OUT(), { status: 'refused', code: 'head-moved', reason: 'r', trees: { tested: o('1'), seen: o('2') } }, { status: 'skipped', code: 'merged-externally', mergeOid: o('c'), seenHead: o('d') }, { status: 'not-run', code: 'checks-pending', reason: 'r' }]) {
      assert.equal(OutcomeSchema.safeParse(x).success, true, JSON.stringify(x));
    }
  });
  it('rejects: a landed outcome with no verdict or merge oid, a refused one with a verdict, a code of another status, an unknown key', () => {
    const { verdict, ...noVerdict } = OUT();
    const { mergeOid, ...noOid } = OUT();
    for (const bad of [noVerdict, noOid, { status: 'refused', code: 'checks-failed', reason: 'r', verdict: 'verified' }, { status: 'refused', code: 'merge-unconfirmed', reason: 'r' }, { status: 'not-run', code: 'conflict', reason: 'r' }, { status: 'skipped', code: 'merged-externally', mergeOid: null, seenHead: o('d') }, OUT({ extra: 1 })]) {
      assert.equal(OutcomeSchema.safeParse(bad).success, false, JSON.stringify(bad));
    }
  });
});

describe('classifyMerged: the only reader of MERGED (§2.3 table)', () => {
  const merge = (over = {}) => step('a', { step: 'merge', attempt: { head: o('1'), at: T, ghExit: 0, doneAt: T }, ...over });
  const doc = (head, oid = o('f')) => ({ headRefOid: head, mergeCommit: oid ? { oid } : null });
  it('at the attempted head with exit 0: ours, this-run, read-back follows', () => {
    const c = classifyMerged({ step: merge(), doc: doc(o('1')) });
    assert.deepEqual([c.step, c.outcome, c.attribution, c.needsReadBack], ['merged', null, 'this-run', true]);
  });
  it('at the attempted head with a non-zero or null gh exit: unknown attribution', () => {
    for (const ghExit of [1, null]) assert.equal(classifyMerged({ step: merge({ attempt: { head: o('1'), at: T, ghExit, doneAt: null } }), doc: doc(o('1')) }).attribution, 'unknown');
  });
  it('at another head: skipped/merged-externally with its merge oid and the seen head', () => {
    const c = classifyMerged({ step: merge(), doc: doc(o('9')) });
    assert.deepEqual(c.outcome, { status: 'skipped', code: 'merged-externally', mergeOid: o('f'), seenHead: o('9') });
    assert.equal(c.external, true);
  });
  it('merged while pending, waiting or updating (no intent): external, whatever the head', () => {
    for (const ph of ['pending', 'wait', 'update']) assert.equal(classifyMerged({ step: step('a', { step: ph }), doc: doc(o('1')) }).outcome.code, 'merged-externally');
  });
  it('no merge oid: in phase merge awaiting-read-back; before intent awaiting-merge-evidence in the SAME phase', () => {
    assert.deepEqual([classifyMerged({ step: merge(), doc: doc(o('1'), null) }).step, classifyMerged({ step: merge(), doc: doc(o('1'), null) }).outcome.code], ['merged', 'awaiting-read-back']);
    const pre = classifyMerged({ step: step('a', { step: 'wait' }), doc: doc(o('1'), null) });
    assert.deepEqual([pre.step, pre.outcome.code], ['wait', 'awaiting-merge-evidence']);
  });
});

describe('verdictOf', () => {
  const rb = (over = {}) => ({ firstParent: o('b'), reasons: [], baseRefName: 'main', tree: o('7'), ...over });
  const args = (readBack, candidateTree = null) => ({ readBack, runBase: 'main', chainTail: o('b'), candidateTree });
  it('picks the first matching verdict in the contract order', () => {
    assert.equal(verdictOf(args(rb())).verdict, 'verified');
    assert.equal(verdictOf(args(rb({ reasons: ['x'] }))).verdict, 'provenance-lost');
    assert.equal(verdictOf(args(rb({ firstParent: o('c') }))).verdict, 'untested-base');
    assert.equal(verdictOf(args(rb({ baseRefName: 'other', firstParent: o('c') }))).verdict, 'wrong-target');
  });
  it('under the rollup policy a measured tree that is not the candidate is tree-mismatch with both trees', () => {
    const v = verdictOf(args(rb({ tree: o('8') }), o('7')));
    assert.deepEqual(v, { verdict: 'tree-mismatch', trees: { expected: o('7'), observed: o('8') } });
    assert.equal(verdictOf(args(rb({ tree: o('8') }))).verdict, 'verified', 'ship-batch has no candidate-tree rule');
  });
});

describe('validatePolicyRun: the load-time invariants (§2.1)', () => {
  const landed = (id, k, parent, mergeOid, over = {}) => step(id, { step: 'merged', mergedOid: mergeOid, outcome: OUT({ chainIndex: k, parent, mergeOid, ...over }) });
  it('a plain run with an outcome, attempt or halt is invalid; a plain run is otherwise valid', () => {
    assert.equal(validatePolicyRun(run([step('a')], undefined)), null);
    assert.match(validatePolicyRun(run([step('a', { outcome: null, attempt: { head: o('1'), at: T, ghExit: null, doneAt: null } })], undefined)), /only by a policy run/);
  });
  it('step ids must be unique and equal the ship-batch members keys', () => {
    assert.match(validatePolicyRun(run([step('a'), step('a')], sbPolicy(['a']))), /not unique/);
    assert.match(validatePolicyRun(run([step('a'), step('b')], sbPolicy(['a']))), /members keys/);
    assert.equal(validatePolicyRun(run([step('a'), step('b')], sbPolicy(['a', 'b']))), null);
  });
  it('phase and outcome are legal pairs only: merged with a null outcome, landed before merged, merge-unconfirmed without an attempt', () => {
    const p = sbPolicy(['a']);
    assert.match(validatePolicyRun(run([step('a', { step: 'merged' })], p)), /not a legal pair/);
    assert.match(validatePolicyRun(run([step('a', { step: 'wait', outcome: OUT() })], p)), /not a legal pair|chain/);
    assert.match(validatePolicyRun(run([step('a', { step: 'merge', outcome: { status: 'not-run', code: 'merge-unconfirmed', reason: 'r' } })], p)), /needs an attempt/);
    assert.equal(validatePolicyRun(run([step('a', { step: 'merge', outcome: { status: 'not-run', code: 'merge-unconfirmed', reason: 'r' }, attempt: { head: o('1'), at: T, ghExit: null, doneAt: null } })], p)), null);
  });
  it('the chain is merge chronology: a later step may hold an earlier chainIndex', () => {
    const p = sbPolicy(['a', 'b'], [o('b'), o('c'), o('d')]);
    const steps = [landed('a', 2, o('c'), o('d')), landed('b', 1, o('b'), o('c'))];
    assert.equal(validatePolicyRun(run(steps, p)), null);
    assert.match(validatePolicyRun(run([landed('a', 2, o('c'), o('d')), landed('b', 1, o('9'), o('c'))], p)), /base chain entry 1/);
  });
  it('a chain inconsistent with the landed records, and a chain verdict with no chainIndex, are invalid', () => {
    assert.match(validatePolicyRun(run([landed('a', 1, o('b'), o('c'))], sbPolicy(['a'], [o('b')]))), /does not match the landed records/);
    assert.match(validatePolicyRun(run([landed('a', null, o('b'), o('c'))], sbPolicy(['a'], [o('b')]))), /take a chainIndex/);
  });
  it('a merge oid repeated across members is invalid', () => {
    const p = sbPolicy(['a', 'b'], [o('b'), o('c')]);
    const dup = step('b', { step: 'merged', mergedOid: o('c'), outcome: { status: 'skipped', code: 'merged-externally', mergeOid: o('c'), seenHead: o('9') } });
    assert.match(validatePolicyRun(run([landed('a', 1, o('b'), o('c')), dup], p, { halt: { code: 'merged-externally', member: 'b', at: T } })), /repeated/);
  });
  it('an external merge or a halting verdict needs its halt record; finalized needs every member terminal or a halt', () => {
    const p = sbPolicy(['a']);
    const ext = step('a', { step: 'merged', mergedOid: o('c'), outcome: { status: 'skipped', code: 'merged-externally', mergeOid: o('c'), seenHead: o('9') } });
    assert.match(validatePolicyRun(run([ext], p)), /needs its halt/);
    assert.equal(validatePolicyRun(run([ext], p, { halt: { code: 'merged-externally', member: 'a', at: T } })), null);
    assert.match(validatePolicyRun(run([step('a')], p, { finalized: { at: T, result: { ok: false, combination: 'subset', trainLanded: false, first: 'f', provenance: [], tails: [] } } })), /finalized needs/);
  });
  it('a rollup run is exactly one step named by its branch; rollup ci is required, equal to attempt.ci, and bound to the candidate', () => {
    const cand = { oid: o('1'), tree: o('7') };
    const roll = { name: 'rollup', grantVersion: 1, remote: 'origin', candidateTree: o('7'), baseChain: [o('b')], excluded: [], members: [{ id: 'm', branch: 'm', head: o('2'), tree: o('3'), runId: null, gate: 'passed', finalReview: null }], rollup: { branch: 'rollup/20261118-1', repo: 'o/n', prNumber: 5, candidate: cand } };
    assert.match(validatePolicyRun(run([step('a'), step('b')], roll)), /exactly one step/);
    const ci = { head: o('1'), tree: o('7'), observedAt: T, checks: [{ name: 'ci', conclusion: 'success' }] };
    const base = step('rollup/20261118-1', { step: 'merged', mergedOid: o('c'), attempt: { head: o('1'), at: T, ghExit: 0, doneAt: T, ci } });
    assert.match(validatePolicyRun(run([{ ...base, outcome: OUT({ chainIndex: 1, parent: o('b'), mergeOid: o('c') }) }], roll)), /carries the intent's ci/);
    assert.equal(validatePolicyRun(run([{ ...base, outcome: OUT({ chainIndex: 1, parent: o('b'), mergeOid: o('c'), ci }) }], { ...roll, baseChain: [o('b'), o('c')] })), null);
    assert.match(validatePolicyRun(run([{ ...base, outcome: OUT({ chainIndex: 1, parent: o('b'), mergeOid: o('c'), ci: { ...ci, tree: o('8') } }) }], { ...roll, baseChain: [o('b'), o('c')] })), /carries the intent's ci/);
  });
  it('ci belongs to the rollup policy only', () => {
    const ci = { head: o('1'), tree: o('7'), observedAt: T, checks: [] };
    assert.match(validatePolicyRun(run([step('a', { step: 'merge', attempt: { head: o('1'), at: T, ghExit: null, doneAt: null, ci } })], sbPolicy(['a']))), /rollup policy/);
  });
  it('PolicySchema is a discriminated union: an unknown name is refused', () => assert.equal(PolicySchema.safeParse({ ...sbPolicy(['a']), name: 'other' }).success, false));
});

describe('combinationOf and summariseRun: the landed set stated honestly (§2.7, §2.8)', () => {
  const l = (id, over = {}) => step(id, { step: 'merged', mergedOid: o('c'), outcome: OUT(over) });
  const ref = (id) => step(id, { outcome: { status: 'refused', code: 'checks-failed', reason: 'r' } });
  const pol = sbPolicy(['a', 'b']);
  it('tested, different, unverified and subset', () => {
    assert.equal(combinationOf(run([l('a'), l('b', { chainIndex: 2 })], pol), { tailTree: o('7') }), 'tested');
    assert.equal(combinationOf(run([l('a'), l('b', { chainIndex: 2 })], pol), { tailTree: o('8') }), 'different');
    assert.equal(combinationOf(run([l('a'), l('b', { chainIndex: 2 })], pol), { tailTree: null }), 'unverified');
    assert.equal(combinationOf(run([l('a'), ref('b')], pol), { tailTree: o('7') }), 'subset');
    assert.equal(combinationOf(run([l('a'), l('b', { verdict: 'untested-base', chainIndex: null })], pol), { tailTree: o('7') }), 'unverified');
  });
  it('the §2.8 table: ok, train landing and the first line for each case', () => {
    const all = summariseRun(run([l('a'), l('b', { chainIndex: 2 })], pol), { tailTree: o('7') });
    assert.deepEqual([all.ok, all.trainLanded, all.combination], [true, true, 'tested']);
    assert.match(all.first, /^landed 2 of 2; final tree = the combined-tested tree$/);
    const diff = summariseRun(run([l('a'), l('b', { chainIndex: 2 })], pol), { tailTree: o('8') });
    assert.deepEqual([diff.ok, diff.trainLanded], [false, true]);
    assert.match(diff.first, /NOT the combined-tested tree/);
    const sub = summariseRun(run([l('a'), ref('b')], pol), { tailTree: o('7') });
    assert.deepEqual([sub.ok, sub.trainLanded, sub.combination], [true, false, 'subset']);
    assert.match(sub.first, /^landed 1 of 2: a SUBSET of the combined-tested set; 1 need the user/);
    const prov = summariseRun(run([l('a', { verdict: 'provenance-lost' }), l('b', { chainIndex: 2 })], pol), { tailTree: o('7') });
    assert.deepEqual([prov.ok, prov.combination, prov.provenance], [false, 'tested', ['PROVENANCE: a provenance-lost']]);
    const none = summariseRun(run([ref('a'), ref('b')], pol), { tailTree: null });
    assert.deepEqual([none.ok, none.first], [false, 'nothing landed; every member needs the user']);
  });
  it('a not-run member keeps the run resumable with its own first line, with or without a landed member', () => {
    const nr = step('b', { outcome: { status: 'not-run', code: 'checks-pending', reason: 'r' } });
    for (const steps of [[l('a'), nr], [step('a', { outcome: { status: 'not-run', code: 'pr-unreadable', reason: 'r' } }), nr]]) {
      const r = summariseRun(run(steps, pol), { tailTree: null });
      assert.equal(r.ok, false);
      assert.match(r.first, /not yet decided: land --resume .* --ship-batch re-checks them/);
    }
  });
  it('under the rollup policy untested-base is not a landing the train may complete on', () => {
    const roll = { ...sbPolicy(['a']), name: 'rollup' };
    const r = summariseRun({ ...run([l('a', { verdict: 'untested-base', chainIndex: null })], roll), halt: { code: 'untested-base', member: 'a', at: T } }, { tailTree: null });
    assert.equal(r.trainLanded, false);
    assert.equal(r.ok, false);
  });
});
