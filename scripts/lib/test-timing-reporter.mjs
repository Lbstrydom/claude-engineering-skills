/**
 * @fileoverview The node:test reporter that records how long each TEST FILE took. Best-effort end
 * to end and silent: it yields NOTHING and writes its report to the path in TEST_TIMING_REPORT
 * itself, inside a try/catch, so no node-managed destination can abort the run and telemetry
 * cannot change a verdict. Node still needs a destination for the pair; the runner gives it
 * `stdout`, and since nothing is yielded stdout is untouched.
 *
 * The event contract, the accumulator, the completeness flag and the reader live in
 * test-timing-report.mjs (pure, no side effects). This module is the only importer of
 * test-runner-listener-ceiling.mjs: node loads a reporter in the runner process and never in a
 * test file, and a third reporter is what crosses node's default listener ceiling.
 * Plan: docs/plans/gate-cost-slice-1.md.
 *
 * @module scripts/lib/test-timing-reporter
 */
import fs from 'node:fs';

// Side effect, on purpose and only here. See test-runner-listener-ceiling.mjs.
import './test-runner-listener-ceiling.mjs';
import { TIMING_REPORT_ENV, createTimingAccumulator } from './test-timing-report.mjs';

/**
 * The reporter. Best-effort end to end; yields nothing (see the file header).
 * @param {AsyncIterable<object>} source
 */
export default async function* testTimingReporter(source) {
  const acc = createTimingAccumulator();
  let complete = true;
  try {
    for await (const event of source) acc.add(event);
  } catch {
    // the stream failing is the runner's business; whatever was gathered is still reported,
    // but marked partial so it cannot be read as the whole run
    complete = false;
  }
  try {
    const target = process.env[TIMING_REPORT_ENV];
    if (target) fs.writeFileSync(target, `${JSON.stringify(acc.report(complete))}\n`);
  } catch {
    // an unwritable path means "timing unavailable", never a failed run
  }
}
