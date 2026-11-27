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
 * **Provenance.** `fleet land` never reads the marker from the tier's output, where any test can print anything: it names a
 * fresh file per attempt in `FLEET_TEST_OUTCOME_FILE`, and the RUNNER writes its machine lines there (`writeOutcomeFile`) and
 * removes the variable from the environment of the tests it runs (`run-tests.mjs` `SCRUBBED_RUNNER_ENV`). A consumer runner
 * that supports classification does the same; one that does not leaves no file, which reads as unclassified.
 *
 * @module scripts/lib/test-outcome-marker
 */
import fs from 'node:fs';
export const TEST_OUTCOME_MARKER = 'test-outcome/v1';
/** The file a runner writes its machine lines to, named by fleet per attempt. */
export const TEST_OUTCOME_FILE_ENV = 'FLEET_TEST_OUTCOME_FILE';
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
  if (!o) return 'unclassified';
  // A run stopped for time is a timeout whatever else it counted: the same load stops a rerun again, at the full cost.
  if (o.guards.some((g) => g.kind === 'timeout')) return 'timeout';
  if (o.testsFailed !== null && o.testsFailed > 0) return 'test-failure';
  // The apparatus failed (a missing report, a killed child): rerun-eligible, and never mistaken for a clean count.
  if (o.guards.some((g) => g.kind === 'instrument')) return 'instrument';
  if (o.testsFailed === null) return 'unclassified';
  return o.guards.length ? 'guard' : 'unclassified';
}

/**
 * Classify ONE attempt's outcome-file text. Exactly one marker line is required: none, a malformed one, or two is `unclassified`.
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
  if (!found.length) return { kind: 'unclassified', outcome: null, why: 'the runner wrote no test-outcome/v1 line' };
  if (found.length > 1) return { kind: 'unclassified', outcome: null, why: `the attempt printed ${found.length} test-outcome/v1 lines (exactly one is trusted)` };
  const outcome = parseOutcomePayload(found[0]);
  if (!outcome) return { kind: 'unclassified', outcome: null, why: 'the test-outcome/v1 line is malformed' };
  const kind = classifyOutcome(outcome);
  return { kind, outcome, why: kind === 'unclassified' ? 'the test-outcome/v1 line names no failed test and no guard' : null };
}

/**
 * What `run-tests.mjs` reports for a FAILING run, from the same inputs its verdict came from. Pure.
 * @param {{status?: number|null, reportText: string|null, guardReportVersion: number|string, watchdog?: object|null,
 *          hang?: {stallLines?: string[], gapFiles?: string[], errors?: string[]}|null, selectionFailed?: boolean}} input
 * @returns {{testsFailed: number|null, guards: Array<{id: string, kind: string}>}}
 */
export function outcomeFromRun({ status = 1, reportText, guardReportVersion, watchdog = null, hang = null, selectionFailed = false }) {
  const guards = [];
  // A signal-killed runner child (status null) did not finish: whatever its partial report counted, nothing vouches for the rest.
  if (status === null && !watchdog) guards.push({ id: 'runner-killed', kind: 'instrument' });
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

/**
 * Write a failing run's machine lines to the file fleet named (`FLEET_TEST_OUTCOME_FILE`), if it named one. Best-effort: a
 * write that fails leaves no file, which fleet reads as unclassified (today's behaviour), never as a classification.
 * @param {string[]} lines the run's output lines; only machine lines (`test-outcome/v1`, `run-tests/v1 failed-files:`) are written
 */
export function writeOutcomeFile(lines, { env = process.env, write = fs.writeFileSync } = {}) {
  const file = env[TEST_OUTCOME_FILE_ENV];
  if (typeof file !== 'string' || !file.trim()) return;
  const machine = lines.filter((l) => l.startsWith(`${TEST_OUTCOME_MARKER} `) || l.startsWith('run-tests/v1 failed-files:'));
  if (!machine.length) return;
  try { write(file, `${machine.join('\n')}\n`); } catch { /* best-effort: absence reads as unclassified */ }
}
