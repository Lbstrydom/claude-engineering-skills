/**
 * @fileoverview Pure Beta-distribution posterior math for binary
 * accept/reject outcomes.  Used by the Phase 2 quickfix-stats learner;
 * future graduated learners (pass-selection, arch-memory thresholds) reuse
 * the same primitive so the math has a single source of truth.
 *
 * The existing `scripts/bandit.mjs` continues to use its own inline
 * implementation in v1 — migration to this module is deferred per the
 * master plan §10 ("v2 candidates").
 *
 * Plan: docs/plans/adaptive-learning-phase-2-quickfix.md §2 (beta-posterior)
 *
 * @module scripts/lib/learning/beta-posterior
 */

const PRIOR_ALPHA = 1; // weak Beta(1,1) prior — uniform over [0,1]
const PRIOR_BETA  = 1;

// ── Posterior summary ─────────────────────────────────────────────────────

/**
 * Summary of the Beta(alpha, beta) posterior.  All values returned are
 * NUMBERS (no NaN); the prior is added implicitly so the result is
 * defined even when alpha === 0 && beta === 0 ("no observations yet").
 *
 * @param {number} alpha — observed successes
 * @param {number} beta  — observed failures
 * @returns {{
 *   mean: number,
 *   variance: number,
 *   ci_low: number,
 *   ci_high: number,
 *   totalObservations: number,
 *   priorAdjustedAlpha: number,
 *   priorAdjustedBeta: number,
 * }}
 */
export function betaPosterior(alpha, beta) {
  if (!Number.isFinite(alpha) || alpha < 0) throw new RangeError('alpha must be a non-negative finite number');
  if (!Number.isFinite(beta)  || beta  < 0) throw new RangeError('beta must be a non-negative finite number');
  const a = alpha + PRIOR_ALPHA;
  const b = beta + PRIOR_BETA;
  const sum = a + b;
  const mean = a / sum;
  const variance = (a * b) / (sum * sum * (sum + 1));
  // 95% Wald-style approximation — adequate for the v1 use case (skip-rule
  // gating).  For very small sample sizes this is conservative which is the
  // safer error direction (we under-skip rather than over-skip).
  const sd = Math.sqrt(variance);
  const ci_low  = Math.max(0, mean - 1.96 * sd);
  const ci_high = Math.min(1, mean + 1.96 * sd);
  return {
    mean,
    variance,
    ci_low,
    ci_high,
    totalObservations: alpha + beta,
    priorAdjustedAlpha: a,
    priorAdjustedBeta: b,
  };
}

// ── Thompson sampling ─────────────────────────────────────────────────────

/**
 * Draw one sample from Beta(alpha + prior, beta + prior).  Used by
 * Thompson-sampling decision rules.  Implementation: gamma-gamma quotient
 * (Marsaglia–Tsang for shape >= 1, Ahrens–Dieter for shape < 1) avoids the
 * dependency footprint of a full statistics library.
 *
 * @param {{alpha: number, beta: number}} arm
 * @returns {number} — value in [0, 1]
 */
export function thompsonSample(arm) {
  if (!arm || typeof arm !== 'object') throw new TypeError('arm must be {alpha, beta}');
  // Audit-fix (Phase 2 R1 H9): validate strictly before coercion so a
  // malformed persisted state (NaN, negative, non-finite) surfaces as a
  // typed error rather than silently sampling from a corrupt posterior.
  // Treat undefined/null as zero (the "no observations yet" default).
  const rawAlpha = arm.alpha == null ? 0 : arm.alpha;
  const rawBeta  = arm.beta  == null ? 0 : arm.beta;
  if (!Number.isFinite(rawAlpha) || rawAlpha < 0) {
    throw new RangeError(`thompsonSample: arm.alpha must be a non-negative finite number (got ${arm.alpha})`);
  }
  if (!Number.isFinite(rawBeta) || rawBeta < 0) {
    throw new RangeError(`thompsonSample: arm.beta must be a non-negative finite number (got ${arm.beta})`);
  }
  const a = rawAlpha + PRIOR_ALPHA;
  const b = rawBeta  + PRIOR_BETA;
  const x = sampleGamma(a);
  const y = sampleGamma(b);
  // x / (x + y) ~ Beta(a, b)
  return x / (x + y);
}

/**
 * Apply one observation to a Beta posterior.  Pure — returns a new arm
 * object, never mutates the input.
 *
 * @param {object} input
 * @param {{alpha: number, beta: number}} input.prior
 * @param {0|1|number} input.observation — clamped to [0, 1]; treated as
 *   the success rate of this single observation.  For binary outcomes use
 *   1 (success) or 0 (failure); fractional values are valid for
 *   continuous rewards.
 * @returns {{alpha: number, beta: number}}
 */
export function updatePosterior({ prior, observation }) {
  if (!prior || typeof prior !== 'object') throw new TypeError('prior must be {alpha, beta}');
  if (!Number.isFinite(observation)) throw new TypeError('observation must be a finite number');
  // Audit-fix (Phase 2 R1 H9): same strict validation as thompsonSample —
  // missing fields default to 0, but malformed values throw rather than
  // silently propagating into the posterior.
  const rawAlpha = prior.alpha == null ? 0 : prior.alpha;
  const rawBeta  = prior.beta  == null ? 0 : prior.beta;
  if (!Number.isFinite(rawAlpha) || rawAlpha < 0) {
    throw new RangeError(`updatePosterior: prior.alpha must be a non-negative finite number (got ${prior.alpha})`);
  }
  if (!Number.isFinite(rawBeta) || rawBeta < 0) {
    throw new RangeError(`updatePosterior: prior.beta must be a non-negative finite number (got ${prior.beta})`);
  }
  const r = Math.max(0, Math.min(1, observation));
  return {
    alpha: rawAlpha + r,
    beta:  rawBeta  + (1 - r),
  };
}

// ── Internal: gamma sampler ───────────────────────────────────────────────

/**
 * Sample from Gamma(shape, scale=1).  Marsaglia–Tsang acceptance-rejection
 * for shape >= 1; Ahrens–Dieter / Boost-style fallback for 0 < shape < 1
 * via the boost transform.  No external dependency.
 */
function sampleGamma(shape) {
  if (!(shape > 0)) throw new RangeError('shape must be > 0');
  if (shape < 1) {
    // Boost transform: Gamma(shape) = Gamma(shape+1) * U^(1/shape)
    const u = Math.random();
    return sampleGamma(shape + 1) * Math.pow(u, 1 / shape);
  }
  // Marsaglia & Tsang (2000) for shape >= 1
  const d = shape - 1 / 3;
  const c = 1 / Math.sqrt(9 * d);
  // eslint-disable-next-line no-constant-condition
  while (true) {
    let x; let v;
    do {
      x = standardNormal();
      v = 1 + c * x;
    } while (v <= 0);
    v = v * v * v;
    const u = Math.random();
    const x2 = x * x;
    if (u < 1 - 0.0331 * x2 * x2) return d * v;
    if (Math.log(u) < 0.5 * x2 + d * (1 - v + Math.log(v))) return d * v;
  }
}

/** Box–Muller transform — one standard normal sample. */
function standardNormal() {
  let u = 0;
  let v = 0;
  while (u === 0) u = Math.random();
  while (v === 0) v = Math.random();
  return Math.sqrt(-2.0 * Math.log(u)) * Math.cos(2.0 * Math.PI * v);
}

// ── Public constants (frozen) ─────────────────────────────────────────────

export const _internals = Object.freeze({
  PRIOR_ALPHA,
  PRIOR_BETA,
  sampleGamma,
  standardNormal,
});
