/**
 * @fileoverview Pure verdict computation. Generalizes scoreArms()'s
 * matchesApparatus boolean into a confidence-tiered vocabulary. The decision
 * table stores explicit {verdict, nextAction} PAIRS (implementation H6 fix —
 * independent verdicts[]/nextActions[] arrays let a semantically-invalid
 * combination pass as long as each half was independently allowed), and is
 * the sole enforcement point: computeVerdict's raw derivation is checked
 * against the exact pair, not membership in two separate lists.
 *
 * `nextAction` is derived from an explicit `floorsMet` boolean, never
 * inferred from `verdict` alone — `verdict:'keep'` means two different
 * things (floors failed vs. floors met but below the switch bar) and only
 * `floorsMet` disambiguates which `nextAction` is reachable.
 *
 * `thresholds` matches config/schema.mjs's actual nested shape —
 * `{comparative?, oracle?, allowUnpricedPromotion?}` — computeVerdict selects
 * the sub-object matching its own `input.mode` internally (implementation H7
 * fix: verdict.mjs previously still read a flat threshold record, out of
 * sync with the schema.mjs H12 fix that nested thresholds by mode).
 *
 * Plan: docs/plans/model-swap-eval-harness.md — File-Level Plan Phase 1.
 *
 * @module scripts/lib/model-eval/verdict
 */

import { z } from 'zod';
import { RoleSchema, TierSchema, JudgeTierSchema, SwitchPercentSchema, ORACLE_FLOOR_KEYS, COMPARATIVE_FLOOR_KEYS } from './contracts.mjs';

// Round-6 audit H5 fix — reject self-contradictory route evidence at the
// schema boundary instead of letting it silently reach success-path verdict
// logic. independenceEligible/judgeTier are DERIVED from lineageStatus by
// route-catalog.mjs::resolveCandidateRoute (never independently set), so a
// caller supplying values that violate that derivation is passing malformed
// evidence, not a legitimate independent combination.
const RouteEvidenceSchema = z.object({
  judgeTier: JudgeTierSchema,
  lineageStatus: z.enum(['known', 'unknown']),
  independenceEligible: z.boolean(),
  // Round-10 audit M7 fix — round-8b's H7 fix added lineageSource to
  // resolveCandidateRoute's return specifically so promotion-tier/Tier-A/B
  // callers could gate on operator-attested vs verified trust — but it was
  // never threaded through to the schema that actually gets PERSISTED as
  // verdict evidence, so the provenance was computed and then dropped
  // before it could ever be inspected downstream.
  // Round-13 audit M1/M5 fix — this was left .optional() for backward
  // compatibility with pre-existing fixtures, with the actual safety
  // enforced functionally (round-11's gating treats missing provenance the
  // same as operator-attested). That "optional but functionally enforced"
  // design kept getting re-flagged across three rounds as a load-bearing
  // field that LOOKS unenforced at the type level. Made REQUIRED — every
  // real route (resolveCandidateRoute always sets it) already has one;
  // this only ever rejected hand-built fixtures, which is exactly the
  // "don't trust a hand-assembled claim" property this schema exists for.
  lineageSource: z.enum(['catalog-verified', 'reviewed-pool', 'operator-attested']),
}).superRefine((v, ctx) => {
  // Round-8b audit L1 fix — lineageStatus is a 2-value enum, so
  // `!== 'known'` and `=== 'unknown'` are the same condition; the original
  // two checks fired together on every violation, never independently. One
  // check, one issue.
  if (v.independenceEligible && v.lineageStatus !== 'known') {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'independenceEligible:true requires lineageStatus:"known"' });
  }
  if (v.judgeTier !== 'C' && !v.independenceEligible) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: `judgeTier:"${v.judgeTier}" requires independenceEligible:true (non-independent routes are capped at Tier C)` });
  }
});

const ComparisonEvidenceSchema = z.object({
  candidateRoute: RouteEvidenceSchema,
  baselineRoute: RouteEvidenceSchema,
  // judgeRoute is nullable — a Tier-C-forced comparative claim (no judge
  // supplied, or judge independence failed) legitimately has none. The H4
  // fix — "a comparative Tier A/B claim requires a verified independent
  // judge" — is enforced by route-catalog.mjs::resolveEvaluationTier's LOGIC
  // (it forces computedJudgeTier:'C' when judgeRoute is missing/unknown/
  // same-lineage), not by making this field non-nullable here.
  judgeRoute: RouteEvidenceSchema.nullable(),
  computedJudgeTier: z.enum(['A', 'B', 'C']),
  independenceChecks: z.object({
    candidateVsBaseline: z.boolean(),
    candidateVsJudge: z.boolean().nullable(),
    baselineVsJudge: z.boolean().nullable(),
  }),
}).superRefine((v, ctx) => {
  // Round-7 audit H4 fix — round-6's H5 fix validated each RouteEvidence
  // object's OWN internal consistency, but a caller could still supply a
  // top-level computedJudgeTier that contradicts the composite evidence
  // (e.g. computedJudgeTier:'A' while independenceChecks says
  // candidateVsJudge:false, or a judgeRoute:null with computedJudgeTier
  // above 'C'). computedJudgeTier is DERIVED by
  // route-catalog.mjs::resolveEvaluationTier from exactly these fields —
  // mirror that derivation here as a validation, not a second
  // implementation, so a hand-built or stale ComparisonEvidence can't
  // reach success-path verdict logic with a self-contradictory claim.
  if (v.computedJudgeTier !== 'C') {
    if (!v.independenceChecks.candidateVsBaseline) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: `computedJudgeTier:"${v.computedJudgeTier}" requires independenceChecks.candidateVsBaseline:true` });
    }
    if (!v.judgeRoute || !v.independenceChecks.candidateVsJudge || !v.independenceChecks.baselineVsJudge) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: `computedJudgeTier:"${v.computedJudgeTier}" requires a non-null judgeRoute with candidateVsJudge:true and baselineVsJudge:true` });
    }
  }
});

// Implementation H3 fix — an explicit, exhaustive key allowlist per mode
// (never z.record(string, ...)) so an unknown/misspelled/differently-cased
// key is REJECTED at validation, not silently ignored by computeRawVerdict's
// fixed set of camelCase reads.
// Round-9 audit M1 fix — .positive() alone accepts Infinity (Infinity > 0);
// these two ratio bounds have no upper .max() the way the [0,1]-bounded
// keys below do, so they need .finite() explicitly. An Infinity threshold
// would make ratioWithinBound's `ratio <= maxRatio` trivially always true,
// silently disabling the floor.
const ComparativeThresholdKeysSchema = z.object({
  minRecallRatioVsBaseline: z.number().positive().finite().optional(),
  maxFalsePositiveRatioVsBaseline: z.number().positive().finite().optional(),
  minF1VsBaseline: z.number().min(0).max(1).optional(),
  maxFalseAcceptDeltaAbs: z.number().min(0).max(1).optional(),
  // Round-5 M2 fix — bounded positive percentages, never a bare z.number()
  // that would accept a negative "improvement" threshold.
  switchIfCostPerKdImprovesByPct: SwitchPercentSchema.optional(),
  switchIfCostImprovesByPct: SwitchPercentSchema.optional(),
  orSwitchIfQualityImprovesByPct: SwitchPercentSchema.optional(),
}).strict();

const OracleThresholdKeysSchema = z.object({
  minRecall: z.number().min(0).max(1).optional(),
  maxFalsePositiveRate: z.number().min(0).max(1).optional(),
  minF1: z.number().min(0).max(1).optional(),
}).strict();

// Round-8b audit M3 fix — .strict() so a stale/misspelled key at this outer
// level is rejected, not silently stripped (the same root-cause fix already
// applied to config/schema.mjs's tier objects and route-catalog.mjs's
// AzureRouteEntrySchema — the third location of the identical class of gap).
const ThresholdsSchema = z.object({
  comparative: ComparativeThresholdKeysSchema.optional(),
  oracle: OracleThresholdKeysSchema.optional(),
  allowUnpricedPromotion: z.boolean().optional(),
}).strict();

// Implementation H3 fix: scorer outputs are legitimately nullable for
// zero-denominator edge cases (e.g. recall with no positive ground-truth
// rows) — the schema must accept that; requiredMetric() below is what fails
// closed when a THRESHOLD actually needs a null metric.
// Round-9 audit M1 fix — a bare z.number() accepts NaN/Infinity; every real
// scorer metric (deterministic-scorer.mjs) is a bounded ratio or count, so a
// non-finite value entering comparison logic can only be corrupted input.
// Round-12 audit H3 fix — a generic z.record can't bound EVERY possible key
// (deterministic-scorer.mjs's raw counts like truePositives/extraCount are
// legitimately unbounded), but the three keys computeRawVerdict actually
// READS via requiredMetric() (recall, falsePositiveRate, f1) are always
// ratios — an impossible value like recall:-5 or f1:99 must fail here, not
// silently drive a threshold comparison.
//
// Integration contract (round-13 audit H6 clarification): candidateMetrics/
// baselineMetrics is a CURATED numeric subset a caller builds from a
// scorer's output — e.g. `{ recall: result.recall, falsePositiveRate:
// result.falsePositiveRate, f1: result.f1 }` — never the raw
// deterministic-scorer.mjs return object passed straight through. That raw
// object legitimately carries non-numeric fields (mismatches: an array of
// diagnostic objects) MetricsSchema was never meant to accept; a future
// caller (Cluster B) must extract the numeric ratios, not pass the scorer's
// output verbatim.
const RATIO_METRIC_KEYS = Object.freeze(['recall', 'falsePositiveRate', 'f1']);
const MetricsSchema = z.record(z.string(), z.number().finite().nullable()).superRefine((v, ctx) => {
  for (const key of RATIO_METRIC_KEYS) {
    const val = v[key];
    if (val != null && (val < 0 || val > 1)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: [key], message: `${key} must be in [0,1] (a ratio metric), got ${val}` });
    }
  }
});

export const VerdictInputSchema = z.discriminatedUnion('mode', [
  z.object({
    mode: z.literal('comparative'),
    role: RoleSchema,
    tier: TierSchema,
    comparisonEvidence: ComparisonEvidenceSchema,
    candidateMetrics: MetricsSchema,
    baselineMetrics: MetricsSchema,
    sampleSize: z.number().int().nonnegative(),
    minSampleSize: z.number().int().positive(),
    // Round-7 audit H2 fix — the same finite/nonnegative constraint applied
    // to cost.mjs's monetary fields (round-6 M1) was missed here; a negative
    // or non-finite cost would corrupt the switch/promotion cost comparison.
    costDelta: z.object({ candidateCostUsd: z.number().finite().nonnegative().nullable(), baselineCostUsd: z.number().finite().nonnegative().nullable() }).nullable(),
    thresholds: ThresholdsSchema,
    // Round-11 audit H5/H8/M5/H9 fix — this is the SAME topic re-raised
    // across rounds 8/8b/9/10 (each time asking "operator-attested Azure
    // lineage shouldn't silently earn Tier A/B"); lineageSource (round-8b
    // H7, round-10 M7) exposed the fact but nothing GATED on it, so it kept
    // resurfacing as unresolved. Closing it here: an operator-attested (or
    // provenance-less) route may not silently reach Tier A/B; computeVerdict
    // caps to Tier C unless the caller explicitly acknowledges the risk.
    acknowledgeOperatorAttestedLineage: z.boolean().optional(),
  }),
  z.object({
    mode: z.literal('oracle'),
    role: RoleSchema,
    tier: TierSchema,
    routeEvidence: RouteEvidenceSchema,
    candidateMetrics: MetricsSchema,
    sampleSize: z.number().int().nonnegative(),
    minSampleSize: z.number().int().positive(),
    corpusVersion: z.string(),
    thresholds: ThresholdsSchema,
  }),
]);

// (role, mode, tier) -> explicit allowed {verdict, nextAction} PAIRS — the
// sole enforcement point for reachability. A computed pair not in this list
// downgrades to the row's declared safe fallback.
const DECISION_TABLE = [
  { mode: 'oracle', tier: 'screen',
    pairs: [['keep', 'promote_to_full'], ['inconclusive', 'reject'], ['manual_review_required', 'reject']],
    fallback: ['manual_review_required', 'reject'] },
  { mode: 'oracle', tier: 'promotion', role: 'adjudicator',
    pairs: [['keep', 'none'], ['inconclusive', 'eligible_for_shadow'], ['inconclusive', 'reject'], ['manual_review_required', 'reject']],
    fallback: ['manual_review_required', 'reject'] },
  { mode: 'oracle', tier: 'promotion', role: 'auditor',
    pairs: [['keep', 'none'], ['inconclusive', 'reject'], ['manual_review_required', 'reject']],
    fallback: ['manual_review_required', 'reject'] },
  { mode: 'comparative', tier: 'screen',
    pairs: [['keep', 'promote_to_full'], ['keep', 'reject'], ['inconclusive', 'reject'], ['manual_review_required', 'reject']],
    fallback: ['manual_review_required', 'reject'] },
  { mode: 'comparative', tier: 'promotion',
    pairs: [['switch', 'promote_to_full'], ['keep', 'none'], ['inconclusive', 'reject'], ['manual_review_required', 'reject']],
    fallback: ['manual_review_required', 'reject'] },
];

// Round-8 audit M5 fix — DERIVED (never hand-duplicated) set of every
// (verdict, nextAction) pair that appears in ANY DECISION_TABLE row, keyed
// as "verdict:nextAction" strings. store/model-eval.mjs uses this to reject
// a persisted pair that is impossible under ALL rows (e.g. switch+reject,
// which no row ever pairs) — a coarser check than full mode/tier/role-aware
// legality (the persisted schema doesn't carry `mode`), but real
// defense-in-depth without duplicating DECISION_TABLE's actual rule.
export const ALL_VALID_VERDICT_NEXT_ACTION_PAIRS = Object.freeze(
  Array.from(new Set(DECISION_TABLE.flatMap((r) => [...r.pairs, r.fallback]).map(([v, a]) => `${v}:${a}`)))
);

function findTableRow({ mode, tier, role }) {
  return DECISION_TABLE.find((r) => r.mode === mode && r.tier === tier && (!r.role || r.role === role))
    || DECISION_TABLE.find((r) => r.mode === mode && r.tier === tier);
}

/** Fail-closed metric read — a threshold that references a metric the scorer
 * didn't produce (or produced as null, a legitimate zero-denominator case)
 * must FAIL the check, never silently default to a value that passes it. */
function requiredMetric(metrics, key) {
  const v = metrics[key];
  if (typeof v !== 'number' || !Number.isFinite(v)) {
    throw new Error(`computeVerdict: threshold references metric "${key}", which is missing/null/non-finite in candidateMetrics/baselineMetrics`);
  }
  return v;
}

/** Ratio check that treats a zero-baseline-to-nonzero-candidate regression as
 * a hard fail, never a silently-passing ratio of 1.
 *
 * Round-8 audit H3 fix — for a higher-is-better metric (recall) a zero
 * baseline used to auto-pass UNCONDITIONALLY, so candidate=0 vs baseline=0
 * ("neither model caught anything") satisfied the floor exactly like a real
 * improvement would — an adversarial success path (met the floor by
 * demonstrating nothing). Now requires a STRICT improvement (candidateVal>0)
 * when the baseline is degenerate; a tie at zero no longer passes.
 */
function ratioWithinBound(candidateVal, baselineVal, maxRatio, { higherIsWorse }) {
  if (baselineVal === 0) {
    return higherIsWorse ? candidateVal === 0 : candidateVal > 0;
  }
  const ratio = candidateVal / baselineVal;
  return higherIsWorse ? ratio <= maxRatio : ratio >= maxRatio;
}

function computeRawVerdict(input) {
  if (input.sampleSize < input.minSampleSize) {
    return { verdict: 'inconclusive', floorsMet: false, reasons: [`sampleSize ${input.sampleSize} below minSampleSize ${input.minSampleSize}`] };
  }

  // Fail loud, never silently-permissive: a caller that omits the mode's
  // threshold sub-object entirely (e.g. passes flat/legacy-shaped thresholds
  // by mistake) must not have every floor check vacuously pass.
  const modeThresholds = input.thresholds[input.mode];
  if (!modeThresholds) {
    throw new Error(`computeVerdict: thresholds.${input.mode} is missing — thresholds must be nested by mode (thresholds.comparative / thresholds.oracle), never a flat record`);
  }
  // Round-6 audit H1 fix — a threshold sub-object that declares ZERO floor
  // keys (e.g. `oracle: {}`, or a comparative object with only a switch/cost
  // key and no floors) makes every floorsMet check vacuously true, so a
  // config typo or omission silently returns "keep" without ever having
  // checked anything. Require at least one recognized FLOOR key per mode
  // (switch/cost keys like switchIfCostImprovesByPct and the
  // allowUnpricedPromotion flag don't count — they gate promotion, not
  // correctness, and are legitimately absent at screen tiers).
  const floorKeys = input.mode === 'oracle' ? ORACLE_FLOOR_KEYS : COMPARATIVE_FLOOR_KEYS;
  if (!floorKeys.some((k) => modeThresholds[k] != null)) {
    throw new Error(`computeVerdict: thresholds.${input.mode} declares no floor keys (checked: ${floorKeys.join(', ')}) — a config with zero enforced floors would return "keep" without checking anything`);
  }

  if (input.mode === 'oracle') {
    const { candidateMetrics } = input;
    const t = modeThresholds;
    const meetsRecall = t.minRecall == null || requiredMetric(candidateMetrics, 'recall') >= t.minRecall;
    const meetsFpr = t.maxFalsePositiveRate == null || requiredMetric(candidateMetrics, 'falsePositiveRate') <= t.maxFalsePositiveRate;
    const meetsF1 = t.minF1 == null || requiredMetric(candidateMetrics, 'f1') >= t.minF1;
    const floorsMet = meetsRecall && meetsFpr && meetsF1;
    return { verdict: floorsMet ? 'keep' : 'inconclusive', floorsMet, reasons: [floorsMet ? 'met oracle floors' : 'did not meet oracle floors'] };
  }

  // comparative
  const { candidateMetrics, baselineMetrics, costDelta } = input;
  const t = modeThresholds;
  const recallOk = t.minRecallRatioVsBaseline == null
    || ratioWithinBound(requiredMetric(candidateMetrics, 'recall'), requiredMetric(baselineMetrics, 'recall'), t.minRecallRatioVsBaseline, { higherIsWorse: false });
  const fprOk = t.maxFalsePositiveRatioVsBaseline == null
    || ratioWithinBound(requiredMetric(candidateMetrics, 'falsePositiveRate'), requiredMetric(baselineMetrics, 'falsePositiveRate'), t.maxFalsePositiveRatioVsBaseline, { higherIsWorse: true });
  const f1Ok = t.minF1VsBaseline == null || requiredMetric(candidateMetrics, 'f1') >= t.minF1VsBaseline;
  // Implementation H8 fix — maxFalseAcceptDeltaAbs (adjudicator's
  // absolute-delta counterpart to the auditor's ratio-based
  // maxFalsePositiveRatioVsBaseline) was declared in config but never
  // enforced. A "false accept" is the adjudicator's false-positive rate —
  // accepting a finding that shouldn't have been accepted.
  const falseAcceptOk = t.maxFalseAcceptDeltaAbs == null
    || Math.abs(requiredMetric(candidateMetrics, 'falsePositiveRate') - requiredMetric(baselineMetrics, 'falsePositiveRate')) <= t.maxFalseAcceptDeltaAbs;
  const floorsMet = recallOk && fprOk && f1Ok && falseAcceptOk;

  if (!floorsMet) {
    return { verdict: 'keep', floorsMet: false, reasons: ['candidate did not meet comparative floors'] };
  }

  // Cost/switch analysis only applies when THIS tier's config declares a
  // switch threshold at all (screen tier's config has none — screening
  // "worth promoting" must never be blocked on missing cost data, which is
  // a promotion-tier-only concern).
  const switchThresholdPct = t.switchIfCostPerKdImprovesByPct ?? t.switchIfCostImprovesByPct;
  if (switchThresholdPct == null) {
    return { verdict: 'keep', floorsMet: true, reasons: ['met floors; no switch threshold configured at this tier'] };
  }

  const unpriced = costDelta == null || costDelta.candidateCostUsd == null || costDelta.baselineCostUsd == null;
  if (unpriced && !input.thresholds.allowUnpricedPromotion) {
    return { verdict: 'inconclusive', floorsMet: true, reasons: ['cost data unavailable and allowUnpricedPromotion is false'] };
  }
  const costImprovedPct = !unpriced && costDelta.baselineCostUsd > 0
    ? ((costDelta.baselineCostUsd - costDelta.candidateCostUsd) / costDelta.baselineCostUsd) * 100 : null;
  const costSwitch = costImprovedPct != null && costImprovedPct >= switchThresholdPct;
  if (costSwitch) return { verdict: 'switch', floorsMet: true, reasons: [`cost improved ${costImprovedPct.toFixed(1)}%`] };
  return { verdict: 'keep', floorsMet: true, reasons: ['met floors but did not clear the switch bar'] };
}

/** @param {z.infer<typeof VerdictInputSchema>} rawInput */
/** Round-11 audit H5/H8/M5/H9 fix — true only when EVERY participating
 * route's trust provenance is independently verifiable (catalog-verified or
 * a reviewed pool). A missing lineageSource is treated with the SAME
 * suspicion as 'operator-attested' — fail closed on unknown provenance,
 * never fail open. */
function allRoutesIndependentlyTrusted(comparisonEvidence) {
  const routes = [comparisonEvidence.candidateRoute, comparisonEvidence.baselineRoute, comparisonEvidence.judgeRoute].filter(Boolean);
  return routes.every((r) => r.lineageSource === 'catalog-verified' || r.lineageSource === 'reviewed-pool');
}

export function computeVerdict(rawInput) {
  const input = VerdictInputSchema.parse(rawInput);
  let judgeTier = input.mode === 'oracle' ? 'C' : input.comparisonEvidence.computedJudgeTier;
  if (input.mode === 'comparative' && judgeTier !== 'C'
    && !input.acknowledgeOperatorAttestedLineage
    && !allRoutesIndependentlyTrusted(input.comparisonEvidence)) {
    judgeTier = 'C';
  }
  const row = findTableRow({ mode: input.mode, tier: input.tier, role: input.role });
  if (!row) throw new Error(`computeVerdict: no decision-table row for mode=${input.mode} tier=${input.tier} role=${input.role}`);

  let { verdict, floorsMet, reasons } = computeRawVerdict(input);

  // Structural invariants:
  if (input.mode === 'oracle' && verdict === 'switch') verdict = 'manual_review_required';
  if (input.mode === 'comparative' && judgeTier === 'C' && verdict === 'switch') verdict = 'manual_review_required';

  // nextAction depends on floorsMet, NOT on the verdict string alone.
  let nextAction = 'none';
  if (verdict === 'switch') {
    nextAction = 'promote_to_full';
  } else if (verdict === 'keep' && input.tier === 'screen') {
    nextAction = floorsMet ? 'promote_to_full' : 'reject';
  } else if (verdict === 'inconclusive' && floorsMet && input.role === 'adjudicator' && input.tier === 'promotion' && input.mode === 'oracle') {
    nextAction = 'eligible_for_shadow';
  } else if (verdict === 'manual_review_required' || (verdict === 'inconclusive' && !floorsMet)) {
    nextAction = 'reject';
  }

  // Implementation H6 fix — validate the EXACT pair, not independent
  // verdict/nextAction membership. An unreachable combination downgrades to
  // the row's declared safe fallback rather than silently passing through.
  const isAllowedPair = row.pairs.some(([v, a]) => v === verdict && a === nextAction);
  if (!isAllowedPair) {
    [verdict, nextAction] = row.fallback;
    reasons = [...reasons, 'computed pair was not in the decision table; downgraded to fallback'];
  }

  return { verdict, nextAction, reasons };
}
