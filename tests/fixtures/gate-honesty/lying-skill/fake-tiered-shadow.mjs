// Fixture: a fake tiered-shadow module that reproduces the exact 2026-07-14
// incident bug — counts fallback_legacy rows as "compared". The
// tiered-shadow-window oracle must catch this.
export function summarize(records) {
  return { comparedRuns: records.length }; // BUG: never excludes fallback_legacy
}
export function windowProgress(comparedRuns) {
  return { met: comparedRuns >= 1, withinWindow: comparedRuns >= 1, min: 1, max: 1 };
}
