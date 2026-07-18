/**
 * Public-contract surface suite — the surviving postgres-parity gate.
 *
 * Plan: docs/plans/postgres-parity.md §12, matrix:
 * docs/plans/postgres-parity-contract-matrix.md.
 *
 * Asserts that every function in the frozen 93-function contract matrix is
 * still reachable through the `scripts/learning-store.mjs` barrel. That is
 * the invariant the M3 domain-module split promised its 18 caller files:
 * the barrel's public surface does not shrink or drift silently.
 *
 * ## What this suite deliberately no longer does
 *
 * It used to also carry a per-function golden-fixture parity half —
 * diffing the pg-backed path against `(return, table mutations)` snapshots
 * recorded from the FROZEN legacy supabase-js path. **That half was
 * retired, never completed.** Three independent reasons, any one fatal:
 *
 *  1. Its purpose was the R1 mitigation — diff new pg path vs legacy path.
 *     M4 deleted the legacy path, so there is nothing to compare against.
 *  2. M4 also dropped `@supabase/supabase-js` from the dependency tree, so
 *     the frozen legacy snapshot could no longer even be imported.
 *  3. The recorder's mutation-capture step was never implemented (it
 *     returned a `__TODO__` sentinel), so no fixture could be produced.
 *
 * Forward regression coverage for the pg path lives in the DB-backed
 * integration suites instead (`db-setup`, `db-withtx`, `db-query`,
 * `store-*`), which exercise the real driver against a disposable
 * postgres+pgvector container. Do not resurrect a fixture harness here
 * without a concrete requirement those suites cannot meet.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import * as ls from '../scripts/learning-store.mjs';

// The 93 frozen-contract functions. Helpers added in M3 P3 for the
// raw-client de-leak are out-of-scope (they're new APIs, not legacy
// migrations).
const CONTRACT_FUNCTIONS = [
  // repo
  'initLearningStore', 'isCloudEnabled', 'upsertRepo', 'getRepoIdByUuid',
  'upsertRepoByUuid', 'getRepoIdByName',
  // runs-findings
  'recordRunStart', 'recordRunComplete', 'updateRunMeta',
  '_resetClassificationColumnCache', 'recordFindings', 'recordPassStats',
  'updatePassStatsPostDeliberation', 'getPassTimings',
  'recordSuppressionEvents', 'recordAdjudicationEvent',
  // debt
  'upsertDebtEntries', 'readDebtEntriesCloud', 'removeDebtEntryCloud',
  'appendDebtEventsCloud', 'readDebtEventsCloud',
  // bandit-fp
  'syncBanditArms', 'loadBanditArms',
  'syncFalsePositivePatterns', 'loadFalsePositivePatterns',
  'getFalsePositivePatterns', 'syncExperiments', 'syncPromptRevision',
  'getPassEffectiveness',
  // plans-ship
  'upsertPlan', 'updatePlanStatus', 'recordRegressionSpec',
  'listConsistencyCandidates', 'promoteRegressionSpec',
  'recordRegressionSpecRun', 'getUnlockedFixes',
  'recordPersonaAuditCorrelation', 'readCorrelationsForRun',
  'readCorrelationsForFinding', 'readAuditEffectiveness',
  'recordPlanVerificationRun', 'recordPlanVerificationItems',
  'readPlanSatisfaction', 'readPersistentPlanFailures', 'recordShipEvent',
  // persona
  'isPersonaCloudEnabled', 'listPersonasForApp', 'upsertPersona',
  'recordPersonaSession', 'getPersonaSessionsByRepo',
  'getPersonaSessionsByUrl',
  // security
  'recordSecurityIncidents', 'getSecurityIncidentsByRepo',
  'markIncidentsHistorical', 'getMaxIncidentRefreshAt',
  'callIncidentNeighbourhoodRpc',
  // learning-decisions
  'insertLearningDecision', 'backfillLearningOutcome',
  'recordDiffComplexity', 'recordConvergenceState',
  'recordFindingResolution', 'callDeferFinding',
  'callMarkFindingNeedsTriage', 'readPendingTriageFindings',
  'readNoBrainerRecommendations', 'readStaleClusters',
  'insertFrictionNote', 'readRecentFriction',
  // arch-memory
  'openRefreshRun', 'publishRefreshRun', 'abortRefreshRun',
  'heartbeatRefreshRun', 'getActiveSnapshot', 'recordSymbolDefinitions',
  'recordSymbolIndex', 'recordSymbolEmbedding', 'recordLayeringViolations',
  'recordDuplicateJustifications',
  'setActiveEmbeddingModel', 'getActiveEmbeddingModel',
  'callNeighbourhoodRpc', 'computeDriftScore', 'recordSymbolFileImports',
  'copyForwardImports', 'markImportGraphPopulated',
  'getImportGraphPopulated', 'getImportersForFiles',
  'upsertDomainSummary', 'getDomainSummaries', 'getTopDuplicateClusters',
  'listSymbolsForSnapshot', 'listLayeringViolationsForSnapshot',
  'copyForwardUntouchedFiles',
];

// ── Structural assertions (run unconditionally, no DB needed) ──────────────

describe('learning-store / contract suite — structural checks', () => {
  it('every contract-matrix function is reachable through the barrel', () => {
    const missing = CONTRACT_FUNCTIONS.filter((fn) => typeof ls[fn] !== 'function');
    assert.deepEqual(missing, [], `barrel missing contract functions: ${missing.join(', ')}`);
  });

  it('the contract function count matches the matrix (93)', () => {
    assert.equal(CONTRACT_FUNCTIONS.length, 93);
  });

  it('the list has no duplicate entries', () => {
    const dupes = CONTRACT_FUNCTIONS.filter((fn, i) => CONTRACT_FUNCTIONS.indexOf(fn) !== i);
    assert.deepEqual(dupes, [], `duplicated contract functions: ${dupes.join(', ')}`);
  });
});
