/**
 * Tier-1 deterministic-seam tests for the banding contract.
 * Plan: docs/plans/arch-memory-band-recalibration.md §2.1 C3 / C7.
 *
 * The load-bearing property: a MISSING embedding must never be coerced into a
 * number. `Number(null) === 0` bands as `review`, which asserts "we looked and
 * it was a poor match" about a symbol that was never compared at all.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

import { recommendationFromSimilarity, rankNeighbourhood } from '../scripts/lib/symbol-index.mjs';
import { ScoredSymbolRecordSchema } from '../scripts/lib/symbol-index-contracts.mjs';

describe('banding / null is unscored, never coerced', () => {
  it('null → unscored', () => {
    assert.equal(recommendationFromSimilarity(null), 'unscored');
  });
  it('undefined → unscored', () => {
    assert.equal(recommendationFromSimilarity(undefined), 'unscored');
  });
  it('NaN → unscored, not a threshold comparison', () => {
    assert.equal(recommendationFromSimilarity(NaN), 'unscored');
  });
  it('a real 0 is NOT unscored — it is a genuine (orthogonal) measurement', () => {
    // This is the distinction the whole change exists to preserve: 0 means
    // "compared, and orthogonal"; null means "never compared".
    assert.equal(recommendationFromSimilarity(0), 'review');
  });
});

describe('banding / threshold table boundaries', () => {
  const cases = [
    [1.00, 'reuse'],
    [0.90, 'reuse'],
    [0.8999, 'extend'],
    [0.85, 'extend'],
    [0.8499, 'justify-divergence'],
    [0.75, 'justify-divergence'],
    [0.7499, 'review'],
    [0.00, 'review'],
    [-1.0, 'review'],
  ];
  for (const [score, band] of cases) {
    it(`${score} → ${band}`, () => assert.equal(recommendationFromSimilarity(score), band));
  }

  it('every finite input maps to exactly one band', () => {
    const bands = new Set();
    for (let s = -1; s <= 1.0001; s += 0.01) bands.add(recommendationFromSimilarity(Number(s.toFixed(4))));
    for (const b of bands) {
      assert.ok(['reuse', 'extend', 'justify-divergence', 'review'].includes(b), `unexpected band ${b}`);
    }
    assert.equal(bands.has('unscored'), false, 'a finite score must never band as unscored');
  });
});

describe('banding / rankNeighbourhood mirrors the RPC null contract', () => {
  const intent = [1, 0, 0];

  it('a record with no embedding gets similarityScore null, not 0', () => {
    const [r] = rankNeighbourhood([{ filePath: 'a.mjs', symbolName: 'f' }], intent, []);
    assert.equal(r.similarityScore, null);
    assert.equal(r.scored, false);
  });

  it('an empty-array embedding is also treated as absent', () => {
    const [r] = rankNeighbourhood([{ filePath: 'a.mjs', symbolName: 'f', embedding: [] }], intent, []);
    assert.equal(r.similarityScore, null);
  });

  it('a real embedding is scored', () => {
    const [r] = rankNeighbourhood([{ filePath: 'a.mjs', symbolName: 'f', embedding: [1, 0, 0] }], intent, []);
    assert.ok(Math.abs(r.similarityScore - 1) < 1e-9);
    assert.equal(r.scored, true);
  });

  it('ranking still coalesces — an unembedded target-path file keeps its hop score', () => {
    // Ranking is an ordering heuristic where COALESCE is legitimate; this is
    // exactly the case that must NOT be buried (an actively-edited file).
    const [r] = rankNeighbourhood([{ filePath: 'a.mjs', symbolName: 'f' }], intent, ['a.mjs']);
    assert.ok(Math.abs(r.score - 0.4) < 1e-9, 'hop*0.4 survives a null similarity');
    assert.equal(r.similarityScore, null, 'but banding still sees no evidence');
  });

  it('a perfect semantic match in an untouched file is not buried by hop score', () => {
    const ranked = rankNeighbourhood([
      { filePath: 'untouched.mjs', symbolName: 'perfect', embedding: [1, 0, 0] },
      { filePath: 'edited.mjs', symbolName: 'unembedded' },
    ], intent, ['edited.mjs']);
    assert.equal(ranked[0].symbolName, 'perfect', '0.6 semantic must outrank 0.4 hop-only');
  });

  it('banding a ranked record never fabricates a verdict for missing evidence', () => {
    const [r] = rankNeighbourhood([{ filePath: 'a.mjs', symbolName: 'f' }], intent, ['a.mjs']);
    assert.equal(recommendationFromSimilarity(r.similarityScore), 'unscored');
  });
});

describe('banding / the contract schema admits the null case', () => {
  const base = {
    id: randomUUID(),
    definitionId: randomUUID(),
    refreshId: randomUUID(),
    repoId: randomUUID(),
    filePath: 'a.mjs', startLine: 1, endLine: 2, symbolName: 'f', kind: 'function',
    signatureHash: '', purposeSummary: null, domainTag: null,
    score: 0.4, hopScore: 1,
  };

  it('accepts similarityScore null with recommendation unscored', () => {
    const r = ScoredSymbolRecordSchema.safeParse({
      ...base, similarityScore: null, scored: false, recommendation: 'unscored',
    });
    assert.equal(r.success, true, JSON.stringify(r.error?.issues));
  });

  it('still accepts a normal scored record', () => {
    const r = ScoredSymbolRecordSchema.safeParse({
      ...base, similarityScore: 0.8, scored: true, recommendation: 'justify-divergence',
    });
    assert.equal(r.success, true, JSON.stringify(r.error?.issues));
  });

  it('rejects an unknown band', () => {
    const r = ScoredSymbolRecordSchema.safeParse({
      ...base, similarityScore: 0.8, recommendation: 'definitely-not-a-band',
    });
    assert.equal(r.success, false);
  });
});
