/**
 * @fileoverview Numeric argv/payload validation for CLI command handlers.
 *
 * Pure — no I/O, no config. Deliberately a separate module from
 * `path-validation.mjs`: a numeric count rule has nothing to do with paths, and
 * bundling the two would produce a miscellaneous-utilities module whose name tells a
 * reader nothing about what is inside it.
 *
 * Plan: docs/plans/layering-and-mutation-contracts.md (C5).
 *
 * @module scripts/lib/command-input
 */

/**
 * A count that will be persisted must be finite, non-negative and integral.
 *
 * `typeof n === 'number'` — the check this replaces — admits `NaN`, `-1`, `1.5` and
 * `Infinity`, all of which then reach the database. `NaN` is the worst of them: a
 * satisfaction percentage derived from it renders as a plausible-looking value rather
 * than failing.
 *
 * `0` is VALID: a verify run over a plan with no parseable acceptance criteria is a real,
 * already-reachable state.
 *
 * @param {unknown} n
 * @param {string} [field] — name used in the reason string
 * @returns {{ok: true, value: number} | {ok: false, reason: string}}
 */
export function validateCriteriaCount(n, field = 'totalCriteria') {
  if (typeof n !== 'number' || !Number.isFinite(n)) {
    return { ok: false, reason: `${field} must be a finite number` };
  }
  if (!Number.isInteger(n)) return { ok: false, reason: `${field} must be an integer` };
  if (n < 0) return { ok: false, reason: `${field} must not be negative` };
  if (n > Number.MAX_SAFE_INTEGER) {
    return { ok: false, reason: `${field} exceeds Number.MAX_SAFE_INTEGER` };
  }
  return { ok: true, value: n };
}

/**
 * Validate every count in a plan-verify payload, plus the relationships between them.
 *
 * Guarding one field while its peers accept `NaN` through the same handler would fix the
 * example rather than the defect — so the caller passes the whole set and this enumerates
 * it. `required` is validated even when absent; optional fields are skipped when
 * `undefined`/`null` but validated whenever present.
 *
 * @param {Record<string, unknown>} payload
 * @param {{required?: string[], optional?: string[]}} [fields]
 * @returns {{ok: true} | {ok: false, reason: string}}
 */
export function validateCountFields(payload, fields = {}) {
  const required = fields.required ?? ['totalCriteria'];
  const optional = fields.optional ?? ['passedCriteria', 'failedCriteria', 'skippedCriteria'];

  for (const f of required) {
    const r = validateCriteriaCount(payload?.[f], f);
    if (!r.ok) return r;
  }
  for (const f of optional) {
    const v = payload?.[f];
    if (v === undefined || v === null) continue;
    const r = validateCriteriaCount(v, f);
    if (!r.ok) return r;
  }

  // Cross-field: the parts cannot exceed the whole. Only checked when both sides are
  // actually present — an absent optional must not synthesise a failure.
  const total = payload?.[required[0]];
  const parts = optional
    .map((f) => payload?.[f])
    .filter((v) => typeof v === 'number' && Number.isFinite(v));
  if (typeof total === 'number' && parts.length) {
    const sum = parts.reduce((a, b) => a + b, 0);
    if (sum > total) {
      return { ok: false, reason: `criteria counts sum to ${sum}, exceeding ${required[0]}=${total}` };
    }
  }
  return { ok: true };
}
