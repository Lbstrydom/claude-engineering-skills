/**
 * @fileoverview Eligibility + readiness rules for the final-reviewer bake-off.
 *
 * The load-bearing cases are the ones that keep the window HONEST, because the
 * failure this guards against is not a crash — it is a window that reads "met"
 * when it isn't. That exact failure happened five times on the tiered-shadow
 * collector before readiness was made mechanical.
 *
 * @module tests/final-review-bakeoff
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { findEligibleTranscripts, assessWindow } from '../scripts/final-review-bakeoff.mjs';
import { zeroFindingArms } from '../scripts/bakeoff-collect.mjs';

/** Build an injectable fake FS for the pure enumerator. */
function io(files, existingPlans = []) {
  return {
    readdir: () => Object.keys(files),
    readFile: (p) => files[p.split(/[\\/]/).pop()],
    exists: (p) => existingPlans.includes(p),
  };
}

const codeTranscript = (plan) => JSON.stringify({ mode: 'code', plan, rounds: [{ round: 1 }] });

describe('findEligibleTranscripts', () => {
  it('accepts a code-mode transcript whose plan still exists', () => {
    const { eligible } = findEligibleTranscripts('.audit',
      io({ 'a-transcript.json': codeTranscript('docs/plans/p.md') }, ['docs/plans/p.md']));
    assert.equal(eligible.length, 1);
    assert.equal(eligible[0].plan, 'docs/plans/p.md');
    assert.equal(eligible[0].rounds, 1);
  });

  it('rejects plan-mode transcripts — a different prompt path, not a thin sample', () => {
    const { eligible, rejected } = findEligibleTranscripts('.audit',
      io({ 'p-transcript.json': JSON.stringify({ mode: 'plan', plan: 'docs/plans/p.md' }) }, ['docs/plans/p.md']));
    assert.equal(eligible.length, 0);
    assert.match(rejected[0].why, /mode=plan/);
  });

  it('rejects a transcript whose plan file has since been deleted', () => {
    // Counting an unreplayable transcript inflates readiness against inputs
    // that cannot actually run — the window would "fill" with dead entries.
    const { eligible, rejected } = findEligibleTranscripts('.audit',
      io({ 'a-transcript.json': codeTranscript('docs/plans/gone.md') }, []));
    assert.equal(eligible.length, 0);
    assert.match(rejected[0].why, /plan missing/);
  });

  it('rejects unparseable transcripts instead of throwing', () => {
    const { eligible, rejected } = findEligibleTranscripts('.audit',
      io({ 'bad-transcript.json': '{not json' }));
    assert.equal(eligible.length, 0);
    assert.equal(rejected[0].why, 'unparseable');
  });

  it('ignores non-transcript files in .audit/', () => {
    const { eligible, rejected } = findEligibleTranscripts('.audit',
      io({ 'session-ledger.json': '{}', 'bandit-state.json': '{}' }));
    assert.equal(eligible.length, 0);
    assert.equal(rejected.length, 0, 'unrelated files are not "rejected", they are out of scope');
  });

  it('is deterministic in ordering', () => {
    const files = { 'c-transcript.json': codeTranscript('p.md'), 'a-transcript.json': codeTranscript('p.md'), 'b-transcript.json': codeTranscript('p.md') };
    const names = findEligibleTranscripts('.audit', io(files, ['p.md'])).eligible.map((e) => e.name);
    assert.deepEqual(names, ['a-transcript.json', 'b-transcript.json', 'c-transcript.json']);
  });
});

describe('assessWindow', () => {
  it('is not ready below target', () => {
    const w = assessWindow(new Array(7), 8);
    assert.equal(w.ready, false);
    assert.match(w.verdict, /^COLLECTING — 7\/8/);
  });

  it('is ready at exactly the target', () => {
    const w = assessWindow(new Array(8), 8);
    assert.equal(w.ready, true);
    assert.match(w.verdict, /^READY/);
  });

  it('READY tells the operator to adjudicate in the same sitting', () => {
    // The stopping rule is half the point: a filled window left unadjudicated
    // is exactly how the previous experiment became unreadable.
    assert.match(assessWindow(new Array(10), 8).verdict, /adjudicate in the same sitting/);
  });

  it('an EMPTY corpus is never ready — no vacuous green', () => {
    const w = assessWindow([], 8);
    assert.equal(w.ready, false);
    assert.equal(w.count, 0);
  });
});

describe('zeroFindingArms (bakeoff-collect)', () => {
  const armEntry = (over) => ({ shadowState: 'ran', buckets: { shadowOnly: 0 }, ...over });

  it('an arm with findings is never listed — this is about ZEROES only', () => {
    const e = { arms: { opus: armEntry({ buckets: { shadowOnly: 4 }, shadowVerdict: 'APPROVE' }), kimi: armEntry({ shadowVerdict: 'APPROVE' }) } };
    assert.deepEqual(zeroFindingArms(e).map((z) => z.arm), ['kimi']);
  });

  it('zero findings WITH a verdict reads as reviewed — a lenient model, not a broken arm', () => {
    const e = { arms: { opus: armEntry({ buckets: { shadowOnly: 1 } }), kimi: armEntry({ shadowVerdict: 'APPROVE' }) } };
    assert.deepEqual(zeroFindingArms(e), [{ arm: 'kimi', verdict: 'APPROVE', evidence: 'reviewed' }]);
  });

  it('zero findings with a RECORDED-but-empty verdict reads as no-verdict — suspect the arm', () => {
    const e = { arms: { kimi: armEntry({ shadowVerdict: null }) } };
    assert.deepEqual(zeroFindingArms(e), [{ arm: 'kimi', verdict: null, evidence: 'no-verdict' }]);
  });

  it('an ABSENT shadowVerdict key is `unrecorded`, NOT `no-verdict`', () => {
    // The campaign's own first three snapshots predate the field. Collapsing
    // absent into null would report them as broken arms and invite a re-run of
    // three snapshots that were fine.
    const e = { arms: { kimi: armEntry({}) } };
    assert.deepEqual(zeroFindingArms(e), [{ arm: 'kimi', verdict: undefined, evidence: 'unrecorded' }]);
  });

  it('an arm that did not RUN is not a zero-finding arm at all', () => {
    const e = { arms: { kimi: { shadowState: 'skipped-no-key', buckets: null } } };
    assert.deepEqual(zeroFindingArms(e), []);
  });
});
