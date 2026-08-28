/**
 * @fileoverview Phase 4a contract for the finalization tail split
 * (docs/plans/legacy-production-audit-decomposition.md Phase 4).
 *
 * `FinalizationDataSchema` is the immutable, serializable INPUT snapshot the
 * orchestration spine builds ONCE, right after all six waves have run and
 * their results are known — enumerated by direct source reading of
 * `runLegacyProductionAudit`'s tail (:1771-3311 as of this plan's Cluster C
 * work), not guessed. Nothing mutates it in place: `finding-assembly.mjs`'s
 * `assembleFindings(data)` returns a NEW `AssembledFindingsSchema` value; the
 * coordinator composes the downstream form by spreading the original
 * immutable fields together with that output, and THAT composed value —
 * never the pre-assembly snapshot — is what `run-persistence.mjs` and
 * `run-telemetry.mjs` each receive alongside their own capability schema.
 *
 * Wave-result objects (`structureResult`, `backendResults[]`, etc.) are
 * intentionally typed `z.unknown()` rather than fully re-modelled here: each
 * wave's `{result, usage, latencyMs, ...}` shape is not formally schema'd
 * anywhere else in this codebase either (FindingSchema/ExecutionMetaSchema
 * govern their PAYLOAD, not the wave-result envelope), so inventing a new
 * shadow schema for them would be a parallel, driftable source of truth —
 * exactly what `.strict()` at the FIELD-PRESENCE level exists to prevent
 * without requiring that. `.strict()` here catches a missing/extra
 * TOP-LEVEL field (the coordinator forgetting to thread a wave result
 * through, or a stage reading a field that was never captured) — the class
 * of bug this contract exists to make impossible, not a payload-shape bug
 * findings' own schemas already own.
 *
 * @module scripts/lib/audit/finalization-contract
 */

import { z } from 'zod';

/**
 * The shared, immutable INPUT snapshot built once by the orchestration spine
 * after all six waves complete. No stage may mutate this object.
 */
export const FinalizationDataSchema = z.object({
  // ── Run identity / control ──────────────────────────────────────────
  ctx: z.record(z.string(), z.unknown()),
  round: z.number().int(),
  planFile: z.string().nullable(),
  planContent: z.string().nullable(),
  strictLint: z.boolean(),
  changedFiles: z.array(z.string()).nullable(),
  impactSet: z.unknown().nullable(),
  totalLatency: z.number(),
  diffLinesChanged: z.number().nullable(),
  diffFilesChanged: z.number().nullable(),
  sessionCacheHit: z.boolean().nullable(),
  mapReducePasses: z.array(z.string()),

  // ── Ledger / suppression state (R2+) ────────────────────────────────
  ledgerFile: z.string().nullable(),
  noLedger: z.boolean(),
  ledger: z.record(z.string(), z.unknown()).nullable(),
  ledgerStats: z.unknown().nullable(),
  ledgerInvalidEntryCount: z.number().int(),
  suppressionUnavailable: z.boolean(),
  fpTracker: z.unknown().nullable(),
  cloudFpPolicy: z.unknown().nullable(),

  // ── Cloud / learning capability flags ───────────────────────────────
  cloudRunId: z.string().nullable(),
  cloudRepoId: z.string().nullable(),
  noCloudRecording: z.boolean(),
  learningWritesAllowed: z.boolean(),
  bandit: z.unknown().nullable(),

  // ── Debt-memory state ────────────────────────────────────────────────
  debtLedger: z.object({ entries: z.array(z.unknown()) }),
  debtContext: z.object({ source: z.string(), canWrite: z.boolean() }).catchall(z.unknown()),
  debtEventsPath: z.string().nullable().optional(),
  newlyEscalated: z.array(z.unknown()),
  debtRunId: z.string(),

  // ── Tool pre-pass ────────────────────────────────────────────────────
  toolFindings: z.array(z.unknown()),
  toolCapability: z.unknown(),

  // ── Structure-pass accounting (mergedResult.files_*) ────────────────
  allPaths: z.instanceof(Set),
  found: z.array(z.string()),
  missing: z.array(z.string()),
  subjectFiles: z.instanceof(Set),

  // ── Wave results (passRegistry construction inputs) ─────────────────
  runStructure: z.boolean(),
  structureResult: z.unknown(),
  runWiring: z.boolean(),
  wiringResult: z.unknown(),
  backendPassNames: z.array(z.string()),
  backendResults: z.array(z.unknown()),
  frontendWillRun: z.boolean(),
  frontendResult: z.unknown(),
  runSustainability: z.boolean(),
  sustainResult: z.unknown(),
  runQuickfix: z.boolean(),
  quickfixResult: z.unknown(),
  runDuplication: z.boolean(),
  duplicationResult: z.unknown(),
  runAdjacency: z.boolean(),
  adjacencyResult: z.unknown(),
  archState: z.string(),
  archResult: z.unknown(),
  orphanState: z.string(),
  orphanResult: z.unknown(),
  eventWiringState: z.string(),
  eventWiringResult: z.unknown(),

  // R2+ flag — spine-computed, read by 4c/4d (isR2Plus does not itself
  // compute anything; it is already final by the time the coordinator runs).
  isR2Plus: z.boolean(),
}).strict();

/**
 * 4b's own output — the merged, deduplicated, verified, verdict-scored
 * finding registry. A NEW value, never a mutation of `FinalizationData`.
 */
export const AssembledFindingsSchema = z.object({
  allFindings: z.array(z.unknown()),
  passRegistry: z.array(z.record(z.string(), z.unknown())),
  allResults: z.array(z.unknown()),
  failedPasses: z.array(z.unknown()),
  verdict: z.string(),
  high: z.number().int(),
  medium: z.number().int(),
  low: z.number().int(),
  suppressionData: z.unknown().optional(),
  debtMemoryData: z.unknown().optional(),
  ledgerRejectedCount: z.number().int().optional(),
  ledgerWriteError: z.string().optional(),
  linterOverlapData: z.unknown().optional(),
  reopenedSet: z.instanceof(Set),
  // Registry-derived usage/cache/timing/summary accounting — computed here
  // (not by 4c/4d) because it is a direct, contiguous continuation of
  // pass-registry assembly, over the SAME `passRegistry`/`allResults` this
  // function already builds.
  totalUsage: z.record(z.string(), z.unknown()),
  cacheMetrics: z.unknown(),
  passTimings: z.record(z.string(), z.string()),
  summaryLines: z.array(z.string()),
}).strict();

/** 4c's own capability handles — non-serializable, injected only into run-persistence.mjs. */
export const PersistenceServicesSchema = z.object({
  writeOutcomes: z.record(z.string(), z.unknown()),
}).strict();

/** 4d's own capability handles — non-serializable, injected only into run-telemetry.mjs. */
export const TelemetryServicesSchema = z.object({
  writeOutcomes: z.record(z.string(), z.unknown()),
}).strict();

/** What the coordinator returns to the orchestration spine. */
export const FinalizationResultSchema = z.object({
  mergedResult: z.record(z.string(), z.unknown()),
}).strict();

function validate(schema, value, label) {
  const result = schema.safeParse(value);
  if (!result.success) {
    throw new Error(`[finalization-contract] ${label} failed validation: ${result.error.message}`);
  }
  return result.data;
}

export const validateFinalizationData = (value) => validate(FinalizationDataSchema, value, 'FinalizationData');
export const validateAssembledFindings = (value) => validate(AssembledFindingsSchema, value, 'AssembledFindings');
export const validatePersistenceServices = (value) => validate(PersistenceServicesSchema, value, 'PersistenceServices');
export const validateTelemetryServices = (value) => validate(TelemetryServicesSchema, value, 'TelemetryServices');
export const validateFinalizationResult = (value) => validate(FinalizationResultSchema, value, 'FinalizationResult');
