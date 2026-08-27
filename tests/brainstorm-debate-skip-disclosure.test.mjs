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
  classifyDebateOutcome, DEBATE_SKIP_REASONS, isDebateEligible,
} from '../scripts/lib/brainstorm/debate-outcome.mjs';
import {
  BrainstormEnvelopeWriteSchema, BrainstormEnvelopeV2Schema,
  DebateRoundSchema, PROVIDER_STATES, BrainstormOutputSchema,
} from '../scripts/lib/brainstorm/schemas.mjs';

const ok = (provider) => ({ provider, state: 'success', text: 'a position' });

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

// ── round-1 audit fixes ──────────────────────────────────────────────────────

describe('envelope — debate and debateSkipped are one outcome, so PAIRS are validated (M3/M6)', () => {
  const ranEntry = {
    provider: 'openai', reactingTo: 'gemini', state: 'success', text: 't',
    errorMessage: null, httpStatus: null, usage: null, latencyMs: 1,
    estimatedCostUsd: null,
  };

  it('REJECTS the contradictory pair — cancelled AND completed', () => {
    const r = BrainstormEnvelopeWriteSchema.safeParse({
      ...baseEnvelope,
      debate: [ranEntry],
      debateSkipped: { reason: 'not-a-pair', detail: 'x' },
    });
    assert.equal(r.success, false, 'a round cannot be both cancelled and completed');
  });

  it('accepts a completed round (populated debate, skipped null)', () => {
    const r = BrainstormEnvelopeWriteSchema.safeParse({
      ...baseEnvelope, debate: [ranEntry], debateSkipped: null,
    });
    assert.equal(r.success, true, r.error?.message);
  });

  it('accepts a cancelled round (empty debate, skipped set)', () => {
    const r = BrainstormEnvelopeWriteSchema.safeParse({
      ...baseEnvelope, debate: [], debateSkipped: { reason: 'not-a-pair', detail: 'x' },
    });
    assert.equal(r.success, true, r.error?.message);
  });

  it('the same refinement guards the READ schema, not only writes', () => {
    const r = BrainstormEnvelopeV2Schema.safeParse({
      ...baseEnvelope,
      debate: [ranEntry],
      debateSkipped: { reason: 'not-a-pair', detail: 'x' },
    });
    assert.equal(r.success, false);
  });
});

describe('DebateRoundSchema state — a debate call is a FRESH request (M2)', () => {
  const entry = (state) => ({
    provider: 'openai', reactingTo: 'gemini', state, text: 'partial',
    errorMessage: null, httpStatus: null, usage: null, latencyMs: 1,
    estimatedCostUsd: null,
  });

  for (const state of ['truncated', 'blocked', 'misconfigured']) {
    it(`persists \`${state}\` under its own name, not collapsed to http_error`, () => {
      const r = BrainstormEnvelopeWriteSchema.safeParse({
        ...baseEnvelope, debate: [entry(state)], debateSkipped: null,
      });
      assert.equal(r.success, true, r.error?.message);
      assert.equal(r.data.debate[0].state, state);
    });
  }

  it('the debate state enum IS the provider-state contract — no second list', () => {
    assert.deepEqual(
      [...DebateRoundSchema.shape.state.options].sort(),
      [...PROVIDER_STATES].sort(),
    );
  });

  it('an unknown state still fails at the boundary rather than being renamed', () => {
    const r = BrainstormEnvelopeWriteSchema.safeParse({
      ...baseEnvelope, debate: [entry('teleported')], debateSkipped: null,
    });
    assert.equal(r.success, false);
  });
});

describe('skip-reason vocabulary has ONE owner (L2)', () => {
  it('the schema enum is derived from DEBATE_SKIP_REASONS, not a second copy', () => {
    const schemaReasons = BrainstormEnvelopeV2Schema.safeParse({
      ...baseEnvelope, debateSkipped: { reason: 'not-a-pair', detail: 'x' },
    });
    assert.equal(schemaReasons.success, true);
    // Every classifier reason must be persistable; a divergence would mean a
    // valid classification that cannot be written.
    for (const reason of DEBATE_SKIP_REASONS) {
      const r = BrainstormEnvelopeWriteSchema.safeParse({
        ...baseEnvelope, debateSkipped: { reason, detail: 'x' },
      });
      assert.equal(r.success, true, `classifier reason "${reason}" is not persistable`);
    }
  });
});

describe('two voices means two DISTINCT voices (round-2 audit M2/M5)', () => {
  it('the same voice twice is not a pair — it used to crash runDebateRound', () => {
    // `providers.find(p => p !== speaker)` is undefined for BOTH speakers here,
    // so the peer lookup yielded undefined and `peerResp.text` threw.
    const r = classifyDebateOutcome({
      providers: ['openai', 'openai'],
      round1: [ok('openai')],
    });
    assert.equal(r.ok, false);
    assert.equal(r.skipped.reason, 'not-a-pair');
    assert.match(r.skipped.detail, /same voice twice/);
  });

  it('two duplicated voices that BOTH succeeded are still not a pair', () => {
    const r = classifyDebateOutcome({
      providers: ['gemini', 'gemini'],
      round1: [ok('gemini'), ok('gemini')],
    });
    assert.equal(r.ok, false);
    assert.equal(r.skipped.reason, 'not-a-pair');
  });

  it('a genuine pair is unaffected — the guard must not fire on the happy path', () => {
    const r = classifyDebateOutcome({
      providers: ['openai', 'gemini'],
      round1: [ok('openai'), ok('gemini')],
    });
    assert.equal(r.ok, true);
    assert.equal(r.skipped, null);
  });
});

describe('the debate/debateSkipped pair contract is TOTAL (round-2 audit M4)', () => {
  it('WriteSchema rejects an envelope with NO debate key', () => {
    const { debate, ...noDebate } = baseEnvelope;
    const r = BrainstormEnvelopeWriteSchema.safeParse({ ...noDebate, debateSkipped: null });
    assert.equal(r.success, false, 'debate must be present so the refinement can judge the pair');
  });

  it('the refinement treats an absent debate as empty, not as unjudgeable', () => {
    const { debate, ...noDebate } = baseEnvelope;
    // READ schema keeps `debate` optional for legacy rows, so the `?? []`
    // fallback is what stops an absent key from skipping the check.
    const r = BrainstormEnvelopeV2Schema.safeParse({
      ...noDebate, debateSkipped: { reason: 'not-a-pair', detail: 'x' },
    });
    assert.equal(r.success, true, 'absent debate + a skip is the legal cancelled case');
  });
});

describe('a state label is not a peer response (round-3 audit H3)', () => {
  const empty = (provider, text) => ({ provider, state: 'success', text });

  for (const [label, text] of [['null', null], ['empty string', ''], ['whitespace only', '   \n ']]) {
    it(`success with ${label} text is NOT debate-eligible`, () => {
      const r = classifyDebateOutcome({
        providers: ['openai', 'gemini'],
        round1: [{ ...ok('openai'), text: 'a real position' }, empty('gemini', text)],
      });
      assert.equal(r.ok, false, 'buildDebatePrompt would throw on this response');
      assert.equal(r.skipped.reason, 'round-1-incomplete');
    });
  }

  it('names the state distinctly — "said success, sent nothing" is not a plain failure', () => {
    const r = classifyDebateOutcome({
      providers: ['openai', 'gemini'],
      round1: [{ ...ok('openai'), text: 'a real position' }, empty('gemini', null)],
    });
    assert.match(r.skipped.detail, /gemini=success-but-empty/);
  });

  it('a real pair with real text still runs', () => {
    const r = classifyDebateOutcome({
      providers: ['openai', 'gemini'],
      round1: [{ ...ok('openai'), text: 'x' }, { ...ok('gemini'), text: 'y' }],
    });
    assert.equal(r.ok, true);
  });

  it('isDebateEligible is the single oracle — it agrees with the classifier', () => {
    const usable = { provider: 'openai', state: 'success', text: 'x' };
    const unusable = { provider: 'openai', state: 'success', text: null };
    assert.equal(isDebateEligible(usable), true);
    assert.equal(isDebateEligible(unusable), false);
    assert.equal(isDebateEligible(undefined), false);
    assert.equal(isDebateEligible({ provider: 'openai', state: 'truncated', text: 'half' }), false);
  });
});

describe('the union is a fallback, not a validation bypass (round-5 audit M5)', () => {
  const ran = {
    provider: 'openai', reactingTo: 'gemini', state: 'success', text: 't',
    errorMessage: null, httpStatus: null, usage: null, latencyMs: 1, estimatedCostUsd: null,
  };
  const contradictory = { ...baseEnvelope, debate: [ran], debateSkipped: { reason: 'not-a-pair', detail: 'x' } };

  it('a schemaVersion:2 record failing V2 does NOT fall through to V1', () => {
    assert.equal(BrainstormEnvelopeV2Schema.safeParse(contradictory).success, false);
    assert.equal(
      BrainstormOutputSchema.safeParse(contradictory).success, false,
      'V1 would accept it and silently strip every V2 field',
    );
  });

  it('a genuine legacy V1 record is still accepted — the guard must not overreach', () => {
    const v1 = {
      topic: 't', redactionCount: 0, resolvedModels: { openai: 'g' },
      providers: [], totalCostUsd: 0,
    };
    assert.equal(BrainstormOutputSchema.safeParse(v1).success, true);
  });

  it('a valid V2 record parses as V2 and keeps its V2 fields', () => {
    const r = BrainstormOutputSchema.safeParse({ ...baseEnvelope, debateSkipped: null });
    assert.equal(r.success, true, r.error?.message);
    for (const k of ['sid', 'round', 'debate', 'debateSkipped']) {
      assert.ok(k in r.data, `${k} was stripped — the V1 branch swallowed a V2 record`);
    }
  });
});
