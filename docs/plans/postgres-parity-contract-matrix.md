# Postgres-Parity — Contract Matrix (M0 #5)

- **Plan**: [`docs/plans/postgres-parity.md`](./postgres-parity.md) §0 prereq #5, §12
- **Source of truth**: [`scripts/learning-store.mjs`](../../scripts/learning-store.mjs) exports.
- **Enforced by**: [`tests/learning-store-contract.test.mjs`](../../tests/learning-store-contract.test.mjs)
  — asserts every function below is still reachable through the barrel.

> **This is a reference document, not a work queue.** It records the frozen
> 93-function public surface the M3 domain-module split promised its 18 caller
> files, plus each function's table access, return shape, and ordering
> semantics. It is useful when changing a store function (does this alter a
> documented return shape?) and when reviewing whether a new export belongs on
> the public surface.

> **Retired: the golden-fixture apparatus (2026-07-18).** Every row's Status
> column used to read `fixture-pending`, pointing at an off-CI recorder that
> replayed a frozen `@supabase/supabase-js` snapshot to capture per-function
> `(return, mutations)` fixtures. **That work was retired, not completed** —
> its purpose was the R1 mitigation (diff the new pg path against the legacy
> path), and M4 deleted the legacy path, dropped `@supabase/supabase-js` from
> the dependency tree, leaving nothing to record from. The recorder's
> mutation-capture step was also never implemented. The Status column is gone;
> the columns that describe the *contract* remain, because those are what the
> document is for. Forward regression coverage for the pg path lives in the
> DB-backed integration suites (`db-setup`, `db-withtx`, `db-query`, `store-*`).
> Full rationale: plan [§12](./postgres-parity.md#12-completion-notes-2026-05-21).

## How to read the columns

| Column | Meaning |
|---|---|
| Function | The exported name from `scripts/learning-store.mjs`. |
| Domain | The M3 split target (`scripts/lib/store/<domain>.mjs`). |
| Tables (W) | Tables the function mutates. |
| Tables (R) | Tables the function reads (or RPC return-shape source). |
| Return | `null` / `id` / `{...}` / `[...]` / `rowCount`. |
| Order | `n/a` (single-row / void), `pk` (sort by primary key), `contract:<ORDER BY>` (function emits an explicit ORDER BY — callers may rely on it), `insensitive` (no ordering guarantee; sort by the named canonical key before comparing). |

> **Counting**: 96 exports in `learning-store.mjs`. 2 are internal client
> accessors (`getReadClient`, `getWriteClient` — removed in M3 per plan
> §2 "Public API surface"). 1 is a test helper (`_resetClassificationColumnCache`).
> The frozen public contract = the 93 production functions enumerated below.

---

## repo (lifecycle + identity)

| Function | Tables (W) | Tables (R) | Return | Order |
|---|---|---|---|---|
| `initLearningStore` | — | `audit_repos` (ping) | `boolean` | n/a |
| `isCloudEnabled` | — | — | `boolean` (in-memory) | n/a |
| `upsertRepo` | `audit_repos` | — | `id` (uuid) | n/a |
| `getRepoIdByUuid` | — | `audit_repos` | `id \| null` | n/a |
| `upsertRepoByUuid` | `audit_repos` | — | `id` | n/a |
| `getRepoIdByName` | — | `audit_repos` | `id \| null` | n/a |

## runs-findings (audit runs + adjudication)

| Function | Tables (W) | Tables (R) | Return | Order |
|---|---|---|---|---|
| `recordRunStart` | `audit_runs` | — | `id` | n/a |
| `recordRunComplete` | `audit_runs` | — | `void` | n/a |
| `updateRunMeta` | `audit_runs` | — | `void` | n/a |
| `recordFindings` | `audit_findings` | — | `void` | n/a |
| `recordPassStats` | `audit_pass_stats` | — | `void` | n/a |
| `updatePassStatsPostDeliberation` | `audit_pass_stats` | — | `void` | n/a |
| `getPassTimings` | — | `audit_pass_stats` | `[{pass_name, p50, p95, mean}]` | `contract:pass_name ASC` |
| `recordSuppressionEvents` | `suppression_events` | — | `void` | n/a |
| `recordAdjudicationEvent` | `finding_adjudication_events` | — | `void` | n/a |
| `getMostRecentAuditRunIdForRepo` | — | `audit_runs` | `id \| null` | `contract:created_at DESC LIMIT 1` |
| `recordDiffComplexity` | `audit_runs` | — | `void` | n/a |
| `recordConvergenceState` | `audit_runs` | — | `void` | n/a |
| `recordFindingResolution` | `audit_findings` | — | `{ok, error?}` | n/a |
| `_resetClassificationColumnCache` | — | — | `void` (in-memory) | n/a |

## debt (out-of-scope finding ledger)

| Function | Tables (W) | Tables (R) | Return | Order |
|---|---|---|---|---|
| `upsertDebtEntries` | `debt_entries` | — | `{upserted}` | n/a |
| `readDebtEntriesCloud` | — | `debt_entries` | `[{topicId, ...}]` | `contract:created_at DESC` |
| `removeDebtEntryCloud` | `debt_entries` | — | `void` | n/a |
| `appendDebtEventsCloud` | `debt_events` | — | `void` | n/a |
| `readDebtEventsCloud` | — | `debt_events` | `[{eventType, ...}]` | `contract:created_at ASC` |

## bandit-fp (Thompson Sampling + false-positive learning)

| Function | Tables (W) | Tables (R) | Return | Order |
|---|---|---|---|---|
| `syncBanditArms` | `bandit_arms` | — | `{synced}` | n/a |
| `loadBanditArms` | — | `bandit_arms` | `[{passName, variantId, alpha, beta, ...}]` | insensitive (sort by `(passName, variantId)`) |
| `upsertPromptVariant` | `prompt_variants` | — | `void` | n/a |
| `syncFalsePositivePatterns` | `false_positive_patterns` | — | `{synced}` | n/a |
| `buildFpPatternRows` | — (pure row builder for the sync above; repo_id never null — sentinel fallback) | — | `[{repo_id, pattern_value, ...}]` | n/a |
| `fpPatternReadColumns` | — (returns the pinned reader column list; migration-backed, schema-guard-tested) | — | `string[]` | n/a |
| `buildFpReadQuery` | — (pure query builder for the read below; bounded `LIMIT n+1`, deterministic `ORDER BY decayed_dismissed DESC, pattern_value ASC`. **Repo scope carries NO `auto_suppress` predicate** — that flag is false for every hierarchy *blocker*, so filtering on it would delete the rows the scope walk depends on; global keeps it, safe because global is the last scope) | — | `{sql, params}` | n/a |
| `loadFalsePositivePatterns` | — | `false_positive_patterns` | **per-scope status envelope** `{repo, global}` where each is `{status: ok\|failed\|skipped, patterns, atLimit, errorName?}` — an empty array cannot distinguish "no patterns" from "the read failed", and that difference gates whether global may suppress | deterministic (`decayed_dismissed DESC, pattern_value ASC`) |
| `getFalsePositivePatterns` | — | `false_positive_patterns` | `[{...}]` (filtered) | insensitive (sort by `patternKey`) |
| `syncExperiments` | `prompt_experiments` | — | `{synced}` | n/a |
| `syncPromptRevision` | `prompt_revisions` | — | `void` | n/a |
| `getPassEffectiveness` | — | `audit_pass_stats` | `[{passName, accepted, dismissed, ewr}]` | insensitive (sort by `passName`) |

## plans-ship (plans + verify + ship-event log)

| Function | Tables (W) | Tables (R) | Return | Order |
|---|---|---|---|---|
| `upsertPlan` | `plans` | — | `{planId}` | n/a |
| `updatePlanStatus` | `plans` | — | `void` | n/a |
| `recordRegressionSpec` | `regression_specs` | — | `{specId}` | n/a |
| `listConsistencyCandidates` | — | `regression_specs` | `[{specId, ...}]` | `contract:created_at DESC` |
| `promoteRegressionSpec` | `regression_specs` | — | `void` | n/a |
| `recordRegressionSpecRun` | `regression_spec_runs` | — | `void` | n/a |
| `getUnlockedFixes` | — | `unlocked_fixes` (view) | `[{commitSha, ...}]` | `contract:committed_at DESC` |
| `countUnlockedFixes` | — | `unlocked_fixes` (view) | `{total, code, plan}` | n/a (aggregate) |
| `countUnremediatedAcceptances` | — | `unremediated_acceptances` (view) | `{total, code, plan}` | n/a (aggregate) |
| `getUnremediatedAcceptances` | — | `unremediated_acceptances` (view) | `[{auditFindingId, ...}]` | `contract:severity, accepted_at ASC` |
| `recordPlanVerificationRun` | `plan_verification_runs` | — | `{runId}` | n/a |
| `recordPlanVerificationItems` | `plan_verification_items` | — | `{inserted}` | n/a |
| `readPlanSatisfaction` | — | `plan_satisfaction` (view) | `{...} \| null` | n/a |
| `readPersistentPlanFailures` | — | `persistent_plan_failures` (view) | `[{criterionHash, ...}]` | `contract:consecutive_failures DESC` |
| `recordShipEvent` | `ship_events` | — | `void` | n/a |

## persona (persona-test sessions + correlations)

| Function | Tables (W) | Tables (R) | Return | Order |
|---|---|---|---|---|
| `isPersonaCloudEnabled` | — | — | `boolean` (in-memory) | n/a |
| `listPersonasForApp` | — | `personas` | `[{name, description, ...}]` | `contract:name ASC` |
| `upsertPersona` | `personas` | — | `id` | n/a |
| `recordPersonaSession` | `persona_test_sessions` | — | `{sessionId}` | n/a |
| `getPersonaSessionsByRepo` | — | `persona_test_sessions` | `[{...}]` | `contract:created_at DESC LIMIT N` |
| `getPersonaSessionsByUrl` | — | `persona_test_sessions` | `[{...}]` | `contract:created_at DESC LIMIT N` |
| `recordPersonaAuditCorrelation` | `persona_audit_correlations` | — | `void` | n/a |
| `readCorrelationsForRun` | — | `persona_audit_correlations` | `[{...}]` | insensitive |
| `readCorrelationsForFinding` | — | `persona_audit_correlations` | `[{...}]` | insensitive |
| `readAuditEffectiveness` | — | `audit_effectiveness` (view) | `{...} \| null` | n/a |

## arch-memory / symbol-index

| Function | Tables (W) | Tables (R) | Return | Order |
|---|---|---|---|---|
| `openRefreshRun` | `refresh_runs` | — | `{refreshId, cancellationToken}` | n/a |
| `publishRefreshRun` (RPC) | `refresh_runs` + `audit_repos` (atomic) | — | `JSONB` | n/a |
| `abortRefreshRun` | `refresh_runs` | — | `void` | n/a |
| `heartbeatRefreshRun` | `refresh_runs` | — | `void` | n/a |
| `getActiveSnapshot` | — | `audit_repos` + `refresh_runs` | `{refreshId, activeEmbeddingModel, activeEmbeddingDim, importGraphPopulated} \| null` | n/a |
| `recordSymbolDefinitions` | `symbol_definitions` | — | `{upserted}` | n/a |
| `recordSymbolIndex` | `symbol_index` | — | `{upserted}` | n/a |
| `recordSymbolEmbedding` | `symbol_embeddings` | — | `void` | n/a |
| `recordLayeringViolations` | `symbol_layering_violations` | — | `{inserted}` | n/a |
| `setActiveEmbeddingModel` | `audit_repos` | — | `void` | n/a |
| `getActiveEmbeddingModel` | — | `audit_repos` | `{model, dim} \| null` | n/a |
| `callNeighbourhoodRpc` (RPC `symbol_neighbourhood`) | — | `symbol_index` etc. | `[{...}]` | `contract:cosine_score DESC LIMIT k` |
| `computeDriftScore` (RPC `drift_score`) | — | `symbol_index`, `symbol_layering_violations` | `{score, dupPairs, ...}` (JSONB) | n/a |
| `recordSymbolFileImports` | `symbol_file_imports` | — | `{inserted}` | n/a |
| `copyForwardImports` | `symbol_file_imports` | `symbol_file_imports` (prior refresh) | `{copied}` | n/a |
| `markImportGraphPopulated` | `refresh_runs` | — | `void` | n/a |
| `getImportGraphPopulated` | — | `refresh_runs` | `boolean` | n/a |
| `getImportersForFiles` | — | `symbol_file_imports` | `[{importer}]` | insensitive |
| `upsertDomainSummary` | `domain_summaries` | — | `void` | n/a |
| `getDomainSummaries` | — | `domain_summaries` | `[{domainTag, summary, ...}]` | insensitive (sort by `domainTag`) |
| `getTopDuplicateClusters` (RPC `top_duplicate_clusters`) | — | `symbol_index` | `[{signatureHash, fileCount, ...}]` | `contract: fileCount DESC LIMIT N` |
| `listSymbolsForSnapshot` | — | `symbol_index` JOIN `symbol_definitions` | `[{...}]` | `contract: file_path ASC, start_line ASC` |
| `listLayeringViolationsForSnapshot` | — | `symbol_layering_violations` | `[{...}]` | `contract: rule_name ASC` |
| `copyForwardUntouchedFiles` | `symbol_definitions`, `symbol_index` | prior refresh rows | `{copied}` | n/a |

## security (incidents)

| Function | Tables (W) | Tables (R) | Return | Order |
|---|---|---|---|---|
| `recordSecurityIncidents` | `security_incidents` | — | `{upserted}` | n/a |
| `getSecurityIncidentsByRepo` | — | `security_incidents` | `[{...}]` | insensitive (sort by `incident_id`) |
| `markIncidentsHistorical` | `security_incidents` | — | `{marked}` | n/a |
| `getMaxIncidentRefreshAt` | — | `security_incidents` | `string \| null` (max `updated_at`) | n/a |
| `callIncidentNeighbourhoodRpc` (RPC `incident_neighbourhood`) | — | `security_incidents` | `[{...}]` | `contract: composite-score DESC LIMIT k` (client re-sorts; fixture order-insensitive) |

## learning-decisions (telemetry + RPC bridges)

| Function | Tables (W) | Tables (R) | Return | Order |
|---|---|---|---|---|
| `insertLearningDecision` | `learning_decisions` | — | `void` | n/a |
| `backfillLearningOutcome` | `learning_decisions` | — | `void` | n/a |
| `callDeferFinding` (RPC `defer_finding`) | `audit_findings`, `recurring_finding_clusters`, `learning_decisions` | — | `{ok, error?}` | n/a |
| `callMarkFindingNeedsTriage` (RPC `mark_finding_needs_triage`) | `audit_findings`, `learning_decisions` | — | `{ok, error?}` | n/a |
| `readPendingTriageFindings` | — | `pending_triage_findings` (view) | `[{...}]` | `contract:LIMIT N` (view's own ORDER BY) |
| `readNoBrainerRecommendations` | — | `no_brainer_recommendations` (view) | `[{...}]` | `contract: view ORDER BY` |
| `readStaleClusters` | — | `recurring_finding_clusters` | `[{...}]` | `contract:last_seen ASC LIMIT N` |
| `insertFrictionNote` | `friction_notes` | — | `{id}` | n/a |
| `readRecentFriction` | — | `friction_notes` | `[{...}]` | `contract:created_at DESC LIMIT N` |

## Internal client accessors (NOT in the public contract — removed in M3)

| Symbol | Reason |
|---|---|
| `getWriteClient` | Internal — abstraction breach; the M3 split closes it. |
| `getReadClient` | Same. |
| `getPersonaSupabase` | Already module-internal (not exported); deleted outright in M3. |

---
