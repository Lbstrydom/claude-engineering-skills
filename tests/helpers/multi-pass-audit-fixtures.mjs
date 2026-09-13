/**
 * @fileoverview Shared canned-response fixtures for the multi-pass code-audit
 * harness tests. Consolidated here (arch:drift duplication cleanup) —
 * `finalization-characterization.test.mjs` and
 * `run-multi-pass-code-audit-harness.test.mjs` each had their own identical
 * copy of all of this.
 *
 * @module tests/helpers/multi-pass-audit-fixtures
 */

export const FIXTURE_DIR = 'tests/fixtures/harness-plan';
export const BACKEND_FILE = `${FIXTURE_DIR}/src/service.mjs`;

export const CLASSIFICATION = { sonarType: 'CODE_SMELL', effort: 'EASY', sourceKind: 'MODEL', sourceName: 'test-stub' };

export function mkFinding(overrides = {}) {
  return {
    id: 'H1', severity: 'HIGH', category: 'Test Category', section: `${BACKEND_FILE}:1`,
    detail: 'canned test finding detail', risk: 'canned risk', recommendation: 'canned recommendation',
    is_quick_fix: false, is_mechanical: false, principle: 'Test Principle',
    classification: CLASSIFICATION,
    ...overrides,
  };
}

export const EMPTY_STRUCTURE = { pass_name: 'structure', files_planned: 2, files_found: 2, files_missing: 0, missing_files: [], export_mismatches: [], findings: [], summary: 'structure ok' };
export const EMPTY_WIRING = { pass_name: 'wiring', wiring_issues: [], findings: [], summary: 'wiring ok' };
export const EMPTY_BACKEND = { pass_name: 'backend', findings: [], quick_fix_warnings: [], summary: 'backend ok' };
export const EMPTY_FRONTEND = { pass_name: 'frontend', findings: [], quick_fix_warnings: [], summary: 'frontend ok' };
export const EMPTY_SUSTAIN = { pass_name: 'sustainability', findings: [], dead_code: [], quick_fix_warnings: [], summary: 'sustainability ok' };
export const EMPTY_QUICKFIX = { pass_name: 'quickfix', findings: [], summary: 'quickfix ok' };

export function defaultResponses(overrides = {}) {
  return {
    structure_pass: EMPTY_STRUCTURE,
    wiring_pass: EMPTY_WIRING,
    backend_pass: EMPTY_BACKEND,
    frontend_pass: EMPTY_FRONTEND,
    sustainability_pass: EMPTY_SUSTAIN,
    quickfix_pass: EMPTY_QUICKFIX,
    ...overrides,
  };
}

/**
 * A minimal, contract-valid FinalizationData (scripts/lib/audit/finalization-contract.mjs)
 * — the envelope `finalizeRun`/`assembleFindings`/`runTelemetry` consume. ONE
 * builder, because three suites each carried their own copy and they had
 * already drifted (audit-code cluster A R1 M6). Cloud is off, learning writes
 * are off, every pass is empty; override what a test is about.
 */
export function minimalFinalizationData(overrides = {}) {
  const structure = { ...EMPTY_STRUCTURE, files_planned: 1, files_found: 1, findings: [], summary: 'ok' };
  const skipped = (name) => ({ pass_name: name, findings: [], summary: 'skipped' });
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
    runStructure: true, structureResult: { result: structure, usage: {}, latencyMs: 10 },
    runWiring: true, wiringResult: { result: { ...EMPTY_WIRING, summary: 'ok' }, usage: {}, latencyMs: 10 },
    backendPassNames: [], backendResults: [],
    frontendWillRun: false, frontendResult: { result: { ...skipped('frontend'), quick_fix_warnings: [] }, usage: {}, latencyMs: 0 },
    runSustainability: false, sustainResult: { result: { ...skipped('sustainability'), dead_code: [], quick_fix_warnings: [] }, usage: {}, latencyMs: 0 },
    runQuickfix: false, quickfixResult: { result: skipped('quickfix'), usage: {}, latencyMs: 0 },
    runDuplication: false, duplicationResult: { result: skipped('duplication'), usage: {}, latencyMs: 0 },
    runAdjacency: false, adjacencyResult: { result: skipped('adjacency'), usage: {}, latencyMs: 0 },
    archState: 'SKIPPED_NO_INTENT', archResult: { result: {}, usage: {}, latencyMs: 0 },
    orphanState: 'SKIPPED_NO_GRAPH', orphanResult: { result: {}, usage: {}, latencyMs: 0 },
    eventWiringState: 'ANALYZED_CLEAN', eventWiringResult: { result: {}, usage: {}, latencyMs: 0 },
    isR2Plus: false,
    ...overrides,
  };
}
