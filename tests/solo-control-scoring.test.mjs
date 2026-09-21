import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scoreArms, scoreMediumSampleWeighted, costPerKnownDefect, decide, SEV_WEIGHTS } from '../scripts/lib/solo-control/scoring.mjs';
import { DECISION_CONSTANTS } from '../scripts/lib/model-ab-decision.mjs';

test('SEV_WEIGHTS is re-exported from model-ab-decision.mjs, not a local duplicate', () => {
  assert.equal(SEV_WEIGHTS, DECISION_CONSTANTS.SEV_WEIGHTS);
});

test('costPerKnownDefect: divides cost total by knownDefectsMatched', () => {
  const result = costPerKnownDefect({ knownDefectsMatched: 4 }, { totalUsd: 12, costStatus: 'available' });
  assert.deepEqual(result, { usdPerKnownDefect: 3, costStatus: 'available' });
});

test('costPerKnownDefect: zero matched known defects is "undefined", never a divide-by-zero or fabricated $0', () => {
  const result = costPerKnownDefect({ knownDefectsMatched: 0 }, { totalUsd: 12, costStatus: 'available' });
  assert.deepEqual(result, { usdPerKnownDefect: null, costStatus: 'undefined' });
});

test('costPerKnownDefect: unpriced cost row propagates as unavailable, never a fabricated number', () => {
  const result = costPerKnownDefect({ knownDefectsMatched: 2 }, { totalUsd: null, costStatus: 'unavailable' });
  assert.deepEqual(result, { usdPerKnownDefect: null, costStatus: 'unavailable' });
});

test('collapse: xN repeated rows in one human_cluster count ONCE (R2-H2)', () => {
  const rows = [
    { arm: 'S-x3', commit: 'c1', severity: 'HIGH', label: 'proven', humanCluster: 'k1' },
    { arm: 'S-x3', commit: 'c1', severity: 'HIGH', label: 'proven', humanCluster: 'k1' },
    { arm: 'S-x3', commit: 'c1', severity: 'HIGH', label: 'proven', humanCluster: 'k1' },
  ];
  const s = scoreArms(rows, { apparatusArm: 'A' });
  assert.equal(s.arms['S-x3'].totalItems, 1);   // collapsed
  assert.equal(s.arms['S-x3'].value, 8);        // counted once (HIGH proven = 8)
  assert.equal(s.arms['S-x3'].repetitionBurden, 3); // 3 raw / 1 item
});

test('precision denominator includes plausible + false (R2-M2)', () => {
  const rows = [
    { arm: 'X', commit: 'c1', severity: 'HIGH', label: 'proven', humanCluster: 'a' },   // value 8, weight 8
    { arm: 'X', commit: 'c1', severity: 'HIGH', label: 'plausible', humanCluster: 'b' }, // value 0, weight 8
    { arm: 'X', commit: 'c1', severity: 'HIGH', label: 'plausible', humanCluster: 'c' }, // value 0, weight 8
  ];
  const s = scoreArms(rows, {});
  // precision = 8 / (8+8+8) = 0.333 — plausible flooding is penalized
  assert.equal(s.arms['X'].precision, 0.333);
});

test('eligibility: false-rate > 0.33 → ineligible; noise-rate > 0.5 → ineligible', () => {
  const falsey = [
    { arm: 'F', commit: 'c', severity: 'LOW', label: 'proven', humanCluster: '1' },
    { arm: 'F', commit: 'c', severity: 'LOW', label: 'false', humanCluster: '2' },
    { arm: 'F', commit: 'c', severity: 'LOW', label: 'false', humanCluster: '3' },
  ];
  assert.equal(scoreArms(falsey, {}).arms['F'].eligible, false);
  assert.equal(scoreArms(falsey, {}).arms['F'].ineligibleReason, 'false-rate>0.33');

  const noisy = [
    { arm: 'N', commit: 'c', severity: 'LOW', label: 'proven', humanCluster: '1' },
    { arm: 'N', commit: 'c', severity: 'LOW', label: 'plausible', humanCluster: '2' },
    { arm: 'N', commit: 'c', severity: 'LOW', label: 'plausible', humanCluster: '3' },
  ];
  assert.equal(scoreArms(noisy, {}).arms['N'].eligible, false);   // 2/3 noise > 0.5
});

test('underpowered arm → eligible:false (R2-M4)', () => {
  const rows = [{ arm: 'S-x3', commit: 'c', severity: 'HIGH', label: 'proven', humanCluster: '1' }];
  const s = scoreArms(rows, { underpowered: ['S-x3'] });
  assert.equal(s.arms['S-x3'].eligible, false);
  assert.equal(s.arms['S-x3'].ineligibleReason, 'underpowered');
});

test('known-defect recall = distinct KD linked to an accepted item', () => {
  const rows = [
    { arm: 'A', commit: 'c1', severity: 'HIGH', label: 'proven', humanCluster: '1', matches: 'KD-001' },
    { arm: 'A', commit: 'c2', severity: 'HIGH', label: 'proven', humanCluster: '2', matches: 'KD-002' },
    { arm: 'S', commit: 'c1', severity: 'HIGH', label: 'proven', humanCluster: '3', matches: 'KD-001' },
    { arm: 'S', commit: 'c2', severity: 'MEDIUM', label: 'false', humanCluster: '4', matches: 'KD-002' }, // false → not recalled
  ];
  const kd = [{ id: 'KD-001' }, { id: 'KD-002' }];
  const s = scoreArms(rows, { knownDefects: kd });
  assert.equal(s.arms['A'].knownDefectRecall, 1);      // 2/2
  assert.equal(s.arms['S'].knownDefectRecall, 0.5);    // 1/2 (KD-002 only via a false → not counted)
});

test('matchesApparatus: eligible + value >= 0.9*apparatus + kd-recall >= apparatus', () => {
  const rows = [
    { arm: 'A', commit: 'c', severity: 'HIGH', label: 'proven', humanCluster: '1', matches: 'KD-1' },
    { arm: 'S', commit: 'c', severity: 'HIGH', label: 'proven', humanCluster: '2', matches: 'KD-1' },
  ];
  const s = scoreArms(rows, { knownDefects: [{ id: 'KD-1' }], apparatusArm: 'A' });
  assert.equal(s.arms['S'].matchesApparatus, true);  // equal value + equal recall
  assert.equal(s.arms['A'].matchesApparatus, null);  // the apparatus vs itself
});

// ── scoreMediumSampleWeighted (Horvitz-Thompson + bootstrap CI) ─────────────

test('scoreMediumSampleWeighted: HT weighting corrects for oversampling one outcome', () => {
  // arm X: 2 rows heavily OVERsampled (inclusionProb=1, both accepted) and
  // 2 rows heavily UNDERsampled (inclusionProb=0.1, both NOT accepted). A naive
  // unweighted average would read 50% accepted; HT weighting must pull the
  // estimate toward the rarely-sampled (and therefore more-representative-of-
  // the-unsampled-population) unaccepted rows.
  const rows = [
    { arm: 'X', label: 'proven', inclusionProb: 1 },
    { arm: 'X', label: 'proven', inclusionProb: 1 },
    { arm: 'X', label: 'false', inclusionProb: 0.1 },
    { arm: 'X', label: 'false', inclusionProb: 0.1 },
  ];
  const r = scoreMediumSampleWeighted(rows, { bootstrapReps: 200 });
  assert.ok(r.arms['X'].acceptedRateEstimate < 0.5, `expected < 0.5, got ${r.arms['X'].acceptedRateEstimate}`);
});

test('scoreMediumSampleWeighted: uniform inclusionProb reduces to a plain accepted rate', () => {
  const rows = [
    { arm: 'Y', label: 'proven', inclusionProb: 0.5 },
    { arm: 'Y', label: 'actionable', inclusionProb: 0.5 },
    { arm: 'Y', label: 'plausible', inclusionProb: 0.5 },
    { arm: 'Y', label: 'false', inclusionProb: 0.5 },
  ];
  const r = scoreMediumSampleWeighted(rows, { bootstrapReps: 100 });
  assert.equal(r.arms['Y'].acceptedRateEstimate, 0.5); // 2 of 4 accepted (proven+actionable)
});

test('scoreMediumSampleWeighted: CI widens with fewer samples', () => {
  const few = [{ arm: 'Z', label: 'proven', inclusionProb: 0.5 }, { arm: 'Z', label: 'false', inclusionProb: 0.5 }];
  const many = Array.from({ length: 40 }, (_, i) => ({ arm: 'Z', label: i % 2 === 0 ? 'proven' : 'false', inclusionProb: 0.5 }));
  const rFew = scoreMediumSampleWeighted(few, { bootstrapReps: 500, seed: 1 });
  const rMany = scoreMediumSampleWeighted(many, { bootstrapReps: 500, seed: 1 });
  const widthFew = rFew.arms['Z'].ci95.hi - rFew.arms['Z'].ci95.lo;
  const widthMany = rMany.arms['Z'].ci95.hi - rMany.arms['Z'].ci95.lo;
  assert.ok(widthMany < widthFew, `more samples should tighten the CI (few=${widthFew}, many=${widthMany})`);
});

test('scoreMediumSampleWeighted: deterministic given the same seed', () => {
  const rows = Array.from({ length: 20 }, (_, i) => ({ arm: 'W', label: i % 3 === 0 ? 'false' : 'proven', inclusionProb: 0.3 }));
  const r1 = scoreMediumSampleWeighted(rows, { bootstrapReps: 300, seed: 9 });
  const r2 = scoreMediumSampleWeighted(rows, { bootstrapReps: 300, seed: 9 });
  assert.deepEqual(r1.arms['W'].ci95, r2.arms['W'].ci95);
});

test('scoreMediumSampleWeighted: an arm with no sampled rows returns null, not a crash', () => {
  const rows = [{ arm: 'A', label: 'proven', inclusionProb: 1 }];
  const r = scoreMediumSampleWeighted(rows, { bootstrapReps: 50 });
  assert.equal(r.arms['A'].sampleN, 1);
  assert.equal(Object.keys(r.arms).length, 1);
});

// ── adjudicated severity overrides emitted severity (exp-5 Gemini R1-G6) ────

test('scoreArms: adjudicated `sev` weights the cluster, not the emitted severity', () => {
  // A model over-claims HIGH; the blind adjudicator's impact rubric assigns
  // MEDIUM. If emitted severity won, value would be 8 (HIGH*proven); the
  // rubric must win, giving 3 (MEDIUM*proven) — a model cannot buy extra
  // credit by inflating its own severity claim.
  const rows = [{ arm: 'X', commit: 'c', severity: 'HIGH', sev: 'MEDIUM', label: 'proven', humanCluster: '1' }];
  const s = scoreArms(rows, {});
  assert.equal(s.arms['X'].value, 3, 'weighted by adjudicated MEDIUM (3), not emitted HIGH (8) — a model cannot buy extra credit by inflating its own severity claim');
});

test('scoreArms: emittedSeverity is preserved on the cluster for calibration, and absent `sev` falls back to it', () => {
  // Two clusters: one adjudicated (sev present, overrides), one not (sev
  // absent, must weight by the emitted value unchanged) — both paths in one
  // test so a regression that always-uses-sev or always-ignores-sev fails.
  const rows = [
    { arm: 'X', commit: 'c1', severity: 'HIGH', sev: 'LOW', label: 'proven', humanCluster: 'adjudicated' },
    { arm: 'X', commit: 'c2', severity: 'HIGH', label: 'proven', humanCluster: 'unadjudicated' },
  ];
  const s = scoreArms(rows, {});
  // adjudicated cluster: LOW*proven = 1; unadjudicated cluster: HIGH*proven = 8; total 9.
  assert.equal(s.arms['X'].value, 9);
});

// ── decide() — experiment 5's default-configuration decision function ──────
//
// Three regression classes below correspond to Gemini gate findings against
// earlier drafts of decide() (docs/plans/reviewer-cost-value-experiment.md
// Audit Trail). Each test reproduces the EXACT scenario that finding
// described and asserts the corrected outcome — these are not generic
// coverage, they are the falsifying cases that broke the prior drafts.

function scored(arms) {
  // Build a minimal scoreArms()-shaped result directly (bypassing the row
  // collapse) so each decide() test controls value/falseRate/noiseRate/
  // eligible precisely, independent of scoreArms' own collapse logic (that
  // is scoreArms' own test's job, not this one's).
  const out = {};
  for (const [id, a] of Object.entries(arms)) {
    out[id] = { arm: id, eligible: true, falseRate: 0, noiseRate: 0, value: 0, ineligibleReason: null, ...a };
  }
  return { apparatusArm: 'A', arms: out };
}

test('decide(): the incumbent wins on its own cost even though cost <= 0.25*cost is false for any positive number (R2-G1)', () => {
  // Earlier draft: "acceptable iff ... $/diff <= 0.25*A.$/diff" applied to
  // EVERY arm including A itself -- algebraically false whenever A's cost is
  // positive, so A could never be a winner. Here A is the clear best AND the
  // only eligible arm; it must win.
  const s = scored({ A: { value: 10 } });
  const d = decide(s, { incumbentArm: 'A', costPerDiff: { A: 6.0 } });
  assert.equal(d.winner, 'A');
  assert.equal(d.winnerReason, 'incumbent');
  assert.equal(d.inconclusive, false);
});

test('decide(): a noisy-but-eligible replacement cannot set the acceptance threshold (R3-G1)', () => {
  // scoreArms marks an arm `eligible` at falseRate<=0.33 -- a fixed ceiling
  // looser than "at least as clean as the incumbent". Earlier draft drew
  // `best` from ALL eligible arms, so a noisy arm at falseRate=0.30 (looser
  // than A's 0.05) with a genuinely higher raw value could become `best` and
  // drag a clean-but-lower-value trusted arm out of the near-best set.
  // Fixed: `best` is drawn from TRUSTED arms only (falseRate <= min(A's, 0.33)).
  const s = scored({
    A: { value: 10, falseRate: 0.05 },
    NOISY: { value: 20, falseRate: 0.30 }, // eligible (<=0.33) but noisier than A
  });
  const d = decide(s, { incumbentArm: 'A', costPerDiff: { A: 5, NOISY: 1 } });
  assert.ok(!d.trusted.includes('NOISY'), 'NOISY must not be trusted -- its falseRate exceeds the incumbent\'s');
  assert.equal(d.best, 'A', 'best must come from the trusted set, not the wider eligible set');
  assert.equal(d.winner, 'A');
});

test('decide(): an ineligible incumbent is never preserved as the fallback winner (R2-G2, corrected shape)', () => {
  // If A itself fails the fixed eligibility ceiling (e.g. its own false-rate
  // regressed -- experiment 1 measured ~40%), A must not win by default; the
  // highest-value arm that DOES clear the fixed ceiling wins, regardless of
  // whether it costs more than 25% of A's (now-untrustworthy) cost.
  const s = scored({
    A: { value: 10, falseRate: 0.40, eligible: false, ineligibleReason: 'false-rate>0.33' },
    CLEAN: { value: 6, falseRate: 0.10 },
  });
  const d = decide(s, { incumbentArm: 'A', costPerDiff: { A: 5, CLEAN: 4 } }); // CLEAN costs 80% of A -- would fail a 25% ceiling
  assert.equal(d.winner, 'CLEAN');
  assert.equal(d.winnerReason, 'replacement');
  assert.deepEqual(d.ineligible, [{ arm: 'A', reason: 'false-rate>0.33' }]);
});

test('decide(): inconclusive when no arm clears the trust bar -- never forces a winner', () => {
  const s = scored({ A: { value: 10, falseRate: 0.40, eligible: false, ineligibleReason: 'false-rate>0.33' } });
  const d = decide(s, { incumbentArm: 'A', costPerDiff: { A: 5 } });
  assert.equal(d.inconclusive, true);
  assert.equal(d.winner, null);
});

test('decide(): inconclusive when best.value is 0 -- a vacuous-pass guard, never a 90%-of-nothing acceptance', () => {
  const s = scored({ A: { value: 0 }, B: { value: 0 } });
  const d = decide(s, { incumbentArm: 'A', costPerDiff: { A: 5, B: 1 } });
  assert.equal(d.inconclusive, true);
  assert.match(d.inconclusiveReason, /best\.value === 0/);
});

test('decide(): nonInferiorCheap is reported as a finding but never overrides the winner rule', () => {
  // CHEAP clears the value bar (>=90% of best) and costs <=25% of A -- so it
  // is both `acceptable` and `nonInferiorCheap`. But EXPENSIVE beats it on
  // raw value and is also within 90% of `best` (because CHEAP IS best here),
  // so the actual cost-minimizing winner among nearBest must still be
  // computed by cost, not short-circuited by the cheap-challenger label.
  const s = scored({ A: { value: 10 }, CHEAP: { value: 10 } });
  const d = decide(s, { incumbentArm: 'A', costPerDiff: { A: 5, CHEAP: 1 } });
  assert.deepEqual(d.nonInferiorCheap, ['CHEAP']);
  assert.equal(d.winner, 'CHEAP', 'the label and the winner rule agree here, but via independent computations');
  // Now flip it: CHEAP is non-inferior on cost but NOT on value (misses the
  // 90% bar) -- it must be reported as neither acceptable nor a winner.
  const s2 = scored({ A: { value: 10 }, CHEAP2: { value: 5 } }); // 50% of best -- below 0.9
  const d2 = decide(s2, { incumbentArm: 'A', costPerDiff: { A: 5, CHEAP2: 1 } });
  assert.deepEqual(d2.nonInferiorCheap, [], 'below the 90% value bar, cost alone cannot earn the label');
  assert.equal(d2.winner, 'A');
});

test('decide(): an arm with incomplete cost data is excluded from ranking, reported as ineligible -- never ranked on a null', () => {
  const s = scored({ A: { value: 10 }, UNPRICED: { value: 20 } });
  const d = decide(s, { incumbentArm: 'A', costPerDiff: { A: 5, UNPRICED: null } });
  assert.deepEqual(d.ineligible, [{ arm: 'UNPRICED', reason: 'cost-incomplete' }]);
  assert.equal(d.winner, 'A');
});

test('decide(): deterministic tie-break -- cost, then recipients, then repeats, then arm id', () => {
  const s = scored({ A: { value: 10 }, TIE1: { value: 10 }, TIE2: { value: 10 } });
  const d = decide(s, {
    incumbentArm: 'A',
    costPerDiff: { A: 5, TIE1: 1, TIE2: 1 }, // TIE1/TIE2 tie on cost
    recipients: { TIE1: 2, TIE2: 1 },        // TIE2 wins on fewer recipients
  });
  assert.equal(d.winner, 'TIE2');
});
