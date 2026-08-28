/**
 * @fileoverview Tier 1/2 unit test for scripts/lib/audit/run-finalization.mjs
 * (docs/plans/legacy-production-audit-decomposition.md — the coordinator).
 *
 * Genuinely different in kind from tests/finalization-characterization.test.mjs
 * (which drives the coordinator indirectly, through the full wave pipeline
 * via `runLegacyProductionAudit` and stubbed GPT calls): this file calls
 * `finalizeRun(data, writeOutcomes)` DIRECTLY with a hand-constructed,
 * minimal-but-complete `FinalizationData` object, bypassing wave
 * orchestration entirely — since `assembleFindings`/`runTelemetry`/
 * `runPersistence` are all pure functions of their `data`/`assembled`
 * params (no closures over the orchestrator), this is a real, valid call,
 * not a mock. It exercises the coordinator's OWN composition logic
 * (mergedResult shape, `_cloudPersistence`, `generatorOutcomes`,
 * `runStatus`) in isolation from the 6-wave pipeline.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

process.env.LEARNING_DISABLE = '1';
process.env.AUDIT_DB_URL = '';

const { finalizeRun } = await import('../scripts/lib/audit/run-finalization.mjs');

const EMPTY_STRUCTURE = { pass_name: 'structure', files_planned: 1, files_found: 1, files_missing: 0, missing_files: [], export_mismatches: [], findings: [], summary: 'ok' };
const EMPTY_WIRING = { pass_name: 'wiring', wiring_issues: [], findings: [], summary: 'ok' };
const EMPTY_PASS = (name) => ({ pass_name: name, findings: [], summary: 'skipped' });

function minimalFinalizationData(overrides = {}) {
  return {
    ctx: {}, round: 1, planFile: null, planContent: null, strictLint: false,
    changedFiles: null, impactSet: null, totalLatency: 100,
    diffLinesChanged: null, diffFilesChanged: null, sessionCacheHit: null,
    mapReducePasses: [],
    ledgerFile: null, noLedger: true, ledger: null, ledgerStats: null,
    ledgerInvalidEntryCount: 0, suppressionUnavailable: false,
    fpTracker: null, cloudFpPolicy: null,
    cloudRunId: null, cloudRepoId: null, noCloudRecording: true,
    learningWritesAllowed: false, bandit: null,
    debtLedger: { entries: [] }, debtContext: { source: 'local', canWrite: false },
    debtEventsPath: null, newlyEscalated: [], debtRunId: 'test-run-1',
    toolFindings: [], toolCapability: { enabled: false },
    allPaths: new Set(['a.mjs']), found: ['a.mjs'], missing: [],
    subjectFiles: new Set(['a.mjs']),
    runStructure: true, structureResult: { result: EMPTY_STRUCTURE, usage: {}, latencyMs: 10 },
    runWiring: true, wiringResult: { result: EMPTY_WIRING, usage: {}, latencyMs: 10 },
    backendPassNames: [], backendResults: [],
    frontendWillRun: false, frontendResult: { result: { ...EMPTY_PASS('frontend'), quick_fix_warnings: [] }, usage: {}, latencyMs: 0 },
    runSustainability: false, sustainResult: { result: { ...EMPTY_PASS('sustainability'), dead_code: [], quick_fix_warnings: [] }, usage: {}, latencyMs: 0 },
    runQuickfix: false, quickfixResult: { result: EMPTY_PASS('quickfix'), usage: {}, latencyMs: 0 },
    runDuplication: false, duplicationResult: { result: EMPTY_PASS('duplication'), usage: {}, latencyMs: 0 },
    runAdjacency: false, adjacencyResult: { result: EMPTY_PASS('adjacency'), usage: {}, latencyMs: 0 },
    archState: 'SKIPPED_NO_INTENT', archResult: { result: {}, usage: {}, latencyMs: 0 },
    orphanState: 'SKIPPED_NO_GRAPH', orphanResult: { result: {}, usage: {}, latencyMs: 0 },
    eventWiringState: 'ANALYZED_CLEAN', eventWiringResult: { result: {}, usage: {}, latencyMs: 0 },
    isR2Plus: false,
    ...overrides,
  };
}

function emptyWriteOutcomes() {
  return { written: 0, spilled: 0, lost: 0, skipped: 0, byWriter: {} };
}

describe('finalizeRun — coordinator composition, called directly (no wave orchestration)', () => {
  it('composes a clean mergedResult from an all-empty pass set', async () => {
    const writeOutcomes = emptyWriteOutcomes();
    const { mergedResult } = await finalizeRun(minimalFinalizationData(), writeOutcomes);
    assert.equal(mergedResult.verdict, 'PASS');
    assert.equal(mergedResult.findings.length, 0);
    assert.equal(mergedResult.files_planned, 1);
    assert.equal(mergedResult.files_found, 1);
    assert.deepEqual(mergedResult.generatorOutcomes, [], 'no discovery-portfolio generators ran on this branch');
    assert.equal(mergedResult.runStatus, 'complete', 'nothing was lost or spilled with cloud off');
    assert.equal(mergedResult._cloudPersistence, 'local-only', 'cloudRunId was null throughout');
    assert.equal(mergedResult._toolCapability.enabled, false);
    assert.equal(mergedResult._cloudRunId, undefined, 'must not be set when cloudRunId is null');
  });

  it('writeOutcomes is the SAME object passed in, mutated in place — never replaced', async () => {
    const writeOutcomes = emptyWriteOutcomes();
    const { mergedResult } = await finalizeRun(minimalFinalizationData(), writeOutcomes);
    assert.equal(mergedResult.writeOutcomes, writeOutcomes, 'the coordinator must thread the SAME tally object through, not construct a fresh one');
  });

  it('a finding from a pass reaches the composed verdict and findings array', async () => {
    const finding = {
      id: 'H1', severity: 'HIGH', category: 'Test', section: 'a.mjs:1',
      detail: 'coordinator test finding', risk: 'r', recommendation: 'rec',
      is_quick_fix: false, is_mechanical: false, principle: 'Test',
      classification: { sonarType: 'BUG', effort: 'MEDIUM', sourceKind: 'MODEL', sourceName: 'test' },
    };
    const data = minimalFinalizationData({
      backendPassNames: ['backend'],
      backendResults: [{ result: { pass_name: 'backend', findings: [finding], quick_fix_warnings: [] }, usage: {}, latencyMs: 0 }],
    });
    const { mergedResult } = await finalizeRun(data, emptyWriteOutcomes());
    assert.equal(mergedResult.verdict, 'SIGNIFICANT_ISSUES');
    assert.equal(mergedResult.findings.length, 1);
    assert.equal(mergedResult.findings[0].detail, 'coordinator test finding');
  });

  it('rejects a FinalizationData object missing a required field (contract enforcement)', async () => {
    const data = minimalFinalizationData();
    delete data.round;
    await assert.rejects(() => finalizeRun(data, emptyWriteOutcomes()), /FinalizationData failed validation/);
  });
});
