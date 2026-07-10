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
  costAmountUsd: z.number().min(0),
  // Snapshotted at RECORDING time (round-3 finding #G2) — immutable once
  // written. A report may additionally show a live-rate re-estimate
  // alongside these, but these two fields never change retroactively.
  costAmountEurAtRecordedFx: z.number().min(0),
  fxRateUsed: z.number().positive(),
  wallClockMs: z.number().int().min(0),
  usageReliability: z.enum(['exact', 'estimated', 'unavailable']),
  createdAt: z.string().datetime(),
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
    costAmountUsd = priced.totalUsd ?? 0;
    inputTokens = priced.inputTokens;
    outputTokens = priced.outputTokens;
    usageReliability = priced.priced ? 'estimated' : 'unavailable';
  }

  return UsageEventSchema.parse({
    provider: raw.provider,
    modelSentinel: raw.modelSentinel,
    resolvedModel: raw.resolvedModel,
    inputTokens,
    outputTokens,
    cachedTokens: raw.usage?.cached_tokens ?? null,
    costAmountUsd,
    costAmountEurAtRecordedFx: toEur(costAmountUsd) ?? 0,
    fxRateUsed: EUR_PER_USD,
    wallClockMs: raw.wallClockMs ?? 0,
    usageReliability,
    createdAt,
  });
}
