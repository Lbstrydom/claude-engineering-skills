import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
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
