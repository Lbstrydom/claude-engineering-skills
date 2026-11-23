/**
 * @fileoverview Pilot 1's PRE-REGISTERED decision rule (docs/plans/seeded-defect-benchmark.md §2.3), pure.
 *
 * `decideMetaPilot` turns per-run rows into one of keep / off / inconclusive / invalid by the table in §2.3, first match
 * wins. It reads counts only: which findings are novel (the matcher) and actionable (a human label) is decided upstream by
 * `scoreMetaPilot`, so the rule never sees a judge's opinion that a human did not confirm.
 *
 * Unit = a RUN (point x arm x replicate). Replicates are paired by index: META rep i with CONTINUE rep i. A pair counts
 * only when BOTH runs are valid (§2.5).
 *
 * Domain: audit-orchestration.
 *
 * @module scripts/lib/audit/meta-pilot-decision
 */

/** The pre-registered thresholds. Changing any of them is a new contract epoch, never an edit (§0.3). */
export const META_PILOT_RULE = Object.freeze({
  plannedPairs: 32,
  minValidPairs: 24,
  maxCompletionGapPoints: 10,
  minCompletionOverall: 0.75,
  minStops: 5,
  offMissRate: 0.4,
  keepMissRate: 0.2,
  keepCostSaved: 0.25,
  keepAdmissionYield: 0.8,
});

/** Contract epoch stamped on every evidence row (C9). */
export const SEEDED_BENCH_EPOCH = 'seeded-bench-v1';

const sum = (xs) => xs.reduce((s, x) => s + x, 0);

/**
 * @typedef {object} MetaRun
 * @property {string} pointId
 * @property {'META'|'CONTINUE'} arm
 * @property {number} rep - replicate index, 0-based
 * @property {boolean} valid - completed, canary detected, no pass lost (§2.5); a recorded stop-run is valid
 * @property {string|null} [invalidReason]
 * @property {boolean} [stopRun] - META only: the guard honoured a stop/structural verdict, so the round did not run
 * @property {number} novelActionableHM - novel, human-labelled REAL, HIGH or MEDIUM findings of the run
 * @property {number} novelActionable - same, any severity MEDIUM+ (the yield counts these)
 * @property {number} costUsd - metered: the meta call plus the round
 */

/** Group the runs into pairs (META rep i, CONTINUE rep i of one point). A pair missing a member is never a pair. */
export function pairRuns(runs) {
  const byKey = new Map();
  for (const r of runs) byKey.set(`${r.pointId}#${r.rep}#${r.arm}`, r);
  const pairs = [];
  const seen = new Set();
  for (const r of runs) {
    const k = `${r.pointId}#${r.rep}`;
    if (seen.has(k)) continue;
    seen.add(k);
    const meta = byKey.get(`${k}#META`); const cont = byKey.get(`${k}#CONTINUE`);
    if (meta && cont) pairs.push({ pointId: r.pointId, rep: r.rep, meta, cont });
  }
  return pairs;
}

/**
 * Evaluate the rule. Returns the branch, the three figures (null when undefined) and every number the report needs.
 * @param {{runs: MetaRun[], plannedPairs?: number}} a
 */
export function decideMetaPilot({ runs, plannedPairs = META_PILOT_RULE.plannedPairs }) {
  const R = META_PILOT_RULE;
  const pairs = pairRuns(runs);
  const valid = pairs.filter((p) => p.meta.valid && p.cont.valid);
  const completion = (arm) => {
    const mine = runs.filter((r) => r.arm === arm);
    return mine.length ? mine.filter((r) => r.valid).length / Math.max(mine.length, plannedPairs) : 0;
  };
  const cMeta = completion('META'); const cCont = completion('CONTINUE');
  const overall = (cMeta + cCont) / 2;
  const gapPoints = Math.abs(cMeta - cCont) * 100;

  const stops = valid.filter((p) => p.meta.stopRun === true);
  const admitted = valid.filter((p) => p.meta.stopRun !== true);
  const missed = stops.filter((p) => p.cont.novelActionableHM >= 1).length;
  const missRate = stops.length ? missed / stops.length : null;
  const metaCost = sum(valid.map((p) => p.meta.costUsd));
  const contCost = sum(valid.map((p) => p.cont.costUsd));
  const costSaved = contCost > 0 ? 1 - metaCost / contCost : null;
  const contFound = sum(admitted.map((p) => p.cont.novelActionable));
  const admissionYield = contFound > 0 ? sum(admitted.map((p) => p.meta.novelActionable)) / contFound : null;

  const figures = {
    pairsPlanned: plannedPairs, pairsPresent: pairs.length, validPairs: valid.length, stops: stops.length, missed, missRate, costSaved, metaCostUsd: metaCost, continueCostUsd: contCost,
    admissionYield, admissionYieldUndefined: admissionYield === null, continueFoundOnAdmitted: contFound,
    completion: { meta: cMeta, continue: cCont, overall, gapPoints },
    invalidPairs: pairs.filter((p) => !(p.meta.valid && p.cont.valid)).map((p) => ({ pointId: p.pointId, rep: p.rep, metaReason: p.meta.valid ? null : p.meta.invalidReason ?? 'invalid', continueReason: p.cont.valid ? null : p.cont.invalidReason ?? 'invalid' })),
  };
  const out = (branch, outcome, why) => ({ branch, outcome, why, figures, rule: R });

  // 1. Invalid: never scored on the survivors, because a failure correlated with an arm is a result about the arm.
  if (valid.length < R.minValidPairs * (plannedPairs / R.plannedPairs) || overall < R.minCompletionOverall || gapPoints > R.maxCompletionGapPoints) {
    return out(1, 'invalid', `valid pairs ${valid.length} of ${plannedPairs} (need ${R.minValidPairs}), completion ${(overall * 100).toFixed(0)}% overall, arm gap ${gapPoints.toFixed(0)} points`);
  }
  // 2. Turn off.
  if (costSaved !== null && costSaved < 0) return out(2, 'off', `META costs more than always continuing (cost saved ${(costSaved * 100).toFixed(1)}%)`);
  if (stops.length >= R.minStops && missRate > R.offMissRate) return out(2, 'off', `|S|=${stops.length} >= ${R.minStops} and miss rate ${(missRate * 100).toFixed(0)}% > ${R.offMissRate * 100}%`);
  // 3. Too few stops to say anything.
  if (stops.length < R.minStops) return out(3, 'inconclusive', `|S|=${stops.length} < ${R.minStops} stops`);
  // 4. Keep.
  if (costSaved !== null && missRate <= R.keepMissRate && costSaved >= R.keepCostSaved && (admissionYield === null || admissionYield >= R.keepAdmissionYield)) {
    return out(4, 'keep', `miss ${(missRate * 100).toFixed(0)}% <= ${R.keepMissRate * 100}%, cost saved ${(costSaved * 100).toFixed(0)}% >= ${R.keepCostSaved * 100}%, admission yield ${admissionYield === null ? 'undefined' : admissionYield.toFixed(2)}`);
  }
  return out(5, 'inconclusive', 'between the keep and turn-off thresholds');
}

/**
 * The pilot rides on BOTH judges (§1.4): a decision stands only if the two judges' novelty sets put it on the same branch.
 * @param {{byJudge: Record<string, MetaRun[]>, plannedPairs?: number}} a
 */
export function decideMetaPilotBothJudges({ byJudge, plannedPairs }) {
  const per = Object.fromEntries(Object.entries(byJudge).map(([j, runs]) => [j, decideMetaPilot({ runs, plannedPairs })]));
  const branches = new Set(Object.values(per).map((d) => d.branch));
  if (Object.keys(per).length < 2) return { outcome: 'inconclusive', branch: 5, why: 'fewer than two judges scored the pilot', perJudge: per };
  if (branches.size === 1) { const d = Object.values(per)[0]; return { outcome: d.outcome, branch: d.branch, why: d.why, perJudge: per }; }
  return { outcome: 'inconclusive', branch: 5, why: `the judges disagree on the branch (${Object.entries(per).map(([j, d]) => `${j}: ${d.branch}`).join(', ')})`, perJudge: per };
}

/**
 * Build the per-run rows for ONE judge from raw runs, the judge's novelty verdicts and the human labels.
 * A finding counts toward a run only if it is MEDIUM+, novel under this judge AND labelled REAL by a human. A novel
 * MEDIUM+ finding with no human label, or UNDETERMINED, makes the score INCOMPLETE (returned in `blocked`), never a guess.
 *
 * @param {{runs: object[], novelByFinding: Map<string, boolean>, labels: Map<string, string>}} a
 *   `runs[i].findings` = [{key, severity}] with `key` unique across the pilot; `labels.get(key)` in
 *   REAL | WRONG | NOT_A_DEFECT | RIGOUR_CHASING | UNDETERMINED
 */
export function scoreMetaRuns({ runs, novelByFinding, labels }) {
  const blocked = [];
  const rows = runs.map((r) => {
    let hm = 0; let any = 0; let noise = 0;
    for (const f of r.findings || []) {
      const sev = String(f.severity).toUpperCase();
      if (sev !== 'HIGH' && sev !== 'MEDIUM') continue;
      if (novelByFinding.get(f.key) !== true) continue;
      const label = labels.get(f.key);
      if (!label || label === 'UNDETERMINED') { blocked.push({ key: f.key, reason: label ?? 'unlabelled' }); continue; }
      if (label === 'REAL') { any += 1; hm += 1; } else noise += 1;
    }
    return { pointId: r.pointId, arm: r.arm, rep: r.rep, valid: r.valid, invalidReason: r.invalidReason ?? null, stopRun: r.stopRun === true, novelActionableHM: hm, novelActionable: any, noise, costUsd: r.costUsd };
  });
  return { rows, blocked, incomplete: blocked.length > 0 };
}
