// Fixture: a fake convergence module whose exported constants/behaviour
// silently diverge from the contract's declared params. The
// convergence-threshold oracle must catch this.
export const CONVERGENCE_THRESHOLDS = { high: 0, medium: 3, quickFix: 0 }; // BUG: medium should be 2
export function evaluateConvergence({ high, medium, quickFix }) {
  return high === 0 && medium <= 3 && quickFix === 0; // BUG: mirrors the wrong constant
}
