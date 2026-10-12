/**
 * @fileoverview Raises the EventEmitter listener ceiling in the `node --test` RUNNER process
 * only, as a side effect of being imported by the timing reporter
 * (scripts/lib/test-timing-reporter.mjs). Plan: docs/plans/gate-cost-slice-1.md.
 *
 * WHY. Node's test runner attaches a fixed number of 'end' listeners per reporter to its
 * internal TestsStream, and the default ceiling is 10. Two reporters (tap + guard) stay under
 * it; three (tap + timing + guard) do not, so every run printed "MaxListenersExceededWarning:
 * Possible EventEmitter memory leak". It is a count of reporters, not a leak.
 *
 * WHY HERE AND NOT A FLAG. Measured on v22.23.2, 2026-10-12:
 *   · `--disable-warning=MaxListenersExceededWarning` (the first version, audit round 1,
 *     M7/M8) is inherited by every test file's process, so it also hid a real leak inside a
 *     test file: a test adding 11 listeners printed the warning under plain `node --test`
 *     and nothing under the flag.
 *   · `--import <module>` does NOT run in the runner process at all (it ran only in the
 *     per-file children), so a preload cannot raise the runner's ceiling.
 *   · Reporter modules ARE loaded in the runner process, and before the reporters are piped
 *     (the third reporter's listeners are what cross the line), and never in a test file. So
 *     importing this from a reporter scopes the change exactly to the runner.
 *
 * THE GUARD BELOW. A test file may import the timing reporter module (tests do). Node sets
 * NODE_TEST_CONTEXT in every test-file process (run-tests.mjs scrubs it from the runner's
 * own env, see SCRUBBED_RUNNER_ENV), so its presence means "I am a test file, change nothing".
 * tests/run-tests-timing.test.mjs pins the hazard, the quiet runner, and that a test file's
 * own warning still prints.
 *
 * @module scripts/lib/test-runner-listener-ceiling
 */
import { EventEmitter } from 'node:events';

/** Room for tap + timing + guard (11 listeners) and a caller's own reporter or two. */
export const RUNNER_LISTENER_CEILING = 20;

if (!process.env.NODE_TEST_CONTEXT) EventEmitter.defaultMaxListeners = RUNNER_LISTENER_CEILING;
