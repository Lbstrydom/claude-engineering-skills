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

  // runs-findings (15, incl. _resetClassificationColumnCache + _resetPassStatsRoundColumnCache test seams)
  '_resetClassificationColumnCache',
  '_resetPassStatsRoundColumnCache', // WS1 run-unification — audit_pass_stats.round probe cache reset

  'recordAdjudicationEvent',
  'recordFindings',
  'recordFinalReviewFindings',      // shadow A/B — idempotent replace-persistence
  'adjudicateFinalReviewFinding',   // shadow A/B — human-adjudication writeback
  'getFinalReviewStats',            // shadow A/B — measurement read surface
  'persistKeptEmbeddings',          // GH #59 — record-time embedding write, exported (undecorated) as a test seam
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
  // bandit-fp (13 — was 14 until upsertPromptVariant was deleted 2026-07-18 as
  // dead code (no caller, 0 rows, conflict target contradicted the table's
  // documented global scope; flagged by on-conflict-lint). +2 from the
  // 2026-07-17 FP-sync idempotency fix:
  // buildFpPatternRows is the pure row builder under test; fpPatternReadColumns
  // returns the reader's column list so the schema-guard test can verify it.
  // +1 from the cloud FP read loop: buildFpReadQuery is the pure query builder,
  // exported so the bounded/deterministic-order/no-repo-predicate query SHAPE is
  // assertable DB-free — there is no live-DB tier here by design, INC-002.
  // +1 isSyncableRepoId: the pure repo-identity guard that stops an unresolved
  // repo laundering repo-private patterns into the cross-repo GLOBAL bucket.
  // +1 buildBanditArmRows: the pure arm-row builder — context_bucket can never
  // be null, the sibling of buildFpPatternRows repo_id pin; exported so that
  // invariant is assertable DB-free, INC-002)
  'buildBanditArmRows',
  'buildFpPatternRows',
  'buildFpReadQuery',
  'fpPatternReadColumns',
  'getFalsePositivePatterns',
  'getPassEffectiveness',
  'isSyncableRepoId',
  'loadBanditArms',
  'loadFalsePositivePatterns',
  'syncBanditArms',
  'syncFalsePositivePatterns',
  // plans-ship (22 — 17 + 3 WS1 + 1 WS3 persona-nav-feedback-recovery + 1 CCR)
  'getCandidateAuditFindings', // WS1 — auto-correlator candidate read (temporally bounded)
  'getExistingCorrelationHashesForSession', // WS1 — first-hit-wins existence check
  'getUnlockedFixes',
  'getUnremediatedAcceptances', // accepted-but-never-remediated /ship nudge (2026-07-27)
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
  'getPlanIdByPath',   // path→id so a human can mark a plan terminal by name
  'validatePlanPath',  // plan-path guard — keeps CLI flags/temp paths out of `plans`
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
  // arch-memory (25 frozen + 7 new caller helpers below)
  'abortRefreshRun',
  'callNeighbourhoodRpc',
  'computeDriftScore',
  'copyForwardCoverage',
  'copyForwardImports',
  'copyForwardUntouchedFiles',
  'getActiveEmbeddingModel',
  'getBandCalibration',
  'recordBandCalibration',
  'sampleSnapshotEmbeddings',
  'getActiveSnapshot',
  'getDomainSummaries',
  'getFreshImportersOrNull', // docs/plans/stage0-evidence-relevance-split.md decision #5/#9 — Stage 0 impactAdapter's bounded-BFS import-graph query
  'getGraphCoverage',
  'getImportGraphPopulated',
  'getImportersForFiles',
  'getTopDuplicateClusters',
  'heartbeatRefreshRun',
  'listFileImportsForSnapshot',
  'listFilesNeedingSummaryRetry',
  'listLayeringViolationsForSnapshot',
  'listSymbolsForSnapshot',
  'countSymbolsForSnapshot', // symbol-index-pipeline-reliability-hardening Theme 2 — capped-pool detector for drift.mjs's pragma reconciliation
  'markImportGraphPopulated',
  'openRefreshRun',
  'publishRefreshRun',
  'recordDuplicateJustifications',
  'recordSummaryOutcomes',
  'recordLayeringViolations',
  'recordSymbolDefinitions',
  'recordSymbolEmbedding',
  'recordSymbolEmbeddings',
  'recordGraphCoverage',
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
  'markRunFindingsAutoDismissed', // 2026-07-22 — control-marker findings sibling writer (scripts/lib/audit/control-markers.mjs)
  // fix-lifecycle projection (docs/plans/remediation-state-fix-lifecycle.md)
  'buildFindingAdjudicationPatch', // gap #2 — remediation_state → audit_findings (pure seam)
  'markFindingsRemediation',       // repo-scoped fingerprint writer for fixed/regressed
  'normalizeRemediationUpdates',   // pure validation seam for the writer (audit R1/M7)
  'reconcileRemediationProjection',// DB-driven self-heal sweep (14-day window)
  'buildLedgerTerminalIndex',      // pure — fingerprint → terminal state index
  'selectReconcileTargets',        // pure — DB-vs-ledger disagreement selector
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
    // 163 → 161: syncExperiments + syncPromptRevision deleted 2026-07-19.
    // Both were dead (no callers, no readers) and syncExperiments wrote to an
    // `experiments` table that does not exist — it would have thrown if ever
    // called. Git history is the archive.
    // 161 → 163: listFilesNeedingSummaryRetry + recordSummaryOutcomes added
    // 2026-07-20 for the bounded null-summary re-queue (plan §2.1 C9). The
    // cap constant is deliberately NOT exported — this surface is functions.
    // 166 → 168: getPlanIdByPath + validatePlanPath added 2026-07-20 with the
    // plan-path guard (a live audit found `--help` and two temp-scratchpad
    // paths registered as plans). The DB status vocabulary that landed
    // alongside them is deliberately NOT here — it is a constant, and it lives
    // in plan-status.mjs with the vocabulary it derives from.
    // 174 → 175: recordRefreshDiffStats added 2026-07-21, then REVERTED back to
    // 174 the same day — the refresh_runs.files_* columns it wrote were never
    // read and duplicated `git diff`, so writer + columns were dropped
    // (migration 20260721150000). Per-run churn is now a log line, not storage.
    // 174 → 175: persistKeptEmbeddings exported (undecorated) 2026-07-22 fixing
    // two REOPENED HIGH findings (GH #59) — unverified write success (rowCount
    // now checked) and missing run/tenant scoping (WHERE EXISTS join to
    // audit_findings.run_id). The export is a test seam, same class as
    // buildFindingAdjudicationPatch / normalizeRemediationUpdates above.
    // 175 → 176: markRunFindingsAutoDismissed added 2026-07-22 — sibling of
    // markRunFindingsNeedsTriage that routes CONTROL-STATE marker findings
    // (ADJACENCY_INCOMPLETE) to a distinct `auto_dismissed` user_action so
    // they stop leaking into pending_triage_findings / the weekly digest.
    // 176 → 177: recordSymbolEmbeddings added 2026-07-24 — batched sibling
    // of recordSymbolEmbedding (chunked multi-row upsert instead of one
    // round trip per symbol; the per-row loop was the dominant driver of
    // the project's Supabase Disk IO budget warning).
    // 177 → 178: countSymbolsForSnapshot added 2026-07-27 (symbol-index-
    // pipeline-reliability-hardening Theme 2) — lets drift.mjs detect when
    // its 10000-row pragma-reconciliation candidate pool is truncated,
    // rather than silently reconciling against a partial snapshot.
    // 178 → 179: getUnremediatedAcceptances added 2026-07-27 — reads the
    // `unremediated_acceptances` view for /ship Step 0.5e. Sibling of
    // getUnlockedFixes one step earlier in the lifecycle: that one asks "this
    // was fixed — is the fix locked?", this asks "this was accepted — was it
    // ever fixed at all?". Measured that day: only 3 of 10 accepted
    // final-review-shadow findings had a confirmed code fix.
    assert.equal(EXPECTED_EXPORTS.length, 179);
  });
});
