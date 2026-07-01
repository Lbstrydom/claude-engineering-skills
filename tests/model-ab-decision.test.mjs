/**
 * Tier-1 (pure) tests for the v2 two-level outcome-based decision rule.
 * Plan: docs/plans/model-ab-harness-v2.md (D5–D8, §4 R2-M3).
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  evaluateDecision, buildClusters, aggregateCost, distinctCodeUnits, qualMult, sevW, normalizeSeverity,
  DECISION_CONSTANTS,
} from '../scripts/lib/model-ab-decision.mjs';
import { EUR_PER_USD } from '../scripts/lib/model-pricing.mjs';

const C = DECISION_CONSTANTS;

/** A finding-grain row (model_ab_finding_scores shape) with sensible defaults. */
function frow(over = {}) {
  return {
    run_id: 'r1', commit_sha: 'c1', assignment_id: 'a1', stage_type: 'audit-code',
    phase: 'prospective', prompt_variant: 'default',
    arm: 'A', stage: 'gpt-gen', source_model: 'gpt-5.5',
    finding_fingerprint: 'fp', canonical_id: 'k1',
    severity: 'HIGH', outcome: 'accepted', remediation_state: 'verified', is_quick_fix: false,
    ...over,
  };
}
function crow(over = {}) {
  return {
    assignment_id: 'a1', commit_sha: 'c1', stage_type: 'audit-code',
    phase: 'prospective', prompt_variant: 'default', arm: 'A',
    standalone_cost_usd: 10, cost_known: true, pass_executions: 5, conformant_passes: 5, any_unmeterable: false,
    ...over,
  };
}

describe('helpers — severity + quality tiers', () => {
  it('normalizeSeverity maps aliases + defaults MEDIUM', () => {
    assert.equal(normalizeSeverity('high'), 'HIGH');
    assert.equal(normalizeSeverity('MED'), 'MEDIUM');
    assert.equal(normalizeSeverity('crit'), 'CRITICAL');
    assert.equal(normalizeSeverity('weird'), 'MEDIUM');
    assert.equal(normalizeSeverity(null), 'MEDIUM');
  });
  it('sevW uses the pinned weights', () => {
    assert.equal(sevW('LOW'), 1);
    assert.equal(sevW('MEDIUM'), 3);
    assert.equal(sevW('HIGH'), 8);
    assert.equal(sevW('CRITICAL'), 15);
  });
  it('qualMult: verified 1.0, fixed 0.6, pending 0.5; quick-fix ×0.4', () => {
    assert.equal(qualMult('verified', false), 1.0);
    assert.equal(qualMult('fixed', false), 0.6);
    assert.equal(qualMult('pending', false), 0.5);
    assert.equal(qualMult('planned', false), 0.5);
    assert.ok(Math.abs(qualMult('verified', true) - 0.4) < 1e-9);   // 1.0 × 0.4
    assert.ok(Math.abs(qualMult('fixed', true) - 0.24) < 1e-9);     // 0.6 × 0.4
  });
});

describe('buildClusters — headline filter + within-assignment clustering', () => {
  it('drops non-prospective and non-default rows from the score', () => {
    const rows = [
      frow(),
      frow({ phase: 'calibration', canonical_id: 'k2' }),
      frow({ prompt_variant: 'probe-A', canonical_id: 'k3' }),
    ];
    const { clusters } = buildClusters(rows);
    assert.equal(clusters.size, 1, 'only the prospective+default row forms a cluster');
  });
  it('distinct code = distinct (commit_sha × stage_type), NOT assignment_id (Gemini R1)', () => {
    // Same commit+stage_type, different assignment_id (a rerun) → 1 distinct code.
    const rows = [
      frow({ assignment_id: 'a1', commit_sha: 'c1' }),
      frow({ assignment_id: 'a2', commit_sha: 'c1', canonical_id: 'k9' }),
    ];
    assert.equal(buildClusters(rows).distinctAssignments, 1, 'reruns of one commit = 1 code unit');
  });
  it('clusters dedup cross-arm WITHIN an assignment (same canonical → one cluster, both arms reached)', () => {
    const rows = [
      frow({ arm: 'A', canonical_id: 'k1' }),
      frow({ arm: 'B', stage: 'oss-gen', canonical_id: 'k1' }),
    ];
    const { clusters } = buildClusters(rows);
    const c = clusters.get('a1::k1');
    assert.ok(c);
    assert.deepEqual([...c.armsReached].sort(), ['A', 'B']);
  });
  it('skips rows with a null/empty canonical_id (never mis-clusters — cf63f2c2)', () => {
    const { clusters } = buildClusters([frow({ canonical_id: null }), frow({ canonical_id: '' }), frow({ canonical_id: 'ok' })]);
    assert.equal(clusters.size, 1);
    assert.ok(clusters.has('a1::ok'));
  });
  it('cluster severity/quality derive from ACCEPTED findings only, not dismissed noise (R3 07c50fd0)', () => {
    // Accepted MED + a dismissed HIGH in the SAME canonical cluster → the
    // cluster value is MED (the accepted adjudication), not HIGH.
    const { clusters } = buildClusters([
      frow({ arm: 'A', canonical_id: 'k1', severity: 'MEDIUM', outcome: 'accepted', remediation_state: 'verified' }),
      frow({ arm: 'B', stage: 'oss-gen', canonical_id: 'k1', severity: 'HIGH', outcome: 'dismissed', remediation_state: 'pending' }),
    ]);
    const c = clusters.get('a1::k1');
    assert.equal(c.maxSevW, 3, 'dismissed HIGH must not inflate the cluster severity');
    assert.equal(c.bestQualMult, 1.0);
  });
});

describe('distinctCodeUnits — counts zero-finding assignments via cost rows (79679362)', () => {
  it('unions finding + cost rows; a cost-only (zero-finding) assignment still counts', () => {
    const findings = [frow({ commit_sha: 'c1' })];
    const costs = [crow({ commit_sha: 'c2', assignment_id: 'a2' })]; // ran, zero findings
    const set = distinctCodeUnits(findings, costs);
    assert.equal(set.size, 2);
    assert.ok(set.has('c1::audit-code'));
    assert.ok(set.has('c2::audit-code'));
  });
  it('a row with no commit_sha is skipped (never falls back to assignment_id/run_id — R3)', () => {
    const set = distinctCodeUnits([frow({ commit_sha: null, assignment_id: 'a9' })], []);
    assert.equal(set.size, 0, 'no commit → cannot attest code diversity');
  });
  it('a zero-finding assignment lifts distinctAssignments past the floor', () => {
    // 1 finding assignment + 1 cost-only assignment = 2 distinct code units.
    const consts = { ...C, MIN_ASSIGNMENTS: 2 };
    const findings = [frow({ commit_sha: 'c1', outcome: 'accepted' })];
    const costs = [
      crow({ arm: 'A', commit_sha: 'c1', pass_executions: 5, conformant_passes: 5 }),
      crow({ arm: 'A', commit_sha: 'c2', assignment_id: 'a2', pass_executions: 5, conformant_passes: 5 }),
    ];
    const r = evaluateDecision(findings, costs, consts);
    assert.equal(r.distinctAssignments, 2);
    assert.notEqual(r.status, 'collecting'); // floor met thanks to the zero-finding run
  });
});

describe('evaluateDecision — decidability gates', () => {
  it('collecting when distinct code < MIN_ASSIGNMENTS', () => {
    const r = evaluateDecision([frow()], [crow()]); // 1 code unit < 12
    assert.equal(r.status, 'collecting');
    assert.equal(r.distinctAssignments, 1);
  });
  it('awaiting-adjudication when a cluster is still pending', () => {
    const consts = { ...C, MIN_ASSIGNMENTS: 1 };
    const r = evaluateDecision([frow({ outcome: 'pending', remediation_state: 'pending' })], [crow()], consts);
    assert.equal(r.status, 'awaiting-adjudication');
  });
  it('insufficient-baseline when there are 0 accepted clusters', () => {
    const consts = { ...C, MIN_ASSIGNMENTS: 1 };
    const r = evaluateDecision([frow({ outcome: 'dismissed', remediation_state: 'pending' })], [crow()], consts);
    assert.equal(r.status, 'insufficient-baseline');
  });
});

describe('evaluateDecision — scoring, recall, gate, frontier, ranking', () => {
  const consts = { ...C, MIN_ASSIGNMENTS: 1 };
  // k1: HIGH verified accepted, reached by A + B (shared).
  // k2: MEDIUM fixed accepted, reached by B only (unique).
  // k3: LOW dismissed, reached by A (a false positive).
  const findings = [
    frow({ arm: 'A', stage: 'gpt-gen', canonical_id: 'k1', severity: 'HIGH', outcome: 'accepted', remediation_state: 'verified' }),
    frow({ arm: 'B', stage: 'oss-gen', canonical_id: 'k1', severity: 'HIGH', outcome: 'accepted', remediation_state: 'verified' }),
    frow({ arm: 'B', stage: 'oss-gen', canonical_id: 'k2', severity: 'MEDIUM', outcome: 'accepted', remediation_state: 'fixed' }),
    frow({ arm: 'A', stage: 'gpt-gen', canonical_id: 'k3', severity: 'LOW', outcome: 'dismissed', remediation_state: 'pending' }),
  ];
  const costs = [
    crow({ arm: 'A', standalone_cost_usd: 10, pass_executions: 5, conformant_passes: 5 }),
    crow({ arm: 'B', standalone_cost_usd: 4, pass_executions: 10, conformant_passes: 10 }),
  ];

  it('status decide with 2 accepted clusters', () => {
    const r = evaluateDecision(findings, costs, consts);
    assert.equal(r.status, 'decide');
    assert.equal(r.totalAcceptedClusters, 2);
  });
  it('arm A: score = 8 (k1) − 1 (FP) = 7; precision 0.5; recall 0.5', () => {
    const r = evaluateDecision(findings, costs, consts);
    const A = r.arms.A;
    assert.equal(A.score, 7);
    assert.equal(A.acceptedWeighted, 8);
    assert.equal(A.precision, 0.5);
    assert.equal(A.recall, 0.5);
    assert.equal(A.reachedAcceptedClusters, 1);
    assert.equal(A.acceptedHighClusters, 1);
  });
  it('arm B: score = 8 + 1.8 + α×3 (unique k2) = 10.85; precision 1.0; recall 1.0', () => {
    const r = evaluateDecision(findings, costs, consts);
    const B = r.arms.B;
    assert.ok(Math.abs(B.acceptedWeighted - 9.8) < 1e-9);
    assert.ok(Math.abs(B.uniqueBonus - 1.05) < 1e-9);  // 0.35 × 3
    assert.ok(Math.abs(B.score - 10.85) < 1e-9);
    assert.equal(B.precision, 1);
    assert.equal(B.recall, 1);
  });
  it('gate: A + B pass (conformance 1.0, precision ≥ 0.30); C has no findings → gated out', () => {
    const r = evaluateDecision(findings, costs, consts);
    assert.equal(r.arms.A.gate.passes, true);
    assert.equal(r.arms.B.gate.passes, true);
    assert.equal(r.arms.C.gate.passes, false); // precision undefined (no findings)
  });
  it('ranking is gated-in arms by score desc — B then A, C excluded', () => {
    const r = evaluateDecision(findings, costs, consts);
    assert.deepEqual(r.ranking.map((a) => a.arm), ['B', 'A']);
  });
  it('cost is a FRONTIER, never folded into score (€/accepted-weighted)', () => {
    const r = evaluateDecision(findings, costs, consts);
    const expectedA = round4((10 * EUR_PER_USD) / 8);
    assert.equal(r.arms.A.frontier.eurPerAcceptedWeighted, expectedA);
    // Score is unchanged by cost — same score with different cost rows.
    const r2 = evaluateDecision(findings, [crow({ arm: 'A', standalone_cost_usd: 999 }), crow({ arm: 'B', standalone_cost_usd: 4, pass_executions: 10, conformant_passes: 10 })], consts);
    assert.equal(r2.arms.A.score, r.arms.A.score);
  });
  it('conformance below floor fails the gate', () => {
    const badConform = [
      crow({ arm: 'A', pass_executions: 10, conformant_passes: 9 }),   // 0.90 < 0.98
      crow({ arm: 'B', pass_executions: 10, conformant_passes: 10 }),
    ];
    const r = evaluateDecision(findings, badConform, consts);
    assert.equal(r.arms.A.gate.passes, false);
    assert.ok(r.arms.A.gate.reasons.some((x) => /conformance/.test(x)));
  });
  it('regression penalty subtracts regPen per regressed cluster', () => {
    const withReg = [
      ...findings,
      frow({ arm: 'A', canonical_id: 'k4', severity: 'MEDIUM', outcome: 'accepted', remediation_state: 'regressed' }),
    ];
    const r = evaluateDecision(withReg, costs, consts);
    // A now also reaches k4 (accepted MED regressed, unique to A): weighted
    // +3×0.5=1.5, unique bonus +α×3=1.05, −regPen(8). Prior A score 7 →
    // 7 + 1.5 + 1.05 − 8 = 1.55.
    assert.ok(Math.abs(r.arms.A.score - 1.55) < 1e-9);
    assert.equal(r.arms.A.regressedClusters, 1);
  });
});

describe('aggregateCost — standalone cost + conformance per arm (headline scope)', () => {
  it('sums per arm and ignores non-prospective/non-default', () => {
    const rows = [
      crow({ arm: 'B', standalone_cost_usd: 2, pass_executions: 5, conformant_passes: 5 }),
      crow({ arm: 'B', assignment_id: 'a2', commit_sha: 'c2', standalone_cost_usd: 3, pass_executions: 5, conformant_passes: 4 }),
      crow({ arm: 'B', phase: 'calibration', standalone_cost_usd: 999 }),   // excluded
    ];
    const m = aggregateCost(rows);
    const b = m.get('B');
    assert.equal(b.standaloneUsd, 5);        // 2 + 3 (calibration excluded)
    assert.equal(b.conformNum, 9);
    assert.equal(b.conformDen, 10);
    assert.equal(b.costKnown, true);         // both contributing rows priced + meterable
  });
  it('costKnown is CONSERVATIVE — one unknown/unmeterable row makes the arm cost unknown', () => {
    const withUnknown = aggregateCost([
      crow({ arm: 'B', standalone_cost_usd: 2 }),
      crow({ arm: 'B', assignment_id: 'a2', commit_sha: 'c2', standalone_cost_usd: null, cost_known: false }),
    ]);
    assert.equal(withUnknown.get('B').costKnown, false);
    const withUnmeterable = aggregateCost([
      crow({ arm: 'C', standalone_cost_usd: 2, any_unmeterable: true }),
    ]);
    assert.equal(withUnmeterable.get('C').costKnown, false);
  });
});

describe('constants are the pinned pre-registered v2 values', () => {
  it('severity weights, quick-fix discount, α, λ, regPen, floors', () => {
    assert.deepEqual(C.SEV_WEIGHTS, { LOW: 1, MEDIUM: 3, HIGH: 8, CRITICAL: 15 });
    assert.equal(C.QUICK_FIX_MULT, 0.4);
    assert.equal(C.ALPHA, 0.35);
    assert.equal(C.LAMBDA, 1.0);
    assert.equal(C.REG_PEN, 8);
    assert.equal(C.PRECISION_FLOOR, 0.30);
    assert.equal(C.MIN_CONFORMANCE, 0.98);
  });
});

function round4(n) { return Math.round(n * 1e4) / 1e4; }
