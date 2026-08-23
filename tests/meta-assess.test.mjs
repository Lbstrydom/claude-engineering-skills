import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { computeAssessmentMetrics, shouldRunAssessment, storeAssessment, formatAssessmentReport } from '../scripts/meta-assess.mjs';

// ── Fixtures ────────────────────────────────────────────────────────────────

function makeOutcome(overrides = {}) {
  return {
    findingId: 'H1',
    severity: 'HIGH',
    category: 'Test Category',
    section: 'test.js',
    pass: 'backend',
    accepted: true,
    round: 1,
    timestamp: Date.now() - 3600000,
    ...overrides,
  };
}

function makeOutcomes(n, overrides = {}) {
  return Array.from({ length: n }, (_, i) => makeOutcome({
    findingId: `F${i}`,
    timestamp: Date.now() - (n - i) * 60000,
    ...overrides,
  }));
}

// ── computeAssessmentMetrics ────────────────────────────────────────────────
// Signature changed 2026-08-23 (docs/plans/meta-assess-store-backed-source.md
// D6): the `fpTracker`/`bandit` positional params were dead — the only line
// in the function's whole body mentioning either was the signature itself.
// Every call site below drops them; `fpTracker.getReport()`'s real,
// unrelated use for the LLM phase lives entirely in main(), untouched.

describe('computeAssessmentMetrics', () => {
  it('returns empty metrics for zero outcomes', () => {
    const result = computeAssessmentMetrics([]);
    assert.equal(result.window.outcomeCount, 0);
    // D4 — an empty window's rate is `null` (unmeasured), never a fabricated
    // `0` indistinguishable from a genuinely perfect run.
    assert.equal(result.metrics.fpRate.overall, null);
    assert.equal(result.metrics.fpRate.measured, false);
  });

  it('computes correct FP rate', () => {
    const outcomes = [
      ...makeOutcomes(3, { accepted: true }),
      ...makeOutcomes(7, { accepted: false }),
    ];
    const result = computeAssessmentMetrics(outcomes);
    assert.equal(result.metrics.fpRate.overall, 0.7);
    assert.equal(result.metrics.fpRate.measured, true);
  });

  it('computes FP rate by pass', () => {
    const outcomes = [
      ...makeOutcomes(4, { pass: 'backend', accepted: true }),
      ...makeOutcomes(6, { pass: 'backend', accepted: false }),
      ...makeOutcomes(5, { pass: 'sustainability', accepted: false }),
    ];
    const result = computeAssessmentMetrics(outcomes);
    assert.equal(result.metrics.fpRate.byPass.backend, 0.6);
    assert.equal(result.metrics.fpRate.byPass.sustainability, 1.0);
  });

  it('detects severity miscalibration when HIGH acceptance < MEDIUM', () => {
    const outcomes = [
      ...makeOutcomes(5, { severity: 'HIGH', accepted: false }),
      ...makeOutcomes(2, { severity: 'HIGH', accepted: true }),
      ...makeOutcomes(3, { severity: 'MEDIUM', accepted: true }),
      ...makeOutcomes(1, { severity: 'MEDIUM', accepted: false }),
    ];
    const result = computeAssessmentMetrics(outcomes);
    // HIGH: 2/7 = 0.286, MEDIUM: 3/4 = 0.75
    assert.equal(result.metrics.severityCalibration.miscalibrated, true);
  });

  it('detects correct calibration when HIGH acceptance >= MEDIUM', () => {
    const outcomes = [
      ...makeOutcomes(4, { severity: 'HIGH', accepted: true }),
      ...makeOutcomes(1, { severity: 'HIGH', accepted: false }),
      ...makeOutcomes(2, { severity: 'MEDIUM', accepted: true }),
      ...makeOutcomes(3, { severity: 'MEDIUM', accepted: false }),
    ];
    const result = computeAssessmentMetrics(outcomes);
    assert.equal(result.metrics.severityCalibration.miscalibrated, false);
  });

  it('detects improving FP trend', () => {
    // First half: 80% FP, second half: 20% FP
    const outcomes = [
      ...makeOutcomes(4, { accepted: false, timestamp: Date.now() - 200000 }),
      ...makeOutcomes(1, { accepted: true, timestamp: Date.now() - 190000 }),
      ...makeOutcomes(1, { accepted: false, timestamp: Date.now() - 100000 }),
      ...makeOutcomes(4, { accepted: true, timestamp: Date.now() - 90000 }),
    ];
    const result = computeAssessmentMetrics(outcomes);
    assert.equal(result.metrics.fpRate.trend, 'improving');
  });

  it('respects window size', () => {
    const outcomes = makeOutcomes(100);
    const result = computeAssessmentMetrics(outcomes, { windowSize: 10 });
    assert.equal(result.window.outcomeCount, 10);
  });

  // ── Store-backed additions (docs/plans/meta-assess-store-backed-source.md) ──

  it('a resolver-supplied byPass is mirrored verbatim; the internal loop does not run', () => {
    const outcomes = makeOutcomes(3, { pass: 'backend', accepted: false });
    const byPass = { 'be-services': { raised: 10, accepted: 2, dismissed: 3, decided: 5, coverage: 0.5, dismissRate: 0.6, measured: true } };
    const result = computeAssessmentMetrics(outcomes, { byPass, provenance: 'store' });
    assert.deepEqual(result.metrics.fpRate.byPass, byPass, 'must mirror verbatim, not re-derive from the outcomes');
    assert.equal('backend' in result.metrics.fpRate.byPass, false, 'the internal per-finding loop must not have run');
  });

  it('provenance:store skips the tail-slice entirely (Gemini G1/round 2 regression guard)', () => {
    const outcomes = makeOutcomes(200);
    const result = computeAssessmentMetrics(outcomes, { provenance: 'store' });
    assert.equal(result.window.outcomeCount, 200, 'a store-backed call must not be silently truncated to windowSize');
  });

  it('provenance:local (or omitted) still slices to windowSize — the negative-direction pairing', () => {
    const outcomes = makeOutcomes(200);
    const withLocal = computeAssessmentMetrics(outcomes, { provenance: 'local' });
    assert.equal(withLocal.window.outcomeCount, 50, 'default windowSize');
    const omitted = computeAssessmentMetrics(outcomes);
    assert.equal(omitted.window.outcomeCount, 50, 'omitted provenance must preserve today\'s behaviour exactly');
  });

  it('a severity bucket with zero occurrences reports null, not a fabricated 0% (D4)', () => {
    const outcomes = makeOutcomes(5, { severity: 'HIGH', accepted: true });
    const result = computeAssessmentMetrics(outcomes);
    assert.equal(result.metrics.severityCalibration.mediumAcceptanceRate, null);
    assert.equal(result.metrics.severityCalibration.measured.MEDIUM, false);
    assert.equal(result.metrics.severityCalibration.highAcceptanceRate, 1);
    assert.equal(result.metrics.severityCalibration.measured.HIGH, true);
  });
});

// ── shouldRunAssessment ─────────────────────────────────────────────────────

describe('shouldRunAssessment', () => {
  it('returns false when no state file exists', () => {
    const result = shouldRunAssessment('/tmp/nonexistent-state.json');
    assert.equal(result.shouldRun, false);
  });

  it('returns true when runs exceed interval', () => {
    const tmpFile = path.join(os.tmpdir(), `pipeline-state-${Date.now()}.json`);
    fs.writeFileSync(tmpFile, JSON.stringify({ runCount: 8, lastAssessmentAtRun: 3 }));
    const result = shouldRunAssessment(tmpFile, 4);
    assert.equal(result.shouldRun, true);
    assert.equal(result.runsSinceLastAssessment, 5);
    fs.unlinkSync(tmpFile);
  });

  it('returns false when under interval', () => {
    const tmpFile = path.join(os.tmpdir(), `pipeline-state-${Date.now()}.json`);
    fs.writeFileSync(tmpFile, JSON.stringify({ runCount: 5, lastAssessmentAtRun: 3 }));
    const result = shouldRunAssessment(tmpFile, 4);
    assert.equal(result.shouldRun, false);
    assert.equal(result.runsSinceLastAssessment, 2);
    fs.unlinkSync(tmpFile);
  });

  it('returns true on first assessment (lastAssessmentAtRun=0)', () => {
    const tmpFile = path.join(os.tmpdir(), `pipeline-state-${Date.now()}.json`);
    fs.writeFileSync(tmpFile, JSON.stringify({ runCount: 4 }));
    const result = shouldRunAssessment(tmpFile, 4);
    assert.equal(result.shouldRun, true);
    fs.unlinkSync(tmpFile);
  });
});

// ── storeAssessment ─────────────────────────────────────────────────────────

describe('storeAssessment', () => {
  it('appends record to JSONL file', () => {
    const tmpFile = path.join(os.tmpdir(), `meta-assess-${Date.now()}.jsonl`);
    const result = { overallHealth: 'healthy', metrics: {}, window: { outcomeCount: 10 } };
    storeAssessment(result, tmpFile);
    storeAssessment({ ...result, overallHealth: 'degraded' }, tmpFile);
    const lines = fs.readFileSync(tmpFile, 'utf-8').trim().split('\n');
    assert.equal(lines.length, 2);
    assert.equal(JSON.parse(lines[0]).overallHealth, 'healthy');
    assert.equal(JSON.parse(lines[1]).overallHealth, 'degraded');
    fs.unlinkSync(tmpFile);
  });
});

// ── formatAssessmentReport ──────────────────────────────────────────────────

describe('formatAssessmentReport', () => {
  it('produces markdown with metrics table', () => {
    const result = {
      window: { fromRun: 1, toRun: 5, outcomeCount: 25, dateRange: '2026-04-01 to 2026-04-06' },
      provenance: 'local',
      scope: 'repo',
      metrics: {
        fpRate: { overall: 0.35, byPass: { backend: 0.2, sustainability: 0.6 }, trend: 'improving' },
        signalQuality: { findingsLeadingToChanges: 16, totalFindings: 25, changeRate: 0.64 },
        severityCalibration: { highAcceptanceRate: 0.8, mediumAcceptanceRate: 0.6, lowAcceptanceRate: 0.3, miscalibrated: false },
        convergenceSpeed: { avgRoundsToConverge: 2.1, medianRoundsToConverge: 2, trend: 'stable' },
      },
      overallHealth: 'healthy',
      diagnosis: 'System performing well.',
      recommendations: [
        { type: 'prompt_change', target: 'sustainability', action: 'Reduce severity for file-size findings', rationale: 'High FP rate in sustainability', priority: 'HIGH' },
      ],
    };
    const md = formatAssessmentReport(result);
    assert.ok(md.includes('# Audit-Loop Meta-Assessment'));
    assert.ok(md.includes('35.0%'));
    assert.ok(md.includes('improving'));
    assert.ok(md.includes('sustainability'));
    assert.ok(md.includes('Reduce severity'));
  });

  it('renders a null (unmeasured) rate as "n/a", never as a crash or "NaN%" (D4)', () => {
    const result = {
      window: { fromRun: 0, toRun: 0, outcomeCount: 0, dateRange: 'N/A' },
      provenance: 'none',
      scope: 'unresolved',
      metrics: {
        fpRate: { overall: null, byPass: {}, trend: 'stable', measured: false },
        signalQuality: { findingsLeadingToChanges: 0, totalFindings: 0, changeRate: null, measured: false },
        severityCalibration: { highAcceptanceRate: null, mediumAcceptanceRate: null, lowAcceptanceRate: null, miscalibrated: false, measured: { HIGH: false, MEDIUM: false, LOW: false } },
        convergenceSpeed: { avgRoundsToConverge: null, medianRoundsToConverge: null, trend: 'stable', measured: false },
      },
      overallHealth: 'unmeasured',
      recommendations: [],
    };
    const md = formatAssessmentReport(result);
    assert.ok(md.includes('n/a'));
    assert.ok(!md.includes('NaN'));
  });

  it('renders the D2a nested byPass shape (provenance:store) without a bare number multiply', () => {
    const result = {
      window: { fromRun: 0, toRun: 0, outcomeCount: 10, dateRange: 'N/A' },
      provenance: 'store',
      scope: 'repo',
      coverage: { recordsTotal: 10, recordsExcluded: 0, passStatRowsTotal: 5, passStatRowsExcluded: 0 },
      metrics: {
        fpRate: {
          overall: 0.3, trend: 'stable', measured: true,
          byPass: { structure: { raised: 5, accepted: 3, dismissed: 2, decided: 5, coverage: 1, dismissRate: 0.4, measured: true } },
        },
        signalQuality: { findingsLeadingToChanges: 7, totalFindings: 10, changeRate: 0.7, measured: true },
        severityCalibration: { highAcceptanceRate: 0.5, mediumAcceptanceRate: 0.5, lowAcceptanceRate: 0.5, miscalibrated: false, measured: { HIGH: true, MEDIUM: true, LOW: true } },
        convergenceSpeed: { avgRoundsToConverge: 2, medianRoundsToConverge: 2, trend: 'stable', measured: true },
      },
      overallHealth: 'healthy',
      recommendations: [],
    };
    const md = formatAssessmentReport(result);
    assert.ok(md.includes('structure'));
    assert.ok(md.includes('40.0%'), 'dismissRate 0.4 must render as 40.0%');
    assert.ok(!md.includes('NaN'), 'the nested object must never be treated as a bare number');
  });
});
