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
export const SEEDED_BENCH_EPOCH = 'seeded-bench-v2'; // v2 = amendment 2 (pilot-time novelty audit); v1 data is never mixed in

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
  // Every aggregated figure must be a real number: a null cost sums as 0 and would flatter (or sink) the cost-saved test.
  const count = (v) => Number.isInteger(v) && v >= 0;
  const malformed = runs.filter((r) => !(Number.isFinite(r.costUsd) && r.costUsd >= 0) || !count(r.novelActionable) || !count(r.novelActionableHM));
  if (malformed.length) {
    return { branch: 1, outcome: 'invalid', why: `${malformed.length} run row(s) have a non-numeric or negative cost/count (${malformed.slice(0, 3).map((r) => `${r.pointId}/${r.arm}/${r.rep}`).join(', ')}); the dataset is incomplete`, figures: { malformed: malformed.length }, rule: R };
  }
  // Run identity must be unique: a duplicate is silently overwritten when pairing but counted in completion.
  const seen = new Set(); const dups = [];
  for (const r of runs) { const k = `${r.pointId}#${r.rep}#${r.arm}`; if (seen.has(k)) dups.push(k); seen.add(k); }
  if (dups.length) return { branch: 1, outcome: 'invalid', why: `duplicate run identities: ${dups.slice(0, 3).join(', ')}`, figures: { duplicates: dups.length }, rule: R };
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
  if (valid.length < R.minValidPairs || overall < R.minCompletionOverall || gapPoints > R.maxCompletionGapPoints) {
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

/** Human labels. `KNOWN` = the finding restates a prior ledger entry (so it is NOT novel, whatever the judges said). */
export const HUMAN_LABELS = Object.freeze(['REAL', 'WRONG', 'NOT_A_DEFECT', 'RIGOUR_CHASING', 'UNDETERMINED', 'KNOWN']);

/**
 * Build the per-run rows from raw runs, the HIDDEN set (both judges said `same`) and the human labels.
 *
 * Novelty is decided by the HUMAN for every finding the human saw: a finding counts toward a run iff it is MEDIUM+, the human
 * labelled it REAL, and did not call it KNOWN. Findings shown to the human are the judge-surfaced ones (not hidden) plus the
 * audited sample of the hidden ones. A hidden finding the human never saw is NOT novel (the audit bounds how often that is wrong).
 * A shown finding with no label, or UNDETERMINED, makes the score INCOMPLETE (`blocked`), never a guess; a missing novelty entry
 * (`hidden` has no verdict for it) also blocks.
 *
 * @param {{runs: object[], hidden: Map<string, boolean>, labels: Map<string, string>}} a
 *   `hidden.get(key)` true = both judges said same; false = surfaced to the human; undefined = never judged (blocks).
 *   `runs[i].findings` = [{key, severity}] with `key` unique across the pilot.
 */
export function scoreMetaRuns({ runs, hidden, labels }) {
  const blocked = [];
  const rows = runs.map((r) => {
    let hm = 0; let any = 0; let noise = 0; let known = 0;
    if (r.valid && !Array.isArray(r.findings)) blocked.push({ key: `${r.pointId}/${r.arm}/${r.rep}`, reason: 'valid-run-without-findings' });
    const findings = Array.isArray(r.findings) ? r.findings : []; // a non-array is blocked above and never iterated
    for (const f of findings) {
      const sev = String(f.severity).toUpperCase();
      if (!['HIGH', 'MEDIUM', 'LOW'].includes(sev)) { blocked.push({ key: f.key, reason: `unrecognised-severity:${f.severity}` }); continue; }
      if (sev === 'LOW') continue;
      const h = hidden.get(f.key);
      if (h === undefined) { blocked.push({ key: f.key, reason: 'no-novelty-judgment' }); continue; } // a missing judgment is NOT 'not novel'
      const label = labels.get(f.key);
      if (h === true && label === undefined) continue; // hidden and not audited: not novel (bounded by the audit)
      if (label === undefined || label === 'UNDETERMINED') { blocked.push({ key: f.key, reason: label ?? 'unlabelled' }); continue; }
      if (label === 'KNOWN') { known += 1; continue; }
      if (label === 'REAL') { any += 1; hm += 1; } else if (['WRONG', 'NOT_A_DEFECT', 'RIGOUR_CHASING'].includes(label)) noise += 1; else blocked.push({ key: f.key, reason: `unrecognised-label:${label}` });
    }
    return { pointId: r.pointId, arm: r.arm, rep: r.rep, valid: r.valid, invalidReason: r.invalidReason ?? null, stopRun: r.stopRun === true, novelActionableHM: hm, novelActionable: any, noise, known, costUsd: r.costUsd };
  });
  return { rows, blocked, incomplete: blocked.length > 0 };
}
