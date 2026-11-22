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

import { CI_TIMING_MARKER, extractTimingReport, renderCiTimingSummary } from '../scripts/lib/ci-timing-summary.mjs';
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
  it('NEGATIVE: text with no report, or a truncated marker line, yields null (never a guessed report)', () => {
    assert.equal(extractTimingReport('nothing here'), null);
    assert.equal(extractTimingReport(`${CI_TIMING_MARKER} {"version":"test-timing/v1","files":[`), null);
    assert.equal(extractTimingReport(`${CI_TIMING_MARKER} {"foreign":true}`), null);
  });
  it('a truncated, foreign or PARTIAL marker before the real one does not shadow it', () => {
    const text = `${CI_TIMING_MARKER} {"trunc\n${CI_TIMING_MARKER} {"version":"test-timing/v1","files":"nope"}\n${CI_TIMING_MARKER} ${report()}`;
    assert.equal(extractTimingReport(text), report());
  });
  it('when several usable markers exist the LAST wins (the summary step runs after the tests, which cannot displace it)', () => {
    const forged = report({ files: [{ file: 'tests/forged.test.mjs', ms: 1, tests: 1 }], totalMs: 1 });
    const text = `${CI_TIMING_MARKER} ${forged}\nnpm test output...\n${CI_TIMING_MARKER} ${report()}`;
    assert.equal(extractTimingReport(text), report());
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
