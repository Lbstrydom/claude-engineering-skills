// Cohort segmentation + decision rule for the AUDIT_CACHE_SEED flip check.
// The check must decide on the SEED-ON cohort only — seed-OFF runs never warm
// the cache (structural ~0%) and would contaminate a global median into a
// permanent HOLD. Pure function, no DB.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { segmentAndDecide } from '../scripts/cache-hitrate-check.mjs';

const run = (hitRate, seedEnabled) => ({ hitRate, seedEnabled });

describe('cache-hitrate-check — segmentAndDecide', () => {
  it('seed-ON >= minRuns and median > threshold → FLIP_TO_ON', () => {
    const runs = [run(0.4, true), run(0.5, true), run(0.45, true), run(0.6, true), run(0.5, true)];
    const d = segmentAndDecide(runs, { minRuns: 5, flipThreshold: 0.3 });
    assert.equal(d.recommendation, 'FLIP_TO_ON');
    assert.equal(d.seedOnCount, 5);
  });

  it('seed-ON < minRuns → INSUFFICIENT_SEED_ON_DATA (even if those runs look great)', () => {
    const runs = [run(0.9, true), run(0.9, true)];
    const d = segmentAndDecide(runs, { minRuns: 5, flipThreshold: 0.3 });
    assert.equal(d.recommendation, 'INSUFFICIENT_SEED_ON_DATA');
    assert.match(d.reason, /default-ON/);
  });

  it('seed-ON >= minRuns but median <= threshold → HOLD', () => {
    const runs = Array.from({ length: 6 }, () => run(0.1, true));
    const d = segmentAndDecide(runs, { minRuns: 5, flipThreshold: 0.3 });
    assert.equal(d.recommendation, 'HOLD');
  });

  it('seed-OFF runs are NOT counted toward the seed-ON cohort (the contamination guard)', () => {
    // 10 seed-OFF runs at 0% + 4 seed-ON runs → still insufficient seed-ON data,
    // and the seed-OFF 0% never drags the decision.
    const runs = [
      ...Array.from({ length: 10 }, () => run(0, false)),
      ...Array.from({ length: 4 }, () => run(0.5, true)),
    ];
    const d = segmentAndDecide(runs, { minRuns: 5, flipThreshold: 0.3 });
    assert.equal(d.recommendation, 'INSUFFICIENT_SEED_ON_DATA');
    assert.equal(d.seedOnCount, 4);
    assert.equal(d.seedOffCount, 10);
  });

  it('null/undefined seedEnabled → unknown cohort, excluded from both (R1-M4 legacy rows)', () => {
    const runs = [
      run(0.5, null), run(0.5, undefined),
      ...Array.from({ length: 5 }, () => run(0.5, true)),
    ];
    const d = segmentAndDecide(runs, { minRuns: 5, flipThreshold: 0.3 });
    assert.equal(d.unknownCount, 2);
    assert.equal(d.seedOnCount, 5);
    assert.equal(d.recommendation, 'FLIP_TO_ON');
  });

  it('env-on-but-no-effective-seed (seedEnabled=false) is seed-OFF, not seed-ON (R1-M4)', () => {
    // A run where AUDIT_CACHE_SEED=1 but no pass effectively seeded records
    // seedEnabled=false, so it must land in seed-OFF — never inflate seed-ON.
    const runs = [run(0, false), ...Array.from({ length: 5 }, () => run(0.5, true))];
    const d = segmentAndDecide(runs, { minRuns: 5, flipThreshold: 0.3 });
    assert.equal(d.seedOnCount, 5);
    assert.equal(d.seedOffCount, 1);
  });
});
