import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { median, mean, summarize } from '../scripts/tiered-shadow-report.mjs';

describe('median/mean', () => {
  test('median of odd/even-length arrays', () => {
    assert.equal(median([1, 2, 3]), 2);
    assert.equal(median([1, 2, 3, 4]), 2.5);
  });
  test('empty array returns null, never NaN/0', () => {
    assert.equal(median([]), null);
    assert.equal(mean([]), null);
  });
});

describe('summarize', () => {
  const okRecord = (overrides = {}) => ({
    legacyOk: true, shadowOk: true,
    comparison: {
      legacyCostUsd: 2, tieredCostUsd: 0.5, legacyLatencySec: 20, tieredLatencySec: 8,
      overlapCount: 3, legacyFindingCount: 4, onlyTieredCount: 1, tieredRunStatus: 'complete',
      ...overrides,
    },
  });

  test('counts legacy/shadow failures separately', () => {
    const s = summarize([
      { legacyOk: false, shadowOk: true, comparison: null },
      { legacyOk: true, shadowOk: false, comparison: null },
      okRecord(),
    ]);
    assert.equal(s.totalRuns, 3);
    assert.equal(s.legacyFailures, 1);
    assert.equal(s.shadowFailures, 1);
    assert.equal(s.comparedRuns, 1);
  });

  test('cost/latency deltas are tiered-minus-legacy (negative = tiered cheaper/faster)', () => {
    const s = summarize([okRecord()]);
    assert.equal(s.costDeltaUsd.mean, -1.5);
    assert.equal(s.latencyDeltaSec.mean, -12);
  });

  test('finding overlap rate excludes comparisons with zero total findings, never divides by zero', () => {
    const zeroFindings = okRecord({ legacyFindingCount: 0, onlyTieredCount: 0, overlapCount: 0 });
    const s = summarize([zeroFindings]);
    assert.equal(s.findingOverlapRate.mean, null);
  });

  test('tieredRunStatus breakdown counts each status', () => {
    const s = summarize([okRecord(), okRecord({ tieredRunStatus: 'fallback_legacy' })]);
    assert.deepEqual(s.tieredRunStatusCounts, { complete: 1, fallback_legacy: 1 });
  });
});

describe('module import safety (2026-07-13 bug: main() fired unconditionally at import time)', () => {
  test('importing this module for its exports (median/mean/summarize) does NOT invoke main() / attempt any I/O', () => {
    // This test file ITSELF is the regression check: the top-of-file static
    // import above ran `main()` unconditionally before this fix (using the
    // TEST RUNNER's own process.argv, not any CLI args) — harmless while
    // main() was pure-local, a real Supabase query once it started reading
    // the cloud store. If the entry guard ever regresses, this whole test
    // file fails immediately on load (a connection error thrown at import
    // time), not quietly inside one test body.
    assert.ok(true, 'reaching this line at all proves the import above did not throw/hang');
  });

  test('subprocess: importing via dynamic import(), with cloud "enabled" and a report-shaped argv, never invokes main()', () => {
    // Stronger than the in-process check above: proves the guard holds even
    // when (a) AUDIT_DB_URL points at a host that would surface a real
    // connection attempt (DNS failure, not just refused-fast), and (b) the
    // importing process's own argv[1] is this test harness's — NOT the
    // report module's path — matching the exact incident shape (a test
    // file importing the module for its exports using the runner's argv).
    // A regressed unconditional main() would either hang past the timeout
    // (a real DNS lookup) or print CLI/report output — this asserts neither.
    const moduleUrl = pathToFileURL(path.resolve('scripts/tiered-shadow-report.mjs')).href;
    const out = execFileSync('node', ['--input-type=module', '-e', [
      "process.env.AUDIT_DB_URL = 'postgresql://invalid:invalid@this-host-does-not-exist.invalid:5432/x';",
      `await import('${moduleUrl}');`,
      "console.log('IMPORT_SENTINEL_OK');",
    ].join('\n')], { encoding: 'utf8', timeout: 5000 });

    assert.equal(out.trim(), 'IMPORT_SENTINEL_OK', 'import must resolve cleanly with no other stdout output (no CLI/report banner)');
  });
});

describe('CLI', () => {
  test('--selfcheck-relocation exits 0 and prints OK', () => {
    const out = execFileSync('node', ['scripts/tiered-shadow-report.mjs', '--selfcheck-relocation'], { encoding: 'utf8' });
    assert.match(out, /OK/);
  });

  test('a missing log file reports zero runs, never crashes', () => {
    const out = execFileSync('node', ['scripts/tiered-shadow-report.mjs', '--log', '/definitely/does/not/exist.jsonl', '--json'], { encoding: 'utf8' });
    const parsed = JSON.parse(out.trim().split('\n').pop());
    assert.equal(parsed.totalRuns, 0);
  });
});
