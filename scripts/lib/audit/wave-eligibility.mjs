/**
 * @fileoverview Wave eligibility — the honest answer to "did this mechanical wave look at anything?".
 *
 * ## The defect this closes (storyline field report, 2026-09-30)
 *
 * The four mechanical waves (orphan-introduced, event-wiring-symmetry, duplication, adjacency) read JS/TS only. Given a
 * diff of twelve C# files they each filtered it to EMPTY and reported success — `ANALYZED_CLEAN — 0 findings`,
 * `Duplication: clean — no candidates over threshold`, `Adjacency: not-triggered`, whose own documentation defines it as
 * "we looked; nothing changed inside a conditional". Nothing was examined, and every one of those lines is exactly what
 * a wave that DID examine a clean change prints. "Checked nothing" wore a clean pass's clothes.
 *
 * ## The rule
 *
 * A wave's eligibility is measured, per run, against the changed files: how many of them could this wave have read at all?
 *   - `no_changes`  there were no changed files — the wave has nothing to say either way (its existing state stands);
 *   - `ineligible`  changed files existed and NONE were eligible — the wave examined nothing, and says `INELIGIBLE`;
 *   - `partial`     some were eligible — the wave examined `k of n` and says so beside its result;
 *   - `full`        every changed file was eligible.
 * `INELIGIBLE` is never `clean`, never `ANALYZED_CLEAN`, never `not-triggered`.
 *
 * Pure: no filesystem, no git.
 *
 * @module scripts/lib/audit/wave-eligibility
 */

/**
 * @param {Iterable<string>} changed changed file paths
 * @param {(path: string) => boolean} isEligible the wave's own reader predicate
 * @returns {{changed: number, eligible: number, ineligibleFiles: string[],
 *   state: 'no_changes'|'ineligible'|'partial'|'full'}}
 */
export function waveEligibility(changed, isEligible) {
  const paths = [...new Set([...(changed || [])].filter((p) => typeof p === 'string' && p !== ''))];
  const eligible = paths.filter((p) => isEligible(p));
  const ineligibleFiles = paths.filter((p) => !isEligible(p));
  let state;
  if (paths.length === 0) state = 'no_changes';
  else if (eligible.length === 0) state = 'ineligible';
  else if (eligible.length < paths.length) state = 'partial';
  else state = 'full';
  return { changed: paths.length, eligible: eligible.length, ineligibleFiles, state };
}

/** The reason a wave that examined nothing gives, e.g. "0 of 12 changed file(s) are js/ts". */
export function ineligibleReason(e, scopeLabel) {
  return `0 of ${e.changed} changed file(s) are ${scopeLabel}; nothing was examined`;
}

/** A short note for a wave that examined only part of the change, or '' when it examined all of it. */
export function eligibilityNote(e, scopeLabel) {
  return e.state === 'partial' ? `examined ${e.eligible} of ${e.changed} changed file(s) (${scopeLabel} only)` : '';
}

/**
 * The wave record the coverage ledger carries (`WAVE_STATES` in file-coverage.mjs).
 * @param {{changed:number, eligible:number, state:string}|null} e
 * @param {string} scopeLabel
 * @param {'completed'|'errored'|'unavailable'} [ranAs] how the wave itself finished, when it did not go ineligible
 * @param {string|null} [reason]
 * @returns {{state: string, eligible: number|null, changed: number|null, reason: string|null}}
 */
export function waveRecord(e, scopeLabel, ranAs = 'completed', reason = null) {
  if (!e) return { state: ranAs, eligible: null, changed: null, reason };
  // The execution outcome wins when the wave did not complete: an errored wave whose input was also ineligible is ERRORED.
  if (e.state === 'ineligible' && ranAs === 'completed') return { state: 'ineligible', eligible: 0, changed: e.changed, reason: ineligibleReason(e, scopeLabel) };
  if (e.state === 'partial' && ranAs === 'completed') return { state: 'partial', eligible: e.eligible, changed: e.changed, reason: eligibilityNote(e, scopeLabel) };
  return { state: ranAs, eligible: e.eligible, changed: e.changed, reason };
}
