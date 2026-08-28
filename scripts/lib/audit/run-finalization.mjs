/**
 * @fileoverview The thin finalization coordinator
 * (docs/plans/legacy-production-audit-decomposition.md Phase 4) — validates
 * the `FinalizationData` snapshot (4a's contract), calls 4b
 * (`finding-assembly.mjs`) then 4d (`run-telemetry.mjs`) then 4c
 * (`run-persistence.mjs`) in that fixed order — preserving the ORIGINAL
 * source order of the pre-split tail — and composes the final `mergedResult`
 * from their outputs plus the spine-computed fields `FinalizationData`
 * already carries.
 *
 * Scope is sequencing plus final result composition — never independent
 * business logic: it may compose 4b/4c/4d's own return values into the
 * declared shape, but must not compute a NEW value none of them already
 * produced.
 *
 * `writeOutcomes` is threaded in from the SPINE, not created here: the tally
 * is declared early in `runLegacyProductionAudit` (before this coordinator
 * exists) so pre-wave writes (`audit.planLink`, `audit.diffComplexity`) also
 * land in it — a fresh object here would silently drop those.
 *
 * Cache-lifecycle note: `cleanupCache()` is NOT called here. It is owned by
 * the orchestration spine's own top-level `try/finally`, which wraps every
 * wave AND this coordinator call — narrowing cleanup to only this
 * coordinator's scope would miss a failure during an earlier wave, before
 * this module is ever reached (Gemini gate round-1 G1 correction).
 *
 * @module scripts/lib/audit/run-finalization
 */

import { assembleFindings } from './finding-assembly.mjs';
import { runTelemetry } from './run-telemetry.mjs';
import { runPersistence } from './run-persistence.mjs';
import { buildExecutionMeta } from '../schemas.mjs';
import { loadOutcomes } from '../findings.mjs';
import { spillSummary } from '../durable-write.mjs';
// Documented allow-list exception (final-review finding, union-diff gate):
// the plan's literal text says the coordinator "may import finalization-
// contract.mjs and the 3 stage modules" — nothing else. Needed here because
// `_executionMeta` (part of the coordinator's own mergedResult composition)
// is derived from `passRegistry`, 4b's own output, and this one aggregation
// already lives in pass-result-cache.mjs (a pre-existing Phase-1 module) —
// duplicating it would be the actual regression. Asserted explicitly, not
// silently allowed: tests/finalization-module-layering.test.mjs.
import { collectReducePassStatuses } from './pass-result-cache.mjs';
import { validateFinalizationData, validateFinalizationResult } from './finalization-contract.mjs';

/**
 * @param {import('./finalization-contract.mjs').FinalizationDataSchema} data
 * @param {{written:number, spilled:number, lost:number, skipped:number, byWriter:Record<string,object>}} writeOutcomes
 *   the SAME tally object the spine has been accumulating into since before
 *   this coordinator was ever called.
 * @returns {Promise<import('./finalization-contract.mjs').FinalizationResultSchema>}
 */
export async function finalizeRun(data, writeOutcomes) {
  validateFinalizationData(data);

  // 4b — pure function. A throw here aborts before 4c/4d ever run (per the
  // finalization behavior matrix: "throws; coordinator aborts before 4c/4d").
  const assembled = await assembleFindings(data);

  const {
    structureResult, allPaths, found, missing, wiringResult,
    backendResults, frontendResult, sustainResult, cloudRunId, toolCapability,
  } = data;
  const {
    allFindings, passRegistry, verdict,
    totalUsage, cacheMetrics, passTimings, summaryLines,
  } = assembled;

  const mergedResult = {
    verdict,
    files_planned: structureResult.result.files_planned ?? allPaths.size,
    files_found: structureResult.result.files_found ?? found.length,
    files_missing: structureResult.result.files_missing ?? missing.length,
    code_files: found,
    findings: allFindings,
    wiring_issues: wiringResult.result.wiring_issues ?? [],
    quick_fix_warnings: [
      ...backendResults.flatMap(r => r.result.quick_fix_warnings ?? []),
      ...(frontendResult.result.quick_fix_warnings ?? []),
      ...(sustainResult.result.quick_fix_warnings ?? [])
    ],
    dead_code: sustainResult.result.dead_code ?? [],
    overall_reasoning: summaryLines.join('\n'),
    _pass_timings: passTimings,
    _failed_passes: assembled.failedPasses.length > 0 ? assembled.failedPasses : undefined,
    _usage: totalUsage,
    _cacheMetrics: cacheMetrics,
    // Typed shape: ExecutionMetaSchema (schemas.mjs), VALIDATED by the builder
    // rather than merely resembling it. `undefined` inputs are dropped and an
    // all-empty block collapses to `undefined`, so a clean round still carries
    // no key at all — absence keeps meaning "nothing degraded", and a hard 0
    // can never read as a measurement nobody took.
    _executionMeta: buildExecutionMeta({
      suppressionUnavailable: data.suppressionUnavailable || undefined,
      ledgerInvalidEntryCount: data.ledgerInvalidEntryCount > 0 ? data.ledgerInvalidEntryCount : undefined,
      // Per-pass REDUCE degradation.
      reducePassStatuses: collectReducePassStatuses(passRegistry),
    }),
  };

  // Attach 4b's optional fields — mirrors the original var-hoisting guard,
  // now expressed as "was this optional field present on 4b's return".
  if (assembled.suppressionData !== undefined) mergedResult._suppression = assembled.suppressionData;
  if (assembled.debtMemoryData !== undefined) mergedResult._debtMemory = assembled.debtMemoryData;
  if (assembled.ledgerRejectedCount !== undefined) mergedResult._ledgerRejectedCount = assembled.ledgerRejectedCount;
  if (assembled.ledgerWriteError !== undefined) mergedResult._ledgerWriteError = assembled.ledgerWriteError;
  if (assembled.linterOverlapData !== undefined) mergedResult._linterOverlap = assembled.linterOverlapData;

  // Attach cloud run ID to result for orchestrator reference. The /audit-code
  // skill reads `_cloudRunId` from the audit --out JSON and forwards it to
  // gemini-review.mjs as `--run-id`, which keys the final-review (+ shadow A/B)
  // per-finding cloud persistence to this run. Absent when cloud is off →
  // gemini-review runs local-only (docs/plans/final-review-shadow-reviewer.md).
  if (cloudRunId) mergedResult._cloudRunId = cloudRunId;

  // Phase C: surface tool-pre-pass capability state
  mergedResult._toolCapability = toolCapability;

  // 4d then 4c, in that fixed order — preserves the ORIGINAL source order.
  // A 4d failure is best-effort/swallowed internally and never propagates
  // here; a 4c failure that escapes its own internal try/catch would abort
  // before session-ledger bookkeeping, matching the pre-split behavior.
  await runTelemetry(data, assembled, mergedResult, { writeOutcomes });
  const { cloudPersistence } = await runPersistence(data, assembled, mergedResult, { writeOutcomes });
  mergedResult._cloudPersistence = cloudPersistence;

  // Phase 7 readiness nudge (every 10 runs)
  try {
    const outcomes = loadOutcomes('.audit/outcomes.jsonl');
    const runCount = new Set(outcomes.map(o => Math.floor(o.timestamp / 300000))).size;
    if (runCount > 0 && runCount % 10 === 0 && runCount < 50) {
      process.stderr.write(`\n  [phase-7] ${runCount}/50 audit runs completed — ${50 - runCount} more for predictive strategy\n`);
    } else if (runCount >= 50) {
      process.stderr.write(`\n  [phase-7] ✓ ${runCount} runs — Phase 7 (predictive strategy) is ready to implement!\n`);
    }
  } catch { /* ignore */ }

  // Phase 11: this branch never ran a discovery-portfolio generator, and
  // completed (no required-generator-failure fallback exists here — THIS
  // function IS the fallback target). AuditRunResultSchema requires both
  // fields on every return, per both orchestrators.
  mergedResult.generatorOutcomes = [];

  // Durability plan decision 3 — the outcome contract.
  //
  // `runStatus` is no longer unconditionally 'complete'. A run that produced
  // findings it could NOT durably record is `incomplete`, and saying so is the
  // whole point: the failure this plan exists for is a run that looks healthy
  // and under-reports. `lost` (not `spilled`) is the trigger — a spilled write
  // is queued and a later drain will apply it, whereas a lost one is only
  // evidence in `lost/` and will never reach the store on its own.
  // SPILLED counts too (Cluster B audit M16). At the moment this row is
  // written the data is NOT in the store, so `complete` is a claim about a
  // state that does not yet exist. `write_outcomes` carries which of the two
  // it was, so "will be retried" and "never" stay distinguishable.
  //
  // 68583a69: a failed LOCAL ledger write (`_ledgerWriteError`, attached above
  // from 4b's optional field) is the same failure shape one layer down — data
  // this run produced that did not durably land. Folding it in means an R2+
  // round that silently lost its suppression state is no longer
  // indistinguishable, from the outside, from one that recorded everything.
  mergedResult.writeOutcomes = writeOutcomes;
  // The ledger-failure override wraps the pinned durability expression rather
  // than editing it in place, on purpose: that inline ternary is pinned
  // byte-identical across every `runStatus`-deriving site by the durability
  // test suite (tests/audit-store-durability-call-site.test.mjs), and a new
  // spelling at only one site is exactly the drift-between-sites class that
  // test exists to catch. Applied at all three sites this expression appears.
  const _ledgerWriteError = mergedResult._ledgerWriteError;
  mergedResult.runStatus = typeof _ledgerWriteError !== 'undefined'
    ? 'incomplete'
    : (writeOutcomes.lost > 0 || writeOutcomes.spilled > 0 ? 'incomplete' : 'complete');

  // Say it where a human will see it. A count that only ever reaches a column
  // is better than stderr, but the operator running the audit is the one who
  // can act now, and `spillSummary` is what tells them whether the backlog is
  // growing. Printed only when there is something to say.
  if (writeOutcomes.lost > 0 || writeOutcomes.spilled > 0) {
    const summary = spillSummary();
    const age = summary.oldestAgeMs == null ? 'n/a' : `${Math.round(summary.oldestAgeMs / 60000)}m`;
    process.stderr.write(
      `  [durable-write] ${writeOutcomes.written} written, ${writeOutcomes.spilled} spilled, ${writeOutcomes.lost} lost `
      + `— queue: ${summary.state === 'ok' ? `${summary.spilled} pending (oldest ${age}), ${summary.lost} unreplayable` : summary.reason}\n`,
    );
  }

  return validateFinalizationResult({ mergedResult });
}
