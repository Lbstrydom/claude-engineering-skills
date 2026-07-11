/**
 * @fileoverview Threshold-config contract for the model swap-in evaluation
 * harness. Split into `screen`/`promotion` tiers (each with its own
 * `minSampleSize`) so the auditor screening tier's small stratified sample
 * never conflicts with the promotion tier's larger floor. Within each tier,
 * `thresholds.comparative`/`thresholds.oracle` are separate sub-keys (round-6
 * audit M3) — a field name never means a baseline-relative ratio in one mode
 * and an absolute floor in another; `computeVerdict` reads only the sub-key
 * matching its own `input.mode`.
 *
 * Implementation H12 fix: the threshold schema is role-specific and
 * `.strict()` — a typo'd or stale field name (e.g. `minF1VsBasline`) fails
 * validation at CLI startup instead of silently validating as an unknown key
 * that `computeVerdict` then reads as `undefined`, weakening a promotion
 * gate without anyone noticing.
 *
 * Plan: docs/plans/model-swap-eval-harness.md — File-Level Plan Phase 1.
 *
 * @module scripts/lib/model-eval/config/schema
 */

import { z } from 'zod';
import { SwitchPercentSchema, ORACLE_FLOOR_KEYS, COMPARATIVE_FLOOR_KEYS } from '../contracts.mjs';

const OracleThresholdsSchema = z.object({
  minRecall: z.number().min(0).max(1).optional(),
  maxFalsePositiveRate: z.number().min(0).max(1).optional(),
  minF1: z.number().min(0).max(1).optional(),
}).strict();

// Round-10 audit L1 fix — verdict.mjs's runtime ComparativeThresholdKeysSchema
// requires .finite() on these two ratio keys (round-9 M1); this config-time
// sibling still used bare .positive() (Infinity passes .positive()), so a
// config could validate at startup and then be rejected — or worse, silently
// accepted with the floor disabled — at the runtime seam. Kept in sync.
const AuditorComparativeThresholdsSchema = z.object({
  minRecallRatioVsBaseline: z.number().positive().finite().optional(),
  maxFalsePositiveRatioVsBaseline: z.number().positive().finite().optional(),
  switchIfCostPerKdImprovesByPct: SwitchPercentSchema.optional(),
  orSwitchIfQualityImprovesByPct: SwitchPercentSchema.optional(),
}).strict();

const AdjudicatorComparativeThresholdsSchema = z.object({
  minF1VsBaseline: z.number().min(0).max(1).optional(),
  maxFalseAcceptDeltaAbs: z.number().min(0).max(1).optional(),
  switchIfCostImprovesByPct: SwitchPercentSchema.optional(),
  // `minLiveShadowRuns` REMOVED (implementation H8 fix) — it duplicated the
  // tier's own top-level `minSampleSize` (both meant "how many live shadow
  // observations before this promotion-tier verdict is trustworthy") and was
  // never actually read by computeRawVerdict, a declared-but-unenforced
  // config key. `minSampleSize` is the single enforced floor.
}).strict();

function tierSchema(comparativeSchema) {
  // Round-6 audit M4 fix — the outer tier object must be `.strict()` too;
  // the file comment already claimed startup validation rejects stale/
  // typo'd field names, but only the LEAF comparative/oracle objects
  // enforced that. A typo'd sibling of minSampleSize/thresholds (or an
  // extra unrecognized key) was silently stripped instead of rejected.
  return z.object({
    minSampleSize: z.number().int().positive(),
    // Round-7 audit M8 fix — verdict.mjs's computeRawVerdict (round-6 H1)
    // rejects a threshold sub-object with zero floor keys at RUNTIME (first
    // computeVerdict call); this config-time refine catches the identical
    // dead-on-arrival config at CLI STARTUP, before any run spends money on
    // it. Both consume the SAME ORACLE_FLOOR_KEYS/COMPARATIVE_FLOOR_KEYS
    // constant from contracts.mjs — the fact "which keys count as a floor"
    // is declared once, not independently in two files.
    thresholds: z.object({
      comparative: comparativeSchema.optional(),
      oracle: OracleThresholdsSchema.optional(),
      allowUnpricedPromotion: z.boolean().optional(),
    }).strict()
      .refine((t) => t.comparative !== undefined || t.oracle !== undefined, {
        message: 'thresholds must define at least one of comparative/oracle',
      })
      .refine((t) => t.comparative === undefined || COMPARATIVE_FLOOR_KEYS.some((k) => t.comparative[k] != null), {
        message: `thresholds.comparative declares no floor keys (checked: ${COMPARATIVE_FLOOR_KEYS.join(', ')}) — this config would pass with zero enforced floors`,
      })
      .refine((t) => t.oracle === undefined || ORACLE_FLOOR_KEYS.some((k) => t.oracle[k] != null), {
        message: `thresholds.oracle declares no floor keys (checked: ${ORACLE_FLOOR_KEYS.join(', ')}) — this config would pass with zero enforced floors`,
      }),
  }).strict();
}

export const ThresholdConfigSchema = z.discriminatedUnion('role', [
  z.object({
    version: z.number().int().positive(),
    role: z.literal('auditor'),
    calibrationNote: z.string().min(1),
    screen: tierSchema(AuditorComparativeThresholdsSchema),
    promotion: tierSchema(AuditorComparativeThresholdsSchema),
  }).strict(),
  z.object({
    version: z.number().int().positive(),
    role: z.literal('adjudicator'),
    calibrationNote: z.string().min(1),
    screen: tierSchema(AdjudicatorComparativeThresholdsSchema),
    promotion: tierSchema(AdjudicatorComparativeThresholdsSchema),
  }).strict(),
]);

/**
 * Validate an arbitrary threshold-config object. Returns {ok, config} |
 * {ok:false, error} — never throws, so CLI startup can fail loud with a
 * readable message instead of an unhandled Zod exception.
 * @param {unknown} raw
 */
export function parseThresholdConfig(raw) {
  const r = ThresholdConfigSchema.safeParse(raw);
  if (r.success) return { ok: true, config: r.data };
  return { ok: false, error: r.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ') };
}
