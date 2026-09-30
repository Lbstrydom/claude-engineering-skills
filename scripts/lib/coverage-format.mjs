/**
 * @fileoverview Presentation helpers for the file-coverage ledger — deliberately DEPENDENCY-FREE.
 *
 * The final-review envelope (`final-review/envelope.mjs`) is a pure module by design, and the summary line lives in
 * `findings-pipeline.mjs`; both need to turn a `_coverage` object into words. Keeping these two functions apart
 * from `file-coverage.mjs` (which pulls in zod, the language registry and the sensitive-path classifier) lets them
 * import the wording without importing the machinery.
 *
 * Both work on a canonical ledger (`files[]`) AND on a reviewer projection (`filesProjection.shown`): the
 * projection keeps every record that is short of full coverage, which is exactly the population these read.
 *
 * @module scripts/lib/coverage-format
 */

/** Repository-controlled text (extension names, invariant prose) rendered on ONE line with control characters neutralised. */
export function oneLine(text) {
  // eslint-disable-next-line no-control-regex
  return String(text ?? '').replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, '?');
}

/** The ledger records of `cov`, whichever shape it is in. */
function recordsOf(cov) {
  return Array.isArray(cov?.files) ? cov.files : (cov?.filesProjection?.shown ?? []);
}

/**
 * The ledger records that are SHORT of full coverage: not audited (and not a policy exclusion or an expected
 * non-code file), or audited with a head-cut read whose changed lines were not all inside the window.
 *
 * @param {object} cov
 * @returns {object[]}
 */
export function shortCoverageFiles(cov) {
  const isShort = (f) => f.outcome !== 'audited'
    ? !['excluded-infra', 'excluded-user'].includes(f.outcome) && f.class !== 'non-code'
    : !(f.read.state === 'full' || (f.read.state === 'head-cut' && f.changedLinesUnread === 0));
  return recordsOf(cov).filter(isShort);
}

/**
 * The operator-facing suffix for the summary line and the CONVERGED banner. Empty string when coverage is complete
 * and nothing was excluded: a clean, fully-covered run prints byte-identical to what it always did.
 *
 * NO ledger at all (`null`/`undefined`) returns '' here: this function words a ledger, it cannot decide what a MISSING one
 * means. A caller that must not treat "no ledger" as clean (the convergence banner) says so itself, via
 * `coverageMissingNote`; a run produced by this tooling always carries one.
 *
 * @param {object|null|undefined} cov a `_coverage`
 * @returns {string}
 */
export function formatCoverageSuffix(cov) {
  if (!cov || typeof cov !== 'object') return '';
  const c = cov.counts || {};
  // An object that is NOT a recognisable ledger must never read as a clean one: an unrecognised status is invalid, said so.
  if (!['complete', 'partial', 'none', 'incomplete'].includes(cov.status)) {
    return 'coverage: LEDGER INVALID — no recognised status';
  }
  // ...and a status string alone does not make a ledger: `{status:'complete'}` must never print as a clean one.
  const shaped = cov.status === 'incomplete'
    || (c && Number.isInteger(c.required) && Number.isInteger(c.short) && (Array.isArray(cov.files) || Array.isArray(cov.filesProjection?.shown)));
  if (!shaped) return 'coverage: LEDGER INVALID — counts or file records missing';
  if (cov.status === 'incomplete') {
    return `coverage: LEDGER INVALID — ${(cov.invariantViolations || []).slice(0, 2).map(oneLine).join('; ') || 'unspecified'}`;
  }
  const parts = [];
  if (cov.status === 'none') {
    parts.push(`coverage: NONE of the ${c.required} changed source file(s) were audited`);
  } else if (cov.status === 'partial') {
    parts.push(`coverage: PARTIAL — ${c.short} of ${c.required} changed source file(s) not fully audited`);
  }
  const unc = cov.uncoveredByExtension || {};
  const uncN = Object.values(unc).reduce((a, b) => a + b, 0);
  if (uncN > 0) {
    parts.push(`${uncN} unrecognised file type(s): ${Object.entries(unc).map(([e, n]) => `${oneLine(e)} ×${n}`).join(', ')}`);
  }
  const recs = recordsOf(cov);
  // A reviewer projection shows at most a capped window of the short files, so per-file counts below are a FLOOR there.
  const floor = !Array.isArray(cov.files) && (cov.filesProjection?.shortTotal ?? 0) > recs.length ? 'at least ' : '';
  const deleted = recs.filter((f) => f.outcome === 'deleted' && ['profiled', 'model-only', 'declarative'].includes(f.class)).length;
  if (deleted > 0) parts.push(`${floor}${deleted} deleted source file(s) not reviewed`);
  const unread = recs.filter((f) => f.outcome === 'audited' && (f.changedLinesUnread ?? 0) > 0).length;
  if (unread > 0) parts.push(`${floor}${unread} file(s) with changed lines past the read window`);
  if ((c.excludedRequired || 0) > 0) parts.push(`${c.excludedRequired} source file(s) excluded by policy`);
  return parts.join('; ');
}

/** What to print when a round carries NO `_coverage` (a result from tooling that predates the contract). */
export const coverageMissingNote = 'no _coverage ledger on this round — which changed files were audited is unknown';
