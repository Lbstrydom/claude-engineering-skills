/**
 * @fileoverview Shared seeded-RNG utilities for reproducible sampling across
 * the audit pipeline. Extracted (tiered-recall audit pipeline, audit fix
 * L1/L2) after the SAME mulberry32 generator + Fisher-Yates shuffle pair was
 * independently reimplemented in `final-adjudication.mjs` and (as a partial
 * inline draw) `gpt-sentinel-trigger.mjs`, on top of pre-existing copies in
 * `scripts/lib/solo-control/stratified-sample.mjs` and
 * `scripts/lib/solo-control/cheap-triager-validate.mjs`. This module is the
 * single source of truth for NEW tiered-recall pipeline code; the two
 * pre-existing solo-control copies are left as-is (out of this cluster's
 * scope — see `.audit/cycle-cluster-state.json`).
 *
 * @module scripts/lib/audit/seeded-random
 */

/** Deterministic seeded PRNG (mulberry32) — same generator family used
 * throughout this pipeline for reproducible sampling given a fixed seed. */
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Fisher-Yates shuffle over a COPY (never mutates the input), driven by an
 * injected RNG (typically from `mulberry32`). */
export function seededShuffleCopy(arr, rng) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/** One deterministic draw in [0, 1) for a given seed — the single-shot form
 * used by e.g. `gpt-sentinel-trigger.mjs::isExplorationSample`, where a full
 * generator closure would be overkill for one draw per call. */
export function seededDraw(seed) {
  return mulberry32(seed)();
}
