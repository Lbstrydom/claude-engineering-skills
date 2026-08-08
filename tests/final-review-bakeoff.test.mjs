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
import { zeroFindingArms, isComplete, summarise, CONTRACT_EPOCH, buildArmArgs, EXPERIMENT_TAG } from '../scripts/bakeoff-collect.mjs';

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

describe('contract epoch + solo arm (bakeoff-collect isComplete)', () => {
  const ran = (over) => ({ shadowState: 'ran', buckets: { shadowOnly: 1 }, primaryVerdict: 'CONCERNS', ...over });
  const full = (over = {}) => ({
    contractEpoch: CONTRACT_EPOCH,
    arms: { opus: ran(), kimi: ran(), 'solo-opus': { primaryVerdict: 'APPROVE' }, ...over },
  });

  it('a fully-populated current-epoch snapshot counts', () => {
    assert.equal(isComplete(full()), true);
  });

  it('an UNSTAMPED entry never counts, however complete it looks', () => {
    // The e1 rows are exactly this shape. Counting them would compare arms that
    // ran at three different reasoning depths and call it a model result.
    const e = full();
    delete e.contractEpoch;
    assert.equal(isComplete(e), false);
  });

  it('a STALE epoch never counts — and is not silently upgraded', () => {
    assert.equal(isComplete({ ...full(), contractEpoch: 'e1-unmatched' }), false);
  });

  it('the solo arm is judged on its primary verdict, not on shadowState', () => {
    // It runs Opus as primary with no shadow; requiring shadowState==='ran'
    // would make every snapshot permanently incomplete.
    assert.equal(isComplete(full({ 'solo-opus': { primaryVerdict: 'REJECT', shadowState: null } })), true);
    assert.equal(isComplete(full({ 'solo-opus': { primaryVerdict: null } })), false);
  });

  it('an arm that ERRORED fails the snapshot even under the right epoch', () => {
    assert.equal(isComplete(full({ kimi: { error: 'exit 1' } })), false);
  });

  it('a missing arm fails the snapshot — absence is never treated as a pass', () => {
    const e = full();
    delete e.arms.kimi;
    assert.equal(isComplete(e), false);
  });

  it('the solo arm is excluded from zero-finding reporting (it has no shadow bucket)', () => {
    const z = zeroFindingArms(full({ opus: ran({ buckets: { shadowOnly: 0 }, shadowVerdict: 'APPROVE' }) }));
    assert.deepEqual(z.map((x) => x.arm), ['opus']);
  });
});

describe('summarise surfaces every arm (bakeoff-collect)', () => {
  const ran = (shadowOnly, primaryFindings) => ({
    shadowState: 'ran', shadowVerdict: 'CONCERNS', buckets: { shadowOnly }, primaryVerdict: 'CONCERNS', primaryFindings,
  });
  const snap = (id, opusUnique, kimiUnique, p1, p2, solo) => ({
    snapshotId: id, contractEpoch: CONTRACT_EPOCH,
    arms: { opus: ran(opusUnique, p1), kimi: ran(kimiUnique, p2), 'solo-opus': { primaryVerdict: 'CONCERNS', primaryFindings: solo } },
  });

  it('the solo arm contributes its PRIMARY findings, never a shadow bucket it does not have', () => {
    const s = summarise([snap('a', 7, 1, 2, 4, 7)], 12);
    assert.equal(s.totals.soloFindings, 7);
    assert.equal(s.totals.opusUnique, 7);
    assert.equal(s.totals.kimiUnique, 1);
  });

  it('primary self-divergence is the per-snapshot |P1 - P2| spread', () => {
    // Same primary model, same transcript, two runs. This is §0.4's
    // "is a 2nd reviewer just a reroll?" question, and it is free to collect.
    const s = summarise([snap('a', 7, 1, 2, 4, 7), snap('b', 3, 2, 5, 5, 3)], 12);
    assert.deepEqual(s.totals.primaryDivergence, [2, 0]);
  });

  it('an INCOMPLETE snapshot contributes to no total — not even a partial one', () => {
    const bad = snap('c', 9, 9, 9, 9, 9);
    delete bad.contractEpoch; // stale-epoch row
    const s = summarise([bad], 12);
    assert.equal(s.complete, 0);
    assert.equal(s.totals.opusUnique, 0);
    assert.equal(s.totals.soloFindings, 0);
    assert.deepEqual(s.totals.primaryDivergence, []);
  });
});

describe('cloud run wiring (bakeoff-collect buildArmArgs)', () => {
  const arm = { id: 'kimi', args: ['--provider', 'openrouter'] };
  const ctx = { transcript: 't.json', plan: 'p.md', mode: 'code', out: 'o.json' };

  it('threads --run-id so the final-review cloud write is armed', () => {
    // `runShadowAndPersist` bails at `if (!runId) return`, so omitting this
    // makes the ENTIRE persist a silent no-op — snapshots 2-3 of this campaign
    // reached the store with final_review_shadow_model NULL and zero findings
    // for exactly this reason, leaving nothing to adjudicate.
    const args = buildArmArgs(arm, { ...ctx, runId: 'run-abc' });
    const i = args.indexOf('--run-id');
    assert.notEqual(i, -1, '--run-id absent — the cloud write would be a no-op');
    assert.equal(args[i + 1], 'run-abc');
  });

  it('OMITS --run-id when registration failed, never passing a blank', () => {
    // A trailing `--run-id` with no value (or an empty string) is consumed as
    // the flag's VALUE by the argv parser and writes nowhere — the same silence
    // as omitting it, but harder to see.
    for (const runId of [null, undefined, '']) {
      const args = buildArmArgs(arm, { ...ctx, runId });
      assert.equal(args.includes('--run-id'), false, `blank run-id leaked for ${JSON.stringify(runId)}`);
    }
  });

  it('keeps the arm\u2019s own provider flags intact alongside the run id', () => {
    const args = buildArmArgs(arm, { ...ctx, runId: 'r1' });
    assert.ok(args.includes('--provider') && args.includes('openrouter'));
    assert.equal(args[args.indexOf('--mode') + 1], 'code');
  });

  it('tags every minted run as an experiment, so per-run rates can exclude it', () => {
    // The campaign quotes "~1.1 accepted HIGH/MED per RUN" — a rate whose
    // denominator is COUNT(*) over audit_runs. Replays are not audits; an
    // untagged replay deflates the rate it is being compared against.
    assert.equal(EXPERIMENT_TAG, 'final-review-bakeoff');
  });
});
