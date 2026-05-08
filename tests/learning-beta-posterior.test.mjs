import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  betaPosterior,
  thompsonSample,
  updatePosterior,
  _internals,
} from '../scripts/lib/learning/beta-posterior.mjs';

describe('beta-posterior / betaPosterior', () => {
  it('Beta(0,0) → uniform-ish (mean=0.5)', () => {
    const r = betaPosterior(0, 0);
    assert.equal(r.mean, 0.5);
    assert.ok(r.ci_low >= 0 && r.ci_low <= 0.5);
    assert.ok(r.ci_high >= 0.5 && r.ci_high <= 1);
    assert.equal(r.totalObservations, 0);
    assert.equal(r.priorAdjustedAlpha, 1);
    assert.equal(r.priorAdjustedBeta, 1);
  });

  it('Beta(10, 2) → high mean (≈0.846 with prior)', () => {
    const r = betaPosterior(10, 2);
    // Posterior alpha=11, beta=3 → mean = 11/14 ≈ 0.786
    assert.ok(r.mean > 0.75 && r.mean < 0.85, `mean = ${r.mean}`);
    assert.equal(r.priorAdjustedAlpha, 11);
    assert.equal(r.priorAdjustedBeta, 3);
  });

  it('Beta(0, 10) → low mean', () => {
    const r = betaPosterior(0, 10);
    assert.ok(r.mean < 0.15, `mean = ${r.mean}`);
  });

  it('CI bounds tighten as observations grow', () => {
    const small = betaPosterior(2, 1);
    const big   = betaPosterior(200, 100);
    const smallWidth = small.ci_high - small.ci_low;
    const bigWidth   = big.ci_high - big.ci_low;
    assert.ok(bigWidth < smallWidth, `large-N CI ${bigWidth} should be tighter than small-N ${smallWidth}`);
  });

  it('rejects negative or non-finite inputs', () => {
    assert.throws(() => betaPosterior(-1, 0));
    assert.throws(() => betaPosterior(0, -1));
    assert.throws(() => betaPosterior(NaN, 0));
    assert.throws(() => betaPosterior(0, Infinity));
  });
});

describe('beta-posterior / thompsonSample', () => {
  it('returns a value in [0, 1]', () => {
    for (let i = 0; i < 100; i += 1) {
      const x = thompsonSample({ alpha: 5, beta: 3 });
      assert.ok(x >= 0 && x <= 1, `out of [0,1]: ${x}`);
    }
  });

  it('high-alpha arms sample higher on average', () => {
    let sumLow = 0; let sumHigh = 0;
    const N = 500;
    for (let i = 0; i < N; i += 1) {
      sumLow  += thompsonSample({ alpha: 1, beta: 9 });
      sumHigh += thompsonSample({ alpha: 9, beta: 1 });
    }
    assert.ok(sumLow / N < 0.25, `low-arm mean ${sumLow / N}`);
    assert.ok(sumHigh / N > 0.75, `high-arm mean ${sumHigh / N}`);
  });

  it('rejects non-object input', () => {
    assert.throws(() => thompsonSample(null));
    assert.throws(() => thompsonSample('foo'));
  });

  // Audit-fix Phase 2 R1 H9: tighter validation on persisted-state coercion.
  it('rejects NaN alpha/beta with a typed RangeError', () => {
    assert.throws(() => thompsonSample({ alpha: NaN, beta: 1 }), /alpha must be a non-negative finite/);
    assert.throws(() => thompsonSample({ alpha: 1, beta: NaN }), /beta must be a non-negative finite/);
  });

  it('rejects negative alpha/beta', () => {
    assert.throws(() => thompsonSample({ alpha: -1, beta: 1 }));
    assert.throws(() => thompsonSample({ alpha: 1, beta: -1 }));
  });

  it('rejects Infinity', () => {
    assert.throws(() => thompsonSample({ alpha: Infinity, beta: 1 }));
  });

  it('treats undefined alpha/beta as zero (default arm)', () => {
    const x = thompsonSample({});
    assert.ok(x >= 0 && x <= 1);
  });
});

describe('beta-posterior / updatePosterior', () => {
  it('observation=1 → alpha+=1, beta unchanged', () => {
    const next = updatePosterior({ prior: { alpha: 5, beta: 3 }, observation: 1 });
    assert.deepEqual(next, { alpha: 6, beta: 3 });
  });

  it('observation=0 → beta+=1, alpha unchanged', () => {
    const next = updatePosterior({ prior: { alpha: 5, beta: 3 }, observation: 0 });
    assert.deepEqual(next, { alpha: 5, beta: 4 });
  });

  it('fractional observation distributes between alpha and beta', () => {
    const next = updatePosterior({ prior: { alpha: 0, beta: 0 }, observation: 0.7 });
    assert.equal(next.alpha, 0.7);
    assert.ok(Math.abs(next.beta - 0.3) < 1e-9);
  });

  it('clamps observation to [0, 1]', () => {
    const a = updatePosterior({ prior: { alpha: 0, beta: 0 }, observation: 5 });
    assert.equal(a.alpha, 1);
    const b = updatePosterior({ prior: { alpha: 0, beta: 0 }, observation: -3 });
    assert.equal(b.beta, 1);
  });

  it('does NOT mutate input', () => {
    const prior = { alpha: 1, beta: 1 };
    updatePosterior({ prior, observation: 1 });
    assert.deepEqual(prior, { alpha: 1, beta: 1 });
  });

  it('rejects malformed input', () => {
    assert.throws(() => updatePosterior({ prior: null, observation: 1 }));
    assert.throws(() => updatePosterior({ prior: {}, observation: NaN }));
  });

  it('rejects NaN/negative alpha/beta in prior (Audit-fix R1 H9)', () => {
    assert.throws(() => updatePosterior({ prior: { alpha: NaN, beta: 0 }, observation: 1 }));
    assert.throws(() => updatePosterior({ prior: { alpha: 0, beta: -5 }, observation: 1 }));
  });
});

describe('beta-posterior / internal sampler robustness', () => {
  it('sampleGamma(shape=0.5) returns positive finite numbers', () => {
    const { sampleGamma } = _internals;
    for (let i = 0; i < 50; i += 1) {
      const x = sampleGamma(0.5);
      assert.ok(x > 0 && Number.isFinite(x), `out of range: ${x}`);
    }
  });

  it('sampleGamma(shape=10) returns positive finite numbers', () => {
    const { sampleGamma } = _internals;
    for (let i = 0; i < 50; i += 1) {
      const x = sampleGamma(10);
      assert.ok(x > 0 && Number.isFinite(x));
    }
  });
});
