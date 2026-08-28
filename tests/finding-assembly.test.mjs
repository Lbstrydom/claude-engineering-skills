/**
 * @fileoverview Tier 1/2 unit tests for scripts/lib/audit/finding-assembly.mjs
 * (docs/plans/legacy-production-audit-decomposition.md Phase 4b).
 *
 * Direct coverage of this module's own exports, complementing (not
 * replacing) tests/finalization-characterization.test.mjs's end-to-end
 * golden-master harness — that file proves the whole finalization tail
 * behaves correctly through the real `runLegacyProductionAudit` entry point;
 * this file proves this ONE stage's own exported contract directly, without
 * going through wave orchestration.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

const { dedupReplacementId, assembleFindings } = await import('../scripts/lib/audit/finding-assembly.mjs');

describe('dedupReplacementId — a dedup replacement\'s id must match its severity', () => {
  it('keeps the existing id when severity is unchanged', () => {
    const counter = { HIGH: 3, MEDIUM: 2, LOW: 1 };
    const id = dedupReplacementId('M2', 'MEDIUM', 'MEDIUM', counter);
    assert.equal(id, 'M2');
    assert.deepEqual(counter, { HIGH: 3, MEDIUM: 2, LOW: 1 }, 'counter must not be mutated when severity is unchanged');
  });

  it('mints a fresh id from the new severity\'s own counter when severity changes', () => {
    const counter = { HIGH: 0, MEDIUM: 2, LOW: 5 };
    const id = dedupReplacementId('L5', 'LOW', 'HIGH', counter);
    assert.equal(id, 'H1');
    assert.equal(counter.HIGH, 1, 'the new severity\'s counter must be incremented');
  });

  it('produces the correct letter prefix for every severity transition', () => {
    const counter = { HIGH: 0, MEDIUM: 0, LOW: 0 };
    for (const [from, to, expectedLetter] of [['LOW', 'HIGH', 'H'], ['HIGH', 'MEDIUM', 'M'], ['MEDIUM', 'LOW', 'L']]) {
      const id = dedupReplacementId('X0', from, to, counter);
      assert.equal(id[0], expectedLetter, `${from}->${to} must produce a ${expectedLetter}-prefixed id, got ${id}`);
    }
  });
});

describe('assembleFindings — pure computation over a minimal FinalizationData', () => {
  const EMPTY_STRUCTURE = { pass_name: 'structure', files_planned: 0, files_found: 0, files_missing: 0, missing_files: [], export_mismatches: [], findings: [], summary: 'ok' };
  const EMPTY_WIRING = { pass_name: 'wiring', wiring_issues: [], findings: [], summary: 'ok' };

  function minimalData(overrides = {}) {
    return {
      ctx: {}, round: 1, planFile: null, planContent: null, strictLint: false,
      changedFiles: null, impactSet: null, totalLatency: 0,
      ledgerFile: null, noLedger: true, ledger: null, round0: undefined,
      cloudRepoId: null, cloudFpPolicy: null, fpTracker: null,
      debtLedger: { entries: [] }, debtContext: { source: 'local', canWrite: false },
      debtEventsPath: null, newlyEscalated: [], debtRunId: 'test-1',
      toolFindings: [],
      runStructure: true, structureResult: { result: EMPTY_STRUCTURE, usage: {}, latencyMs: 0 },
      runWiring: true, wiringResult: { result: EMPTY_WIRING, usage: {}, latencyMs: 0 },
      backendPassNames: [], backendResults: [],
      frontendWillRun: false, frontendResult: { result: { pass_name: 'frontend', findings: [], quick_fix_warnings: [], summary: 'ok' }, usage: {}, latencyMs: 0 },
      runSustainability: false, sustainResult: { result: { pass_name: 'sustainability', findings: [], dead_code: [], quick_fix_warnings: [], summary: 'skipped' }, usage: {}, latencyMs: 0 },
      runQuickfix: false, quickfixResult: { result: { pass_name: 'quickfix', findings: [], summary: 'skipped' }, usage: {}, latencyMs: 0 },
      runDuplication: false, duplicationResult: { result: { pass_name: 'duplication', findings: [], summary: 'skipped' }, usage: {}, latencyMs: 0 },
      runAdjacency: false, adjacencyResult: { result: { pass_name: 'adjacency', findings: [], summary: 'skipped' }, usage: {}, latencyMs: 0 },
      archState: 'SKIPPED_NO_INTENT', archResult: { result: {}, usage: {}, latencyMs: 0 },
      orphanState: 'SKIPPED_NO_GRAPH', orphanResult: { result: {}, usage: {}, latencyMs: 0 },
      eventWiringState: 'ANALYZED_CLEAN', eventWiringResult: { result: {}, usage: {}, latencyMs: 0 },
      strictLint: false,
      ...overrides,
    };
  }

  it('an all-empty pass set produces a PASS verdict with zero findings', async () => {
    const result = await assembleFindings(minimalData());
    assert.equal(result.verdict, 'PASS');
    assert.equal(result.allFindings.length, 0);
    assert.equal(result.high, 0);
    assert.equal(result.medium, 0);
    assert.equal(result.low, 0);
    assert.equal(typeof result.fpPassSuppressedCount, 'number', 'fpPassSuppressedCount must always be a number, even with nothing to suppress');
  });

  it('a HIGH finding from a pass propagates into allFindings and the verdict', async () => {
    const finding = {
      id: 'H1', severity: 'HIGH', category: 'Test', section: 'a.mjs:1',
      detail: 'test finding', risk: 'test risk', recommendation: 'test rec',
      is_quick_fix: false, is_mechanical: false, principle: 'Test',
      classification: { sonarType: 'BUG', effort: 'MEDIUM', sourceKind: 'MODEL', sourceName: 'test' },
    };
    const data = minimalData({
      backendPassNames: ['backend'],
      backendResults: [{ result: { pass_name: 'backend', findings: [finding], quick_fix_warnings: [] }, usage: {}, latencyMs: 0 }],
    });
    const result = await assembleFindings(data);
    assert.equal(result.verdict, 'SIGNIFICANT_ISSUES');
    assert.equal(result.high, 1);
    assert.equal(result.allFindings.length, 1);
    assert.equal(result.allFindings[0].detail, 'test finding');
  });

  it('totalUsage/cacheMetrics/passTimings/summaryLines are always present on the return value', async () => {
    const result = await assembleFindings(minimalData());
    assert.equal(typeof result.totalUsage, 'object');
    assert.ok(result.cacheMetrics === null || typeof result.cacheMetrics === 'object');
    assert.equal(typeof result.passTimings, 'object');
    assert.ok(Array.isArray(result.summaryLines));
  });
});
