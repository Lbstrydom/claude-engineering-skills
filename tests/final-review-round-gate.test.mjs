/**
 * @fileoverview Tier 1 unit tests for the final-review round gate
 * (scripts/lib/final-review/round-gate.mjs) and the round-2 prior-topic
 * suppression (post-review.mjs::applyPriorRoundSuppression).
 *
 * Field report 2026-09-26: the final reviewer was re-run 7 times; the last run
 * called every remaining finding "not release-blocking" yet its verdict stayed
 * CONCERNS_REMAINING, so the gate closed only by user override. These pin:
 *   - the code-computed disposition truth table (verdict stays the model's word);
 *   - the fail-closed reading of a missing/contradictory release-blocking pair;
 *   - the hard 2-round cap as a refusal, not prose;
 *   - prior-round suppression, WITH a negative control (a genuinely different
 *     finding must survive) and the is_reopened escape hatch;
 *   - the debt projection that feeds debt-auto-capture's existing write path.
 * Canned objects only — no provider, no network.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  FINAL_REVIEW_MAX_ROUNDS, checkBlockingPair, isReleaseBlocking, computeGateDisposition,
  stampGateDisposition, validateRoundArgs, parsePriorResult, buildPriorRoundBlock,
  finalReviewToLedgerEntries,
} from '../scripts/lib/final-review/round-gate.mjs';
import { applyPriorRoundSuppression } from '../scripts/lib/final-review/post-review.mjs';
import { getReviewPrompt, RELEASE_BLOCKING_BLOCK } from '../scripts/lib/final-review/prompts.mjs';

function finding(overrides = {}) {
  return {
    id: 'G1', severity: 'MEDIUM', category: 'Missing Error Handling',
    section: 'scripts/lib/foo.mjs:10',
    detail: 'readConfig swallows the parse error and returns an empty object, hiding a corrupt config file',
    risk: 'a corrupt config silently resets every setting to default',
    recommendation: 'rethrow with the file path', is_quick_fix: false, is_mechanical: false,
    principle: 'Fail loudly', is_reopened: false,
    classification: { sonarType: 'BUG', effort: 'EASY', sourceKind: 'REVIEWER', sourceName: 'gemini' },
    release_blocking: false, blocking_basis: 'none', _hash: 'abcd1234',
    ...overrides,
  };
}
const blocking = (o = {}) => finding({ id: 'G2', release_blocking: true, blocking_basis: 'data_loss', _hash: 'ffff0000', ...o });
const result = (verdict, new_findings = [], wrongly_dismissed = [], extra = {}) => ({ verdict, new_findings, wrongly_dismissed, ...extra });
const refuted = { verification: { verification: 'refuted', verificationReason: 'entity exists' } };

describe('checkBlockingPair — the pairing rule the provider schema cannot express', () => {
  it('accepts the two legal pairs', () => {
    assert.equal(checkBlockingPair(finding()).valid, true);
    assert.equal(checkBlockingPair(blocking()).valid, true);
  });
  it('rejects blocking with basis none, and non-blocking with a real basis', () => {
    assert.equal(checkBlockingPair(finding({ release_blocking: true, blocking_basis: 'none' })).valid, false);
    assert.equal(checkBlockingPair(finding({ release_blocking: false, blocking_basis: 'security' })).valid, false);
  });
  it('rejects a missing field and an off-enum basis', () => {
    const { release_blocking: _rb, ...noFlag } = finding();
    assert.equal(checkBlockingPair(noFlag).valid, false);
    assert.equal(checkBlockingPair(finding({ blocking_basis: 'style' })).valid, false);
  });
  it('isReleaseBlocking fails CLOSED on an invalid pair, and exempts a refuted finding', () => {
    assert.equal(isReleaseBlocking(finding({ release_blocking: undefined })), true);
    assert.equal(isReleaseBlocking(finding({ release_blocking: false, blocking_basis: 'security' })), true);
    assert.equal(isReleaseBlocking(finding()), false, 'negative control: a valid non-blocking finding does not block');
    assert.equal(isReleaseBlocking(blocking(refuted)), false);
  });
});

describe('computeGateDisposition — truth table', () => {
  const cases = [
    ['APPROVE, no findings', result('APPROVE'), 'approve'],
    ['APPROVE + non-blocking finding', result('APPROVE', [finding()]), 'approve'],
    ['APPROVE + blocking finding (contradiction resolves closed)', result('APPROVE', [blocking()]), 'blocked'],
    ['CONCERNS, all non-blocking', result('CONCERNS', [finding(), finding({ id: 'G3' })]), 'approve_with_debt'],
    ['CONCERNS_REMAINING, all non-blocking (the field-report case)', result('CONCERNS_REMAINING', [finding()]), 'approve_with_debt'],
    ['CONCERNS_REMAINING, no findings', result('CONCERNS_REMAINING'), 'approve_with_debt'],
    ['CONCERNS + one blocking', result('CONCERNS', [finding(), blocking()]), 'blocked'],
    ['CONCERNS + degraded finding (no pair)', result('CONCERNS', [finding({ release_blocking: undefined, blocking_basis: undefined })]), 'blocked'],
    ['CONCERNS + blocking but REFUTED', result('CONCERNS', [blocking(refuted)]), 'approve_with_debt'],
    ['CONCERNS + HIGH wrongly_dismissed', result('CONCERNS', [], [{ original_finding_id: 'H3', recommended_severity: 'HIGH' }]), 'blocked'],
    ['CONCERNS + MEDIUM wrongly_dismissed', result('CONCERNS', [], [{ original_finding_id: 'M3', recommended_severity: 'MEDIUM' }]), 'approve_with_debt'],
    ['CONCERNS + HIGH wrongly_dismissed but refuted', result('CONCERNS', [], [{ original_finding_id: 'H3', recommended_severity: 'HIGH', ...refuted }]), 'approve_with_debt'],
    ['REJECT, no findings', result('REJECT'), 'blocked'],
    ['REJECT, non-blocking only', result('REJECT', [finding()]), 'blocked'],
    ['coverage-gated (reviewer saw none of the diff)', result('CONCERNS', [], [], { _coverageGate: { downgraded: true } }), 'blocked'],
    ['unrecognised verdict', result('MAYBE'), 'blocked'],
  ];
  for (const [name, r, expected] of cases) {
    it(`${name} → ${expected}`, () => {
      assert.equal(computeGateDisposition(r).disposition, expected);
    });
  }

  it('names the blocking ids, the debt ids and the pair violations', () => {
    const d = computeGateDisposition(result('CONCERNS', [finding(), blocking(), finding({ id: 'G9', blocking_basis: 'bogus' })]));
    assert.deepEqual(d.blockingIds, ['G2', 'G9']);
    assert.deepEqual(d.debtIds, ['G1']);
    assert.deepEqual(d.pairViolations.map((p) => p.id), ['G9']);
  });

  it('stampGateDisposition leaves the model verdict untouched and emits a summary fragment', () => {
    const r = result('CONCERNS_REMAINING', [finding()]);
    const line = stampGateDisposition(r, 2);
    assert.equal(r.verdict, 'CONCERNS_REMAINING', 'verdict is the model\'s word');
    assert.equal(r.gateDisposition, 'approve_with_debt');
    assert.equal(r.finalReviewRound, 2);
    assert.match(line, /Gate: approve_with_debt \(blocking 0, debt 1\) \| Round 2\/2/);
  });
});

describe('validateRoundArgs — the 2-round cap is code', () => {
  it('the cap is 2', () => assert.equal(FINAL_REVIEW_MAX_ROUNDS, 2));
  it('refuses --round 3 and above, naming the cap and the way to close', () => {
    for (const round of ['3', '4', '10']) {
      const v = validateRoundArgs({ round, priorPath: 'prior.json' });
      assert.equal(v.ok, false);
      assert.match(v.error, /capped at 2 rounds/);
      assert.match(v.error, /debt-auto-capture\.mjs --final-review/);
    }
  });
  it('round 2 requires --prior; --prior requires round 2', () => {
    assert.equal(validateRoundArgs({ round: '2', priorPath: null }).ok, false);
    assert.equal(validateRoundArgs({ round: null, priorPath: 'p.json' }).ok, false);
    assert.equal(validateRoundArgs({ round: '1', priorPath: 'p.json' }).ok, false);
  });
  it('rejects a non-integer round', () => {
    assert.equal(validateRoundArgs({ round: '1.5', priorPath: null }).ok, false);
    assert.equal(validateRoundArgs({ round: '0', priorPath: null }).ok, false);
    assert.equal(validateRoundArgs({ round: 'two', priorPath: null }).ok, false);
  });
  it('negative control: absent, 1, and 2-with-prior are accepted', () => {
    assert.deepEqual(validateRoundArgs({ round: null, priorPath: null }), { ok: true, round: null });
    assert.deepEqual(validateRoundArgs({ round: '1', priorPath: null }), { ok: true, round: 1 });
    assert.deepEqual(validateRoundArgs({ round: '2', priorPath: 'p.json' }), { ok: true, round: 2 });
  });
  it('parsePriorResult refuses non-JSON and a result without new_findings', () => {
    assert.equal(parsePriorResult('not json').ok, false);
    assert.equal(parsePriorResult('{"verdict":"CONCERNS"}').ok, false);
    assert.equal(parsePriorResult('{"new_findings":[]}').ok, true);
  });
});

describe('applyPriorRoundSuppression — round 2 does not re-raise settled items', () => {
  const prior = [finding({ id: 'G1' })];
  const reworded = finding({
    id: 'G1', detail: 'readConfig swallows the JSON parse error and returns an empty object, hiding a corrupt config file on disk',
  });
  const different = finding({
    id: 'G2', category: 'Race Condition', section: 'scripts/lib/queue.mjs:88',
    detail: 'drainQueue reads the length before awaiting the lock, so two workers can both pop the last job',
    risk: 'the same job runs twice',
  });

  it('drops a reworded re-raise of a prior-round finding', () => {
    const r = { new_findings: [reworded] };
    applyPriorRoundSuppression(r, prior);
    assert.equal(r.new_findings.length, 0);
    assert.equal(r._priorSuppressedCount, 1);
    assert.equal(r._priorSuppressedFindings[0].matchedPriorId, 'G1');
  });

  it('negative control: a genuinely different finding survives', () => {
    const r = { new_findings: [reworded, different] };
    applyPriorRoundSuppression(r, prior);
    assert.deepEqual(r.new_findings.map((f) => f.category), ['Race Condition']);
  });

  it('a re-raise marked is_reopened survives (the prompt requires it to cite the changed line)', () => {
    const r = { new_findings: [{ ...reworded, is_reopened: true }] };
    applyPriorRoundSuppression(r, prior);
    assert.equal(r.new_findings.length, 1);
  });

  it('no prior findings → no-op', () => {
    const r = { new_findings: [reworded] };
    assert.deepEqual(applyPriorRoundSuppression(r, []), { suppressed: 0 });
    assert.equal(r.new_findings.length, 1);
  });
});

describe('buildPriorRoundBlock — the settled-items prompt block', () => {
  it('names the round, the cap, each prior finding, and the narrowed scope', () => {
    const block = buildPriorRoundBlock({ new_findings: [finding(), blocking()] }, 2);
    assert.match(block, /ROUND 2 OF 2/);
    assert.match(block, /\[G1\] MEDIUM non-blocking/);
    assert.match(block, /\[G2\] MEDIUM BLOCKING\(data_loss\)/);
    assert.match(block, /regressions introduced by the fixes/);
    assert.match(block, /is_reopened: true/);
  });
  it('redacts a secret carried in prior finding prose (it rides the system prompt, outside the envelope scan)', () => {
    const block = buildPriorRoundBlock({ new_findings: [finding({ detail: 'hardcoded ghp_abcdefghijklmnopqrstuvwxyz0123456789 in config' })] }, 2);
    assert.doesNotMatch(block, /ghp_abcdefghij/);
    assert.match(block, /REDACTED/);
  });
});

describe('finalReviewToLedgerEntries — debt projection for debt-auto-capture', () => {
  it('projects non-blocking findings only; lists blocking; skips an unkeyable one', () => {
    const r = { finalReviewRound: 2, new_findings: [finding(), blocking(), finding({ id: 'G7', _hash: undefined }), finding({ id: 'G8', _hash: 'dead0001', ...refuted })] };
    const { entries, blocked, skipped } = finalReviewToLedgerEntries(r);
    assert.deepEqual(entries.map((e) => e.topicId), ['abcd1234']);
    assert.equal(entries[0].ruling, 'defer');
    assert.equal(entries[0].pass, 'final-review');
    assert.match(entries[0].rulingRationale, /round 2 finding G1/);
    assert.ok(entries[0].rulingRationale.length >= 20);
    assert.deepEqual(blocked, ['G2']);
    assert.deepEqual(skipped.map((s) => s.id), ['G7']);
  });
});

describe('prompt — release-blocking definitions always reach the model', () => {
  it('getReviewPrompt appends the release-blocking block after the (evolvable) base', () => {
    const p = getReviewPrompt();
    assert.ok(p.includes(RELEASE_BLOCKING_BLOCK));
    for (const basis of ['acceptance_criterion', 'changed_code_regression', 'security', 'data_loss', 'runtime_failure']) {
      assert.ok(RELEASE_BLOCKING_BLOCK.includes(basis), basis);
    }
  });
});
