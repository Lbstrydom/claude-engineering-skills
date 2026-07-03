/**
 * Tests for scripts/lib/brainstorm/depth-config.mjs
 * Plan ACs: AC2, AC3 (and §13.D depth realignment).
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { DEPTH_TOKENS, autoPromoteDepth, resolveDepth } from '../scripts/lib/brainstorm/depth-config.mjs';

describe('DEPTH_TOKENS map (§13.D)', () => {
  it('has shallow / standard / deep tiers in correct ratios', () => {
    assert.equal(DEPTH_TOKENS.shallow, 500);
    assert.equal(DEPTH_TOKENS.standard, 1500);
    assert.equal(DEPTH_TOKENS.deep, 4000);
  });

  it('standard matches the existing helper default (1500) so no-flag invocations preserve prior behaviour', () => {
    assert.equal(DEPTH_TOKENS.standard, 1500);
  });

  it('deep > standard so auto-promote actually expands context (not restricts)', () => {
    assert.ok(DEPTH_TOKENS.deep > DEPTH_TOKENS.standard, 'deep must exceed standard');
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
    assert.equal(r.maxTokens, 500);
    assert.equal(r.autoPromoted, false);
  });

  it('autoPromote fires when no explicit', () => {
    const r = resolveDepth({ topic: 'how should we structure this' });
    assert.equal(r.depth, 'deep');
    assert.equal(r.maxTokens, 4000);
    assert.equal(r.autoPromoted, true);
  });

  it('falls back to standard when neither explicit nor matching', () => {
    const r = resolveDepth({ topic: 'fix a typo' });
    assert.equal(r.depth, 'standard');
    assert.equal(r.maxTokens, 1500);
    assert.equal(r.autoPromoted, false);
  });

  it('shallow carries reasoningEffort "low" — reasoning models must not burn the 500-token cap thinking (field-found gpt-5.5)', () => {
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
