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
  // repo (6 — initLearningStore + isCloudEnabled live above)
  'getRepoIdByName',
  'getRepoIdByUuid',
  'upsertRepo',
  'upsertRepoByUuid',
  'resolveRepoForStore', // signal-recovery Cluster A §2.1 — stable repoRowId resolver
  // Added 2026-08-12 (cross-skill-cli-integrity F7). `resolveRepoForStore`
  // returns null for THREE different facts — cloud-off, unresolvable, and a
  // thrown DB error — so a WRITE caller could not tell a repo that genuinely has
  // no identity from a transient failure, and wrote a permanently unscoped row
  // on the second. This is the discriminated form (`kind:'resolved'|'cloud-off'|
  // 'unresolved'|'error'`) and is now the single implementation; the older name
  // is a thin wrapper over it so existing call sites are untouched.
  'resolveRepoForStoreResult',
  // Added 2026-09-04 (drift-signal-attribution). The publishable identity of the
  // configured store — fingerprint + database name, never a hostname. It is a
  // READ of configuration rather than of the database, so it is sync and answers
  // for a cloud-off run too (as null). It sits on the barrel because the
  // reporting CLIs that must name their store are `arch-memory`, which may
  // depend on `learning-store` but NOT on `stores` — three direct
  // `db/client.mjs` imports produced three layering violations.
  'getActiveStoreDescriptor',

  // runs-findings (15, incl. _resetClassificationColumnCache + _resetPassStatsRoundColumnCache test seams)
  '_resetClassificationColumnCache',
  '_resetPassStatsRoundColumnCache', // WS1 run-unification — audit_pass_stats.round probe cache reset

  'recordAdjudicationEvent',
  'recordFindings',
  'recordFinalReviewFindings',      // shadow A/B — idempotent replace-persistence
  'adjudicateFinalReviewFinding',   // shadow A/B — human-adjudication writeback
  'recordFinalReviewFix',           // shadow A/B — fix-outcome writeback (remediation axis)
  'getFinalReviewStats',            // shadow A/B — measurement read surface
  'persistKeptEmbeddings',          // GH #59 — record-time embedding write, exported (undecorated) as a test seam
  'recordPassStats',
  'recordRunComplete',
  'recordRunStart',
  'recordSuppressionEvents',
  // Added 2026-08-14. The durable `reason` for a reopened finding was the
  // hardcoded literal 'Scope changed', so `suppression_events` — the only place
  // a reopen survives its run — could not distinguish a model-declared reopen
  // from a mechanical file-touch reopen of a dismissal. Exported (rather than
  // inlined) so the string contract is directly testable: it is the accumulating
  // signal the deferred reopen-policy decision reads.
  'reopenReason',
  'updatePassStatsPostDeliberation',
  'updateRunMeta',
  'getPassTimings',
  // debt (5)
  'appendDebtEventsCloud',
  'readDebtEntriesCloud',
  // Single-statement reconciliation snapshot (entry presence + latest lifecycle
  // event per topic). One statement, not a transaction: under READ COMMITTED two
  // consecutive SELECTs can observe different committed states.
  'readReconciliationSnapshot',
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
  'countUnlockedFixes', // denominator for the /ship lock nudge — rows are LIMIT-capped (2026-07-29)
  'countAgedUnlockedFixes', // what the 14-day window DROPPED — the denominator's blind spot (2026-08-11)
  'countAgedUnremediatedAcceptances', // same, for the 30d ceiling + 7d floor (2026-08-11)
  'countAcceptedPermanent', // the DISPOSITION axis — decided, not forgotten (2026-08-11)
  'countUnremediatedAcceptances', // same denominator, sibling view (2026-07-31)
  'getUnlockedFixes',
  // Repo-scoped single-finding lookup. Exists because the LIMIT-20 sampler
  // above must never be used to find ONE finding: unscoped it returned an
  // arbitrary 20 cross-repo rows, so a real finding usually was not among
  // them AND its foreign repo_id could be written into a regression spec.
  'findUnlockedFixInRepo',
  'getUnremediatedAcceptances', // accepted-but-never-remediated /ship nudge (2026-07-27)
  // remediation-state verification reconciler read side
  // (docs/plans/remediation-state-verification-reconciler.md) — a THIRD reader
  // over this view family, unbounded by age, ordered by the reconciler's OWN
  // throttle column rather than severity.
  'getStaleAcceptedFindingsForVerification',
  'countStaleAcceptedFindingsForVerification',
  // Read-time work-unit grouping for the two nudge readers above. Public
  // because the grouping is computed at READ time — deliberately not persisted
  // yet — so the command handler needs the vectors, and a caller that cannot
  // tell "no embedding" from "not returned" would fold uncompared rows into a
  // unit (2026-08-13).
  'getFindingEmbeddings',
  // The page clamp for BOTH nudge readers above. Public because the CLI must
  // echo the RESOLVED limit/offset back to the caller, and one owner of the
  // bounds beats the CLI re-deriving them and drifting (2026-08-10).
  'resolveNudgePage',
  'insertRunRowWithPolicyFallback', // selector-policy 42703 write seam (plan: ux-lock-selector-policy)
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
  // persona-test-candidates: RETIRED 2026-08-11 (migration 20260811070000).
  // WS-PIPE1's aggregation table was superseded by the regression_specs path
  // /ship Step 5.6 actually promotes from. `git log -S` over every skill
  // surface returned 0 commits for all three CLI verbs across their entire
  // history, no FK referenced the table, nothing was ever promoted from it,
  // and its only two rows were smoke-test fixtures.
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
  // Pure decision function (not a store operation) exported so the
  // unverified-refresh-pointer branch is testable without a database —
  // audit R3 H1, tests/active-snapshot-pointer.test.mjs.
  'resolveActiveSnapshot',
  'sampleSnapshotEmbeddings',
  'getActiveSnapshot',
  'getDomainSummaries',
  'getFreshImportersOrNull', // docs/plans/stage0-evidence-relevance-split.md decision #5/#9 — Stage 0 impactAdapter's bounded-BFS import-graph query
  'resolveImportGraphFreshness', // the PURE freshness decision behind getFreshImportersOrNull — split out so it is testable without a DB (the query defect it hid passed every pure test for the function's whole history)
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
  'listSnapshotFilePaths', // incremental-refresh-ownership-propagation Cluster A — the ownership filter's candidate set, UNIONed over symbol_index + symbol_file_imports so a pure importer is not missed
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
  'buildFindingRow',            // 2026-08-13 — pure finding→row mapper (existence-gate persistence, migration 20260813120000)
  // fix-lifecycle projection (docs/plans/remediation-state-fix-lifecycle.md)
  'buildFindingAdjudicationPatch', // gap #2 — remediation_state → audit_findings (pure seam)
  'markFindingsRemediation',       // repo-scoped fingerprint writer for fixed/regressed
  'normalizeRemediationUpdates',   // pure validation seam for the writer (audit R1/M7)
  'reconcileRemediationProjection',// DB-driven self-heal sweep (14-day window)
  'buildLedgerTerminalIndex',      // pure — fingerprint → terminal state index
  'selectReconcileTargets',        // pure — DB-vs-ledger disagreement selector
  // remediation-state VERIFICATION reconciler (docs/plans/remediation-state-verification-reconciler.md)
  // — id-addressed sibling of markFindingsRemediation above, for the population
  // that lifecycle is structurally blind to (session/round/14-day-bounded).
  'applyRemediationVerificationResults',
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

  // skill-efficacy census (docs/plans/skill-efficacy-census.md Phase 2) —
  // per-skill window-count readers, one per store module
  'getAuditFindingConversionRate',
  'getAuditRunWindowCounts',
  'getPersonaSessionWindowCounts',
  'getPlanWindowCounts',
  'getRegressionSpecWindowCounts',
  'getShipEventWindowCounts',
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
    // 199 → 200: listSnapshotFilePaths added 2026-09-05 — the ownership filter's
    // candidate set for incremental copy-forward. UNIONed over symbol_index and
    // symbol_file_imports because a file that imports but exports no extractable
    // symbol appears only in the latter, and feeding the oracle symbol_index
    // alone would leave every pure importer unclassified.
    // 198 → 199: getActiveStoreDescriptor added 2026-09-04 — the publishable
    // identity of the configured store, on the barrel because the CLIs that must
    // name their store are `arch-memory`, which may not depend on `stores`.
    // 197 → 198: resolveImportGraphFreshness added 2026-09-04 — the PURE freshness
    // decision split out of getFreshImportersOrNull so it is reachable without a DB.
    // Same shape as resolveActiveSnapshot: the query it sat behind named a phantom
    // column, and no pure test could see that because there was no seam.
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
    // 179 → 180: recordFinalReviewFix — shadow A/B fix-outcome writeback
    // (the remediation axis this file's 178 → 179 entry exists to surface).
    // 180 → 181: countUnlockedFixes added 2026-07-29. getUnlockedFixes caps at
    // LIMIT 20, so /ship counted its rows and reported "20" when the real
    // backlog was 232 — and 113 of those were plan-mode findings that can
    // never carry a regression spec. The nudge needed a denominator it could
    // not compute from a capped row list.
    // 181 → 182: findUnlockedFixInRepo added 2026-07-30 (cross-tenant write fence).
    // 182 → 183: countUnremediatedAcceptances added 2026-07-31 — the SAME
    // capped-rows undercount as 180 → 181, in the sibling view, unnoticed
    // because only the unlocked_fixes half was fixed. /ship reported "20"
    // against a real 129 and the operator was asked to plan work off it.
    // 183 → 184: resolveCandidateStatesByFingerprint added 2026-08-09
    // (docs/plans/learning-persona-quickfix-honest-failure.md item 7). It is the
    // ONE new public store operation: reconcile asks it for the state of the
    // specific fingerprints it holds journals for, instead of membership-testing
    // a paginated candidate list. A sequence of pages is not a snapshot, and
    // treating "not in the list" as "already promoted" destroyed recovery
    // journals for any candidate past page 100. The cursor codec, query builder,
    // bounds and state projection that landed alongside it are deliberately NOT
    // here — they live in candidate-pagination.mjs, which the barrel does not
    // re-export, because this surface is store OPERATIONS and constants are
    // excluded by design.
    // 184 → 185: resolveNudgePage added 2026-08-10 (upstream report 96a829f8).
    // Both /ship nudge readers now take `limit`/`offset` so their tail is
    // reachable — a consumer measured 44 obligations of which 24 could not be
    // enumerated by ANY invocation, because `--limit` was a registered flag no
    // handler read. The clamp is exported rather than duplicated in the CLI so
    // the payload can echo what it actually resolved: a caller who cannot tell
    // a clamped page from an exhausted one reads a short page as "no tail".
    // 185 → 186: countAgedUnlockedFixes added 2026-08-11. The 14-day window sat
    // INSIDE the predicate that defines the obligation, so "not shown" and "not
    // owed" were one state and an unlocked HIGH fix left the backlog by the
    // passage of time with no trace but a smaller number — measured that day, 94
    // code findings had aged out against 1 still visible. This is the same
    // reporting gap 180 → 181 closed on the ROW axis (`shown` vs `total`),
    // reappearing on the TIME axis, and it needed its own reader for the same
    // reason: the count of what a bound excluded cannot be computed from the
    // rows the bound kept.
    // 186 -> 187: countAgedUnremediatedAcceptances added 2026-08-11, the sibling
    // of 185 -> 186 on the other nudge view. It needs its own reader rather than
    // a shared one because this view's window has TWO bounds doing opposite jobs:
    // a 7-day maturity FLOOR (a row under it is not yet due and will appear on
    // its own) and a 30-day CEILING (a row over it is gone for good). Both read
    // as "not shown", so a single counter would have to fold them and the fold
    // is the defect. Measured the day it landed: agedOut 0, but 201 live
    // obligations with the first 31 due to expire five days later.
    // 187 -> 184: the three persona-test-candidates operations retired
    // 2026-08-11 with the table itself (migration 20260811070000). The only
    // surface reduction in this pin's history — recorded here because a
    // SHRINKING count is exactly as much a contract change as a growing one,
    // and a silently-dropped export is how a consumer finds out by crashing.
    // 184 -> 181: listConsistencyCandidates, resolveCandidateStatesByFingerprint
    // and promoteRegressionSpec retired 2026-08-11 with the consistency
    // candidate/promotion path. Second shrink in this pin's history, and the
    // same reasoning applies — a dropped export is a contract change.
    // 181 -> 182: countAcceptedPermanent added 2026-08-11. A third axis on the
    // same nudge view, and it needs its own reader for the same reason the
    // other two did — this one is not a TIME bound but a DISPOSITION:
    // `user_action = 'accepted-permanent'` means weighed and declined on the
    // merits, and migration 20260811160000 stopped the nag reporting those as
    // open work. Excluding them is only honest if the count stays visible, so
    // the reader exists to keep `accepted-permanent` from becoming a silence
    // button. Deliberately UNWINDOWED, unlike its two siblings: a windowed
    // count would expire the guarantee exactly when the dumping ground becomes
    // worth auditing. Measured the day it landed: 36 of 231 rows in this repo
    // were already decided and still being reported as open.
    // 182 → 183: +resolveRepoForStoreResult (cross-skill-cli-integrity F7 — the
    // discriminated repo resolver that lets a write caller fail closed on a
    // transient lookup failure instead of silently writing repo_id NULL).
    // 183 → 184: +getFindingEmbeddings (2026-08-13). Backs `--group-by
    // work-unit` on the acceptance nudge: 132 open rows carried 99 distinct
    // `category` strings, so the field that looks like a grouping key is very
    // nearly a unique one, and the backlog could only be worked a row at a
    // time. Membership is deterministic by design (cosine over these vectors,
    // cutoff derived from the repo's own distribution) — only the LABEL may
    // come from a model, because the unit key is what a caller filters and
    // diffs on.
    // 184 → 185: +buildFindingRow (2026-08-13). The finding→row mapper, lifted
    // out of `recordFindings` with the existence-gate persistence leg
    // (migration 20260813120000). A test seam, same class as
    // buildFindingAdjudicationPatch / normalizeRemediationUpdates above: the
    // invariant worth pinning — that `severity` keeps the MODEL's value while
    // the gate's verdict lands in `verdict_severity` — was unreachable by any
    // test while the mapping was an inline closure.
    // 185 → 186: +reopenReason (2026-08-14). `suppression_events.reason` was
    // the hardcoded literal 'Scope changed' for every reopened finding, and
    // that row is the ONLY durable record of a reopen — the per-round counters
    // live in stderr and the result JSON, both gitignored and per-run. So the
    // store could not distinguish a model-declared, line-citing reopen from a
    // purely mechanical file-touch reopen of a dismissal the operator had
    // already disproved. Same class as a hardcoded 0 in telemetry: a constant
    // that reads as a measurement. Exported so the string contract is testable.
    // 186 → 192: +6 skill-efficacy census window-count readers (2026-08-22,
    // docs/plans/skill-efficacy-census.md Phase 2) — getAuditFindingConversionRate,
    // getAuditRunWindowCounts, getPersonaSessionWindowCounts, getPlanWindowCounts,
    // getRegressionSpecWindowCounts, getShipEventWindowCounts. One per store
    // module, each answering "how much did this skill get used in the current
    // vs. prior window" for the `cross-skill.mjs skill-census` report.
    // 192 → 195: +3 for the remediation-state VERIFICATION reconciler
    // (docs/plans/remediation-state-verification-reconciler.md, 2026-08-30) —
    // applyRemediationVerificationResults (runs-findings, id-addressed writer),
    // getStaleAcceptedFindingsForVerification + countStaleAcceptedFindingsForVerification
    // (ship-nudges, unbounded-age read side). Closes the gap the existing
    // fixed-lifecycle machinery (session-scoped, round-diff-scoped, 14-day-
    // bounded) cannot reach: upstream report 97d09c1c-8dd0-42d1-bfdb-93963f0c07a0.
    // 195 -> 197: TWO exports landed on 2026-09-04, from concurrent sessions,
    // and each independently wrote "195 -> 196" here. The count is 197; a
    // conflict resolution that keeps one comment and one increment silently
    // drops the other export from the pin.
    //
    // +1 `readReconciliationSnapshot` — the local-vs-store debt reconcile
    // (docs/plans/backlog-and-drift-reduction.md). ONE statement rather than a
    // transaction: under READ COMMITTED two consecutive SELECTs can observe
    // different committed states, and the classifier must see entry presence
    // and the latest lifecycle event at the SAME instant or it can prune an
    // entry that was merely reopened.
    //
    // +1 `resolveActiveSnapshot` — the pure decision half of
    // `getActiveSnapshot` (docs/plans/consumer-corpus-and-honesty-2026-09-04.md).
    // Extracted because audit R3 H1 (a repo-binding guard whose failure changed
    // nothing, so an unverified refresh pointer still came back as the repo's
    // active snapshot) survived a whole round purely by being unreachable from
    // a test: it sat between two awaits in a store module with no live-DB
    // harness. Exporting the decision is what made it provable.
    // tests/active-snapshot-pointer.test.mjs.
    assert.equal(EXPECTED_EXPORTS.length, 200);
  });
});
