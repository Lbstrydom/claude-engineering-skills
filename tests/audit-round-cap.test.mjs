/**
 * Pure unit tests for the GPT audit round cap (docs/plans/audit-round-cap-structural-or-stop.md §2.1, §9).
 * The spawned-CLI half lives in tests/audit-round-cap-cli.test.mjs.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  AUDIT_ROUND_CAPS, EXIT_CAPPED, MIN_PAST_CAP_REASON_CHARS,
  readFlagValue, parseRoundFlag, resolveAuditMode, validateAuditRound, cardFileName, formatRoundCapLine,
} from '../scripts/lib/audit/round-cap.mjs';

const GOOD = 'one more round converges: the fix removes the recurring cluster';

describe('readFlagValue', () => {
  it('distinguishes absent, present-with-value and present-without-value', () => {
    assert.deepEqual(readFlagValue(['plan', 'x'], '--round'), { present: false, value: null });
    assert.deepEqual(readFlagValue(['--round', '3'], '--round'), { present: true, value: '3' });
    assert.deepEqual(readFlagValue(['--round'], '--round'), { present: true, value: null });
    assert.deepEqual(readFlagValue(['--round', '--out', 'f'], '--round'), { present: true, value: null });
  });
});

describe('parseRoundFlag — strict whole-string positive integer', () => {
  it('applies the default only when the flag is absent', () => {
    assert.deepEqual(parseRoundFlag(['plan', 'p.md'], '--round', 1), { ok: true, value: 1 });
    assert.deepEqual(parseRoundFlag(['--round', '4'], '--round', 1), { ok: true, value: 4 });
  });
  for (const bad of ['', '1.5', '3junk', '1e2', '0', '-1', 'abc', '9007199254740993', ' 2', '02']) {
    it(`refuses ${JSON.stringify(bad)}`, () => {
      const r = parseRoundFlag(['--round', bad], '--round', 1);
      assert.equal(r.ok, false, `expected refusal for ${JSON.stringify(bad)}`);
      assert.equal(r.code, 'BAD_ROUND');
      assert.equal(r.exitCode, 1);
    });
  }
  it('refuses a present flag with no value (does not fall back to the default)', () => {
    const r = parseRoundFlag(['--round'], '--round', 1);
    assert.equal(r.ok, false);
    assert.match(r.error, /missing value/);
  });
  it('names the flag it parsed', () => {
    const r = parseRoundFlag(['--max-rounds', 'x'], '--max-rounds', 4);
    assert.match(r.error, /--max-rounds/);
  });
});

describe('resolveAuditMode — positional is authoritative', () => {
  it('accepts positional alone and positional + equal --mode', () => {
    assert.deepEqual(resolveAuditMode(['plan', 'p.md']), { ok: true, mode: 'plan' });
    assert.deepEqual(resolveAuditMode(['plan', 'p.md', '--mode', 'plan']), { ok: true, mode: 'plan' });
  });
  it('refuses a conflicting --mode', () => {
    const r = resolveAuditMode(['plan', 'p.md', '--mode', 'code']);
    assert.equal(r.ok, false);
    assert.equal(r.code, 'MODE_CONFLICT');
    assert.equal(r.exitCode, 1);
  });
  it('does not invent a conflict when the positional is missing', () => {
    // an invalid positional is the usage check's problem, not a mode conflict
    assert.deepEqual(resolveAuditMode(['--mode', 'plan']), { ok: true, mode: '--mode' });
  });
});

describe('validateAuditRound — cap grid', () => {
  for (const mode of ['plan', 'code']) {
    const { soft, absolute } = AUDIT_ROUND_CAPS[mode];
    it(`${mode}: rounds within the soft cap pass with no flag`, () => {
      for (const round of [1, soft]) {
        const r = validateAuditRound({ mode, round });
        assert.equal(r.ok, true);
        assert.equal(r.pastCap, false);
      }
    });
    it(`${mode}: --past-cap on a within-cap round is refused as unneeded (exit 1, no card)`, () => {
      const r = validateAuditRound({ mode, round: soft, pastCapReason: GOOD });
      assert.equal(r.ok, false);
      assert.equal(r.code, 'PAST_CAP_UNNEEDED');
      assert.equal(r.exitCode, 1);
      assert.equal(r.needsCard, false);
    });
    it(`${mode}: soft+1 without a reason, or with a short one, is a card-bearing cap stop`, () => {
      for (const reason of [null, undefined, '', 'short', '   padded   ']) {
        const r = validateAuditRound({ mode, round: soft + 1, pastCapReason: reason });
        assert.equal(r.ok, false, `reason ${JSON.stringify(reason)}`);
        assert.equal(r.code, 'PAST_CAP_REQUIRED');
        assert.equal(r.exitCode, EXIT_CAPPED);
        assert.equal(r.needsCard, true);
        assert.match(r.error, /--past-cap/);
        assert.ok(r.error.includes(String(soft)) && r.error.includes(String(absolute)), 'names both caps');
      }
    });
    it(`${mode}: soft+1 .. absolute with a real reason passes, trimmed`, () => {
      for (let round = soft + 1; round <= absolute; round++) {
        const r = validateAuditRound({ mode, round, pastCapReason: `  ${GOOD}  ` });
        assert.equal(r.ok, true);
        assert.equal(r.pastCap, true);
        assert.equal(r.pastCapReason, GOOD);
      }
    });
    it(`${mode}: past the absolute cap is refused whatever the reason`, () => {
      const r = validateAuditRound({ mode, round: absolute + 1, pastCapReason: GOOD });
      assert.equal(r.ok, false);
      assert.equal(r.code, 'ABSOLUTE_CAP');
      assert.equal(r.exitCode, EXIT_CAPPED);
      assert.equal(r.needsCard, true);
    });
  }
  it('the reason threshold is exactly MIN_PAST_CAP_REASON_CHARS after trimming', () => {
    const edge = 'x'.repeat(MIN_PAST_CAP_REASON_CHARS);
    assert.equal(validateAuditRound({ mode: 'plan', round: 4, pastCapReason: edge }).ok, true);
    assert.equal(validateAuditRound({ mode: 'plan', round: 4, pastCapReason: edge.slice(1) }).ok, false);
  });
  it('rebuttal and unknown modes are never capped', () => {
    assert.equal(validateAuditRound({ mode: 'rebuttal', round: 99 }).ok, true);
    assert.equal(validateAuditRound({ mode: undefined, round: 99 }).ok, true);
  });
  it('negative control: the exit-4 code is distinct from the CLI-error (1) and INCOMPLETE (3) codes', () => {
    assert.equal(EXIT_CAPPED, 4);
    assert.ok(![0, 1, 2, 3].includes(EXIT_CAPPED));
  });
});

describe('cardFileName / formatRoundCapLine', () => {
  it('keys the card by session and round, with a fallback session token', () => {
    assert.equal(cardFileName('audit-plan-1-2', 4), 'audit-plan-1-2-r4-structural-card.json');
    assert.equal(cardFileName(null, 4), 'session-r4-structural-card.json');
  });
  it('renders within-cap and past-cap lines', () => {
    assert.match(formatRoundCapLine({ mode: 'plan', round: 2, pastCap: false }), /within cap: plan round 2\/3/);
    const line = formatRoundCapLine({ mode: 'code', round: 7, pastCap: true, pastCapReason: GOOD });
    assert.match(line, /past cap: code round 7 \(soft 6, absolute 8\)/);
    assert.ok(line.includes(GOOD));
  });
});
