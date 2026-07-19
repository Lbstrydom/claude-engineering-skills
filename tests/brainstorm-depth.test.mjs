/**
 * Tests for scripts/lib/brainstorm/depth-config.mjs
 * Plan ACs: AC2, AC3 (and §13.D depth realignment).
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { DEPTH_TOKENS, autoPromoteDepth, resolveDepth } from '../scripts/lib/brainstorm/depth-config.mjs';

describe('DEPTH_TOKENS map (§13.D)', () => {
  // The literal pins that used to live here (500 / 1500 / 4000) were REMOVED
  // on 2026-07-19, deliberately — they were not merely stale, they encoded the
  // defect. `DEPTH_TOKENS` is now the provider's TOTAL output ceiling, which
  // reasoning tokens are drawn from before any prose; the old figures were
  // sized for prose alone, so `shallow` returned an empty response and
  // `standard` was one reasoning-heavy answer away from the same fate. In
  // particular the "standard must stay 1500 to preserve prior behaviour" pin
  // was actively harmful: the prior behaviour is what broke.
  //
  // Structural invariants live here; the numeric contract (ceiling ≥ prose +
  // reasoning headroom) is asserted in tests/brainstorm-depth-budget.test.mjs.
  it('orders the tiers so depth is monotonic', () => {
    assert.ok(DEPTH_TOKENS.shallow < DEPTH_TOKENS.standard, 'shallow must be under standard');
    assert.ok(DEPTH_TOKENS.deep > DEPTH_TOKENS.standard, 'deep must exceed standard');
  });

  it('gives every tier room for reasoning tokens, not just prose', () => {
    for (const tier of ['shallow', 'standard', 'deep']) {
      assert.ok(DEPTH_TOKENS[tier] >= 2000,
        `${tier}: a ceiling this tight is consumed by thinking before any text is emitted`);
    }
  });
});

describe('autoPromoteDepth — heuristic', () => {
  const positive = [
    'design the architecture for a recommendation engine',
    'new schema for user preferences',
    'migration plan for the auth tables',
    'refactor the auth flow',
    'how should we structure the persistence layer?',
    "what's the best approach to event sourcing?",
  ];

  for (const topic of positive) {
    it(`promotes "${topic.slice(0, 40)}…" → deep`, () => {
      assert.equal(autoPromoteDepth(topic), 'deep');
    });
  }

  const negative = [
    'fix the login button text',
    'rename a variable',
    'what time is it',
    '',
  ];

  for (const topic of negative) {
    it(`does NOT promote "${topic.slice(0, 30)}" → null`, () => {
      assert.equal(autoPromoteDepth(topic), null);
    });
  }

  it('handles non-string input safely', () => {
    assert.equal(autoPromoteDepth(null), null);
    assert.equal(autoPromoteDepth(undefined), null);
    assert.equal(autoPromoteDepth(123), null);
  });
});

describe('resolveDepth — explicit + auto-promote precedence', () => {
  it('explicitDepth wins over auto-promote (architecture topic with explicit shallow)', () => {
    const r = resolveDepth({ explicitDepth: 'shallow', topic: 'design the architecture' });
    assert.equal(r.depth, 'shallow');
    assert.equal(r.maxTokens, DEPTH_TOKENS.shallow);
    assert.equal(r.autoPromoted, false);
  });

  it('autoPromote fires when no explicit', () => {
    const r = resolveDepth({ topic: 'how should we structure this' });
    assert.equal(r.depth, 'deep');
    assert.equal(r.maxTokens, DEPTH_TOKENS.deep);
    assert.equal(r.autoPromoted, true);
  });

  it('falls back to standard when neither explicit nor matching', () => {
    const r = resolveDepth({ topic: 'fix a typo' });
    assert.equal(r.depth, 'standard');
    assert.equal(r.maxTokens, DEPTH_TOKENS.standard);
    assert.equal(r.autoPromoted, false);
  });

  // Retained as a cost/latency hint, NOT as the truncation defence — that job
  // moved to REASONING_HEADROOM_TOKENS after `low` proved insufficient on
  // gpt-5.6 and was never available for Gemini at all.
  it('shallow carries reasoningEffort "low" — a 150–250-word answer needs no deep deliberation', () => {
    const r = resolveDepth({ explicitDepth: 'shallow' });
    assert.equal(r.reasoningEffort, 'low');
  });

  it('standard and deep leave reasoningEffort null (model default — behaviour unchanged)', () => {
    assert.equal(resolveDepth({ explicitDepth: 'standard' }).reasoningEffort, null);
    assert.equal(resolveDepth({ explicitDepth: 'deep' }).reasoningEffort, null);
    assert.equal(resolveDepth({ topic: 'fix a typo' }).reasoningEffort, null);
    assert.equal(resolveDepth({ topic: 'how should we structure this' }).reasoningEffort, null, 'auto-promoted deep also null');
  });

  it('throws on unknown explicit depth', () => {
    assert.throws(() => resolveDepth({ explicitDepth: 'huge' }), /Unknown depth/);
  });

  it('R4-M7 — rejects inherited Object.prototype keys (constructor / toString / __proto__)', () => {
    for (const malicious of ['constructor', 'toString', 'hasOwnProperty', '__proto__', 'valueOf']) {
      assert.throws(
        () => resolveDepth({ explicitDepth: malicious }),
        /Unknown depth/,
        `must reject inherited key: ${malicious}`,
      );
    }
  });
});
