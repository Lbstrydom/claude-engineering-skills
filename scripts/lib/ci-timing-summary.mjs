/**
 * @fileoverview The per-file test timing report, carried through CI WITHOUT an artifact. `full-suite.yml` may not upload
 * artifacts (storage billing for a public repo is not clearly free; `tests/workflow-runner-labels.test.mjs` fails on it),
 * so the one thing a baseline refresh of `.test-tiers.json` needs (per-file timings of a full run) used to require a
 * 16-minute local `npm test`. This module renders the report as text a job SUMMARY and the step LOG both carry, and reads
 * it back from either: a `--timing` file may hold the raw report, a saved job summary, or the output of
 * `gh run view <id> --log`.
 *
 * The carrier is ONE marker line, `test-timing-json: {"version":"test-timing/v1",...}`. A log prefixes every line with a
 * job/step/timestamp, so the reader finds the marker anywhere in a line, not at its start. A partial report is refused on
 * both sides: a refresh from part of a run would mislead (`test-tier.mjs refresh-heavy` says the same).
 *
 * TRUST. The marker is a convention, not a signature: a test that printed its own marker line could be read as the CI
 * measurement when the real one is missing. That is accepted because the consumer is a human-reviewed baseline refresh
 * (`refresh-heavy` is report-only, and listing a file still needs its own reach and a replay), and the summary step's marker is
 * the LAST one in a log, so it wins whenever it exists.
 *
 * @module scripts/lib/ci-timing-summary
 */
import { parseTimingReport } from './test-timing-report.mjs';

export const CI_TIMING_MARKER = 'test-timing-json:';

/**
 * Render a report for CI: a short markdown table of the slowest files, then the marker line.
 *
 * @param {string|null} reportText the raw `TEST_TIMING_KEEP` file
 * @param {{top?: number}} [o]
 * @returns {{ok: true, text: string} | {ok: false, reason: string}}
 */
export function renderCiTimingSummary(reportText, { top = 15 } = {}) {
  const rep = parseTimingReport(reportText);
  if (!rep.ok) return { ok: false, reason: rep.reason };
  if (!rep.report.complete) return { ok: false, reason: 'the timing report is partial; a partial run must not be carried as if it were a measurement' };
  const files = [...rep.report.files].sort((a, b) => b.ms - a.ms);
  const rows = files.slice(0, top).map((f) => `| \`${f.file}\` | ${(f.ms / 1000).toFixed(1)} | ${f.tests} |`);
  const text = [
    '### Test timing (full suite)',
    '',
    `${files.length} test files, ${(rep.report.totalMs / 1000).toFixed(0)} s of test-body time (worker-seconds, not wall time). Slowest ${rows.length}:`,
    '',
    '| file | seconds | tests |',
    '|---|---|---|',
    ...rows,
    '',
    'Machine-readable (save this run\'s log or summary and pass it to `node scripts/test-tier.mjs refresh-heavy --timing <file>`):',
    '',
    '```',
    `${CI_TIMING_MARKER} ${JSON.stringify(rep.report)}`,
    '```',
    '',
  ].join('\n');
  return { ok: true, text };
}

/**
 * Find a timing report in text that is the raw report, a saved job summary, or a CI log. Returns the report TEXT (what
 * `parseTimingReport` takes) or null when none is present.
 *
 * Only a USABLE report counts (`parseTimingReport` ok): a truncated, foreign or partial marker before the real one must not
 * shadow it. When several usable markers are present the LAST wins: the summary step runs after `npm test`, so anything a
 * test printed earlier with the same marker (by accident or otherwise) cannot displace the measurement. A log line that
 * carries the marker inside a longer prefix is handled by searching the line, not anchoring it.
 *
 * @param {string} text
 * @returns {string|null}
 */
export function extractTimingReport(text) {
  const t = String(text ?? '');
  const trimmed = t.trim();
  if (trimmed.startsWith('{') && parseTimingReport(trimmed).ok) return trimmed;
  let found = null;
  for (const line of t.split(/\r?\n/)) {
    const i = line.indexOf(CI_TIMING_MARKER);
    if (i < 0) continue;
    const payload = line.slice(i + CI_TIMING_MARKER.length).trim();
    if (parseTimingReport(payload).ok) found = payload;
  }
  return found;
}
