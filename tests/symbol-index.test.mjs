import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  normaliseSignature,
  normaliseBody,
  signatureHash,
  chunkBatches,
  cosineSimilarity,
  rankNeighbourhood,
} from '../scripts/lib/symbol-index.mjs';
import { runWithConcurrency } from '../scripts/symbol-index/summarise-domains.mjs';

describe('runWithConcurrency (domain-summary worker pool)', () => {
  it('processes every item exactly once', async () => {
    const seen = [];
    await runWithConcurrency([1, 2, 3, 4, 5], 2, async (n) => { seen.push(n); });
    assert.deepEqual(seen.sort((a, b) => a - b), [1, 2, 3, 4, 5]);
  });

  it('never exceeds the concurrency limit in flight', async () => {
    let inFlight = 0; let peak = 0;
    const item = () => async () => {
      inFlight++; peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight--;
    };
    const items = Array.from({ length: 12 }, item);
    await runWithConcurrency(items, 3, (fn) => fn());
    assert.ok(peak <= 3, `peak in-flight ${peak} must be <= 3`);
    assert.ok(peak >= 2, `peak ${peak} should actually use the pool`);
  });

  it('empty input is a no-op (no workers spawned)', async () => {
    let calls = 0;
    await runWithConcurrency([], 4, async () => { calls++; });
    assert.equal(calls, 0);
  });

  it('a limit larger than the item count still processes all', async () => {
    const seen = [];
    await runWithConcurrency(['a', 'b'], 10, async (x) => { seen.push(x); });
    assert.deepEqual(seen.sort(), ['a', 'b']);
  });
});

describe('normaliseSignature', () => {
  it('collapses whitespace', () => {
    assert.equal(normaliseSignature('foo (  a, b )'), 'foo(a,b)');
  });
  it('handles empty', () => {
    assert.equal(normaliseSignature(''), '');
    assert.equal(normaliseSignature(null), '');
  });
});

describe('normaliseBody', () => {
  it('strips block comments', () => {
    assert.equal(normaliseBody('a/* inner */b'), 'ab');
  });
  it('strips line comments', () => {
    assert.equal(normaliseBody('a\n  // hi\nb'), 'a b');
  });
});

describe('signatureHash', () => {
  it('is deterministic across runs', () => {
    const input = { symbolName: 'foo', signature: 'foo(a, b)', bodyText: 'return a+b' };
    assert.equal(signatureHash(input), signatureHash(input));
  });
  it('differs when body changes substantively', () => {
    const a = signatureHash({ symbolName: 'foo', signature: 'foo()', bodyText: 'return 1' });
    const b = signatureHash({ symbolName: 'foo', signature: 'foo()', bodyText: 'return 2' });
    assert.notEqual(a, b);
  });
  it('is stable across whitespace-only body changes', () => {
    const a = signatureHash({ symbolName: 'foo', signature: 'foo()', bodyText: 'return 1' });
    const b = signatureHash({ symbolName: 'foo', signature: 'foo()', bodyText: 'return  1\n' });
    assert.equal(a, b);
  });
  it('is stable across LF/CRLF', () => {
    const a = signatureHash({ symbolName: 'foo', signature: 'foo()', bodyText: 'a\nb' });
    const b = signatureHash({ symbolName: 'foo', signature: 'foo()', bodyText: 'a\r\nb' });
    assert.equal(a, b);
  });
});

describe('chunkBatches', () => {
  it('chunks evenly', () => {
    assert.deepEqual(chunkBatches([1, 2, 3, 4], 2), [[1, 2], [3, 4]]);
  });
  it('handles remainder', () => {
    assert.deepEqual(chunkBatches([1, 2, 3], 2), [[1, 2], [3]]);
  });
  it('handles empty', () => {
    assert.deepEqual(chunkBatches([], 5), []);
  });
  it('handles n<=0', () => {
    assert.deepEqual(chunkBatches([1, 2], 0), []);
  });
});

describe('cosineSimilarity', () => {
  it('returns 1 for identical vectors', () => {
    assert.ok(Math.abs(cosineSimilarity([1, 0, 1], [1, 0, 1]) - 1) < 1e-9);
  });
  it('returns 0 for orthogonal vectors', () => {
    assert.equal(cosineSimilarity([1, 0], [0, 1]), 0);
  });
  it('returns 0 for length mismatch', () => {
    assert.equal(cosineSimilarity([1, 2], [1, 2, 3]), 0);
  });
  it('returns 0 for empty', () => {
    assert.equal(cosineSimilarity([], []), 0);
  });
});

describe('rankNeighbourhood', () => {
  const records = [
    { symbolName: 'a', filePath: 'x.mjs', embedding: [1, 0] },
    { symbolName: 'b', filePath: 'y.mjs', embedding: [0.9, 0.1] },
    { symbolName: 'c', filePath: 'z.mjs', embedding: [0, 1] },
  ];
  it('combines hop_score + similarity', () => {
    const ranked = rankNeighbourhood(records, [1, 0], ['x.mjs'], 3);
    assert.equal(ranked[0].symbolName, 'a'); // hop=1 + sim=1 → score 1
    // b has sim ~0.99 but no hop → 0.6 * 0.99 = ~0.59
    // a has hop=1 + sim=1 → 0.4 + 0.6 = 1.0
    assert.ok(ranked[0].score > ranked[1].score);
  });
  it('alphabetical tie-break', () => {
    const ties = [
      { symbolName: 'b', filePath: 'p.mjs', embedding: [1, 0] },
      { symbolName: 'a', filePath: 'p.mjs', embedding: [1, 0] },
    ];
    const ranked = rankNeighbourhood(ties, [1, 0], [], 2);
    assert.equal(ranked[0].symbolName, 'a');
  });
});

// `recommendationFromSimilarity` was DELETED 2026-07-20 along with these
// tests, which asserted the 0.90 / 0.85 / 0.75 cutoffs. Those tests passed for
// the entire period during which the bands they describe fired ZERO times in
// 1,763 real consultations — a green suite pinning a mapping nothing could
// reach. That is the failure mode worth remembering: the tests were correct
// about the function and told us nothing about the system.
//
// Banding now lives in arch-memory/background-calibration.mjs against a
// per-repo floor; see tests/arch-memory-background-calibration.test.mjs, whose
// assertions are tied to measured distribution properties rather than to
// constants.
