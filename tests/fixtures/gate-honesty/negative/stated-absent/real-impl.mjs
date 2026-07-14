// Fixture: a CORRECTLY-behaving implementation, so this fixture's only
// divergence is the containment check (stated text absent from SKILL.md).
export const CONVERGENCE_THRESHOLDS = { high: 0, medium: 2, quickFix: 0 };
export function evaluateConvergence({ high, medium, quickFix }) {
  return high === 0 && medium <= 2 && quickFix === 0;
}
