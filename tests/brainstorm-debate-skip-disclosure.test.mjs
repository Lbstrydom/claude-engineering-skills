/**
 * A requested-but-cancelled `--debate` round has to be distinguishable from one
 * that was never requested.
 *
 * The defect this pins: `runDebateRound` returned a bare `[]` on every skip and
 * the caller emitted `debate: []` — the exact value a run WITHOUT `--debate`
 * emits. Nothing downstream could tell the two apart, so a skill-following
 * agent rendered no debate block and no explanation after the user had already
 * paid for round 1. The single-provider case had no stderr warning either (the
 * old warning was nested inside `if (providers.length === 2)`), so it was
 * silent on every surface at once.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  classifyDebateOutcome, DEBATE_SKIP_REASONS,
} from '../scripts/lib/brainstorm/debate-outcome.mjs';
import {
  BrainstormEnvelopeWriteSchema, BrainstormEnvelopeV2Schema,
} from '../scripts/lib/brainstorm/schemas.mjs';

const ok = (provider) => ({ provider, state: 'success' });

describe('classifyDebateOutcome — the direction it must NOT fire', () => {
  it('two voices, both successful → the debate runs, and skipped is null', () => {
    const r = classifyDebateOutcome({
      providers: ['openai', 'gemini'],
      round1: [ok('openai'), ok('gemini')],
    });
    assert.equal(r.ok, true);
    assert.equal(r.skipped, null);
  });
});

describe('classifyDebateOutcome — not-a-pair (previously silent on EVERY surface)', () => {
  for (const providers of [[], ['openai'], ['openai', 'gemini', 'azure-claude']]) {
    it(`${providers.length} voice(s) → not-a-pair, naming the count`, () => {
      const r = classifyDebateOutcome({
        providers,
        round1: providers.map(ok),
      });
      assert.equal(r.ok, false);
      assert.equal(r.skipped.reason, 'not-a-pair');
      // The detail has to carry the actual count — "skipped" with no number is
      // the uninformative state this whole change exists to remove.
      assert.match(r.skipped.detail, new RegExp(`\\b${providers.length}\\b`));
    });
  }
});

describe('classifyDebateOutcome — round-1-incomplete', () => {
  it('one voice failed → reason names BOTH providers and their states', () => {
    const r = classifyDebateOutcome({
      providers: ['openai', 'gemini'],
      round1: [ok('openai'), { provider: 'gemini', state: 'timeout' }],
    });
    assert.equal(r.ok, false);
    assert.equal(r.skipped.reason, 'round-1-incomplete');
    assert.match(r.skipped.detail, /openai=success/);
    assert.match(r.skipped.detail, /gemini=timeout/);
    assert.match(r.skipped.detail, /1\/2/);
  });

  it('a provider missing from round1 entirely reads as `absent`, not as success', () => {
    const r = classifyDebateOutcome({
      providers: ['openai', 'gemini'],
      round1: [ok('openai')],
    });
    assert.equal(r.ok, false);
    assert.match(r.skipped.detail, /gemini=absent/);
  });

  it('`truncated` is not success — half an argument is not a peer response', () => {
    const r = classifyDebateOutcome({
      providers: ['openai', 'gemini'],
      round1: [ok('openai'), { provider: 'gemini', state: 'truncated' }],
    });
    assert.equal(r.ok, false);
    assert.equal(r.skipped.reason, 'round-1-incomplete');
  });

  it('every emitted reason is in the closed set the SKILL.md renders', () => {
    const cases = [
      { providers: ['openai'], round1: [ok('openai')] },
      { providers: ['openai', 'gemini'], round1: [ok('openai')] },
    ];
    for (const c of cases) {
      assert.ok(DEBATE_SKIP_REASONS.includes(classifyDebateOutcome(c).skipped.reason));
    }
  });
});

// ── the envelope contract ────────────────────────────────────────────────────

const baseEnvelope = {
  topic: 't',
  redactionCount: 0,
  resolvedModels: { openai: 'gpt-x' },
  providers: [],
  totalCostUsd: 0,
  sid: 's1',
  round: 0,
  capturedAt: new Date('2026-08-27T00:00:00Z').toISOString(),
  schemaVersion: 2,
  debate: [],
  archContextAttached: false,
  archContextChars: 0,
  archContextWarning: null,
};

describe('envelope — a writer cannot omit the disclosure', () => {
  it('WriteSchema REJECTS an envelope with no debateSkipped key', () => {
    const r = BrainstormEnvelopeWriteSchema.safeParse({ ...baseEnvelope });
    assert.equal(r.success, false, 'omitting debateSkipped must fail at the write boundary');
  });

  it('WriteSchema accepts null — "not requested", or "it ran"', () => {
    const r = BrainstormEnvelopeWriteSchema.safeParse({ ...baseEnvelope, debateSkipped: null });
    assert.equal(r.success, true, r.error?.message);
  });

  it('WriteSchema accepts the skip object and preserves reason + detail', () => {
    const skipped = { reason: 'round-1-incomplete', detail: 'only 1/2 …' };
    const r = BrainstormEnvelopeWriteSchema.safeParse({ ...baseEnvelope, debateSkipped: skipped });
    assert.equal(r.success, true, r.error?.message);
    // A z.object STRIPS undeclared keys and the writer emits parsed data, so
    // round-tripping is the only proof the field survives to the consumer.
    assert.deepEqual(r.data.debateSkipped, skipped);
  });

  it('rejects a reason outside the closed set', () => {
    const r = BrainstormEnvelopeWriteSchema.safeParse({
      ...baseEnvelope, debateSkipped: { reason: 'because', detail: 'x' },
    });
    assert.equal(r.success, false);
  });

  it('V2 READ stays back-compatible — legacy rows have no such key', () => {
    const r = BrainstormEnvelopeV2Schema.safeParse({ ...baseEnvelope });
    assert.equal(r.success, true, r.error?.message);
  });
});
