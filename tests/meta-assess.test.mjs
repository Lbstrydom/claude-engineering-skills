import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { computeAssessmentMetrics, shouldRunAssessment, storeAssessment, formatAssessmentReport } from '../scripts/meta-assess.mjs';
import { FalsePositiveTracker } from '../scripts/lib/findings.mjs';
import { PromptBandit } from '../scripts/bandit.mjs';

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
    pipelineVariant: 'A',
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

describe('computeAssessmentMetrics', () => {
  it('returns empty metrics for zero outcomes', () => {
    const fpTracker = new FalsePositiveTracker(path.join(os.tmpdir(), `fp-test-${Date.now()}.json`));
    const bandit = new PromptBandit(path.join(os.tmpdir(), `bandit-test-${Date.now()}.json`));
    const result = computeAssessmentMetrics([], fpTracker, bandit);
    assert.equal(result.window.outcomeCount, 0);
    assert.equal(result.metrics.fpRate.overall, 0);
  });

  it('computes correct FP rate', () => {
    const outcomes = [
      ...makeOutcomes(3, { accepted: true }),
      ...makeOutcomes(7, { accepted: false }),
    ];
    const fpTracker = new FalsePositiveTracker(path.join(os.tmpdir(), `fp-test-${Date.now()}.json`));
    const bandit = new PromptBandit(path.join(os.tmpdir(), `bandit-test-${Date.now()}.json`));
    const result = computeAssessmentMetrics(outcomes, fpTracker, bandit);
    assert.equal(result.metrics.fpRate.overall, 0.7);
  });

  it('computes FP rate by pass', () => {
    const outcomes = [
      ...makeOutcomes(4, { pass: 'backend', accepted: true }),
      ...makeOutcomes(6, { pass: 'backend', accepted: false }),
      ...makeOutcomes(5, { pass: 'sustainability', accepted: false }),
    ];
    const fpTracker = new FalsePositiveTracker(path.join(os.tmpdir(), `fp-test-${Date.now()}.json`));
    const bandit = new PromptBandit(path.join(os.tmpdir(), `bandit-test-${Date.now()}.json`));
    const result = computeAssessmentMetrics(outcomes, fpTracker, bandit);
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
    const fpTracker = new FalsePositiveTracker(path.join(os.tmpdir(), `fp-test-${Date.now()}.json`));
    const bandit = new PromptBandit(path.join(os.tmpdir(), `bandit-test-${Date.now()}.json`));
    const result = computeAssessmentMetrics(outcomes, fpTracker, bandit);
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
    const fpTracker = new FalsePositiveTracker(path.join(os.tmpdir(), `fp-test-${Date.now()}.json`));
    const bandit = new PromptBandit(path.join(os.tmpdir(), `bandit-test-${Date.now()}.json`));
    const result = computeAssessmentMetrics(outcomes, fpTracker, bandit);
    assert.equal(result.metrics.severityCalibration.miscalibrated, false);
  });

  it('returns insufficient_data for pipeline comparison with small N', () => {
    const outcomes = makeOutcomes(3, { pipelineVariant: 'A' });
    const fpTracker = new FalsePositiveTracker(path.join(os.tmpdir(), `fp-test-${Date.now()}.json`));
    const bandit = new PromptBandit(path.join(os.tmpdir(), `bandit-test-${Date.now()}.json`));
    const result = computeAssessmentMetrics(outcomes, fpTracker, bandit);
    assert.equal(result.metrics.pipelineComparison.betterVariant, 'insufficient_data');
  });

  it('compares pipeline variants when enough data', () => {
    const outcomes = [
      ...makeOutcomes(6, { pipelineVariant: 'A', accepted: true }),
      ...makeOutcomes(6, { pipelineVariant: 'B', accepted: false }),
    ];
    const fpTracker = new FalsePositiveTracker(path.join(os.tmpdir(), `fp-test-${Date.now()}.json`));
    const bandit = new PromptBandit(path.join(os.tmpdir(), `bandit-test-${Date.now()}.json`));
    const result = computeAssessmentMetrics(outcomes, fpTracker, bandit);
    assert.equal(result.metrics.pipelineComparison.betterVariant, 'A');
  });

  it('detects improving FP trend', () => {
    // First half: 80% FP, second half: 20% FP
    const outcomes = [
      ...makeOutcomes(4, { accepted: false, timestamp: Date.now() - 200000 }),
      ...makeOutcomes(1, { accepted: true, timestamp: Date.now() - 190000 }),
      ...makeOutcomes(1, { accepted: false, timestamp: Date.now() - 100000 }),
      ...makeOutcomes(4, { accepted: true, timestamp: Date.now() - 90000 }),
    ];
    const fpTracker = new FalsePositiveTracker(path.join(os.tmpdir(), `fp-test-${Date.now()}.json`));
    const bandit = new PromptBandit(path.join(os.tmpdir(), `bandit-test-${Date.now()}.json`));
    const result = computeAssessmentMetrics(outcomes, fpTracker, bandit);
    assert.equal(result.metrics.fpRate.trend, 'improving');
  });

  it('respects window size', () => {
    const outcomes = makeOutcomes(100);
    const fpTracker = new FalsePositiveTracker(path.join(os.tmpdir(), `fp-test-${Date.now()}.json`));
    const bandit = new PromptBandit(path.join(os.tmpdir(), `bandit-test-${Date.now()}.json`));
    const result = computeAssessmentMetrics(outcomes, fpTracker, bandit, { windowSize: 10 });
    assert.equal(result.window.outcomeCount, 10);
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
      metrics: {
        fpRate: { overall: 0.35, byPass: { backend: 0.2, sustainability: 0.6 }, trend: 'improving' },
        signalQuality: { findingsLeadingToChanges: 16, totalFindings: 25, changeRate: 0.64 },
        severityCalibration: { highAcceptanceRate: 0.8, mediumAcceptanceRate: 0.6, lowAcceptanceRate: 0.3, miscalibrated: false },
        convergenceSpeed: { avgRoundsToConverge: 2.1, medianRoundsToConverge: 2, trend: 'stable' },
        pipelineComparison: {
          variantA: { runs: 12, fpRate: 0.3, avgFindings: 12 },
          variantB: { runs: 13, fpRate: 0.4, avgFindings: 13 },
          betterVariant: 'A',
        },
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
});
