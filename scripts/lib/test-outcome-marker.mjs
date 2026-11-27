/**
 * @fileoverview The one line a test runner prints on a failing run to say WHY it is red, and its one reader — `fleet land`
 * classifies a red tier from it (docs/plans/fleet-train-landing-friction.md section 2.1). Dependency-free on purpose: the test
 * runner imports it, and a consumer's own runner (any language) can print the same line with nothing from this repo.
 *
 * Grammar: `test-outcome/v1 {"testsFailed": <int >= 0 | null>, "guards": [{"id": "<slug>", "kind": "policy|timeout|instrument"}]}`
 *  - `testsFailed`: tests the runner itself recorded as failed; null when it could not count them.
 *  - `guards`: every non-test reason the run is red. `policy` = a deterministic rule over a FINISHED run (a slow-test budget, a
 *    coverage floor); `timeout` = the run or a test was stopped for time; `instrument` = the measuring apparatus failed.
 * Bump the version if the payload changes.
 *
 * The marker only DESCRIBES a red run. It never moves an exit code, and a green run is never read for it.
 *
 * @module scripts/lib/test-outcome-marker
 */
export const TEST_OUTCOME_MARKER = 'test-outcome/v1';
export const GUARD_KINDS = Object.freeze(['policy', 'timeout', 'instrument']);
/** What a red attempt was, as `fleet land` decides it. */
export const FAILURE_KINDS = Object.freeze(['test-failure', 'guard', 'timeout', 'instrument', 'unclassified']);

const GUARD_ID = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const MAX_GUARDS = 32;

/** The line itself. @param {{testsFailed: number|null, guards: Array<{id: string, kind: string}>}} o */
export const outcomeLine = (o) => `${TEST_OUTCOME_MARKER} ${JSON.stringify({ testsFailed: o.testsFailed, guards: o.guards })}`;

/**
 * Parse the payload after the marker. Anything outside the grammar is `null` (the caller reads that as unclassified).
 * @returns {{testsFailed: number|null, guards: Array<{id: string, kind: string}>}|null}
 */
export function parseOutcomePayload(payload) {
  let v;
  try { v = JSON.parse(String(payload ?? '').trim()); } catch { return null; }
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
  const keys = Object.keys(v).sort().join(',');
  if (keys !== 'guards,testsFailed') return null;
  const tf = v.testsFailed;
  if (!(tf === null || (Number.isInteger(tf) && tf >= 0))) return null;
  if (!Array.isArray(v.guards) || v.guards.length > MAX_GUARDS) return null;
  for (const g of v.guards) {
    if (!g || typeof g !== 'object' || Object.keys(g).sort().join(',') !== 'id,kind') return null;
    if (typeof g.id !== 'string' || !GUARD_ID.test(g.id) || !GUARD_KINDS.includes(g.kind)) return null;
  }
  return { testsFailed: tf, guards: v.guards.map((g) => ({ id: g.id, kind: g.kind })) };
}

/**
 * The failure kind of a parsed outcome (null = no usable marker). Pure; the ONE reader of what a marker means.
 * @returns {'test-failure'|'guard'|'timeout'|'instrument'|'unclassified'}
 */
export function classifyOutcome(o) {
  if (!o || o.testsFailed === null) return 'unclassified';
  if (o.testsFailed > 0) return 'test-failure';
  if (o.guards.some((g) => g.kind === 'timeout')) return 'timeout';
  if (o.guards.some((g) => g.kind === 'instrument')) return 'instrument';
  return o.guards.length ? 'guard' : 'unclassified';
}

/**
 * Classify ONE attempt's log text (the caller passes only that attempt's segment). Exactly one marker line is required: none,
 * a malformed one, or two (a test that printed a forged line before the runner printed its own) is `unclassified`.
 * @param {string|null} text
 * @returns {{kind: string, outcome: {testsFailed: number|null, guards: object[]}|null, why: string|null}}
 */
export function classifyAttemptLog(text) {
  const found = [];
  for (const raw of String(text ?? '').split(/\r?\n/)) {
    // A tier log may carry a prefix (a timestamp, CI's job/step columns): the marker is found where it starts.
    const at = raw.indexOf(`${TEST_OUTCOME_MARKER} `);
    if (at >= 0) found.push(raw.slice(at + TEST_OUTCOME_MARKER.length + 1));
  }
  if (!found.length) return { kind: 'unclassified', outcome: null, why: 'the runner printed no test-outcome/v1 line' };
  if (found.length > 1) return { kind: 'unclassified', outcome: null, why: `the attempt printed ${found.length} test-outcome/v1 lines (exactly one is trusted)` };
  const outcome = parseOutcomePayload(found[0]);
  if (!outcome) return { kind: 'unclassified', outcome: null, why: 'the test-outcome/v1 line is malformed' };
  const kind = classifyOutcome(outcome);
  return { kind, outcome, why: kind === 'unclassified' ? 'the test-outcome/v1 line names no failed test and no guard' : null };
}

/**
 * What `run-tests.mjs` reports for a FAILING run, from the same inputs its verdict came from. Pure.
 * @param {{reportText: string|null, guardReportVersion: number|string, watchdog?: object|null,
 *          hang?: {stallLines?: string[], gapFiles?: string[], errors?: string[]}|null, selectionFailed?: boolean}} input
 * @returns {{testsFailed: number|null, guards: Array<{id: string, kind: string}>}}
 */
export function outcomeFromRun({ reportText, guardReportVersion, watchdog = null, hang = null, selectionFailed = false }) {
  const guards = [];
  if (watchdog) guards.push({ id: 'idle-watchdog', kind: 'timeout' });
  if (hang?.stallLines?.length) guards.push({ id: 'per-test-limit', kind: 'timeout' });
  if (hang?.gapFiles?.length || hang?.errors?.length) guards.push({ id: 'hang-guard', kind: 'instrument' });
  let testsFailed = null;
  let report = null;
  try { report = JSON.parse(reportText); } catch { report = null; }
  if (report?.version === guardReportVersion && Array.isArray(report.failures)) testsFailed = report.failures.length;
  else guards.push({ id: 'guard-report', kind: 'instrument' });
  if (selectionFailed) guards.push({ id: 'test-selection', kind: 'instrument' });
  return { testsFailed, guards };
}
