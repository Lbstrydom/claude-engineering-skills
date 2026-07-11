/**
 * @fileoverview Cost event correlation for the model swap-in evaluation
 * harness. Wraps the EXISTING model-pricing.mjs — no second pricing source.
 *
 * Plan: docs/plans/model-swap-eval-harness.md — File-Level Plan Phase 1.
 *
 * @module scripts/lib/model-eval/cost
 */

import { z } from 'zod';
import { priceFor, isPriced, costFromUsage, PRICING_VERSION } from '../model-pricing.mjs';
import { RoleSchema, ProviderSchema } from './contracts.mjs';

export const ModelEvalUsageEventSchema = z.object({
  runId: z.string().min(1),
  role: RoleSchema,
  phase: z.enum(['generation', 'extraction', 'judge']),
  armId: z.string().nullable(),
  candidateRef: z.string().min(1),
  provider: ProviderSchema,
  resolvedModel: z.string().min(1),
  // Round-6 audit M2 fix — buildUsageEvent() required a separate
  // pricingModel input but discarded it from the persisted event, so a
  // stored row couldn't be traced back to what actually priced it (resolvedModel
  // is the underlying model identity, NOT the pricing SKU for Azure routes —
  // see the H8 fix note on buildUsageEvent below).
  pricingModel: z.string().min(1),
  deploymentId: z.string().nullable(),
  // Round-9 audit H11 fix — the provider's usage object can itself be
  // null/absent (an error path, or a provider that doesn't report usage).
  // sanitizeTokens() clamps that to 0 either way, so inputTokens/outputTokens
  // alone can't distinguish "captured, genuinely zero" (essentially
  // impossible for a real completion) from "never captured." usageStatus
  // makes that distinction explicit and load-bearing.
  usageStatus: z.enum(['captured', 'missing']),
  inputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
  priceTableVersion: z.string().min(1),
  // Round-6 audit M1 fix — a monetary field must be finite and non-negative;
  // an unconstrained z.number() silently accepted NaN/Infinity/negative
  // "costs" from a corrupted usage payload.
  costUsd: z.number().finite().nonnegative().nullable(),
  // Implementation M7/L2/L4/M13 fix — capturedAt is nullable and NEVER
  // synthesized: a builder does not invent missing operational metadata.
  // null means "provider did not report a capture time," visible as such,
  // not disguised as a plausible-looking 1970 sentinel.
  // Round-7 audit L1 fix — a non-null value must be a real ISO 8601
  // timestamp (every caller constructs it via `new Date().toISOString()`),
  // not an arbitrary string that would silently corrupt time-correlation.
  capturedAt: z.string().datetime().nullable(),
}).superRefine((v, ctx) => {
  if (v.usageStatus === 'missing' && v.costUsd != null) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'usageStatus:"missing" must not carry a non-null costUsd — an uncaptured usage cannot have been priced' });
  }
});

const CostPhaseEntrySchema = z.object({
  usd: z.number().finite().nonnegative().nullable(),
  status: z.enum(['available', 'unavailable']),
}).superRefine((v, ctx) => {
  if (v.status === 'available' && v.usd == null) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'status:"available" requires a non-null usd' });
  }
  if (v.status === 'unavailable' && v.usd != null) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'status:"unavailable" requires usd:null' });
  }
});

// Round-7 audit M2 fix — costStatus/totalUsd and each byPhase entry's
// status/usd were independently nullable, so a schema-valid row could claim
// costStatus:'available' with totalUsd:null (or the reverse) — an internally
// contradictory cost row a downstream reader can't sanely interpret.
export const CostRowSchema = z.object({
  runId: z.string().min(1),
  role: RoleSchema,
  armId: z.string().nullable(),
  candidateRef: z.string().min(1),
  totalUsd: z.number().finite().nonnegative().nullable(),
  costStatus: z.enum(['available', 'unavailable']),
  byPhase: z.record(z.string(), CostPhaseEntrySchema),
}).superRefine((v, ctx) => {
  if (v.costStatus === 'available' && v.totalUsd == null) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'costStatus:"available" requires a non-null totalUsd' });
  }
  if (v.costStatus === 'unavailable' && v.totalUsd != null) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'costStatus:"unavailable" requires totalUsd:null' });
  }
  // Round-10 audit M2 fix — totalUsd/costStatus and each byPhase entry were
  // validated independently, so a schema-valid row could claim a totalUsd
  // that doesn't match the sum of its own byPhase breakdown. Only checked
  // when every phase is priced (an unpriced phase already forces
  // costStatus:'unavailable'/totalUsd:null via assembleCostRows' own logic,
  // so there's nothing to sum in that case).
  if (v.costStatus === 'available') {
    const phaseValues = Object.values(v.byPhase);
    if (phaseValues.every((p) => p.usd != null)) {
      const sum = phaseValues.reduce((acc, p) => acc + p.usd, 0);
      if (Math.abs(sum - v.totalUsd) > 1e-9) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: `totalUsd (${v.totalUsd}) does not match the sum of byPhase entries (${sum})` });
      }
    }
  }
});

/**
 * @param {{runId, role, phase, armId, candidateRef, resolvedModel, pricingModel, deploymentId, provider, usage: object, capturedAt?: string|null}} args
 * @returns {z.infer<typeof ModelEvalUsageEventSchema>}
 */
export function buildUsageEvent({ runId, role, phase, armId, candidateRef, resolvedModel, pricingModel, deploymentId, provider, usage, capturedAt = null }) {
  // Implementation H8 fix — price against `pricingModel` (the underlying
  // model SKU, e.g. route-catalog.mjs's resolved pricingModel field), NEVER
  // `resolvedModel`/`deploymentId` directly for Azure routes — an Azure
  // deployment id is an arbitrary user-chosen name, not a valid
  // model-pricing.mjs key. For public/OSS routes pricingModel === resolvedModel.
  // Implementation H4/H10 fix — `pricingModel` is REQUIRED, never a silent
  // fallback to `resolvedModel` (route-catalog.mjs::resolveCandidateRoute
  // sets it unconditionally on every route kind — a caller supplying a
  // resolvedModel-only event has a real route-construction bug that must
  // surface, not be papered over).
  if (!pricingModel) {
    throw new Error('buildUsageEvent: pricingModel is required (route-catalog.mjs sets it on every resolved route — a missing value means the caller built this event without going through resolveCandidateRoute)');
  }
  // Implementation H11 fix — check pricing availability BEFORE computing
  // cost, an explicit branch rather than relying on costFromUsage's own
  // null-cost policy to paper over an unpriced model.
  const priced = isPriced(pricingModel);
  const cost = costFromUsage(usage, pricingModel);
  // Round-9 audit H11 fix (widened by round-10 H2/H4, round-11 H4) —
  // usage==null means the provider response never reported usage at all;
  // sanitizeTokens() clamps that to 0 tokens regardless, which would
  // otherwise look identical to a genuine (and essentially impossible)
  // zero-token completion. `usage: {}` — or any object missing a whole
  // SIDE (only input tokens, or only output tokens) — is the identical
  // failure mode: costFromUsage needs BOTH sides for a reliable total, so
  // a one-sided usage object must be 'missing' too, not just a fully-empty one.
  // Round-13 audit H4 fix — presence alone ("!= null") isn't enough; a
  // malformed provider payload could report input_tokens:"not-a-number" and
  // still pass this check, then sanitizeTokens() silently clamps it to 0 —
  // the same "garbage looks like a legitimate zero" failure mode this
  // whole usageStatus mechanism exists to prevent, just at the VALUE level
  // instead of the field-presence level.
  // Round-14 audit M3/M4 fix — finite alone still accepted a negative
  // token count; sanitizeTokens() clamps negatives to 0, so a malformed
  // input_tokens:-5 would still be tagged usageStatus:'captured' and priced
  // from a silently-zeroed count — a real-looking $0 cost instead of a
  // visible "missing" state. A token count can never legitimately be negative.
  const isValidTokenCount = (v) => typeof v === 'number' && Number.isFinite(v) && v >= 0;
  const hasInputTokenField = usage != null && (isValidTokenCount(usage.input_tokens) || isValidTokenCount(usage.prompt_tokens));
  const hasOutputTokenField = usage != null && (isValidTokenCount(usage.output_tokens) || isValidTokenCount(usage.completion_tokens));
  const usageStatus = (hasInputTokenField && hasOutputTokenField) ? 'captured' : 'missing';
  return ModelEvalUsageEventSchema.parse({
    runId, role, phase, armId, candidateRef, provider, resolvedModel, pricingModel, deploymentId,
    usageStatus, inputTokens: cost.inputTokens, outputTokens: cost.outputTokens,
    priceTableVersion: PRICING_VERSION,
    costUsd: (priced && usageStatus === 'captured') ? cost.totalUsd : null,
    capturedAt,
  });
}

/**
 * Groups by the composite (runId, role, armId, candidateRef) identity
 * (implementation H10 fix — candidateRef alone collapsed events from
 * distinct runs/roles/arms/deployments into one row). Per-phase status is
 * tracked separately from the numeric sum (implementation M6 fix) so an
 * unpriced phase is visible, not silently absent from `byPhase`.
 * @param {Array<z.infer<typeof ModelEvalUsageEventSchema>>} usageEvents
 */
export function assembleCostRows(rawUsageEvents) {
  // Implementation M5 fix — validate at the aggregation boundary; callers
  // may compose/deserialize events outside buildUsageEvent().
  const usageEvents = rawUsageEvents.map((e) => ModelEvalUsageEventSchema.parse(e));
  const byKey = new Map();
  for (const e of usageEvents) {
    const key = JSON.stringify([e.runId, e.role, e.armId, e.candidateRef]);
    if (!byKey.has(key)) {
      byKey.set(key, { runId: e.runId, role: e.role, armId: e.armId, candidateRef: e.candidateRef, totalUsd: 0, byPhase: {}, anyUnpriced: false });
    }
    const acc = byKey.get(key);
    const phaseAcc = acc.byPhase[e.phase] || { usd: 0, status: 'available' };
    if (e.costUsd == null) {
      acc.anyUnpriced = true;
      phaseAcc.status = 'unavailable';
      phaseAcc.usd = null;
    } else {
      acc.totalUsd += e.costUsd;
      if (phaseAcc.usd != null) phaseAcc.usd += e.costUsd;
    }
    acc.byPhase[e.phase] = phaseAcc;
  }
  const rows = [];
  for (const acc of byKey.values()) {
    // Round-10 audit M4 fix — insert byPhase keys in SORTED order so object
    // key order (which follows insertion order for string keys) is
    // deterministic regardless of the arrival order of parallel usage events.
    const sortedByPhase = {};
    for (const phase of Object.keys(acc.byPhase).sort()) sortedByPhase[phase] = acc.byPhase[phase];
    rows.push(CostRowSchema.parse({
      runId: acc.runId, role: acc.role, armId: acc.armId, candidateRef: acc.candidateRef,
      totalUsd: acc.anyUnpriced ? null : acc.totalUsd,
      costStatus: acc.anyUnpriced ? 'unavailable' : 'available',
      byPhase: sortedByPhase,
    }));
  }
  // Round-10 audit M4 fix — rows themselves were emitted in Map first-seen
  // (insertion) order, which tracks event arrival order rather than being a
  // property of the data; sort by the composite identity for a stable,
  // reproducible row order regardless of how events arrived.
  rows.sort((a, b) => {
    const ka = `${a.runId}|${a.role}|${a.armId ?? ''}|${a.candidateRef}`;
    const kb = `${b.runId}|${b.role}|${b.armId ?? ''}|${b.candidateRef}`;
    return ka < kb ? -1 : ka > kb ? 1 : 0;
  });
  return rows;
}

export { priceFor, isPriced };
