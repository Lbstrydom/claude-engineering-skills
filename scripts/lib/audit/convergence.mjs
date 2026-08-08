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
  // BOTH fields are required, not just `blocked` (audit clusterA-H6). `checkDetectors`
  // always returns `checked: entries.length` (detector.mjs), so a result carrying
  // `blocked` without it did not come from a real census — it is a hand-built or
  // truncated object, and treating it as a completed run is how "the detectors ran
  // and found nothing" becomes indistinguishable from "something fabricated a pass".
  // An intentionally empty run says so explicitly with `checked: 0`.
  // `checked` must be a COUNT — a non-negative integer. `typeof x === 'number'`
  // admits NaN, Infinity and -1, each of which would sail through as a completed
  // census (audit clusterA-H5). A census that counted NaN entries did not happen.
  if (detectorResult === undefined || detectorResult === null
    || typeof detectorResult.blocked !== 'boolean'
    || !Number.isInteger(detectorResult.checked) || detectorResult.checked < 0) {
    return { converged: false, reason: 'detector-not-run' };
  }
  if (detectorResult.blocked) {
    return { converged: false, reason: 'detector-undispositioned' };
  }
  return { converged: true, reason: 'converged' };
}

/**
 * Map a round's ledger state to the `detectorResult` the oracle above expects.
 *
 * **Ledger PRESENCE is the wrong predicate**, and this function exists so that
 * mistake has one place to not be made. Two states look alike and must diverge:
 * a legitimate R1 run (no ledger can exist yet) and an R2+ run whose ledger was
 * omitted, corrupt, or lost — where the detectors are *unknown*, not *absent*.
 * Handing the second an explicit empty result would let a round that lost its
 * ledger converge on counts alone and license `AI-Gate: passed`, which is the
 * failure this whole wiring exists to close.
 *
 * | round | ledger state                    | returns                        |
 * |-------|---------------------------------|--------------------------------|
 * | R1    | none (expected)                 | `{blocked:false, checked:0}`   |
 * | R2+   | valid                           | `checkDetectors(ledger, {cwd})` |
 * | R2+   | missing/corrupt                 | `undefined` ⇒ `detector-not-run` |
 *
 * `undefined` is returned deliberately rather than throwing: the caller is a
 * best-effort telemetry/evidence block, and the honest verdict for "we could
 * not check" is non-convergence, not a crashed audit.
 *
 * @param {{round?: number, suppressionUnavailable?: boolean, ledger?: object|null,
 *          cwd?: string,
 *          checkDetectorsFn?: (ledger: object, opts: object) => {blocked: boolean}}} args
 *   `suppressionUnavailable` is the orchestrator's own function-scoped flag, set
 *   when `validateLedgerForR2` reports a missing or corrupt R2+ ledger. It is
 *   the input rather than the richer validation object because that object is
 *   `const`-scoped inside the `isR2Plus` block and is not visible at the verdict
 *   site — a binding this signature makes impossible to get wrong.
 *
 *   `checkDetectorsFn` is injected — production passes the real `checkDetectors`,
 *   which keeps this module free of a static dependency on `detector.mjs` (the
 *   threshold does not own the ripgrep call) and lets the three rows below be
 *   asserted without a filesystem.
 * @returns {{blocked: boolean, checked?: number}|undefined}
 */
export function resolveDetectorResultForRound({ round, suppressionUnavailable, ledger, cwd, checkDetectorsFn } = {}) {
  // The round must be KNOWN before "this is R1, no detectors can exist" is a safe
  // conclusion (audit clusterA-H4). `!(round >= 2)` is true for `undefined`, `null`,
  // `NaN`, `'2'` and negatives alike, so a lost or mistyped round would have taken
  // the converges-clean branch — fail-open, in the resolver written to be fail-closed.
  // An unknown round is unknown detectors: same verdict as a lost ledger.
  if (!Number.isInteger(round) || round < 1) return undefined;
  if (round < 2) return { blocked: false, checked: 0 };
  // Unknown, not absent — the caller must NOT converge on counts alone.
  if (suppressionUnavailable) return undefined;
  if (!ledger || typeof checkDetectorsFn !== 'function') return undefined;
  return checkDetectorsFn(ledger, { cwd: cwd ?? process.cwd() });
}
