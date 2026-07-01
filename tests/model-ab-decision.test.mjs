/**
 * Tier-1 (pure) tests for the pre-registered decision-rule evaluator. Plan §9.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { evaluateCell, evaluateDecision, aggregateCells, DECISION_CONSTANTS } from '../scripts/lib/model-ab-decision.mjs';

const C = DECISION_CONSTANTS;
const baseline = { acceptedUniques: 100, dismissedUniques: 20, costUsd: 10 };

/** A cell that meets run/assignment/pending gates so ratio logic is exercised. */
function decidableCell(over = {}) {
  return {
    arm: 'B', stage: 'oss-gen', runs: C.CELL_N, distinctAssignments: C.MIN_ASSIGNMENTS,
    acceptedUniques: 90, dismissedUniques: 20, pendingUniques: 0, costUsd: 4, conformanceRate: 0.99,
    ...over,
  };
}

describe('evaluateCell — gating states', () => {
  it('collecting when runs < CELL_N', () => {
    const r = evaluateCell(decidableCell({ runs: C.CELL_N - 1 }), baseline);
    assert.equal(r.status, 'collecting');
  });
  it('collecting when distinctAssignments < MIN_ASSIGNMENTS', () => {
    const r = evaluateCell(decidableCell({ distinctAssignments: 1 }), baseline);
    assert.equal(r.status, 'collecting');
  });
  it('awaiting-adjudication when any finding is pending (never decide on noise)', () => {
    const r = evaluateCell(decidableCell({ pendingUniques: 3 }), baseline);
    assert.equal(r.status, 'awaiting-adjudication');
  });
  it('insufficient-baseline when A accepted 0 (undefined accepted ratio)', () => {
    const r = evaluateCell(decidableCell(), { acceptedUniques: 0, dismissedUniques: 5, costUsd: 10 });
    assert.equal(r.status, 'insufficient-baseline');
  });
});

describe('evaluateCell — keep/drop verdicts', () => {
  it('KEEP when all thresholds pass', () => {
    const r = evaluateCell(decidableCell(), baseline);
    assert.equal(r.status, 'decide');
    assert.equal(r.verdict, 'keep');
  });
  it('DROP when accepted ratio below floor', () => {
    const r = evaluateCell(decidableCell({ acceptedUniques: 70 }), baseline); // 0.70 < 0.80
    assert.equal(r.verdict, 'drop');
    assert.ok(r.reasons.some((x) => /accepted ratio/.test(x)));
  });
  it('DROP when dismissed ratio above ceiling', () => {
    const r = evaluateCell(decidableCell({ dismissedUniques: 30 }), baseline); // 30/20=1.5 > 1.25
    assert.equal(r.verdict, 'drop');
  });
  it('DROP when conformance below floor', () => {
    const r = evaluateCell(decidableCell({ conformanceRate: 0.95 }), baseline);
    assert.equal(r.verdict, 'drop');
  });
  it('DROP when cost ratio above ceiling', () => {
    const r = evaluateCell(decidableCell({ costUsd: 6 }), baseline); // 6/10=0.6 > 0.5
    assert.equal(r.verdict, 'drop');
  });
});

describe('evaluateCell — ratio math edge cases (R3-M1)', () => {
  it('null arm cost EXCLUDES the cost ratio (never counts as 0/pass-or-fail)', () => {
    const r = evaluateCell(decidableCell({ costUsd: null }), baseline);
    assert.equal(r.status, 'decide');
    assert.equal(r.metrics.costRatio, null);
    assert.ok(r.reasons.some((x) => /cost ratio excluded/.test(x)));
  });
  it('A dismissed 0 → dismissed ratio undefined, not gating (still can KEEP)', () => {
    const r = evaluateCell(decidableCell(), { acceptedUniques: 100, dismissedUniques: 0, costUsd: 10 });
    assert.equal(r.status, 'decide');
    assert.equal(r.metrics.dismissedRatio, null);
    assert.equal(r.verdict, 'keep');
  });
  it('unknown conformance is not gating', () => {
    const r = evaluateCell(decidableCell({ conformanceRate: null }), baseline);
    assert.equal(r.status, 'decide');
    assert.equal(r.verdict, 'keep');
  });
});

describe('aggregateCells + evaluateDecision — folds view rows across runs', () => {
  const rows = [
    // Arm A baseline (two runs)
    { run_id: 'r1', arm: 'A', stage: null, accepted_uniques: 50, dismissed_uniques: 10, pending_uniques: 0, cost_usd: 5, conformant_passes: null, pass_executions: null },
    { run_id: 'r2', arm: 'A', stage: null, accepted_uniques: 50, dismissed_uniques: 10, pending_uniques: 0, cost_usd: 5, conformant_passes: null, pass_executions: null },
    // Arm B oss-gen (two runs)
    { run_id: 'r1', arm: 'B', stage: 'oss-gen', accepted_uniques: 45, dismissed_uniques: 10, pending_uniques: 0, cost_usd: 2, conformant_passes: 5, pass_executions: 5 },
    { run_id: 'r2', arm: 'B', stage: 'oss-gen', accepted_uniques: 45, dismissed_uniques: 10, pending_uniques: 0, cost_usd: 2, conformant_passes: 5, pass_executions: 5 },
  ];
  it('aggregates run counts + sums across runs', () => {
    const { cells } = aggregateCells(rows);
    const b = cells.find((c) => c.arm === 'B');
    assert.equal(b.runs, 2);
    assert.equal(b.acceptedUniques, 90);
    assert.equal(b.conformanceRate, 1); // 10/10
  });
  it('evaluateDecision compares non-A cells to aggregated baseline A', () => {
    const res = evaluateDecision(rows);
    assert.equal(res.baseline.acceptedUniques, 100);
    assert.equal(res.baseline.dismissedUniques, 20);
    // B has 2 runs < CELL_N(20) → collecting.
    assert.equal(res.summary.collecting, 1);
    assert.equal(res.cells.length, 1);
    assert.equal(res.cells[0].arm, 'B');
  });
  it('constants are the pinned pre-registered values', () => {
    assert.equal(DECISION_CONSTANTS.MIN_ACCEPTED_RATIO, 0.80);
    assert.equal(DECISION_CONSTANTS.MAX_COST_RATIO, 0.50);
    assert.equal(DECISION_CONSTANTS.MIN_CONFORMANCE, 0.98);
    assert.equal(DECISION_CONSTANTS.CELL_N, 20);
  });
});
