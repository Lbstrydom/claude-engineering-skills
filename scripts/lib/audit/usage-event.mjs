/**
 * @fileoverview UsageEvent — provider-neutral cost/usage record for the
 * tiered-recall audit pipeline's cost-budget tracking.
 *
 * Plan: docs/plans/tiered-recall-audit-pipeline.md Phase 4 (round-1 finding
 * #13: cover all four providers, not just OpenAI/Anthropic; round-3 Gemini
 * gate finding #G2: snapshot the EUR conversion at RECORDING time, never
 * recompute it later from a "current" rate — that guarantees the exact
 * historical corruption the original draft's "convert at report time"
 * design claimed to prevent).
 *
 * @module scripts/lib/audit/usage-event
 */

import { z } from 'zod';
import { costFromUsage, toEur, EUR_PER_USD } from '../model-pricing.mjs';

export const UsageEventSchema = z.object({
  provider: z.enum(['openai', 'anthropic', 'gemini', 'oss']),
  modelSentinel: z.string().max(100),
  resolvedModel: z.string().max(100),
  inputTokens: z.number().int().min(0),
  outputTokens: z.number().int().min(0),
  cachedTokens: z.number().int().min(0).nullable().optional(),
  // Nullable since the c5808479 fix: an unpriced OR unmeterable call has no
  // knowable cost, and `0` is a lie about it that no reader can distinguish
  // from a genuinely free call. `usageReliability` says WHY it is absent. This
  // is a WIDENING, so every historical serialized event still parses.
  // `.finite()` (audit R2 H1): `Infinity >= 0` is true, so `min(0)` alone let a
  // non-finite amount through into a persisted/serialized event — and
  // JSON.stringify writes Infinity as `null`, corrupting it on the way out.
  // model-eval/cost.mjs's sibling monetary field already carried `.finite()`;
  // this one did not, and the two schemas describe the same kind of value.
  costAmountUsd: z.number().finite().min(0).nullable(),
  // Snapshotted at RECORDING time (round-3 finding #G2) — immutable once
  // written. A report may additionally show a live-rate re-estimate
  // alongside these, but these two fields never change retroactively.
  costAmountEurAtRecordedFx: z.number().finite().min(0).nullable(),
  fxRateUsed: z.number().finite().positive(),
  wallClockMs: z.number().int().min(0),
  usageReliability: z.enum(['exact', 'estimated', 'unavailable']),
  createdAt: z.string().datetime(),
}).superRefine((v, ctx) => {
  // Audit R1 H2/M5 — making the money fields nullable widened this schema, and
  // a widened schema with three independently-validated fields can express
  // states the contract forbids: `'exact'` with no amount, or `'unavailable'`
  // WITH one — which is exactly the fabricated-$0 shape the c5808479 fix
  // removed from buildUsageEvent, left constructible through the schema itself.
  // usageReliability is the discriminator, so bind the amounts to it.
  const hasUsd = v.costAmountUsd != null;
  const hasEur = v.costAmountEurAtRecordedFx != null;
  if (v.usageReliability === 'unavailable' && (hasUsd || hasEur)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'usageReliability:"unavailable" must carry null costAmountUsd/costAmountEurAtRecordedFx — an unknowable cost has no amount' });
  }
  if (v.usageReliability !== 'unavailable' && !hasUsd) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: `usageReliability:"${v.usageReliability}" requires a non-null costAmountUsd — a known cost must state its amount` });
  }
  // The two currencies are one snapshotted amount in two units; one present
  // without the other is a half-written record either way.
  if (hasUsd !== hasEur) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'costAmountUsd and costAmountEurAtRecordedFx must be both present or both null' });
  }
  // Audit R2 M5 — joint PRESENCE was checked but not joint VALUE, so the pair
  // could disagree while passing. The whole point of snapshotting fxRateUsed
  // (round-3 #G2) is that the EUR figure is reproducible from the USD one at
  // the rate recorded beside it; if it is not, one of the three is wrong and
  // the record cannot be audited later. Scaled tolerance, since the product is
  // a float multiplication.
  if (hasUsd && hasEur) {
    const expectedEur = v.costAmountUsd * v.fxRateUsed;
    if (Math.abs(v.costAmountEurAtRecordedFx - expectedEur) > 1e-9 * Math.max(1, Math.abs(expectedEur))) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: `costAmountEurAtRecordedFx (${v.costAmountEurAtRecordedFx}) must equal costAmountUsd x fxRateUsed (${expectedEur}) — the EUR figure is a snapshot of the USD one, not an independent number` });
    }
  }
});

/**
 * Build a validated UsageEvent from a raw provider usage object + resolved
 * model id, reusing this codebase's existing pricing engine
 * (`model-pricing.mjs::costFromUsage`/`toEur`) rather than re-deriving cost
 * from scratch (#1 DRY). Pure — no I/O, no clock access; `createdAt` is
 * caller-supplied so this function is deterministic and independently
 * testable. `EUR_PER_USD` is read ONCE here and snapshotted into the event
 * as `fxRateUsed` (round-3 finding #G2) — never recomputed later.
 *
 * @param {object} raw
 * @param {'openai'|'anthropic'|'gemini'|'oss'} raw.provider
 * @param {string} raw.modelSentinel
 * @param {string} raw.resolvedModel - concrete model id, used to look up pricing
 * @param {object|null} raw.usage - provider usage object ({input_tokens,output_tokens,...} or {prompt_tokens,completion_tokens})
 * @param {number} [raw.wallClockMs]
 * @param {number} [raw.selfReportedCostUsd] - when the backend self-reports
 *   cost (e.g. the Claude CLI backend's `total_cost_usd`), pass it here to
 *   mark the event `usageReliability: 'exact'` and skip token-based pricing.
 * @param {string} createdAt - ISO timestamp, caller-supplied (no Date.now() here)
 * @returns {import('zod').infer<typeof UsageEventSchema>}
 * @throws {import('zod').ZodError} if the resulting event doesn't conform
 */
export function buildUsageEvent(raw, createdAt) {
  if (!raw || typeof raw !== 'object') {
    throw new Error('buildUsageEvent: raw must be an object');
  }
  let costAmountUsd;
  let inputTokens;
  let outputTokens;
  let usageReliability;

  if (typeof raw.selfReportedCostUsd === 'number') {
    costAmountUsd = raw.selfReportedCostUsd;
    inputTokens = raw.usage?.input_tokens ?? raw.usage?.prompt_tokens ?? 0;
    outputTokens = raw.usage?.output_tokens ?? raw.usage?.completion_tokens ?? 0;
    usageReliability = 'exact';
  } else {
    const priced = costFromUsage(raw.usage, raw.resolvedModel);
    // c5808479 fix — this was `priced.totalUsd ?? 0` with the reliability
    // keyed on `priced.priced` alone, so an unmeterable call on a PRICED model
    // was recorded as `estimated $0`: a fabricated amount under a label that
    // claims it was calculated. Both halves had to change — relabelling alone
    // still writes a `0` to disk that no reader can tell from a free call.
    // `unmeterable` and unpriced are both "no knowable cost", so both take the
    // pre-existing 'unavailable' state that computeCostReport already excludes
    // from `costUsd` and counts in `unavailableCostEventCount`.
    const knowable = priced.priced && !priced.unmeterable;
    costAmountUsd = knowable ? priced.totalUsd : null;
    inputTokens = priced.inputTokens;
    outputTokens = priced.outputTokens;
    usageReliability = knowable ? 'estimated' : 'unavailable';
  }

  return UsageEventSchema.parse({
    provider: raw.provider,
    modelSentinel: raw.modelSentinel,
    resolvedModel: raw.resolvedModel,
    inputTokens,
    outputTokens,
    cachedTokens: raw.usage?.cached_tokens ?? null,
    costAmountUsd,
    // `?? 0` dropped with the same fix: toEur() already passes null through,
    // and coercing it back to 0 would re-fabricate in EUR exactly what the
    // line above stopped fabricating in USD.
    costAmountEurAtRecordedFx: toEur(costAmountUsd),
    fxRateUsed: EUR_PER_USD,
    wallClockMs: raw.wallClockMs ?? 0,
    usageReliability,
    createdAt,
  });
}

/**
 * Fail-open wrapper around `buildUsageEvent` for capture sites where usage/cost
 * is ADVISORY telemetry, not a correctness input — the tiered pipeline's
 * per-stage capture (`tiered-pipeline.mjs`). A malformed provider usage object,
 * an unknown provider, or a missing field must degrade to a dropped event
 * (`null`), NEVER throw up through a discovery/Stage-1/Stage-2 call and abort
 * the audit. (An UNPRICED model is not a failure — `buildUsageEvent` returns a
 * valid `usageReliability: 'unavailable'` event, kept so `computeCostReport`
 * can count it in `unavailableCostEventCount`.)
 * @param {object} raw - same shape as `buildUsageEvent`'s first argument
 * @param {string} createdAt - ISO timestamp
 * @returns {import('zod').infer<typeof UsageEventSchema>|null}
 */
export function tryBuildUsageEvent(raw, createdAt) {
  try {
    return buildUsageEvent(raw, createdAt);
  } catch {
    return null;
  }
}
