/**
 * The CI timing carrier: `full-suite.yml` prints the per-file timing report into the job summary and the log (no artifact),
 * and `test-tier.mjs refresh-heavy --timing` reads it back from a raw report, a saved summary or a `gh run view --log`
 * dump. A partial or unusable report is refused on both sides.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { CI_TIMING_MARKER, encodeTimingChunks, extractTimingReport, renderCiTimingSummary } from '../scripts/lib/ci-timing-summary.mjs';
import { parseTimingReport } from '../scripts/lib/test-timing-report.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TIER = path.join(ROOT, 'scripts', 'test-tier.mjs');
const WORKFLOW = fs.readFileSync(path.join(ROOT, '.github', 'workflows', 'full-suite.yml'), 'utf8');

const report = (over = {}) => JSON.stringify({
  version: 'test-timing/v1', complete: true, totalMs: 100000, ignored: 0,
  files: [
    { file: 'tests/fleet-a.test.mjs', ms: 61000, tests: 12 },
    { file: 'tests/tiny.test.mjs', ms: 500, tests: 3 },
    { file: 'tests/unlisted-heavy.test.mjs', ms: 90000, tests: 4 },
  ],
  ...over,
});

describe('renderCiTimingSummary / extractTimingReport', () => {
  it('ROUND TRIP: what is rendered can be read back byte-for-byte, from the summary and from a prefixed log', () => {
    const r = renderCiTimingSummary(report());
    assert.equal(r.ok, true);
    assert.match(r.text, /\| `tests\/unlisted-heavy\.test\.mjs` \| 90\.0 \| 4 \|/, 'the slowest file leads the table');
    assert.deepEqual(parseTimingReport(extractTimingReport(r.text)).report, JSON.parse(report()));
    const log = r.text.split('\n').map((l) => `full-suite\tTest timing report\t2026-11-22T12:00:00.0000000Z ${l}`).join('\n');
    assert.deepEqual(parseTimingReport(extractTimingReport(log)).report, JSON.parse(report()));
  });
  it('the raw report is accepted as is', () => {
    assert.equal(extractTimingReport(report()), report());
  });
  it('a partial report is REFUSED on the render side (never carried as if it were a measurement)', () => {
    const r = renderCiTimingSummary(report({ complete: false }));
    assert.equal(r.ok, false);
    assert.match(r.reason, /partial/);
  });
  it('unusable input is refused: null, garbage, wrong version', () => {
    for (const bad of [null, 'not json', JSON.stringify({ version: 'other' })]) assert.equal(renderCiTimingSummary(bad).ok, false, String(bad));
  });
  // A report big enough to need several chunks, shaped like the real one (1,287 files in the failing CI run).
  const big = (n = 1300, tag = 'a') => JSON.stringify({
    version: 'test-timing/v1', complete: true, totalMs: n * 1000, ignored: 0,
    files: Array.from({ length: n }, (_, i) => ({ file: `tests/${tag}-${String(i).padStart(4, '0')}.test.mjs`, ms: 1000 + i, tests: 3 })),
  });
  const markerLines = (text) => text.split('\n').filter((l) => l.startsWith(`${CI_TIMING_MARKER}#`));

  it('REGRESSION (run 45024725865): a full-size report never makes a line the log pipeline dropped, and still round-trips', () => {
    const r = renderCiTimingSummary(big());
    assert.equal(r.ok, true);
    const lines = markerLines(r.text);
    assert.ok(lines.length > 10, `${lines.length} chunk lines: a 1,300-file report must be chunked`);
    assert.ok(Math.max(...r.text.split('\n').map((l) => l.length)) < 4000, 'no output line may approach the length that was dropped (about 100 KB)');
    assert.equal(extractTimingReport(r.text), JSON.stringify(JSON.parse(big())));
  });
  it('a log whose CI decorator prefixes every line reassembles the same report', () => {
    const log = renderCiTimingSummary(big()).text.split('\n').map((l) => `full-suite\tTest timing report (job summary)\t2026-11-22T13:13:14.29Z ${l}`).join('\n');
    assert.equal(extractTimingReport(log), JSON.stringify(JSON.parse(big())));
  });
  it('NEGATIVE: no report, a TORN run (a missing chunk, a lost tail) or a foreign marker yields null, never a guessed report', () => {
    assert.equal(extractTimingReport('nothing here'), null);
    const lines = markerLines(renderCiTimingSummary(big()).text);
    assert.equal(extractTimingReport(lines.filter((_, i) => i !== 3).join('\n')), null, 'a missing middle chunk');
    assert.equal(extractTimingReport(lines.slice(0, -1).join('\n')), null, 'a lost tail (the observed failure shape)');
    assert.equal(extractTimingReport(encodeTimingChunks('{"foreign":true}').join('\n')), null);
    assert.equal(extractTimingReport(encodeTimingChunks('{"version":"test-timing/v1","files":"nope"}').join('\n')), null);
  });
  it('a whole run followed by a NEWER torn one returns null, not the stale earlier measurement', () => {
    const whole = markerLines(renderCiTimingSummary(big(1300, 'a')).text);
    const torn = markerLines(renderCiTimingSummary(big(1300, 'b')).text).slice(0, 5);
    assert.equal(extractTimingReport(`${whole.join('\n')}
${torn.join('\n')}`), null);
  });
  it('INTEGRITY: a line cut short at a chunk boundary is refused even when the rest decodes (the checksum is over the whole text)', () => {
    const lines = markerLines(renderCiTimingSummary(big()).text);
    lines[2] = lines[2].slice(0, -4);
    assert.equal(extractTimingReport(lines.join('\n')), null);
    const swapped = markerLines(renderCiTimingSummary(big()).text);
    [swapped[1], swapped[2]] = [swapped[2], swapped[1]];
    assert.equal(extractTimingReport(swapped.join('\n')), null, 'reordered chunks');
  });
  it('a torn run before the real one does not shadow it', () => {
    const lines = markerLines(renderCiTimingSummary(big()).text);
    const text = `${lines.slice(0, 4).join('\n')}\nunrelated output\n${markerLines(renderCiTimingSummary(big(1300, 'b')).text).join('\n')}`;
    assert.equal(extractTimingReport(text), JSON.stringify(JSON.parse(big(1300, 'b'))));
  });
  it('when several whole reports exist the LAST wins (the summary step runs after the tests, which cannot displace it)', () => {
    const forged = markerLines(renderCiTimingSummary(big(5, 'forged')).text).join('\n');
    const real = markerLines(renderCiTimingSummary(big(1300, 'real')).text).join('\n');
    assert.equal(extractTimingReport(`${forged}\nnpm test output...\n${real}`), JSON.stringify(JSON.parse(big(1300, 'real'))));
  });
});

describe('test-tier CLI', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ci-timing-'));
  const save = (name, text) => { const f = path.join(dir, name); fs.writeFileSync(f, text); return f; };
  const run = (...args) => spawnSync(process.execPath, [TIER, ...args], { cwd: ROOT, encoding: 'utf8' });

  it('timing-summary prints the table and the marker for a complete report', () => {
    const r = run('timing-summary', '--timing', save('raw.json', report()));
    assert.equal(r.status, 0, r.stderr);
    assert.ok(r.stdout.includes(CI_TIMING_MARKER));
  });
  it('timing-summary exits 3 and prints NOTHING for a missing, partial or garbage report', () => {
    for (const f of [path.join(dir, 'absent.json'), save('partial.json', report({ complete: false })), save('garbage.json', 'x')]) {
      const r = run('timing-summary', '--timing', f);
      assert.equal(r.status, 3, r.stderr);
      assert.equal(r.stdout, '');
    }
  });
  it('refresh-heavy reads a saved CI LOG, not only the raw file (the whole point)', () => {
    const log = renderCiTimingSummary(report()).text.split('\n').map((l) => `full-suite\tstep\t2026-11-22T12:00:00Z ${l}`).join('\n');
    const r = run('refresh-heavy', '--timing', save('ci.log', log));
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /report only; nothing is written/);
    assert.match(r.stdout, /tests\/unlisted-heavy\.test\.mjs: 90s, over the .* threshold and not listed/);
  });
  it('refresh-heavy still reads the raw file, and says plainly when a file holds no report', () => {
    assert.equal(run('refresh-heavy', '--timing', save('raw2.json', report())).status, 0);
    const none = run('refresh-heavy', '--timing', save('empty.log', 'just a log with no marker'));
    assert.notEqual(none.status, 0);
    assert.match(none.stderr, /no test-timing\/v1 report found/);
  });
  it('cleanup', () => { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }); });
});

describe('full-suite.yml carries the report (no artifact, cache or second job: tests/workflow-runner-labels.test.mjs owns that and stays green)', () => {
  it('the npm test step keeps the timing file on the runner, and the summary step runs always and cannot fail the job', () => {
    assert.match(WORKFLOW, /name: npm test\s+env:\s+TEST_TIMING_KEEP: \$\{\{ runner\.temp \}\}\/test-timing\.json\s+run: npm test/);
    const step = WORKFLOW.slice(WORKFLOW.indexOf('- name: Test timing report (job summary)'));
    assert.match(step, /if: always\(\)/);
    assert.match(step, /continue-on-error: true/, 'the step cannot turn the job red');
    assert.match(step, /\$GITHUB_STEP_SUMMARY" \|\| true/, 'even the summary append is tolerated');
    assert.match(step, /timing-summary --timing/);
    assert.match(step, /GITHUB_STEP_SUMMARY/);
    assert.match(step, /else\s+echo "::notice title=audit-loop-no-measurement::/, 'a missing report is a notice, never a red job');
  });
});
