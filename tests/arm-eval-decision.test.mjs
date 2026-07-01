/**
 * Tier-1 tests for the arm-eval two-level decision + leaderboard.
 * Plan: docs/plans/arm-eval-framework.md §10.3.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  evaluateArmEval, sessionArmMeans, sessionSelfConsistency, kendallTau, DECISION_CONSTANTS,
} from '../scripts/lib/arm-eval/decision.mjs';

const C2 = { ...DECISION_CONSTANTS, MIN_TASKS: 2, MIN_ANCHOR_TASKS: 2 };

/** Build a session judge from {arm:{p1,p2}} single-dim scores (1–5). */
function judge(armScores) {
  const arms = Object.keys(armScores);
  const labelToArm = {}; const p1 = {}; const p2 = {};
  arms.forEach((arm, i) => {
    const label = `output-${i + 1}`;
    labelToArm[label] = arm;
    p1[label] = { correctness: armScores[arm].p1 };
    p2[label] = { correctness: armScores[arm].p2 };
  });
  return { conformant: true, dims: ['correctness'], labelToArm, passes: [p1, p2] };
}
function sess(taskId, armScores, opts = {}) {
  return {
    taskId,
    judge: judge(armScores),
    conformance: opts.conformance || Object.fromEntries(Object.keys(armScores).map((a) => [a, true])),
    humanRanking: opts.humanRanking || null,
    costEur: opts.costEur || null,
  };
}

describe('helpers', () => {
  it('sessionArmMeans unblinds + averages the two passes', () => {
    const m = sessionArmMeans(judge({ GPT: { p1: 4, p2: 4 }, OSS: { p1: 2, p2: 4 } }));
    assert.equal(m.GPT, 4);
    assert.equal(m.OSS, 3); // (2+4)/2
  });
  it('sessionSelfConsistency = |p1−p2| per arm', () => {
    const sc = sessionSelfConsistency(judge({ GPT: { p1: 4, p2: 4 }, OSS: { p1: 2, p2: 5 } }));
    assert.equal(sc.GPT, 0);
    assert.equal(sc.OSS, 3);
  });
  it('kendallTau: identical=1, reversed=-1, null on <2 shared', () => {
    assert.equal(kendallTau(['a', 'b', 'c'], ['a', 'b', 'c']), 1);
    assert.equal(kendallTau(['a', 'b', 'c'], ['c', 'b', 'a']), -1);
    assert.equal(kendallTau(['a'], ['a']), null);
  });
});

describe('evaluateArmEval — gates + ranking + verdict', () => {
  it('collecting below MIN_TASKS', () => {
    const r = evaluateArmEval({ experimentType: 'plan-authoring', baselineArm: 'GPT', sessions: [sess('t1', { GPT: { p1: 4, p2: 4 }, OSS: { p1: 4, p2: 4 } })] });
    assert.equal(r.status, 'collecting');
  });
  it('oss-competitive when an OSS arm beats baseline on paired delta', () => {
    const S = [
      sess('t1', { GPT: { p1: 3, p2: 3 }, OSS: { p1: 4, p2: 4 } }),
      sess('t2', { GPT: { p1: 3, p2: 3 }, OSS: { p1: 5, p2: 5 } }),
    ];
    const r = evaluateArmEval({ experimentType: 'plan-authoring', baselineArm: 'GPT', sessions: S, constants: C2 });
    assert.equal(r.status, 'decide');
    assert.ok(r.verdict.call.startsWith('oss-competitive'));
    assert.equal(r.verdict.credible, false);            // no human anchor → provisional
    assert.match(r.verdict.call, /provisional/);
    assert.equal(r.verdict.bestOssArm, 'OSS');
    assert.ok(r.arms.OSS.pairedDeltaVsBaseline > 0);
    assert.equal(r.ranking[0].arm, 'OSS'); // ranks above baseline
  });
  it('baseline-wins when OSS trails', () => {
    const S = [
      sess('t1', { GPT: { p1: 5, p2: 5 }, OSS: { p1: 3, p2: 3 } }),
      sess('t2', { GPT: { p1: 5, p2: 5 }, OSS: { p1: 3, p2: 3 } }),
    ];
    const r = evaluateArmEval({ experimentType: 'plan-authoring', baselineArm: 'GPT', sessions: S, constants: C2 });
    assert.ok(r.verdict.call.startsWith('baseline-wins'));
  });
  it('conformance gate DISQUALIFIES a flaky arm (no survivorship bias)', () => {
    // OSS scores great when it works, but fails half the sessions → gated out.
    const S = [
      sess('t1', { GPT: { p1: 4, p2: 4 }, OSS: { p1: 5, p2: 5 } }, { conformance: { GPT: true, OSS: false } }),
      sess('t2', { GPT: { p1: 4, p2: 4 }, OSS: { p1: 5, p2: 5 } }, { conformance: { GPT: true, OSS: true } }),
    ];
    const r = evaluateArmEval({ experimentType: 'plan-authoring', baselineArm: 'GPT', sessions: S, constants: C2 });
    assert.equal(r.arms.OSS.conformanceRate, 0.5);
    assert.equal(r.arms.OSS.gate.passes, false);
    assert.ok(r.arms.OSS.gate.reasons.some((x) => /conformance/.test(x)));
    assert.ok(!r.ranking.some((a) => a.arm === 'OSS'), 'flaky arm excluded from ranking');
    assert.ok(r.verdict.call.startsWith('baseline-wins')); // no OSS arm survived
  });
  it('self-consistency ABSOLUTE floor breach → not-credible gate (tie stays provable)', () => {
    // Wild intra-judge variance on OSS (Δ=4 > 0.75) → gated out even though means look ok.
    const S = [
      sess('t1', { GPT: { p1: 4, p2: 4 }, OSS: { p1: 1, p2: 5 } }),
      sess('t2', { GPT: { p1: 4, p2: 4 }, OSS: { p1: 1, p2: 5 } }),
    ];
    const r = evaluateArmEval({ experimentType: 'plan-authoring', baselineArm: 'GPT', sessions: S, constants: C2 });
    assert.equal(r.arms.OSS.gate.passes, false);
    assert.ok(r.arms.OSS.gate.reasons.some((x) => /self-consistency/.test(x)));
    assert.equal(r.arms.GPT.gate.passes, true); // GPT is self-consistent → stays
  });
  it('human anchor: τ over ≥ tasks → anchored; else directional', () => {
    const S = [
      sess('t1', { GPT: { p1: 3, p2: 3 }, OSS: { p1: 5, p2: 5 } }, { humanRanking: ['OSS', 'GPT'] }),
      sess('t2', { GPT: { p1: 3, p2: 3 }, OSS: { p1: 5, p2: 5 } }, { humanRanking: ['OSS', 'GPT'] }),
    ];
    const r = evaluateArmEval({ experimentType: 'plan-authoring', baselineArm: 'GPT', sessions: S, constants: C2 });
    assert.equal(r.anchor.anchored, true);
    assert.equal(r.anchor.meanTau, 1);
    assert.equal(r.confidence, 'anchored');
    assert.equal(r.verdict.credible, true);              // anchored → firm verdict
    assert.doesNotMatch(r.verdict.call, /provisional/);
    // no human rankings → unanchored
    const r2 = evaluateArmEval({ experimentType: 'plan-authoring', baselineArm: 'GPT', sessions: [sess('t1', { GPT: { p1: 3, p2: 3 }, OSS: { p1: 5, p2: 5 } }), sess('t2', { GPT: { p1: 3, p2: 3 }, OSS: { p1: 5, p2: 5 } })], constants: C2 });
    assert.equal(r2.anchor.anchored, false);
    assert.match(r2.confidence, /unanchored/);
  });
  it('a session where the BASELINE is non-conformant yields no paired delta (audit R1 41d26f73)', () => {
    const S = [
      // t1: baseline GPT non-conformant → OSS gets NO paired delta this session.
      sess('t1', { GPT: { p1: 3, p2: 3 }, OSS: { p1: 5, p2: 5 } }, { conformance: { GPT: false, OSS: true } }),
      // t2: both conformant → OSS paired delta = +2.
      sess('t2', { GPT: { p1: 3, p2: 3 }, OSS: { p1: 5, p2: 5 } }, { conformance: { GPT: true, OSS: true } }),
    ];
    const r = evaluateArmEval({ experimentType: 'plan-authoring', baselineArm: 'GPT', sessions: S, constants: C2 });
    // Only t2 contributed a paired delta (mean = +2), not t1's meaningless +2-vs-missing-baseline.
    assert.equal(r.arms.OSS.pairedDeltaVsBaseline, 2);
    // GPT conformance rate reflects the miss.
    assert.equal(r.arms.GPT.conformanceRate, 0.5);
  });
  it('reports € frontier alongside, never in the score', () => {
    const S = [
      sess('t1', { GPT: { p1: 4, p2: 4 }, OSS: { p1: 4, p2: 4 } }, { costEur: { GPT: 1.0, OSS: 0.2 } }),
      sess('t2', { GPT: { p1: 4, p2: 4 }, OSS: { p1: 4, p2: 4 } }, { costEur: { GPT: 1.0, OSS: 0.2 } }),
    ];
    const r = evaluateArmEval({ experimentType: 'plan-authoring', baselineArm: 'GPT', sessions: S, constants: C2 });
    assert.equal(r.arms.OSS.costEur, 0.4);
    assert.equal(r.arms.GPT.rubricMean, r.arms.OSS.rubricMean); // tie on quality; cost differs but doesn't move the score
  });
});
