/**
 * @fileoverview A node:test reporter that exists to catch ONE thing: a test
 * failure the runner reports in its output but does not carry into its exit
 * code — a false green.
 *
 * **The hole, demonstrated (Node 22.19, 2026-08-11).** A suite whose callback
 * throws at CONSTRUCTION time — `describe('x', () => { test(...) })` where
 * `test` was never imported — is reported as `not ok` in the TAP body, but the
 * dead suite contributes nothing to the `# fail` tally:
 *
 *     # tests 1   # suites 2   # pass 1   # fail 0     ← and exit code 0
 *
 * So `npm test` is green while a whole suite never executed. This landed for
 * real in `tests/gate-evidence-tree-identity.test.mjs` (dd83e1f8): three suites
 * died at construction, the file reported `# pass 15 # fail 0`, and the
 * pre-push `check` passed. Nine subtests asserting the `auditedBranch` identity
 * contract were silently absent for the life of that commit.
 *
 * **The invariant enforced here is deliberately broader than that one cause**:
 *
 *     a non-todo `test:fail` reported alongside exit 0 is always a lie.
 *
 * Keying on the CONSEQUENCE (a failure the exit code dropped) rather than on
 * the cause (construction-time ReferenceError) means a future variant — a
 * throwing fixture, a hook failure node tallies differently, a node upgrade
 * that changes the accounting — is caught without anyone predicting it. It also
 * cannot raise a false alarm: a genuine non-todo failure already exits 1, so on
 * that path the guard merely agrees with the runner and changes nothing.
 *
 * **Why non-todo.** A failing `{ todo: true }` test also emits `test:fail` and
 * also legitimately exits 0 — that is what todo MEANS. Probed empirically
 * rather than assumed; the two events are distinguished by `data.todo`.
 *
 * This module is a pure transform: it accumulates and emits ONE JSON line at
 * end-of-stream. The reporter's `--test-reporter-destination` file IS the
 * report, so nothing here touches the filesystem or the environment.
 *
 * @module scripts/lib/test-guard-reporter
 */

/** Bumped if the report shape changes; the reader refuses an unknown version. */
export const GUARD_REPORT_VERSION = 'test-guard/v1';

/**
 * True when a `test:fail` event represents a failure that MUST be reflected in
 * the exit code. Pure, and exported so the suite asserts against this predicate
 * rather than re-implementing the todo carve-out.
 *
 * @param {object} data - the `data` payload of a `test:fail` event.
 * @returns {boolean}
 */
export function isExitCodeWorthyFailure(data) {
  // `todo` is the one documented case where node reports a failure and still
  // exits 0 on purpose. Everything else must move the exit code.
  return !data?.todo;
}

/**
 * Reduce a `test:fail` event to the minimum a human needs to find it again.
 *
 * @param {object} data - the `data` payload of a `test:fail` event.
 * @returns {{name: string, type: string|null, file: string|null, line: number|null, error: string|null}}
 */
export function summariseFailure(data) {
  return {
    name: typeof data?.name === 'string' ? data.name : '<unnamed>',
    // 'suite' is the construction-failure signature; 'test' is an ordinary one.
    type: data?.details?.type ?? null,
    file: data?.file ?? null,
    line: typeof data?.line === 'number' ? data.line : null,
    error: data?.details?.error?.message ?? null,
  };
}

/**
 * The reporter. Emits a single JSON line at end-of-stream describing every
 * exit-code-worthy failure observed.
 *
 * Emitting unconditionally — including the zero-failure case — is what lets the
 * reader treat a MISSING report as a guard that did not run, and fail closed on
 * it. A reporter that stayed silent when clean would be indistinguishable from
 * a reporter that never loaded.
 */
export default async function* testGuardReporter(source) {
  const failures = [];
  for await (const event of source) {
    if (event.type === 'test:fail' && isExitCodeWorthyFailure(event.data)) {
      failures.push(summariseFailure(event.data));
    }
  }
  yield `${JSON.stringify({ version: GUARD_REPORT_VERSION, failures })}\n`;
}
