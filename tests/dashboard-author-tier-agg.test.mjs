// Pure aggregator for the Author-Tier dashboard panel (model-tier-observation).
// Deterministic seam → unit-tested directly (no DB).

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { aggregateAuthorTier } from '../scripts/lib/dashboard/author-tier-agg.mjs';

describe('aggregateAuthorTier', () => {
  it('empty input → zeroed shape, diversity gate not met', () => {
    const a = aggregateAuthorTier([]);
    assert.equal(a.total, 0);
    assert.deepEqual(a.bySuggestedTier, []);
    assert.deepEqual(a.ladders, []);
    assert.equal(a.distinctProviderLadders, 0);
    assert.equal(a.diversityGateMet, false);
    assert.deepEqual(a.agreement, { agree: 0, disagree: 0, declaredUnknown: 0 });
  });

  it('aggregates suggested tier × converged (string/bool converged both counted)', () => {
    const a = aggregateAuthorTier([
      { suggested_tier: 'frontier', declared_tier: 'frontier', provider: 'anthropic', family: 'claude', model: 'claude-opus-4-8', converged: 'true', n: 3 },
      { suggested_tier: 'frontier', declared_tier: 'frontier', provider: 'anthropic', family: 'claude', model: 'claude-opus-4-8', converged: false, n: 1 },
      { suggested_tier: 'economy', declared_tier: 'economy', provider: 'anthropic', family: 'claude', model: 'claude-opus-4-8', converged: true, n: 2 },
    ]);
    assert.equal(a.total, 6);
    const front = a.bySuggestedTier.find((t) => t.tier === 'frontier');
    assert.deepEqual(front, { tier: 'frontier', total: 4, converged: 3, convergedPct: 75 });
    const econ = a.bySuggestedTier.find((t) => t.tier === 'economy');
    assert.equal(econ.convergedPct, 100);
    // tier ordering is the canonical economy→standard→frontier→unknown
    assert.deepEqual(a.bySuggestedTier.map((t) => t.tier), ['economy', 'frontier']);
  });

  it('unknown / unlisted suggested tier folds into "unknown"', () => {
    const a = aggregateAuthorTier([{ suggested_tier: 'wat', converged: true, n: 2 }]);
    assert.equal(a.bySuggestedTier[0].tier, 'unknown');
  });

  it('ladder partition keys: distinct providers + diversity gate at >=3', () => {
    const rows = [
      { suggested_tier: 'frontier', declared_tier: 'frontier', provider: 'anthropic', family: 'claude', model: 'claude-opus-4-8', converged: true, n: 5 },
      { suggested_tier: 'standard', declared_tier: 'standard', provider: 'openai', family: 'gpt', model: 'gpt-5.5', converged: true, n: 2 },
      { suggested_tier: 'economy', declared_tier: 'economy', provider: 'google', family: 'gemini', model: 'gemini-flash-latest', converged: true, n: 1 },
    ];
    const a = aggregateAuthorTier(rows);
    assert.equal(a.distinctProviderLadders, 3);
    assert.equal(a.diversityGateMet, true);
    assert.equal(a.ladders.length, 3);
    assert.equal(a.ladders[0].model, 'claude-opus-4-8'); // sorted by count desc
  });

  it('single-provider data does NOT meet the diversity gate (bias guard)', () => {
    const a = aggregateAuthorTier([
      { suggested_tier: 'frontier', declared_tier: 'frontier', provider: 'anthropic', family: 'claude', model: 'claude-opus-4-8', converged: true, n: 50 },
    ]);
    assert.equal(a.distinctProviderLadders, 1);
    assert.equal(a.diversityGateMet, false);
  });

  it('rows with no declared model create no ladder + count as declaredUnknown', () => {
    const a = aggregateAuthorTier([
      { suggested_tier: 'standard', declared_tier: 'unknown', provider: null, family: null, model: null, converged: true, n: 4 },
    ]);
    assert.deepEqual(a.ladders, []);
    assert.equal(a.distinctProviderLadders, 0);
    assert.equal(a.agreement.declaredUnknown, 4);
  });

  it('agreement: suggested vs declared tier', () => {
    const a = aggregateAuthorTier([
      { suggested_tier: 'frontier', declared_tier: 'frontier', provider: 'anthropic', family: 'claude', model: 'm', converged: true, n: 2 }, // agree
      { suggested_tier: 'economy', declared_tier: 'frontier', provider: 'anthropic', family: 'claude', model: 'm', converged: true, n: 1 },  // disagree
      { suggested_tier: 'standard', declared_tier: 'unknown', provider: 'anthropic', family: 'claude', model: 'm', converged: true, n: 3 }, // unknown
    ]);
    assert.deepEqual(a.agreement, { agree: 2, disagree: 1, declaredUnknown: 3 });
  });

  it('ignores non-positive / non-array input safely', () => {
    assert.equal(aggregateAuthorTier(null).total, 0);
    assert.equal(aggregateAuthorTier([{ suggested_tier: 'frontier', n: 0 }]).total, 0);
  });
});
