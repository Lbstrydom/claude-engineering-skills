/**
 * @fileoverview Tier 1 unit tests for scripts/lib/audit/finalization-contract.mjs
 * (docs/plans/legacy-production-audit-decomposition.md Phase 4a) — pure,
 * deterministic Zod schemas, test-first per this repo's testing doctrine.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

const {
  validateFinalizationData, validateAssembledFindings,
  validatePersistenceServices, validateTelemetryServices,
} = await import('../scripts/lib/audit/finalization-contract.mjs');

function minimalFinalizationData(overrides = {}) {
  return {
    ctx: {},
    round: 1,
    planFile: null,
    planContent: null,
    strictLint: false,
    changedFiles: null,
    impactSet: null,
    totalLatency: 0,
    diffLinesChanged: null,
    diffFilesChanged: null,
    sessionCacheHit: null,
    mapReducePasses: [],
    ledgerFile: null,
    noLedger: true,
    ledger: null,
    ledgerStats: null,
    ledgerInvalidEntryCount: 0,
    suppressionUnavailable: false,
    fpTracker: null,
    cloudFpPolicy: null,
    cloudRunId: null,
    cloudRepoId: null,
    noCloudRecording: false,
    learningWritesAllowed: true,
    bandit: null,
    debtLedger: { entries: [] },
    debtContext: { source: 'local', canWrite: false },
    debtEventsPath: null,
    newlyEscalated: [],
    debtRunId: 'audit-test-1',
    toolFindings: [],
    toolCapability: { enabled: false },
    allPaths: new Set(),
    found: [],
    missing: [],
    subjectFiles: new Set(),
    runStructure: true,
    structureResult: {},
    runWiring: true,
    wiringResult: {},
    backendPassNames: [],
    backendResults: [],
    frontendWillRun: false,
    frontendResult: {},
    runSustainability: true,
    sustainResult: {},
    runQuickfix: true,
    quickfixResult: {},
    runDuplication: true,
    duplicationResult: {},
    runAdjacency: true,
    adjacencyResult: {},
    archState: 'SKIPPED_NO_INTENT',
    archResult: {},
    orphanState: 'SKIPPED_NO_GRAPH',
    orphanResult: {},
    eventWiringState: 'ANALYZED_CLEAN',
    eventWiringResult: {},
    isR2Plus: false,
    ...overrides,
  };
}

describe('FinalizationDataSchema', () => {
  it('accepts a fully-populated, minimal-valued object', () => {
    assert.doesNotThrow(() => validateFinalizationData(minimalFinalizationData()));
  });

  it('rejects a missing required field', () => {
    const data = minimalFinalizationData();
    delete data.round;
    assert.throws(() => validateFinalizationData(data), /FinalizationData failed validation/);
  });

  it('rejects an extra undeclared field (.strict() doing its job)', () => {
    const data = minimalFinalizationData({ someInventedField: 'oops' });
    assert.throws(() => validateFinalizationData(data), /FinalizationData failed validation/);
  });

  it('4b\'s fixture constructs FinalizationData alone, with no capability handles faked', () => {
    // The whole point of splitting the contract in two (round-4 M1 fix): a
    // pure-function stage's test fixture must not need to fake a
    // PersistenceServices/TelemetryServices handle it never touches.
    const data = minimalFinalizationData();
    assert.equal('writeOutcomes' in data, false, 'FinalizationData must carry no persistence/telemetry capability handles');
    assert.doesNotThrow(() => validateFinalizationData(data));
  });
});

describe('AssembledFindingsSchema', () => {
  function minimalAssembled(overrides = {}) {
    return {
      allFindings: [],
      passRegistry: [],
      allResults: [],
      failedPasses: [],
      verdict: 'PASS',
      high: 0,
      medium: 0,
      low: 0,
      reopenedSet: new Set(),
      totalUsage: {},
      cacheMetrics: null,
      passTimings: {},
      summaryLines: [],
      ...overrides,
    };
  }

  it('accepts a minimal-valued object with all optional fields omitted', () => {
    assert.doesNotThrow(() => validateAssembledFindings(minimalAssembled()));
  });

  it('rejects a missing required field', () => {
    const data = minimalAssembled();
    delete data.verdict;
    assert.throws(() => validateAssembledFindings(data));
  });

  it('rejects an extra undeclared field', () => {
    assert.throws(() => validateAssembledFindings(minimalAssembled({ notARealField: 1 })));
  });

  it('accepts the optional debt/ledger/linter-overlap fields when present', () => {
    assert.doesNotThrow(() => validateAssembledFindings(minimalAssembled({
      suppressionData: { keptCount: 1 },
      debtMemoryData: { debtSuppressed: 0 },
      ledgerRejectedCount: 2,
      ledgerWriteError: 'disk full',
      linterOverlapData: { linterOverlapCount: 0 },
    })));
  });
});

describe('PersistenceServicesSchema / TelemetryServicesSchema', () => {
  it('both require exactly a writeOutcomes handle, nothing else', () => {
    assert.doesNotThrow(() => validatePersistenceServices({ writeOutcomes: { written: 0, spilled: 0, lost: 0, skipped: 0, byWriter: {} } }));
    assert.doesNotThrow(() => validateTelemetryServices({ writeOutcomes: { written: 0, spilled: 0, lost: 0, skipped: 0, byWriter: {} } }));
    assert.throws(() => validatePersistenceServices({}));
    assert.throws(() => validateTelemetryServices({ writeOutcomes: {}, extra: 1 }));
  });
});
