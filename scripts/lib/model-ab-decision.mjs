/**
 * @fileoverview Pre-registered decision-rule evaluator for the model-A/B/C burn-in.
 *
 * Plan: docs/plans/model-ab-experiment-harness.md (decision 8, resolves R1-M2 /
 * R2-H4 / R3-M1). The constants are PINNED here — written BEFORE data, so the
 * keep/drop verdict is a pre-registered rule, not a post-hoc rationalization.
 * DO NOT tune these against collected data (that would break pre-registration);
 * changing a threshold mid-experiment invalidates the runs already scored.
 *
 * A cell = one (arm × stage). It is DECIDABLE only when it has ≥ CELL_N runs AND
 * its findings are FULLY adjudicated (0 pending) — deciding on un-labelled
 * findings is deciding on noise (R2-H4). Otherwise the cell reads `collecting`
 * (needs runs) or `awaiting-adjudication` (drain the human queue). Ratio math
 * edge cases (R3-M1): a 0 baseline denominator → `insufficient-baseline` (never
 * a pass); a null cost excludes that run from the cost ratio (never counts as 0).
 *
 * PURE — no I/O. The CLI (cross-skill.mjs model-ab-decision) reads the scorer
 * view, folds rows into cells via `aggregateCells`, and calls `evaluateDecision`.
 *
 * @module scripts/lib/model-ab-decision
 */

/** Pinned pre-registered constants (decision 8). */
export const DECISION_CONSTANTS = Object.freeze({
  MIN_ACCEPTED_RATIO: 0.80,   // arm accepted-uniques ≥ 0.80 × A
  MAX_DISMISSED_RATIO: 1.25,  // arm dismissed-uniques ≤ 1.25 × A
  MAX_COST_RATIO: 0.50,       // arm cost ≤ 0.50 × A
  MIN_CONFORMANCE: 0.98,      // structured-output conformance floor
  CELL_N: 20,                 // paired runs per cell before it is decidable
  MIN_ASSIGNMENTS: 2,         // distinct assignments the cell must span
});

/**
 * Evaluate ONE arm cell against the baseline (A) cell.
 *
 * @param {object} cell - { arm, stage, runs, distinctAssignments?, acceptedUniques,
 *   dismissedUniques, pendingUniques, costUsd (nullable), conformanceRate (nullable) }
 * @param {object} baseline - { acceptedUniques, dismissedUniques, costUsd (nullable) }
 * @param {object} [constants=DECISION_CONSTANTS]
 * @returns {{ arm, stage, status:'decide'|'collecting'|'awaiting-adjudication'|'insufficient-baseline',
 *   verdict?:'keep'|'drop', reasons:string[], metrics:object }}
 */
export function evaluateCell(cell, baseline, constants = DECISION_CONSTANTS) {
  const C = constants;
  const runs = Number(cell.runs) || 0;
  const pending = Number(cell.pendingUniques) || 0;
  const distinctAssignments = cell.distinctAssignments != null ? Number(cell.distinctAssignments) : runs;
  const base = { arm: cell.arm, stage: cell.stage };

  // 1. Not enough runs / assignments → collecting.
  if (runs < C.CELL_N || distinctAssignments < C.MIN_ASSIGNMENTS) {
    return { ...base, status: 'collecting', reasons: [`${runs}/${C.CELL_N} runs, ${distinctAssignments}/${C.MIN_ASSIGNMENTS} assignments`], metrics: {} };
  }
  // 2. Un-labelled findings → awaiting adjudication (deciding on noise otherwise).
  if (pending > 0) {
    return { ...base, status: 'awaiting-adjudication', reasons: [`${pending} finding(s) still pending`], metrics: {} };
  }
  // 3. Baseline denominator sanity (R3-M1).
  const baseAccepted = Number(baseline?.acceptedUniques);
  const baseDismissed = Number(baseline?.dismissedUniques);
  if (!(baseAccepted > 0)) {
    return { ...base, status: 'insufficient-baseline', reasons: ['A had 0 accepted uniques — accepted ratio undefined'], metrics: {} };
  }

  // 4. Ratios.
  const acceptedUniques = Number(cell.acceptedUniques) || 0;
  const dismissedUniques = Number(cell.dismissedUniques) || 0;
  const acceptedRatio = acceptedUniques / baseAccepted;
  // Dismissed ratio: undefined when A dismissed 0 — treat as pass-through (can't
  // exceed a ceiling relative to 0; noise on the dismissed axis is measured
  // absolutely elsewhere), flagged in reasons.
  const dismissedRatio = baseDismissed > 0 ? dismissedUniques / baseDismissed : null;
  // Cost ratio: null when either side's cost is unknown → EXCLUDED (logged), never 0.
  const armCost = cell.costUsd == null ? null : Number(cell.costUsd);
  const baseCost = baseline?.costUsd == null ? null : Number(baseline.costUsd);
  const costRatio = (armCost != null && baseCost != null && baseCost > 0) ? armCost / baseCost : null;
  const conformanceRate = cell.conformanceRate == null ? null : Number(cell.conformanceRate);

  const reasons = [];
  let keep = true;

  if (acceptedRatio < C.MIN_ACCEPTED_RATIO) { keep = false; reasons.push(`accepted ratio ${acceptedRatio.toFixed(2)} < ${C.MIN_ACCEPTED_RATIO}`); }
  if (dismissedRatio != null && dismissedRatio > C.MAX_DISMISSED_RATIO) { keep = false; reasons.push(`dismissed ratio ${dismissedRatio.toFixed(2)} > ${C.MAX_DISMISSED_RATIO}`); }
  else if (dismissedRatio == null) reasons.push('dismissed ratio undefined (A dismissed 0) — not gating');
  if (conformanceRate != null && conformanceRate < C.MIN_CONFORMANCE) { keep = false; reasons.push(`conformance ${conformanceRate.toFixed(3)} < ${C.MIN_CONFORMANCE}`); }
  else if (conformanceRate == null) reasons.push('conformance unknown — not gating');
  if (costRatio != null && costRatio > C.MAX_COST_RATIO) { keep = false; reasons.push(`cost ratio ${costRatio.toFixed(2)} > ${C.MAX_COST_RATIO}`); }
  else if (costRatio == null) reasons.push('cost ratio excluded (unpriced) — not gating');

  if (keep && reasons.length === 0) reasons.push('all thresholds met');
  return {
    ...base, status: 'decide', verdict: keep ? 'keep' : 'drop', reasons,
    metrics: { acceptedRatio, dismissedRatio, costRatio, conformanceRate, runs },
  };
}

/**
 * Fold scorer-view rows (one per run × arm × stage) into per-(arm × stage) cells
 * aggregated across runs. Baseline (arm 'A') rows become the comparison base.
 *
 * @param {Array<object>} viewRows - rows from model_ab_effectiveness
 * @returns {{ cells: object[], baselineByStage: Map<string,object> }}
 */
export function aggregateCells(viewRows) {
  const byKey = new Map(); // `${arm}::${stage}` → agg
  for (const r of viewRows || []) {
    const key = `${r.arm}::${r.stage ?? 'none'}`;
    if (!byKey.has(key)) {
      byKey.set(key, {
        arm: r.arm, stage: r.stage ?? null,
        runIds: new Set(), acceptedUniques: 0, dismissedUniques: 0, pendingUniques: 0,
        costUsd: 0, costKnown: false, conformNum: 0, conformDen: 0,
      });
    }
    const a = byKey.get(key);
    if (r.run_id) a.runIds.add(r.run_id);
    a.acceptedUniques += Number(r.accepted_uniques) || 0;
    a.dismissedUniques += Number(r.dismissed_uniques) || 0;
    a.pendingUniques += Number(r.pending_uniques) || 0;
    if (r.cost_usd != null) { a.costUsd += Number(r.cost_usd); a.costKnown = true; }
    if (r.conformant_passes != null && r.pass_executions != null) {
      a.conformNum += Number(r.conformant_passes); a.conformDen += Number(r.pass_executions);
    }
  }
  const cells = [];
  const baselineByStage = new Map();
  for (const a of byKey.values()) {
    const cell = {
      arm: a.arm, stage: a.stage, runs: a.runIds.size, distinctAssignments: a.runIds.size,
      acceptedUniques: a.acceptedUniques, dismissedUniques: a.dismissedUniques, pendingUniques: a.pendingUniques,
      costUsd: a.costKnown ? a.costUsd : null,
      conformanceRate: a.conformDen > 0 ? a.conformNum / a.conformDen : null,
    };
    if (a.arm === 'A') baselineByStage.set('A-overall', cell);
    cells.push(cell);
  }
  return { cells, baselineByStage };
}

/**
 * Evaluate all non-baseline cells against baseline A.
 * @param {Array<object>} viewRows
 * @param {object} [constants]
 * @returns {{ constants:object, baseline:object|null, cells:object[], summary:object }}
 */
export function evaluateDecision(viewRows, constants = DECISION_CONSTANTS) {
  const { cells } = aggregateCells(viewRows);
  // Baseline A aggregated across ALL its stages (the production run's accepted/
  // dismissed/cost total) — the comparison denominator.
  const aCells = cells.filter((c) => c.arm === 'A');
  const baseline = aCells.reduce((acc, c) => ({
    acceptedUniques: acc.acceptedUniques + (c.acceptedUniques || 0),
    dismissedUniques: acc.dismissedUniques + (c.dismissedUniques || 0),
    costUsd: (acc.costUsd == null || c.costUsd == null) ? (acc.costUsd ?? c.costUsd) : acc.costUsd + c.costUsd,
  }), { acceptedUniques: 0, dismissedUniques: 0, costUsd: null });

  const evaluated = cells
    .filter((c) => c.arm !== 'A')
    .map((c) => evaluateCell(c, baseline, constants));

  const summary = {
    decide: evaluated.filter((e) => e.status === 'decide').length,
    keep: evaluated.filter((e) => e.verdict === 'keep').length,
    drop: evaluated.filter((e) => e.verdict === 'drop').length,
    collecting: evaluated.filter((e) => e.status === 'collecting').length,
    awaitingAdjudication: evaluated.filter((e) => e.status === 'awaiting-adjudication').length,
    insufficientBaseline: evaluated.filter((e) => e.status === 'insufficient-baseline').length,
  };
  return { constants, baseline: aCells.length ? baseline : null, cells: evaluated, summary };
}
