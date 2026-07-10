/**
 * @fileoverview ReviewEffortEvent — manually-logged human review time, kept
 * as a SEPARATE schema from UsageEvent (round-2 finding #7 — the original
 * draft mixed cost and operator-minutes into one ambiguous scalar).
 *
 * Operator-minutes are NOT inferred from model wall-clock (that's latency,
 * not human time) — this is an explicit v1 limitation: auto-tracking human
 * review time is out of scope; a person (or the human-queue UI, once one
 * exists) logs start/end.
 *
 * Plan: docs/plans/tiered-recall-audit-pipeline.md Phase 4.
 * @module scripts/lib/audit/review-effort-event
 */

import { z } from 'zod';

// Cluster B audit fixes M4/L3: real ISO datetimes (not arbitrary strings),
// endedAt >= startedAt enforced, minutesSpent finite with a sane ceiling
// (24h/review — catches unit errors like seconds-as-minutes, not a real cap).
//
// Round-2 audit fixes M5/M9: `minutesSpent` is caller-supplied (see
// `buildReviewEffortEvent` docstring) so it may legitimately be LESS than the
// startedAt..endedAt interval (breaks, interruptions) — but it can never
// exceed the interval, since active review time can't outrun wall-clock time.
// A one-minute interval claiming 300 minutesSpent is exactly the impossible
// case `computeCostReport`'s per-accepted-HIGH metric would otherwise trust
// silently; a small tolerance (1 minute) absorbs rounding on caller-supplied
// timestamps without weakening the check.
export const ReviewEffortEventSchema = z.object({
  envelopeId: z.string().max(100),
  reviewerId: z.string().max(100).nullable().optional(),
  startedAt: z.string().datetime(),
  endedAt: z.string().datetime(),
  minutesSpent: z.number().finite().min(0).max(1440),
}).superRefine((e, ctx) => {
  const startMs = new Date(e.startedAt).getTime();
  const endMs = new Date(e.endedAt).getTime();
  if (endMs < startMs) {
    ctx.addIssue({ code: 'custom', path: ['endedAt'], message: 'endedAt must not be before startedAt' });
    return;
  }
  const intervalMinutes = (endMs - startMs) / 60000;
  if (e.minutesSpent > intervalMinutes + 1) {
    ctx.addIssue({
      code: 'custom',
      path: ['minutesSpent'],
      message: `minutesSpent (${e.minutesSpent}) exceeds the startedAt..endedAt interval (${intervalMinutes.toFixed(2)} min)`,
    });
  }
});

/**
 * Build a validated ReviewEffortEvent. Pure — `minutesSpent` is caller-
 * computed (not derived from wall-clock timestamps here) so a caller with a
 * stopwatch/UI-tracked duration can supply it directly without this module
 * doing its own date-math.
 *
 * @param {object} raw
 * @returns {import('zod').infer<typeof ReviewEffortEventSchema>}
 * @throws {Error} plain Error if `raw` is missing or not an object
 * @throws {import('zod').ZodError} if `raw` is an object but doesn't conform to the schema
 */
export function buildReviewEffortEvent(raw) {
  if (!raw || typeof raw !== 'object') {
    throw new Error('buildReviewEffortEvent: raw must be an object');
  }
  return ReviewEffortEventSchema.parse({
    envelopeId: raw.envelopeId,
    reviewerId: raw.reviewerId ?? null,
    startedAt: raw.startedAt,
    endedAt: raw.endedAt,
    minutesSpent: raw.minutesSpent,
  });
}
