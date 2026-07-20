/**
 * Tier-1 tests for per-repo unsupervised band calibration.
 * Plan: docs/plans/arch-memory-band-recalibration.md §2.1 C4-REVISED / C7-REVISED.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  computeBackgroundStats,
  floorFromStats,
  bandTopResult,
  cosineSimilarity,
  DEFAULT_K,
  MIN_CLIFF_DELTA,
} from '../scripts/lib/arch-memory/background-calibration.mjs';

/** Deterministic pseudo-random vectors — no Math.random, so runs are stable. */
function seededVectors(count, dim = 32, seed = 7) {
  let s = seed;
  const rnd = () => { s = (s * 1103515245 + 12345) % 2147483648; return s / 2147483648; };
  return Array.from({ length: count }, () => Array.from({ length: dim }, () => rnd() - 0.5));
}

describe('background-calibration / k is empirical', () => {
  it('DEFAULT_K is 3 — 4 would sit above this repo\'s true positives', () => {
    // Measured: mu+3sigma = 0.7146 (matches the labelled hard-negative ceiling
    // 0.7162 to 0.2%); mu+4sigma = 0.7584, ABOVE the observed true-positive
    // range 0.73-0.83, i.e. it would suppress real matches.
    assert.equal(DEFAULT_K, 3);
  });
});

describe('background-calibration / stats refuse to guess', () => {
  it('returns null on too few vectors rather than a fabricated floor', () => {
    assert.equal(computeBackgroundStats(seededVectors(5)), null);
    assert.equal(computeBackgroundStats([]), null);
    assert.equal(computeBackgroundStats(null), null);
  });

  it('returns null when vectors are present but unusable', () => {
    assert.equal(computeBackgroundStats(Array.from({ length: 40 }, () => [])), null);
  });

  it('computes mean/sd/percentiles over all pairs', () => {
    const stats = computeBackgroundStats(seededVectors(30));
    assert.ok(stats, 'expected stats');
    assert.equal(stats.n, 30);
    assert.equal(stats.pairs, (30 * 29) / 2);
    assert.ok(Number.isFinite(stats.mean) && Number.isFinite(stats.sd));
    assert.ok(stats.p50 <= stats.p95 && stats.p95 <= stats.p99 && stats.p99 <= stats.max);
  });

  it('a null stats object yields a null floor, never 0', () => {
    assert.equal(floorFromStats(null), null);
    assert.equal(floorFromStats({ mean: NaN, sd: 1 }), null);
    assert.equal(floorFromStats({ mean: 0.5, sd: 0.04 }, 0), null);
  });

  it('floor tracks the corpus — a denser corpus gets a higher bar', () => {
    const sparse = floorFromStats({ mean: 0.30, sd: 0.05 });
    const dense = floorFromStats({ mean: 0.58, sd: 0.044 });
    assert.ok(dense > sparse, 'a repetitive-vocabulary repo must raise its own bar');
  });

  it('reproduces the measured floor for this repo', () => {
    // mu=0.5831 sigma=0.0438 measured over 7,140 background pairs.
    const floor = floorFromStats({ mean: 0.5831, sd: 0.0438 }, 3);
    assert.ok(Math.abs(floor - 0.7145) < 0.001, `got ${floor}`);
    // Independently derived supervised ceiling was 0.7162 — agreement to 0.2%.
    assert.ok(Math.abs(floor - 0.7162) < 0.005);
  });
});

describe('background-calibration / banding is two-state', () => {
  const cal = { floor: 0.7146 };
  const r = (s) => ({ similarityScore: s });

  it('no embedding → unscored, never a verdict', () => {
    assert.equal(bandTopResult([r(null)], cal).band, 'unscored');
    assert.equal(bandTopResult([], cal).band, 'unscored');
    assert.equal(bandTopResult([{}], cal).band, 'unscored');
  });

  it('an UNCALIBRATED repo gets review — not a guess', () => {
    // The honest default for a fresh consumer: matches pre-existing behaviour
    // with an accurate label, rather than banding on a borrowed constant.
    const out = bandTopResult([r(0.95), r(0.5)], { floor: null });
    assert.equal(out.band, 'review');
    assert.match(out.reason, /uncalibrated/);
  });

  it('below the floor → review', () => {
    const out = bandTopResult([r(0.70), r(0.60)], cal);
    assert.equal(out.band, 'review');
    assert.match(out.reason, /below-noise-floor/);
  });

  it('above the floor AND distinctive → precedent', () => {
    const out = bandTopResult([r(0.82), r(0.70)], cal);
    assert.equal(out.band, 'precedent');
    assert.ok(out.cliff > MIN_CLIFF_DELTA);
  });

  it('above the floor but NOT distinctive → review (hubness guard)', () => {
    // Everything scoring alike means the corpus vocabulary is doing the work,
    // not the match. An absolute floor alone cannot catch this.
    const out = bandTopResult([r(0.74), r(0.735), r(0.73)], cal);
    assert.equal(out.band, 'review');
    assert.match(out.reason, /not-distinctive/);
  });

  it('a lone result cannot fail the cliff test vacuously', () => {
    const out = bandTopResult([r(0.82)], cal);
    assert.equal(out.band, 'precedent');
    assert.equal(out.cliff, null);
  });

  it('reuse and extend are RETIRED — never emitted', () => {
    const bands = new Set();
    for (let s = 0; s <= 1.0001; s += 0.01) {
      bands.add(bandTopResult([r(Number(s.toFixed(3))), r(0.1)], cal).band);
    }
    assert.equal(bands.has('reuse'), false);
    assert.equal(bands.has('extend'), false);
    for (const b of bands) assert.ok(['review', 'precedent', 'unscored'].includes(b), b);
  });
});

describe('background-calibration / cosineSimilarity guards', () => {
  it('returns null on shape mismatch or empties rather than throwing', () => {
    assert.equal(cosineSimilarity([1, 0], [1, 0, 0]), null);
    assert.equal(cosineSimilarity([], []), null);
    assert.equal(cosineSimilarity(null, [1]), null);
  });
  it('returns null on a zero vector (undefined direction, not similarity 0)', () => {
    assert.equal(cosineSimilarity([0, 0], [1, 0]), null);
  });
  it('identical vectors → 1', () => {
    assert.ok(Math.abs(cosineSimilarity([1, 2, 3], [1, 2, 3]) - 1) < 1e-12);
  });
});
