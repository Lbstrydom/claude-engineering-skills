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
    : !(f.read.state === 'full' || ((f.read.state === 'head-cut' || f.read.state === 'windowed') && f.changedLinesUnread === 0));
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
  // An empty measurement universe is said so (5c16 / 70b5): `complete` over nothing is not a clean bill. `scopeOutcome` is absent on a
  // ledger written before it existed, which reads exactly as it always did.
  if (cov.scopeOutcome === 'no-change-set') parts.push('coverage: not measured — no change set (plan/full scope audits files, not a diff)');
  else if (cov.scopeOutcome === 'no-code-in-scope') parts.push(`coverage: NO_CODE_IN_SCOPE — ${c.required === 0 ? 'none' : c.required} of the ${cov.changedTotal} changed file(s) are implementation code`);
  if (cov.status === 'none') {
    parts.push(`coverage: NONE of the ${c.required} changed source file(s) were audited`);
  } else if (cov.status === 'partial') {
    parts.push(`coverage: PARTIAL — ${c.short} of ${c.required} changed source file(s) not fully audited`);
  }
  const unc = cov.uncoveredByExtension || {};
  const uncN = Object.values(unc).reduce((a, b) => a + b, 0);
  if (uncN > 0) {
    // Say it plainly when a file of such a type was changed AND nothing read it (not merely declared out of scope).
    const never = unreviewedUnrecognisedFiles(cov).length > 0 ? ' never sent to any pass' : '';
    parts.push(`${uncN} unrecognised file type(s)${never}: ${Object.entries(unc).map(([e, n]) => `${oneLine(e)} ×${n}`).join(', ')}`);
  }
  const recs = recordsOf(cov);
  // A reviewer projection shows at most a capped window of the short files, so per-file counts below are a FLOOR there.
  const floor = !Array.isArray(cov.files) && (cov.filesProjection?.shortTotal ?? 0) > recs.length ? 'at least ' : '';
  const deleted = recs.filter((f) => f.outcome === 'deleted' && ['profiled', 'model-only', 'declarative'].includes(f.class)).length;
  if (deleted > 0) parts.push(`${floor}${deleted} deleted source file(s) not reviewed`);
  const unread = recs.filter((f) => UNREAD_OUTCOMES.has(f.outcome) && (f.changedLinesUnread ?? 0) > 0).length;
  if (unread > 0) parts.push(`${floor}${changedLinesUnreadTotal(cov)} changed line(s) in ${unread} file(s) never rendered to any pass`);
  if ((c.excludedRequired || 0) > 0) parts.push(`${c.excludedRequired} source file(s) excluded by policy`);
  const req = requiredSubjectsLine(cov);
  if (req) parts.push(req);
  return parts.join('; ');
}

/**
 * The subjects the operator declared with `--require` that were NOT read in full (status PARTIAL / UNREAD / SENSITIVE; an
 * `N/A` deleted subject is satisfied). Works on the canonical ledger and the reviewer projection alike: the block rides both.
 *
 * @param {object|null|undefined} cov a `_coverage`
 * @returns {Array<{path: string, status: string, reason: string|null}>}
 */
export function requiredSubjectsNotFull(cov) {
  const nf = cov?.requiredSubjects?.notFull;
  return Array.isArray(nf) ? nf : [];
}

/** `required: 11/12 FULL — package-lock.json UNREAD (not-admitted)`: every non-FULL subject NAMED with its reason, never a bare count. */
function requiredSubjectsLine(cov) {
  const rs = cov?.requiredSubjects;
  if (!rs || !(rs.declared > 0)) return '';
  const notFull = requiredSubjectsNotFull(cov);
  const na = rs.notApplicable > 0 ? ` (+${rs.notApplicable} N/A)` : '';
  const shown = notFull.slice(0, 20).map((s) => `${oneLine(s.path)} ${s.status}${s.reason ? ` (${oneLine(s.reason)})` : ''}`);
  const more = notFull.length > 20 ? `, +${notFull.length - 20} more` : '';
  return `required: ${rs.full}/${rs.declared} FULL${na}${shown.length ? ` — ${shown.join(', ')}${more}` : ''}`;
}

/**
 * Changed files of an UNRECOGNISED type that no pass was ever sent: class `uncovered`, outcome `not-admitted`
 * (upstream 57bd3de9: a changed `.jsonl` eval fixture passed two gates unread). Deliberately narrow, so it can gate:
 * `non-code` (binary, asset, lockfile, generated) is an EXPECTED exclusion; `excluded-*` is a DECLARED one
 * (`.auditignore` / `--exclude-paths` is the explicit acceptance); `sensitive` and `deleted` have their own outcomes.
 * Works on the canonical ledger and the reviewer projection alike.
 *
 * @param {object|null|undefined} cov a `_coverage`
 * @returns {object[]} the ledger records
 */
export function unreviewedUnrecognisedFiles(cov) {
  if (!cov || typeof cov !== 'object') return [];
  return recordsOf(cov).filter((f) => f?.class === 'uncovered' && f.outcome === 'not-admitted');
}

/**
 * Changed lines no completed pass rendered, summed over the files that MEASURED it — audited files read partially and
 * budget-omitted ones (every changed line unread) (`null` = not measurable,
 * contributes nothing). The one count both the convergence gate and the summary line read (upstream report 58f4e3a5:
 * a round converged PASS with 844 changed lines unread, and the line beside the verdict said only "5 file(s)").
 * On a reviewer projection this is a floor (only the shown records are summed).
 *
 * @param {object|null|undefined} cov a `_coverage`
 * @returns {number}
 */
export function changedLinesUnreadTotal(cov) {
  if (!cov || typeof cov !== 'object') return 0;
  return recordsOf(cov).reduce((n, f) => {
    const u = UNREAD_OUTCOMES.has(f?.outcome) ? f.changedLinesUnread : null;
    return n + (Number.isInteger(u) && u > 0 ? u : 0);
  }, 0);
}

/** Outcomes whose `changedLinesUnread` is a shortfall a re-run can fix. A policy exclusion never is (final gate G1). */
const UNREAD_OUTCOMES = new Set(['audited', 'budget-omitted']);

/** What to print when a round carries NO `_coverage` (a result from tooling that predates the contract). */
export const coverageMissingNote = 'no _coverage ledger on this round — which changed files were audited is unknown';
