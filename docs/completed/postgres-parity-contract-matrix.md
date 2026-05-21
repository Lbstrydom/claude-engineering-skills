# Postgres-Parity — Contract Matrix (M0 #5)

- **Plan**: [`docs/plans/postgres-parity.md`](./postgres-parity.md) §0 prereq #5, §9 "Golden-fixture contract model"
- **Source of truth**: [`scripts/learning-store.mjs`](../../scripts/learning-store.mjs)
  exports — frozen at SHA <recorded by the snapshot generator; see below>.
- **Generated fixture target**: `tests/fixtures/contract/<function>.json`.
  These are produced once, **off-CI**, by running the frozen-supabase-js path
  ([`tests/fixtures/learning-store.legacy.mjs`](../../tests/fixtures/learning-store.legacy.mjs))
  against a **local `supabase start` stack** (never the production project).
  Recording is driven by
  [`scripts/postgres-parity/record-golden-fixtures.mjs`](../../scripts/postgres-parity/record-golden-fixtures.mjs).

## How to read the columns

| Column | Meaning |
|---|---|
| Function | The exported name from `scripts/learning-store.mjs`. |
| Domain | The M3 split target (`scripts/lib/store/<domain>.mjs`). |
| Tables (W) | Tables the function mutates. |
| Tables (R) | Tables the function reads (or RPC return-shape source). |
| Return | `null` / `id` / `{...}` / `[...]` / `rowCount`. |
| Order | `n/a` (single-row / void), `pk` (sort by primary key), `contract:<ORDER BY>` (function emits an explicit ORDER BY — fixture is order-sensitive), `insensitive` (fixture comparator sorts both sides by a canonical key). |
| Status | `fixture-pending` until the off-CI recording runs and lands JSON in `tests/fixtures/contract/`. |

> **Counting**: 96 exports in `learning-store.mjs`. 2 are internal client
> accessors (`getReadClient`, `getWriteClient` — removed in M3 per plan
> §2 "Public API surface"). 1 is a test helper (`_resetClassificationColumnCache`).
> The frozen public contract = the 93 production functions enumerated below.

---

## repo (lifecycle + identity)

| Function | Tables (W) | Tables (R) | Return | Order | Status |
|---|---|---|---|---|---|
| `initLearningStore` | — | `audit_repos` (ping) | `boolean` | n/a | fixture-pending |
| `isCloudEnabled` | — | — | `boolean` (in-memory) | n/a | n/a (pure JS) |
| `upsertRepo` | `audit_repos` | — | `id` (uuid) | n/a | fixture-pending |
| `getRepoIdByUuid` | — | `audit_repos` | `id \| null` | n/a | fixture-pending |
| `upsertRepoByUuid` | `audit_repos` | — | `id` | n/a | fixture-pending |
| `getRepoIdByName` | — | `audit_repos` | `id \| null` | n/a | fixture-pending |

## runs-findings (audit runs + adjudication)

| Function | Tables (W) | Tables (R) | Return | Order | Status |
|---|---|---|---|---|---|
| `recordRunStart` | `audit_runs` | — | `id` | n/a | fixture-pending |
| `recordRunComplete` | `audit_runs` | — | `void` | n/a | fixture-pending |
| `updateRunMeta` | `audit_runs` | — | `void` | n/a | fixture-pending |
| `recordFindings` | `audit_findings` | — | `void` | n/a | fixture-pending |
| `recordPassStats` | `audit_pass_stats` | — | `void` | n/a | fixture-pending |
| `updatePassStatsPostDeliberation` | `audit_pass_stats` | — | `void` | n/a | fixture-pending |
| `getPassTimings` | — | `audit_pass_stats` | `[{pass_name, p50, p95, mean}]` | `contract:pass_name ASC` | fixture-pending |
| `recordSuppressionEvents` | `suppression_events` | — | `void` | n/a | fixture-pending |
| `recordAdjudicationEvent` | `finding_adjudication_events` | — | `void` | n/a | fixture-pending |
| `getMostRecentAuditRunIdForRepo` | — | `audit_runs` | `id \| null` | `contract:created_at DESC LIMIT 1` | fixture-pending |
| `recordDiffComplexity` | `audit_runs` | — | `void` | n/a | fixture-pending |
| `recordConvergenceState` | `audit_runs` | — | `void` | n/a | fixture-pending |
| `recordFindingResolution` | `audit_findings` | — | `{ok, error?}` | n/a | fixture-pending |
| `_resetClassificationColumnCache` | — | — | `void` (in-memory) | n/a | n/a (test helper) |

## debt (out-of-scope finding ledger)

| Function | Tables (W) | Tables (R) | Return | Order | Status |
|---|---|---|---|---|---|
| `upsertDebtEntries` | `debt_entries` | — | `{upserted}` | n/a | fixture-pending |
| `readDebtEntriesCloud` | — | `debt_entries` | `[{topicId, ...}]` | `contract:created_at DESC` | fixture-pending |
| `removeDebtEntryCloud` | `debt_entries` | — | `void` | n/a | fixture-pending |
| `appendDebtEventsCloud` | `debt_events` | — | `void` | n/a | fixture-pending |
| `readDebtEventsCloud` | — | `debt_events` | `[{eventType, ...}]` | `contract:created_at ASC` | fixture-pending |

## bandit-fp (Thompson Sampling + false-positive learning)

| Function | Tables (W) | Tables (R) | Return | Order | Status |
|---|---|---|---|---|---|
| `syncBanditArms` | `bandit_arms` | — | `{synced}` | n/a | fixture-pending |
| `loadBanditArms` | — | `bandit_arms` | `[{passName, variantId, alpha, beta, ...}]` | insensitive (sort by `(passName, variantId)`) | fixture-pending |
| `upsertPromptVariant` | `prompt_variants` | — | `void` | n/a | fixture-pending |
| `syncFalsePositivePatterns` | `false_positive_patterns` | — | `{synced}` | n/a | fixture-pending |
| `loadFalsePositivePatterns` | — | `false_positive_patterns` | `[{patternKey, ...}]` | insensitive (sort by `patternKey`) | fixture-pending |
| `getFalsePositivePatterns` | — | `false_positive_patterns` | `[{...}]` (filtered) | insensitive (sort by `patternKey`) | fixture-pending |
| `syncExperiments` | `prompt_experiments` | — | `{synced}` | n/a | fixture-pending |
| `syncPromptRevision` | `prompt_revisions` | — | `void` | n/a | fixture-pending |
| `getPassEffectiveness` | — | `audit_pass_stats` | `[{passName, accepted, dismissed, ewr}]` | insensitive (sort by `passName`) | fixture-pending |

## plans-ship (plans + verify + ship-event log)

| Function | Tables (W) | Tables (R) | Return | Order | Status |
|---|---|---|---|---|---|
| `upsertPlan` | `plans` | — | `{planId}` | n/a | fixture-pending |
| `updatePlanStatus` | `plans` | — | `void` | n/a | fixture-pending |
| `recordRegressionSpec` | `regression_specs` | — | `{specId}` | n/a | fixture-pending |
| `listConsistencyCandidates` | — | `regression_specs` | `[{specId, ...}]` | `contract:created_at DESC` | fixture-pending |
| `promoteRegressionSpec` | `regression_specs` | — | `void` | n/a | fixture-pending |
| `recordRegressionSpecRun` | `regression_spec_runs` | — | `void` | n/a | fixture-pending |
| `getUnlockedFixes` | — | `unlocked_fixes` (view) | `[{commitSha, ...}]` | `contract:committed_at DESC` | fixture-pending |
| `recordPlanVerificationRun` | `plan_verification_runs` | — | `{runId}` | n/a | fixture-pending |
| `recordPlanVerificationItems` | `plan_verification_items` | — | `{inserted}` | n/a | fixture-pending |
| `readPlanSatisfaction` | — | `plan_satisfaction` (view) | `{...} \| null` | n/a | fixture-pending |
| `readPersistentPlanFailures` | — | `persistent_plan_failures` (view) | `[{criterionHash, ...}]` | `contract:consecutive_failures DESC` | fixture-pending |
| `recordShipEvent` | `ship_events` | — | `void` | n/a | fixture-pending |

## persona (persona-test sessions + correlations)

| Function | Tables (W) | Tables (R) | Return | Order | Status |
|---|---|---|---|---|---|
| `isPersonaCloudEnabled` | — | — | `boolean` (in-memory) | n/a | n/a (pure JS) |
| `listPersonasForApp` | — | `personas` | `[{name, description, ...}]` | `contract:name ASC` | fixture-pending |
| `upsertPersona` | `personas` | — | `id` | n/a | fixture-pending |
| `recordPersonaSession` | `persona_test_sessions` | — | `{sessionId}` | n/a | fixture-pending |
| `getPersonaSessionsByRepo` | — | `persona_test_sessions` | `[{...}]` | `contract:created_at DESC LIMIT N` | fixture-pending |
| `getPersonaSessionsByUrl` | — | `persona_test_sessions` | `[{...}]` | `contract:created_at DESC LIMIT N` | fixture-pending |
| `recordPersonaAuditCorrelation` | `persona_audit_correlations` | — | `void` | n/a | fixture-pending |
| `readCorrelationsForRun` | — | `persona_audit_correlations` | `[{...}]` | insensitive | fixture-pending |
| `readCorrelationsForFinding` | — | `persona_audit_correlations` | `[{...}]` | insensitive | fixture-pending |
| `readAuditEffectiveness` | — | `audit_effectiveness` (view) | `{...} \| null` | n/a | fixture-pending |

## arch-memory / symbol-index

| Function | Tables (W) | Tables (R) | Return | Order | Status |
|---|---|---|---|---|---|
| `openRefreshRun` | `refresh_runs` | — | `{refreshId, cancellationToken}` | n/a | fixture-pending |
| `publishRefreshRun` (RPC) | `refresh_runs` + `audit_repos` (atomic) | — | `JSONB` | n/a | fixture-pending |
| `abortRefreshRun` | `refresh_runs` | — | `void` | n/a | fixture-pending |
| `heartbeatRefreshRun` | `refresh_runs` | — | `void` | n/a | fixture-pending |
| `getActiveSnapshot` | — | `audit_repos` + `refresh_runs` | `{refreshId, activeEmbeddingModel, activeEmbeddingDim, importGraphPopulated} \| null` | n/a | fixture-pending |
| `recordSymbolDefinitions` | `symbol_definitions` | — | `{upserted}` | n/a | fixture-pending |
| `recordSymbolIndex` | `symbol_index` | — | `{upserted}` | n/a | fixture-pending |
| `recordSymbolEmbedding` | `symbol_embeddings` | — | `void` | n/a | fixture-pending |
| `recordLayeringViolations` | `symbol_layering_violations` | — | `{inserted}` | n/a | fixture-pending |
| `setActiveEmbeddingModel` | `audit_repos` | — | `void` | n/a | fixture-pending |
| `getActiveEmbeddingModel` | — | `audit_repos` | `{model, dim} \| null` | n/a | fixture-pending |
| `callNeighbourhoodRpc` (RPC `symbol_neighbourhood`) | — | `symbol_index` etc. | `[{...}]` | `contract:cosine_score DESC LIMIT k` | fixture-pending |
| `computeDriftScore` (RPC `drift_score`) | — | `symbol_index`, `symbol_layering_violations` | `{score, dupPairs, ...}` (JSONB) | n/a | fixture-pending |
| `recordSymbolFileImports` | `symbol_file_imports` | — | `{inserted}` | n/a | fixture-pending |
| `copyForwardImports` | `symbol_file_imports` | `symbol_file_imports` (prior refresh) | `{copied}` | n/a | fixture-pending |
| `markImportGraphPopulated` | `refresh_runs` | — | `void` | n/a | fixture-pending |
| `getImportGraphPopulated` | — | `refresh_runs` | `boolean` | n/a | fixture-pending |
| `getImportersForFiles` | — | `symbol_file_imports` | `[{importer}]` | insensitive | fixture-pending |
| `upsertDomainSummary` | `domain_summaries` | — | `void` | n/a | fixture-pending |
| `getDomainSummaries` | — | `domain_summaries` | `[{domainTag, summary, ...}]` | insensitive (sort by `domainTag`) | fixture-pending |
| `getTopDuplicateClusters` (RPC `top_duplicate_clusters`) | — | `symbol_index` | `[{signatureHash, fileCount, ...}]` | `contract: fileCount DESC LIMIT N` | fixture-pending |
| `listSymbolsForSnapshot` | — | `symbol_index` JOIN `symbol_definitions` | `[{...}]` | `contract: file_path ASC, start_line ASC` | fixture-pending |
| `listLayeringViolationsForSnapshot` | — | `symbol_layering_violations` | `[{...}]` | `contract: rule_name ASC` | fixture-pending |
| `copyForwardUntouchedFiles` | `symbol_definitions`, `symbol_index` | prior refresh rows | `{copied}` | n/a | fixture-pending |

## security (incidents)

| Function | Tables (W) | Tables (R) | Return | Order | Status |
|---|---|---|---|---|---|
| `recordSecurityIncidents` | `security_incidents` | — | `{upserted}` | n/a | fixture-pending |
| `getSecurityIncidentsByRepo` | — | `security_incidents` | `[{...}]` | insensitive (sort by `incident_id`) | fixture-pending |
| `markIncidentsHistorical` | `security_incidents` | — | `{marked}` | n/a | fixture-pending |
| `getMaxIncidentRefreshAt` | — | `security_incidents` | `string \| null` (max `updated_at`) | n/a | fixture-pending |
| `callIncidentNeighbourhoodRpc` (RPC `incident_neighbourhood`) | — | `security_incidents` | `[{...}]` | `contract: composite-score DESC LIMIT k` (client re-sorts; fixture order-insensitive) | fixture-pending |

## learning-decisions (telemetry + RPC bridges)

| Function | Tables (W) | Tables (R) | Return | Order | Status |
|---|---|---|---|---|---|
| `insertLearningDecision` | `learning_decisions` | — | `void` | n/a | fixture-pending |
| `backfillLearningOutcome` | `learning_decisions` | — | `void` | n/a | fixture-pending |
| `callDeferFinding` (RPC `defer_finding`) | `audit_findings`, `recurring_finding_clusters`, `learning_decisions` | — | `{ok, error?}` | n/a | fixture-pending |
| `callMarkFindingNeedsTriage` (RPC `mark_finding_needs_triage`) | `audit_findings`, `learning_decisions` | — | `{ok, error?}` | n/a | fixture-pending |
| `readPendingTriageFindings` | — | `pending_triage_findings` (view) | `[{...}]` | `contract:LIMIT N` (view's own ORDER BY) | fixture-pending |
| `readNoBrainerRecommendations` | — | `no_brainer_recommendations` (view) | `[{...}]` | `contract: view ORDER BY` | fixture-pending |
| `readStaleClusters` | — | `recurring_finding_clusters` | `[{...}]` | `contract:last_seen ASC LIMIT N` | fixture-pending |
| `insertFrictionNote` | `friction_notes` | — | `{id}` | n/a | fixture-pending |
| `readRecentFriction` | — | `friction_notes` | `[{...}]` | `contract:created_at DESC LIMIT N` | fixture-pending |

## Internal client accessors (NOT in the public contract — removed in M3)

| Symbol | Reason |
|---|---|
| `getWriteClient` | Internal — abstraction breach; the M3 split closes it. Not a fixture. |
| `getReadClient` | Same. Not a fixture. |
| `getPersonaSupabase` | Already module-internal (not exported); deleted outright in M3. |

---

## Fixture format

Each fixture file `tests/fixtures/contract/<function>.json` is structured:

```json
{
  "function": "upsertRepo",
  "input": { "profile": { "repoFingerprint": "…", "…": "…" }, "repoName": "demo" },
  "expected": {
    "return": { "id": "<UUID-NORMALISED>" },
    "mutations": [
      {
        "table": "audit_repos",
        "where": { "fingerprint": "…" },
        "rowSnapshot": { "name": "demo", "…": "…" }
      }
    ]
  },
  "frozenAtSha": "<source SHA of learning-store.mjs at recording time>"
}
```

UUIDs and `now()` timestamps are normalised by the comparator (plan §9
"Determinism"). Per-test isolation uses `TRUNCATE … RESTART IDENTITY
CASCADE` + deterministic re-seed (plan §9 "Isolation").

## Recording the fixtures

```bash
# Prereq: Docker running + `supabase start` stack up locally.
# Never against the production Supabase project.
node scripts/postgres-parity/record-golden-fixtures.mjs \
  --legacy tests/fixtures/learning-store.legacy.mjs \
  --supabase-url http://127.0.0.1:54321 \
  --service-role-key <local-anon-or-service-key> \
  --out tests/fixtures/contract/
```

The script seeds deterministic inputs, calls the frozen legacy path
per matrix row, captures `(return, table mutations)`, normalises
UUIDs / `now()`, and writes one JSON file per row. Re-running is
idempotent.

## Coverage gate

Plan §9 "Coverage": the contract suite **fails** if any function in
this matrix has no recorded fixture. The CI lint
[`scripts/postgres-parity/check-non-core-references.mjs`](../../scripts/postgres-parity/check-non-core-references.mjs)
cross-checks function count against this matrix on every PR (the lint
script does double duty — see §M0 #1 doc).
