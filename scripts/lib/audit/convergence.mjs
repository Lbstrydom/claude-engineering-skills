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

/**
 * Convergence including the detector gate.
 *
 * `evaluateConvergence` above is the finding-count threshold and is left untouched — it is
 * what `skills/audit-code/gate-contract.json` binds and what `tests/gate-honesty.test.mjs`
 * pins. This wraps it so the detector requirement lives in the SAME oracle rather than
 * becoming a second, parallel threshold somewhere in the SKILL text (a stated gate with no
 * enforcing code is exactly what the gate-contract system exists to catch).
 *
 * A cross-cutting finding's detector must reach zero UNDISPOSITIONED matches at its own
 * full scope. That is what stops "fixed 1 of 4" converging clean, and equally what stops a
 * fix that reintroduces the class.
 *
 * `detectorResult` is supplied by the caller (from `checkDetectors`) rather than run here,
 * so this stays a pure predicate and the ripgrep invocation has one call site.
 *
 * **It is REQUIRED, not optional.** An earlier version read `detectorResult?.blocked`, so a
 * caller that forgot to run `checkDetectors` — or lost the wiring in a refactor — got
 * `converged: true` the moment the counts passed. A function whose name promises the
 * detector gate, returning green having never seen a detector result, is this plan's own
 * defect class written into the plan's own mechanism. Absent input is therefore
 * `detector-not-run`: not converged, and named so the operator can tell "no detectors were
 * declared" (pass `checkDetectors`' own `{blocked:false, checked:0}`) from "nobody asked".
 *
 * @param {{high: number, medium: number, quickFix: number}} counts
 * @param {{blocked: boolean, undispositioned?: object[], checked?: number}} detectorResult
 * @returns {{converged: boolean, reason: string}}
 */
export function evaluateConvergenceWithDetectors(counts, detectorResult) {
  if (!evaluateConvergence(counts)) {
    return { converged: false, reason: 'finding-thresholds' };
  }
  if (detectorResult === undefined || detectorResult === null || typeof detectorResult.blocked !== 'boolean') {
    return { converged: false, reason: 'detector-not-run' };
  }
  if (detectorResult.blocked) {
    return { converged: false, reason: 'detector-undispositioned' };
  }
  return { converged: true, reason: 'converged' };
}
