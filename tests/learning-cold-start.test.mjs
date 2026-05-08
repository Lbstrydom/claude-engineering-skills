import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { hasEnoughSamples, withFallback, _internals } from '../scripts/lib/learning/cold-start.mjs';

describe('cold-start / hasEnoughSamples', () => {
  it('returns true at exactly the default threshold (30)', () => {
    assert.equal(hasEnoughSamples({ totalSamples: 30 }), true);
  });

  it('returns false below default threshold', () => {
    assert.equal(hasEnoughSamples({ totalSamples: 29 }), false);
  });

  it('respects custom threshold', () => {
    assert.equal(hasEnoughSamples({ totalSamples: 5, threshold: 5 }), true);
    assert.equal(hasEnoughSamples({ totalSamples: 4, threshold: 5 }), false);
  });

  it('treats negative or non-finite samples as not-enough', () => {
    assert.equal(hasEnoughSamples({ totalSamples: -1 }), false);
    assert.equal(hasEnoughSamples({ totalSamples: NaN }), false);
    assert.equal(hasEnoughSamples({ totalSamples: Infinity }), false);
  });

  it('treats negative or non-finite threshold as invalid (false)', () => {
    assert.equal(hasEnoughSamples({ totalSamples: 100, threshold: -1 }), false);
    assert.equal(hasEnoughSamples({ totalSamples: 100, threshold: NaN }), false);
  });
});

describe('cold-start / withFallback', () => {
  it('runs predictFn above threshold', () => {
    const result = withFallback(() => 'predict', () => 'fallback', 100);
    assert.equal(result, 'predict');
  });

  it('runs fallbackFn below threshold', () => {
    const result = withFallback(() => 'predict', () => 'fallback', 5);
    assert.equal(result, 'fallback');
  });

  it('respects custom threshold parameter', () => {
    const r1 = withFallback(() => 'p', () => 'f', 5, 5);
    const r2 = withFallback(() => 'p', () => 'f', 4, 5);
    assert.equal(r1, 'p');
    assert.equal(r2, 'f');
  });

  it('throws on non-function inputs', () => {
    assert.throws(() => withFallback('not-a-fn', () => 'f', 100));
    assert.throws(() => withFallback(() => 'p', null, 100));
  });

  it('only runs the chosen fn (no double-execution)', () => {
    let predictCount = 0; let fallbackCount = 0;
    withFallback(() => { predictCount += 1; }, () => { fallbackCount += 1; }, 100);
    assert.equal(predictCount, 1);
    assert.equal(fallbackCount, 0);
  });
});

describe('cold-start / internals', () => {
  it('default threshold is 30 (matches existing prompt-bandit pattern)', () => {
    assert.equal(_internals.DEFAULT_THRESHOLD, 30);
  });
});
