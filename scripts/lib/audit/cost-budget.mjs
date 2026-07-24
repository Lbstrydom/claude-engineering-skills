/**
 * @fileoverview Cost-budget tracking — the end-to-end euros+operator-minutes
 * per accepted-HIGH-equivalent metric for the tiered-recall audit pipeline.
 *
 * Plan: docs/plans/tiered-recall-audit-pipeline.md Phase 4.
 *
 * Persistence reuses this codebase's existing `AppendOnlyStore`
 * (`lib/file-store.mjs` — already battle-tested for outcomes/evaluations)
 * rather than hand-rolled read-modify-write JSON (audit-code Cluster B
 * findings H5/H6/H8/M4/M8/M9, all closed by this reuse): appends are
 * lock-guarded (safe under the audit pipeline's parallel passes),
 * schema-validated on write (malformed events are quarantined, never
 * silently persisted), and JSONL-append semantics mean a corrupt file can
 * never be misread as "empty" and then overwritten — `readJsonlFile` skips
 * only the individual bad LINE, with a warning, never the whole file.
 *
 * `computeCostReport` is PURE (no I/O) so it's directly unit-testable.
 *
 * @module scripts/lib/audit/cost-budget
 */

import { AppendOnlyStore, readJsonlFile } from '../file-store.mjs';
import { UsageEventSchema } from './usage-event.mjs';
import { ReviewEffortEventSchema } from './review-effort-event.mjs';
import { DECISION_CONSTANTS } from '../model-ab-decision.mjs';

const SEV_WEIGHTS = DECISION_CONSTANTS.SEV_WEIGHTS; // reused, not reinvented — round-2 finding #7

/**
 * Pure computation over already-loaded event/finding arrays.
 *
 * `acceptedHighEquivalentCount` (round-2 finding #7): severity-weighted count
 * of accepted findings, using the SAME `SEV_WEIGHTS` ratios already in
 * production use (`model_ab_finding_scores`) — a HIGH counts as 1.0
 * equivalent, a MEDIUM as 3/8, etc.
 *
 * Unavailable pricing is tracked SEPARATELY from the cost sum (audit-code
 * Cluster B finding H7/M12) — a `usageReliability: 'unavailable'` event
 * contributes to `unavailableCostEventCount` and is EXCLUDED from `costUsd`,
 * rather than being silently summed in as a confirmed $0. `costUsd` therefore
 * reflects only priced events; `unavailableCostEventCount > 0` tells the
 * caller the true total may be higher than reported.
 *
 * Zero-accepted-HIGH edge case: returns nulls for the per-equivalent rates
 * with an explicit `reason`, rather than dividing by zero or silently
 * reporting 0 (AGENTS.md "audit your success paths").
 *
 * @param {object} inputs
 * @param {Array<import('zod').infer<typeof UsageEventSchema>>} inputs.usageEvents
 * @param {Array<import('zod').infer<typeof ReviewEffortEventSchema>>} inputs.reviewEffortEvents
 * @param {Array<{severity: 'HIGH'|'MEDIUM'|'LOW'}>} inputs.acceptedFindings - findings that
 *   reached `stage2_verified` or `stage2_missed_candidate` this run
 * @returns {{costUsd: number, costEurAsRecorded: number, operatorMinutes: number,
 *   unavailableCostEventCount: number,
 *   acceptedHighEquivalentCount: number, costUsdPerAcceptedHigh: number|null,
 *   operatorMinutesPerAcceptedHigh: number|null, reason?: string}}
 */
export function computeCostReport({ usageEvents = [], reviewEffortEvents = [], acceptedFindings = [] }) {
  let costUsd = 0;
  let costEurAsRecorded = 0;
  let unavailableCostEventCount = 0;
  for (const e of usageEvents) {
    if (e.usageReliability === 'unavailable') { unavailableCostEventCount += 1; continue; }
    costUsd += e.costAmountUsd || 0;
    costEurAsRecorded += e.costAmountEurAtRecordedFx || 0;
  }
  const operatorMinutes = reviewEffortEvents.reduce((s, e) => s + (e.minutesSpent || 0), 0);
  const acceptedHighEquivalentCount = acceptedFindings.reduce((s, f) => {
    const w = SEV_WEIGHTS[String(f.severity || '').toUpperCase()];
    return s + (typeof w === 'number' ? w / SEV_WEIGHTS.HIGH : 0);
  }, 0);

  if (acceptedHighEquivalentCount === 0) {
    return {
      costUsd, costEurAsRecorded, operatorMinutes, unavailableCostEventCount,
      acceptedHighEquivalentCount: 0,
      costUsdPerAcceptedHigh: null,
      operatorMinutesPerAcceptedHigh: null,
      reason: 'no-accepted-highs',
    };
  }

  return {
    costUsd, costEurAsRecorded, operatorMinutes, unavailableCostEventCount, acceptedHighEquivalentCount,
    costUsdPerAcceptedHigh: costUsd / acceptedHighEquivalentCount,
    operatorMinutesPerAcceptedHigh: operatorMinutes / acceptedHighEquivalentCount,
  };
}

/**
 * Build the `_usage` cost block from a run's captured usage events. `costUsd`
 * is the REAL priced sum when any captured event was priceable, else `null`
 * (honestly unmeasured) — never a fabricated `0` from empty or all-
 * `unavailable` events (the 2026-07-22 defect this closes). The rest of the
 * cost report (`unavailableCostEventCount`, per-accepted-HIGH rates, …)
 * passes through so a partially-priced run stays diagnosable.
 *
 * `droppedUsageEventCount`: events that failed to build at all
 * (`tryBuildUsageEvent` returned null) never reach `computeCostReport`, so
 * they wouldn't even land in `unavailableCostEventCount` — a silent
 * under-count. Surfacing the drop count makes "cost may be higher than
 * reported" visible, mirroring `unavailableCostEventCount`'s own semantics.
 *
 * @param {Array<object>} usageEvents - events from `tryBuildUsageEvent` (may be empty)
 * @param {Array<{severity: string}>} [acceptedFindings]
 * @param {number} [droppedCount] - events `tryBuildUsageEvent` could not build
 */
export function buildUsageBlock(usageEvents, acceptedFindings = [], droppedCount = 0) {
  const report = computeCostReport({ usageEvents, reviewEffortEvents: [], acceptedFindings });
  const hasPricedUsage = usageEvents.some((e) => e && e.usageReliability !== 'unavailable');
  return { ...report, costUsd: hasPricedUsage ? report.costUsd : null, droppedUsageEventCount: droppedCount };
}

/** @returns {AppendOnlyStore} a schema-validating, lock-guarded store for UsageEvents at `filePath`. */
export function openUsageEventStore(filePath) {
  return new AppendOnlyStore(filePath, { schema: UsageEventSchema });
}

/** @returns {AppendOnlyStore} a schema-validating, lock-guarded store for ReviewEffortEvents at `filePath`. */
export function openReviewEffortStore(filePath) {
  return new AppendOnlyStore(filePath, { schema: ReviewEffortEventSchema });
}

/** Append one UsageEvent (schema-validated; invalid events are quarantined, not persisted). */
export function recordUsageEvent(filePath, event) {
  openUsageEventStore(filePath).append(event);
}

/** Append one ReviewEffortEvent (schema-validated; invalid events are quarantined, not persisted). */
export function recordReviewEffort(filePath, event) {
  openReviewEffortStore(filePath).append(event);
}

/**
 * Load + re-validate every record through UsageEventSchema (audit fix M7 —
 * `AppendOnlyStore.append` validates on WRITE, but a record written by an
 * older schema version, or corrupted by some path other than this module,
 * would otherwise reach `computeCostReport` unvalidated, where `|| 0`
 * defaults could silently launder malformed numeric fields into the report).
 * Invalid records are dropped with a stderr warning, never silently included.
 */
export function loadUsageEvents(filePath) {
  // consolidated-gate fix (Gemini gate, round 1): `.filter()` returned the
  // RAW record `r` whenever validation succeeded, never the validated
  // `result.data` — bypassing any Zod defaults/transforms/`.strip()` the
  // schema defines. `computeCostReport` (called from `tiered-pipeline.mjs`,
  // Cluster E's own new code) consumes this array directly, so a raw
  // record silently diverging from the schema's canonical shape is
  // load-bearing here, not just a cosmetic gap.
  const out = [];
  for (const r of readJsonlFile(filePath)) {
    const result = UsageEventSchema.safeParse(r);
    if (!result.success) { process.stderr.write(`  [cost-budget] Skipping invalid UsageEvent in ${filePath}\n`); continue; }
    out.push(result.data);
  }
  return out;
}

/** Load + re-validate every record through ReviewEffortEventSchema — see `loadUsageEvents`. */
export function loadReviewEffortEvents(filePath) {
  const out = [];
  for (const r of readJsonlFile(filePath)) {
    const result = ReviewEffortEventSchema.safeParse(r);
    if (!result.success) { process.stderr.write(`  [cost-budget] Skipping invalid ReviewEffortEvent in ${filePath}\n`); continue; }
    out.push(result.data);
  }
  return out;
}
