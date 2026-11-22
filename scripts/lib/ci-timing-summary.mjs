/**
 * @fileoverview The per-file test timing report, carried through CI WITHOUT an artifact. `full-suite.yml` may not upload
 * artifacts (storage billing for a public repo is not clearly free; `tests/workflow-runner-labels.test.mjs` fails on it),
 * so the one thing a baseline refresh of `.test-tiers.json` needs (per-file timings of a full run) used to require a
 * 16-minute local `npm test`. This module renders the report as text a job SUMMARY and the step LOG both carry, and reads
 * it back from either: a `--timing` file may hold the raw report, a saved job summary, or the output of
 * `gh run view <id> --log`.
 *
 * THE CARRIER IS CHUNKED, and that is measured, not stylistic. The first version printed the whole report as ONE line
 * (about 100 KB for 1,287 files); in that run's own log (run 45024725865) the table before it was present and the line
 * itself, with everything after it, was missing: the log pipeline drops an oversized line. So the report is base64 text
 * split into lines of `CHUNK_CHARS`, each `test-timing-json#<i>/<n>: <chunk>`. Base64 because a chunk boundary may fall
 * anywhere and a reader trims whitespace; it has no characters a trim or a log decorator can eat. A log prefixes every line
 * with a job/step/timestamp, so the reader finds the marker anywhere in a line. A partial report is refused on both sides: a
 * refresh from part of a run would mislead (`test-tier.mjs refresh-heavy` says the same).
 *
 * TRUST. The marker is a convention, not a signature: a test that printed its own marker lines could be read as the CI
 * measurement when the real ones are missing. That is accepted because the consumer is a human-reviewed baseline refresh
 * (`refresh-heavy` is report-only, and listing a file still needs its own reach and a replay), and the summary step's
 * markers are the LAST in a log, so they win whenever they exist.
 *
 * @module scripts/lib/ci-timing-summary
 */
import crypto from 'node:crypto';
import { parseTimingReport } from './test-timing-report.mjs';

export const CI_TIMING_MARKER = 'test-timing-json';
/** Characters of base64 per line: far below the length at which the log dropped a line, and a line a human can scroll past. */
export const CHUNK_CHARS = 3000;

/**
 * Chunked marker lines for a report text: `test-timing-json#<i>/<n>/<sha8>: <base64 chunk>`. The sha8 is the first 8 hex
 * characters of the sha256 of the WHOLE base64 text, repeated on every line, so a reader can prove it reassembled exactly
 * what was written (a line cut short at a chunk boundary would otherwise decode to valid JSON with a few bytes missing).
 * @param {string} reportJson
 * @returns {string[]}
 */
export function encodeTimingChunks(reportJson) {
  const b64 = Buffer.from(reportJson, 'utf8').toString('base64');
  const sha = crypto.createHash('sha256').update(b64).digest('hex').slice(0, 8);
  const chunks = [];
  for (let i = 0; i < b64.length; i += CHUNK_CHARS) chunks.push(b64.slice(i, i + CHUNK_CHARS));
  return chunks.map((c, i) => `${CI_TIMING_MARKER}#${i + 1}/${chunks.length}/${sha}: ${c}`);
}

/**
 * Render a report for CI: a short markdown table of the slowest files, then the chunked marker lines.
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
  const markerLines = encodeTimingChunks(JSON.stringify(rep.report));
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
    ...markerLines,
    '```',
    '',
  ].join('\n');
  return { ok: true, text };
}

const CHUNK_LINE = new RegExp(`${CI_TIMING_MARKER}#(\\d+)/(\\d+)/([0-9a-f]{8}): ([A-Za-z0-9+/=]+)`);

/**
 * Find a timing report in text that is the raw report, a saved job summary, or a CI log. Returns the report TEXT (what
 * `parseTimingReport` takes) or null when none is present.
 *
 * A report is reassembled from a run of chunk lines `1/n .. n/n` in order; a gap, a repeat or a changed `n` abandons that
 * run (an earlier torn run must not shadow a later whole one). Only a USABLE report counts (`parseTimingReport` ok). When
 * several usable reports are present the LAST wins: the summary step runs after `npm test`, so anything a test printed
 * earlier with the same marker cannot displace the measurement.
 *
 * @param {string} text
 * @returns {string|null}
 */
export function extractTimingReport(text) {
  const t = String(text ?? '');
  const trimmed = t.trim();
  if (trimmed.startsWith('{') && parseTimingReport(trimmed).ok) return trimmed;
  let found = null;
  let run = null; // {n, sha, parts}
  // A run that tears (a gap, a repeat, a changed header) or ends unfinished is the LATEST attempt failing: it clears what an
  // earlier whole run found, so a stale measurement is never returned as if it were the newest one.
  const abandon = () => { if (run) found = null; run = null; };
  for (const line of t.split(/\r?\n/)) {
    const m = CHUNK_LINE.exec(line);
    if (!m) continue;
    const i = Number(m[1]);
    const n = Number(m[2]);
    const sha = m[3];
    const payload = m[4];
    if (i === 1) { abandon(); run = { n, sha, parts: [payload] }; }
    else if (run && run.n === n && run.sha === sha && run.parts.length === i - 1) run.parts.push(payload);
    else { abandon(); continue; }
    if (run.parts.length === run.n) {
      const b64 = run.parts.join('');
      let decoded = null;
      if (crypto.createHash('sha256').update(b64).digest('hex').slice(0, 8) === run.sha) {
        try { decoded = Buffer.from(b64, 'base64').toString('utf8'); } catch { decoded = null; }
      }
      found = decoded !== null && parseTimingReport(decoded).ok ? decoded : null;
      run = null;
    }
  }
  abandon();
  return found;
}
