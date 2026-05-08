/**
 * @fileoverview Cold-start guard primitives.  Pure functions used by all
 * adaptive-learning learners to fall back to existing hardcoded behaviour
 * when sample counts are below the trust threshold.
 *
 * Plan: docs/plans/adaptive-learning-phase-2-quickfix.md §2 (cold-start)
 *
 * @module scripts/lib/learning/cold-start
 */

const DEFAULT_THRESHOLD = 30; // matches existing prompt-bandit cold-start

/**
 * @param {{totalSamples: number, threshold?: number}} input
 * @returns {boolean}
 */
export function hasEnoughSamples({ totalSamples, threshold = DEFAULT_THRESHOLD }) {
  if (!Number.isFinite(totalSamples) || totalSamples < 0) return false;
  if (!Number.isFinite(threshold)    || threshold    < 0) return false;
  return totalSamples >= threshold;
}

/**
 * Run `predictFn` if there are enough samples; otherwise run `fallbackFn`.
 * Both fns are invoked with no arguments (callers should curry their own
 * context in via closures).  Returns whichever fn ran — pure and trivially
 * testable.
 *
 * @template T
 * @param {() => T} predictFn
 * @param {() => T} fallbackFn
 * @param {number} totalSamples
 * @param {number} [threshold]
 * @returns {T}
 */
export function withFallback(predictFn, fallbackFn, totalSamples, threshold = DEFAULT_THRESHOLD) {
  if (typeof predictFn  !== 'function') throw new TypeError('predictFn must be a function');
  if (typeof fallbackFn !== 'function') throw new TypeError('fallbackFn must be a function');
  return hasEnoughSamples({ totalSamples, threshold }) ? predictFn() : fallbackFn();
}

export const _internals = Object.freeze({ DEFAULT_THRESHOLD });
