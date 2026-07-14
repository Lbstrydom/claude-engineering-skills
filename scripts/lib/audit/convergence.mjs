/**
 * @fileoverview The audit-code convergence threshold, extracted (plan
 * §F2.5 — "the one enabling refactor") from the inline expression at
 * `legacy-production-audit.mjs`'s author-tier telemetry block so it is a
 * single, unit-assertable, importable source of truth.
 *
 * `CONVERGENCE_THRESHOLDS` is the canonical runtime value; the SKILL.md
 * prose and each contract's `params` are deliberate pinned copies (tripwires,
 * not sources) — see the plan's "authority direction" note.
 *
 * @module scripts/lib/audit/convergence
 */

/** The quality threshold /audit-code gates on — SKILL.md's stated rule. */
export const CONVERGENCE_THRESHOLDS = Object.freeze({ high: 0, medium: 2, quickFix: 0 });

/**
 * @param {{high: number, medium: number, quickFix: number}} counts
 * @returns {boolean}
 */
export function evaluateConvergence({ high, medium, quickFix }) {
  return high === CONVERGENCE_THRESHOLDS.high
    && medium <= CONVERGENCE_THRESHOLDS.medium
    && quickFix === CONVERGENCE_THRESHOLDS.quickFix;
}
