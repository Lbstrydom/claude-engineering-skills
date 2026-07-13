/**
 * Pins the public-export surface of `scripts/learning-store.mjs`.
 *
 * Plan §2 "Public API surface" / R3/M2: the frozen contract is the 93
 * named persistence functions enumerated in the contract matrix, plus
 * (post-M3 P3) the 9 caller-replacement helpers added for the
 * raw-client de-leak. `getReadClient` / `getWriteClient` /
 * `getPersonaSupabase` are NOT part of the contract — those are
 * internal abstraction breaches removed in M3.
 *
 * Any accidental addition / removal of an export fails this test —
 * forcing a deliberate update to the matrix + this pinned list.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import * as ls from '../scripts/learning-store.mjs';

// The frozen public surface, alphabetically sorted. Mirrors the contract
// matrix at docs/plans/postgres-parity-contract-matrix.md. Synced from
// `node -e "console.log(Object.keys(await import('./scripts/learning-store.mjs')).sort())"`
const EXPECTED_EXPORTS = [
  // Lifecycle
  'initLearningStore',
  'isCloudEnabled',
  'isPersonaCloudEnabled',

  // ── frozen 93-function persistence contract ──────────────────────────────
  // repo (5 — initLearningStore + isCloudEnabled live above)
  'getRepoIdByName',
  'getRepoIdByUuid',
  'upsertRepo',
  'upsertRepoByUuid',
  'resolveRepoForStore', // signal-recovery Cluster A §2.1 — stable repoRowId resolver

  // runs-findings (14, incl. _resetClassificationColumnCache + _resetPassStatsRoundColumnCache test seams)
  '_resetClassificationColumnCache',
  '_resetPassStatsRoundColumnCache', // WS1 run-unification — audit_pass_stats.round probe cache reset

  'recordAdjudicationEvent',
  'recordFindings',
  'recordFinalReviewFindings',      // shadow A/B — idempotent replace-persistence
  'adjudicateFinalReviewFinding',   // shadow A/B — human-adjudication writeback
  'getFinalReviewStats',            // shadow A/B — measurement read surface
  'recordPassStats',
  'recordRunComplete',
  'recordRunStart',
  'recordSuppressionEvents',
  'updatePassStatsPostDeliberation',
  'updateRunMeta',
  'getPassTimings',
  // debt (5)
  'appendDebtEventsCloud',
  'readDebtEntriesCloud',
  'readDebtEventsCloud',
  'removeDebtEntryCloud',
  'upsertDebtEntries',
  // friction (7)
  'appendMitigationRef',
  'buildFrictionUpsertPayload',
  'getFrictionNeighbourhood',
  'getFrictionRecurrence',
  'listFrictionSourceHashes',
  'reconcileTombstones',
  'upsertFrictionRow',
  // bandit-fp (9)
  'getFalsePositivePatterns',
  'getPassEffectiveness',
  'loadBanditArms',
  'loadFalsePositivePatterns',
  'syncBanditArms',
  'syncExperiments',
  'syncFalsePositivePatterns',
  'syncPromptRevision',
  'upsertPromptVariant',
  // plans-ship (21 — 17 + 3 WS1 + 1 WS3 persona-nav-feedback-recovery additions)
  'getCandidateAuditFindings', // WS1 — auto-correlator candidate read (temporally bounded)
  'getExistingCorrelationHashesForSession', // WS1 — first-hit-wins existence check
  'getUnlockedFixes',
  'insertRunRowWithPolicyFallback', // selector-policy 42703 write seam (plan: ux-lock-selector-policy)
  'listConsistencyCandidates',
  'promoteRegressionSpec',
  'readAuditEffectiveness',
  'readCorrelationCountsByType', // WS3 — persona-tests dashboard correlation-loop-health line
  'readCorrelationsForFinding',
  'readCorrelationsForRun',
  'readPersistentPlanFailures',
  'readPlanSatisfaction',
  'readShipEvents', // Cluster D / Phase 7 — ship-health dashboard panel
  'recordPersonaAuditCorrelation',
  'recordPlanVerificationItems',
  'recordPlanVerificationRun',
  'recordRegressionSpec',
  'recordRegressionSpecRun',
  'recordShipEvent',
  'retireMissedCorrelationsForHash', // WS1 — dismissal cascade (Gemini gate round-3 finding)
  'updatePlanStatus',
  'upsertPlan',
  // persona (9 — isPersonaCloudEnabled lives in Lifecycle)
  'getPersonaSessionsByRepo',
  'getPersonaSessionsByUrl',
  'listPersonasForApp',
  'recordPersonaSession',
  'upsertPersona',
  // persona-clickpath → nav reachability seeding (reader + pure sanitize/unnest helpers)
  'getReachabilityEvidence',
  'sanitizeStepUrl',
  'buildSanitizedClickPath',
  'unnestReachabilityRows',
  // persona-test-candidates (3 — Phase 3 WS-PIPE1, aggregation table for
  // consistency-mode canary findings; lifecycle distinct from
  // persona_test_sessions so kept as a separate domain module)
  'listPersonaTestCandidates',
  'markPersonaTestCandidateProposed',
  'upsertPersonaTestCandidate',
  // security (8 — +3 audit-trail/stats back-port: docs/plans/security)
  'callIncidentNeighbourhoodRpc',
  'getMaxIncidentRefreshAt',
  'getSecurityEvents',
  'getSecurityIncidentsByRepo',
  'getSecurityStats',
  'markIncidentsHistorical',
  'recordSecurityEvents',
  'recordSecurityIncidents',
  // learning-decisions (10 frozen + 2 new caller helpers below)
  'backfillLearningOutcome',
  'callDeferFinding',
  'callMarkFindingNeedsTriage',
  'insertFrictionNote',
  'insertLearningDecision',
  'readNoBrainerRecommendations',
  'readPendingTriageFindings',
  'readRecentFriction',
  'readStaleClusters',
  'refreshRecurringClusters', // Cluster C / Phase 6 — recurring-cluster recompute
  'recordConvergenceState',
  'recordDiffComplexity',
  'recordFindingResolution',
  'getAuthorTierStats', // model-tier-observation — author_tier dashboard reader
  // arch-memory (24 frozen + 7 new caller helpers below)
  'abortRefreshRun',
  'callNeighbourhoodRpc',
  'computeDriftScore',
  'copyForwardImports',
  'copyForwardUntouchedFiles',
  'getActiveEmbeddingModel',
  'getActiveSnapshot',
  'getDomainSummaries',
  'getImportGraphPopulated',
  'getImportersForFiles',
  'getTopDuplicateClusters',
  'heartbeatRefreshRun',
  'listFileImportsForSnapshot',
  'listLayeringViolationsForSnapshot',
  'listSymbolsForSnapshot',
  'markImportGraphPopulated',
  'openRefreshRun',
  'publishRefreshRun',
  'recordLayeringViolations',
  'recordSymbolDefinitions',
  'recordSymbolEmbedding',
  'recordSymbolFileImports',
  'recordSymbolIndex',
  'setActiveEmbeddingModel',
  'upsertDomainSummary',

  // ── M3 P3 — 10 named exports for the raw-client de-leak ─────────────────
  // runs-findings extension
  'getAuditRunConvergence',
  'getRunFindingOutcomeCounts', // Cluster B / Phase 4 — pass_selection resolver input
  'auditRunExists',             // determinism WS1 Phase 2 — finalize run-existence probe
  'markRunFindingsNeedsTriage', // determinism WS1 Phase 2 — finalize reconciliation writeback
  // dashboard audit-run findings viewer (docs/plans/dashboard-audit-run-viewer.md)
  'getRunFindings',
  'getRunMeta',
  'getRecentFindingsByRepo', // /persona-test Phase 0d enrichment — recent findings by repo
  '_resetRunReadColumnCache', // read-path optional-column probe cache reset (test seam)
  // repo extension
  'listRepoIds',
  // learning-decisions extensions
  'readDecisionsPaginated',
  'readUnresolvedDecisions',
  // arch-memory extensions
  'deleteRefreshRuns',
  'demoteRefreshRuns',
  'findStaleRunningRefresh',
  'getRefreshRun',
  'listPrunableRefreshRuns',
  'listRollbacksForRepo',

  // model-ab (12 — model-A/B/C experiment harness store; v2 adds finding-scores + arm-cost readers)
  'modelAbSchemaReady',
  'ensureArmSet',
  'reserveSpend',
  'reconcileSpend',
  'releaseSpend',
  'releaseOrphanedReservations',
  'cumulativeSpendEur',
  'applyModelAbAdjudication',
  'getModelAbAdjudicationQueue',
  'getModelAbEffectiveness',
  'getModelAbFindingScores',
  'getModelAbArmCost',
  'getAdjudicatorGroundTruth', // model-swap-eval-harness Phase 4
].sort();

// Internal client accessors that must NOT escape (plan §2 / R3/M2).
const FORBIDDEN_EXPORTS = ['getReadClient', 'getWriteClient', 'getPersonaSupabase'];

describe('learning-store.mjs — public export surface (plan §2 / R3/M2)', () => {
  it('EXPECTED_EXPORTS has no duplicate names (a dup could mask a missing export)', () => {
    const dups = EXPECTED_EXPORTS.filter((e, i) => EXPECTED_EXPORTS.indexOf(e) !== i);
    assert.deepEqual([...new Set(dups)], [], `duplicate pinned names: ${[...new Set(dups)].join(', ')}`);
  });

  it('exports exactly the pinned contract — no accidental additions / removals', () => {
    const actual = Object.keys(ls).sort();
    const missing = EXPECTED_EXPORTS.filter((e) => !actual.includes(e));
    const extra   = actual.filter((e) => !EXPECTED_EXPORTS.includes(e));
    assert.deepEqual(
      { missing, extra },
      { missing: [], extra: [] },
      'public surface drift detected — update the contract matrix + the EXPECTED_EXPORTS list together'
    );
    // Length-equality is the backstop: includes-based missing/extra can't catch
    // a duplicate-vs-missing cancellation, so pin the counts match exactly.
    assert.equal(actual.length, EXPECTED_EXPORTS.length, 'exported-name count drifted from the pin');
  });

  it('does NOT export internal client accessors (M3 P3 removal)', () => {
    for (const forbidden of FORBIDDEN_EXPORTS) {
      assert.ok(
        !(forbidden in ls),
        `${forbidden} leaked back into the public surface — this is the abstraction breach M3 P3 closed`
      );
    }
  });

  it('every exported name is a callable function (no stray constants / classes)', () => {
    for (const name of EXPECTED_EXPORTS) {
      const v = ls[name];
      assert.equal(
        typeof v, 'function',
        `${name} should be a function, got ${typeof v}`
      );
    }
  });

  it('pins the total export count (update deliberately when the surface changes)', () => {
    // The single authoritative number is this assertion + the EXPECTED_EXPORTS
    // list above; the per-domain section comments are descriptive only and not
    // a second source of truth (their historical sub-counts are not summed here).
    assert.equal(EXPECTED_EXPORTS.length, 154);
  });
});
