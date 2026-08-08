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

// ── Postgres `numeric` arrives as a STRING over node-pg ──────────────────────
// Found live 2026-08-08: `cache_hit_rate` is a numeric column, so every row
// reaches this module as e.g. "0.1130", not 0.113. The median then did
// `(sorted[mid - 1] + sorted[mid]) / 2` — string CONCATENATION, then divide —
// so an EVEN-sized cohort produced NaN while an ODD-sized one silently worked
// (it returns `sorted[mid]` untouched, which coerces on the later `* 100`).
//
// That made the verdict depend on cohort PARITY, not on the data: `NaN > 0.3`
// is false, so an even-sized seed-ON cohort always fell through to HOLD no
// matter how good the hit rates were. The real run had 67 seed-ON (odd, so it
// reported a true 11.3%) and 72 seed-OFF (even → the "NaN%" baseline).
describe('cache-hitrate-check — numeric-as-string from Postgres', () => {
  const pgRun = (hitRate, seedEnabled) => ({ hitRate: String(hitRate), seedEnabled });

  it('EVEN-sized seed-ON cohort of numeric strings decides on the data, not on parity', () => {
    // 6 runs (even) all well above the 30% threshold → must be FLIP_TO_ON.
    // Pre-fix this returned HOLD, because the median was NaN.
    const runs = Array.from({ length: 6 }, () => pgRun('0.5000', true));
    const d = segmentAndDecide(runs, { minRuns: 5, flipThreshold: 0.3 });
    assert.equal(d.recommendation, 'FLIP_TO_ON');
    assert.equal(d.seedOnMedian, 0.5);
  });

  it('ODD and EVEN cohorts of identical values give the identical median', () => {
    const odd = segmentAndDecide(Array.from({ length: 5 }, () => pgRun('0.4000', true)),
      { minRuns: 5, flipThreshold: 0.3 });
    const even = segmentAndDecide(Array.from({ length: 6 }, () => pgRun('0.4000', true)),
      { minRuns: 5, flipThreshold: 0.3 });
    assert.equal(odd.seedOnMedian, 0.4);
    assert.equal(even.seedOnMedian, 0.4);
    assert.equal(odd.recommendation, even.recommendation);
  });

  it('EVEN-sized seed-OFF cohort renders a real baseline, never "NaN%"', () => {
    const runs = [
      ...Array.from({ length: 4 }, () => pgRun('0.2000', false)),
      ...Array.from({ length: 5 }, () => pgRun('0.5000', true)),
    ];
    const d = segmentAndDecide(runs, { minRuns: 5, flipThreshold: 0.3 });
    assert.equal(d.seedOffMedian, 0.2);
    assert.doesNotMatch(d.reason, /NaN/);
    assert.match(d.reason, /Seed-OFF baseline: 20\.0%/);
  });

  it('unmeasured runs are excluded from the median, not counted as 0%', () => {
    // The live store had 112 of 251 R2+ rows with a null cache_hit_rate. Folding
    // those in as zeros would halve a genuine median and manufacture a HOLD.
    const runs = [
      ...Array.from({ length: 5 }, () => pgRun('0.6000', true)),
      ...Array.from({ length: 5 }, () => ({ hitRate: null, seedEnabled: true })),
    ];
    const d = segmentAndDecide(runs, { minRuns: 5, flipThreshold: 0.3 });
    assert.equal(d.seedOnMedian, 0.6, 'median must reflect only the runs that measured something');
    assert.equal(d.recommendation, 'FLIP_TO_ON');
  });

  it('a cohort with NO usable hit-rate values is insufficient, never a silent HOLD', () => {
    // All values unparseable → we cannot decide. Reporting HOLD would assert
    // "seeding isn't paying off" on the strength of no measurement at all.
    const runs = Array.from({ length: 6 }, () => ({ hitRate: null, seedEnabled: true }));
    const d = segmentAndDecide(runs, { minRuns: 5, flipThreshold: 0.3 });
    assert.equal(d.recommendation, 'INSUFFICIENT_SEED_ON_DATA');
    assert.equal(d.seedOnMedian, null);
  });
});
