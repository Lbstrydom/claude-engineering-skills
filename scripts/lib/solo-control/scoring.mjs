/**
 * @fileoverview Phase 4 decision math for the audit-effectiveness experiment —
 * pure, deterministic, no I/O (extracted from the CLI so `solo-control-audit.mjs`
 * stays a thin orchestrator; audit R1-M3 god-script fix). Takes labeled adjudication
 * rows + the known-defect set, returns per-arm metrics + eligibility.
 *
 * Plan: docs/plans/audit-effectiveness-experiment.md (section 12.2).
 *
 * @module scripts/lib/solo-control/scoring
 */

import { DECISION_CONSTANTS } from '../model-ab-decision.mjs';
import { mulberry32 } from '../rng.mjs';

// Round-1 audit M2 self-correction (Sustainability Notes,
// docs/plans/model-swap-eval-harness.md) — this used to be a local literal
// duplicate of model-ab-decision.mjs's own weights; re-exported from the one
// canonical source instead (values were already byte-identical, so this is a
// pure DRY consolidation, not a behavior change).
export const SEV_WEIGHTS = DECISION_CONSTANTS.SEV_WEIGHTS;
export const LABEL_FACTORS = Object.freeze({ proven: 1.0, actionable: 0.6, plausible: 0, false: 0 });
// Exported (not just module-local) so ledger-decompose.mjs's byte-identical
// copy (SEV_WEIGHTS + sevWeight, flagged by `arch:duplicates`) can import the
// canonical implementation instead of re-declaring it — this module is the
// natural home since it already re-exports SEV_WEIGHTS from the single
// upstream source (model-ab-decision.mjs).
export const sevWeight = (s) => SEV_WEIGHTS[String(s || '').toUpperCase()] ?? 0;

// A cluster's label = the BEST label among its member rows (proven > actionable >
// plausible > false). The scoring unit is the (commit, arm, human_cluster) — so an
// xN arm's repeated calls that surface the same issue count ONCE (audit R2-H2).
const LABEL_RANK = { proven: 3, actionable: 2, plausible: 1, false: 0 };
function bestLabel(a, b) { return (LABEL_RANK[b] ?? -1) > (LABEL_RANK[a] ?? -1) ? b : a; }

const RISKY_CLASSES = /\b(security|migration|concurrenc|auth|data.?loss|race|deadlock)\b/i;

/**
 * @param {Array<{arm:string, commit:string, severity:string, label:string,
 *   humanCluster?:string, category?:string, matches?:string|null}>} rows
 *   labeled adjudication rows (label in {proven,actionable,plausible,false}).
 * @param {{knownDefects?: Array<{id:string}>, underpowered?: Set<string>|string[],
 *   apparatusArm?: string}} opts
 */
export function scoreArms(rows, { knownDefects = [], underpowered = [], apparatusArm = 'A' } = {}) {
  const underSet = new Set(underpowered);
  const arms = [...new Set(rows.map((r) => r.arm))];
  const kdIds = new Set(knownDefects.map((d) => d.id));

  // Collapse raw rows → one item per (commit, arm, human_cluster). Cluster key falls
  // back to a per-row id so an unclustered row is its own unit (never merged blindly).
  const clusters = new Map(); // `${arm}\x00${commit}\x00${cluster}` -> item
  const rawByArm = {};
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    rawByArm[r.arm] = (rawByArm[r.arm] || 0) + 1;
    const cl = (r.humanCluster && String(r.humanCluster).trim()) || `row:${i}`;
    const key = `${r.arm}\x00${r.commit}\x00${cl}`;
    const prev = clusters.get(key);
    if (!prev) {
      clusters.set(key, { arm: r.arm, commit: r.commit, severity: r.severity, label: r.label, category: r.category || '', matches: r.matches || null });
    } else {
      prev.label = bestLabel(prev.label, r.label);
      // keep the highest severity + any KD match in the cluster
      if (sevWeight(r.severity) > sevWeight(prev.severity)) prev.severity = r.severity;
      if (!prev.matches && r.matches) prev.matches = r.matches;
    }
  }

  const items = [...clusters.values()];
  const perArm = {};
  for (const arm of arms) {
    const own = items.filter((it) => it.arm === arm);
    const accepted = own.filter((it) => LABEL_FACTORS[it.label] > 0);
    const value = accepted.reduce((a, it) => a + sevWeight(it.severity) * LABEL_FACTORS[it.label], 0);
    const labeledWeight = own.reduce((a, it) => a + sevWeight(it.severity), 0); // ALL labels (incl plausible+false)
    const falseCount = own.filter((it) => it.label === 'false').length;
    const noiseCount = own.filter((it) => it.label === 'plausible' || it.label === 'false').length;
    const totalItems = own.length;
    // Severity-weighted precision — denominator includes plausible AND false (R2-M2),
    // so an arm that floods plausible-but-unproven noise is penalized.
    const precision = labeledWeight > 0 ? +(value / labeledWeight).toFixed(3) : null;
    const falseRate = totalItems > 0 ? falseCount / totalItems : 0;
    const noiseRate = totalItems > 0 ? noiseCount / totalItems : 0;

    // Known-defect recall: distinct KD linked to an ACCEPTED item from this arm.
    const kdMatched = new Set(accepted.filter((it) => it.matches && kdIds.has(it.matches)).map((it) => it.matches));
    const kdRecall = kdIds.size > 0 ? +(kdMatched.size / kdIds.size).toFixed(3) : null;

    // Risky-class accepted value (for the recall floor comparison downstream).
    const riskyAcceptedValue = accepted.filter((it) => RISKY_CLASSES.test(it.category)).reduce((a, it) => a + sevWeight(it.severity) * LABEL_FACTORS[it.label], 0);

    const isUnderpowered = underSet.has(arm);
    // Eligibility ceiling (R2-M2 + R2-M4): FP ceiling AND noise ceiling AND not underpowered.
    const eligible = !isUnderpowered && falseRate <= 0.33 && noiseRate <= 0.5;

    perArm[arm] = {
      arm, eligible, underpowered: isUnderpowered,
      value: +value.toFixed(2), precision, falseRate: +falseRate.toFixed(3), noiseRate: +noiseRate.toFixed(3),
      acceptedItems: accepted.length, totalItems, falseCount,
      knownDefectRecall: kdRecall, knownDefectsMatched: kdMatched.size, knownDefectsTotal: kdIds.size,
      riskyAcceptedValue: +riskyAcceptedValue.toFixed(2),
      repetitionBurden: totalItems > 0 ? +((rawByArm[arm] || 0) / totalItems).toFixed(2) : null,
      ineligibleReason: eligible ? null : (isUnderpowered ? 'underpowered' : falseRate > 0.33 ? 'false-rate>0.33' : 'noise-rate>0.5'),
    };
  }

  // "Matches the apparatus": eligible AND value >= 0.9*apparatus AND kd-recall >= apparatus.
  const appt = perArm[apparatusArm];
  for (const arm of arms) {
    if (arm === apparatusArm || !appt) { perArm[arm].matchesApparatus = null; continue; }
    const a = perArm[arm];
    perArm[arm].matchesApparatus = !!(a.eligible && a.value >= 0.9 * appt.value
      && (a.knownDefectRecall == null || appt.knownDefectRecall == null || a.knownDefectRecall >= appt.knownDefectRecall));
  }

  return { apparatusArm, arms: perArm, scoringUnit: '(commit, arm, human_cluster)', sevWeights: SEV_WEIGHTS, labelFactors: LABEL_FACTORS };
}

// ── Stratified-MEDIUM-sample weighted estimation (audit-effectiveness Phase 4b) ──
//
// scoreArms() above is EXHAUSTIVE scoring — every cluster on the sheet is counted
// directly. The MEDIUM tier is instead a SAMPLE of the full MEDIUM-cluster
// population (stratified-sample.mjs), each with a known inclusion probability —
// so it needs a different estimator: Horvitz-Thompson (inverse-probability
// weighting) to project the sample back to a population-level rate, with a
// weighted bootstrap for an honest confidence interval. Never conflate this with
// scoreArms' `value`/`precision` — those are exact counts; these are ESTIMATES.

/** Horvitz-Thompson-weighted accepted rate: each row's vote is weighted by
 * 1/inclusionProb (rows from a heavily-undersampled stratum count for more, since
 * they represent more of the unsampled population). */
function htAcceptedRate(rows) {
  let num = 0, den = 0;
  for (const r of rows) {
    const w = r.inclusionProb > 0 ? 1 / r.inclusionProb : 0;
    den += w;
    if (LABEL_FACTORS[r.label] > 0) num += w;
  }
  return den > 0 ? +(num / den).toFixed(3) : null;
}

function bootstrapCI(rows, { reps, seed }) {
  const rng = mulberry32(seed);
  const ests = [];
  for (let b = 0; b < reps; b++) {
    const resample = Array.from({ length: rows.length }, () => rows[Math.floor(rng() * rows.length)]);
    const est = htAcceptedRate(resample);
    if (est != null) ests.push(est);
  }
  if (ests.length === 0) return { lo: null, hi: null };
  ests.sort((a, b) => a - b);
  const lo = ests[Math.max(0, Math.floor(0.025 * ests.length))];
  const hi = ests[Math.min(ests.length - 1, Math.floor(0.975 * ests.length))];
  return { lo, hi };
}

/**
 * Per-arm Horvitz-Thompson-weighted accepted-rate ESTIMATE over a stratified
 * MEDIUM-cluster sample, with a 95% bootstrap confidence interval. Each input row
 * is one (arm present in a sampled cluster) — already collapsed to the cluster's
 * best label (same collapse rule as scoreArms) with that cluster's inclusionProb
 * attached (from stratified-sample.mjs's sampling map).
 *
 * @param {Array<{arm:string, label:string, inclusionProb:number}>} sampledLabeledRows
 * @param {{bootstrapReps?: number, seed?: number}} [opts]
 */
export function scoreMediumSampleWeighted(sampledLabeledRows, { bootstrapReps = 1000, seed = 12345 } = {}) {
  const arms = [...new Set(sampledLabeledRows.map((r) => r.arm))];
  const perArm = {};
  for (const arm of arms) {
    const armRows = sampledLabeledRows.filter((r) => r.arm === arm);
    if (armRows.length === 0) { perArm[arm] = null; continue; }
    perArm[arm] = {
      sampleN: armRows.length,
      acceptedRateEstimate: htAcceptedRate(armRows),
      ci95: bootstrapCI(armRows, { reps: bootstrapReps, seed: seed + arm.length }),
    };
  }
  return { arms: perArm, sampleTotal: sampledLabeledRows.length, method: 'horvitz-thompson + weighted bootstrap (95% CI)' };
}

// ── Cost-per-known-defect (model-swap-eval-harness Phase 3 — round-3 audit
// H2 verified false positive, dismissed: scoreArms() already returns
// knownDefectsMatched as a plain integer alongside knownDefectRecall, so no
// change to scoreArms()'s return shape was needed for this join). ──────────

/**
 * costPerKnownDefect = costRows.totalUsd / perArmScore.knownDefectsMatched —
 * a pure sibling function over scoreArms()'s existing per-arm fields and
 * cost.mjs's existing CostRowSchema-shaped aggregate. Zero-matched is NOT a
 * divide-by-zero or a fabricated $0 — it's a distinct, visible
 * costStatus:'undefined' (this arm matched no known defects, so a
 * per-defect cost has no meaning), matching this repo's own established
 * costStatus:'available'|'unavailable' discipline (cost.mjs) rather than
 * inventing a third convention.
 *
 * @param {{knownDefectsMatched: number}} perArmScore - one arm's entry from scoreArms().arms[armId]
 * @param {{totalUsd: number|null, costStatus: 'available'|'unavailable'}} costRow - cost.mjs CostRowSchema row for the same arm
 * @returns {{usdPerKnownDefect: number|null, costStatus: 'available'|'unavailable'|'undefined'}}
 */
export function costPerKnownDefect(perArmScore, costRow) {
  if (perArmScore.knownDefectsMatched === 0) {
    return { usdPerKnownDefect: null, costStatus: 'undefined' };
  }
  if (costRow.costStatus !== 'available' || costRow.totalUsd == null) {
    return { usdPerKnownDefect: null, costStatus: 'unavailable' };
  }
  return { usdPerKnownDefect: +(costRow.totalUsd / perArmScore.knownDefectsMatched).toFixed(4), costStatus: 'available' };
}
