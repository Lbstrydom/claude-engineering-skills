/**
 * @fileoverview Two-level arm-eval decision + leaderboard (D2/D3 / §10.3).
 *
 * Plan: docs/plans/arm-eval-framework.md §10.3. Consumes per-SESSION judge
 * results (blinded, double-pass) + optional human rankings + cross-checks +
 * conformance, and produces the OSS-vs-baseline verdict:
 *
 *   LEVEL 1 — GATE (before ranking): an arm whose CONFORMANCE RATE < floor is
 *     DISQUALIFIED (Gemini-gate fix: a flaky arm must be penalized, not have its
 *     failures silently dropped — no survivorship bias). Self-consistency is an
 *     ABSOLUTE floor (≤0.75); breach → `not-credible` (no verdict). The
 *     between-arm-spread comparison is an ADVISORY note, NEVER a gate (so a
 *     genuine near-tie stays provable — Gemini-gate fix).
 *   LEVEL 2 — RANK survivors by PAIRED per-task delta vs the baseline arm (not
 *     absolute means — controls task difficulty). Human agreement (Kendall τ,
 *     accumulated across ≥8 tasks) is the anchor; below floor → `unanchored`.
 *   FRONTIER — € per arm reported ALONGSIDE, never divided into the score.
 *
 * PURE — no I/O. Constants calibrate-then-freeze.
 *
 * @module scripts/lib/arm-eval/decision
 */

export const DECISION_CONSTANTS = Object.freeze({
  SELF_CONSISTENCY_FLOOR: 0.75,   // max intra-judge mean |Δ| between passes (1–5 scale)
  CONFORMANCE_FLOOR: 0.90,        // min per-arm conformant-session rate (Level-1 gate)
  HUMAN_TAU_FLOOR: 0.60,          // min mean Kendall τ (Claude ranking vs human)
  MIN_ANCHOR_TASKS: 8,            // min human-spot-checked tasks for a credible anchor
  MIN_TASKS: 8,                   // decidability: distinct tasks in the prospective set
});

/** Mean of an array (0 for empty). */
function mean(xs) { return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0; }
function round4(n) { return Number.isFinite(n) ? Math.round(n * 1e4) / 1e4 : n; }

/** Per-(arm) rubric mean for ONE session, averaged over the two judge passes.
 * Returns { arm: meanScore } using the labelToArm unblinding map. */
export function sessionArmMeans(judge) {
  const out = {};
  if (!judge || !judge.conformant || !Array.isArray(judge.passes) || judge.passes.length === 0) return out;
  for (const [label, arm] of Object.entries(judge.labelToArm)) {
    const perPass = judge.passes.map((p) => {
      const dims = p[label]; if (!dims) return null;
      const vals = Object.values(dims);
      return vals.length ? mean(vals) : null;
    }).filter((x) => x != null);
    if (perPass.length) out[arm] = mean(perPass);
  }
  return out;
}

/** Per-(arm) self-consistency for ONE session: mean over dims of |pass1−pass2|,
 * then mean over arms present. Returns { arm: delta }. Requires ≥2 passes. */
export function sessionSelfConsistency(judge) {
  const out = {};
  if (!judge || judge.passes.length < 2) return out;
  const [p1, p2] = judge.passes;
  for (const [label, arm] of Object.entries(judge.labelToArm)) {
    const d1 = p1[label]; const d2 = p2[label]; if (!d1 || !d2) continue;
    const deltas = Object.keys(d1).filter((k) => k in d2).map((k) => Math.abs(d1[k] - d2[k]));
    if (deltas.length) out[arm] = mean(deltas);
  }
  return out;
}

/** Kendall τ between two rankings (arrays of arm ids, best→worst). Handles the
 * common small-n case; returns null if <2 shared arms. */
export function kendallTau(rankA, rankB) {
  const common = rankA.filter((a) => rankB.includes(a));
  const n = common.length;
  if (n < 2) return null;
  const posA = new Map(common.map((a) => [a, rankA.indexOf(a)]));
  const posB = new Map(common.map((a) => [a, rankB.indexOf(a)]));
  let concordant = 0, discordant = 0;
  for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) {
    const a = common[i], b = common[j];
    const s = Math.sign(posA.get(a) - posA.get(b)) * Math.sign(posB.get(a) - posB.get(b));
    if (s > 0) concordant++; else if (s < 0) discordant++;
  }
  const denom = (n * (n - 1)) / 2;
  return denom ? (concordant - discordant) / denom : null;
}

/**
 * Evaluate an arm-eval experiment across sessions.
 * @param {{
 *   experimentType: string, baselineArm: string,
 *   sessions: Array<{ taskId:string, judge:object, conformance?:Record<string,boolean>,
 *     humanRanking?:string[]|null, costEur?:Record<string,number>|null,
 *     crossChecks?:Record<string,object>|null }>,
 *   constants?: object,
 * }} input
 */
export function evaluateArmEval({ experimentType, baselineArm, sessions = [], constants = DECISION_CONSTANTS } = {}) {
  const C = constants;
  const arms = new Set();
  for (const s of sessions) for (const a of Object.values(s.judge?.labelToArm || {})) arms.add(a);
  const armIds = [...arms];

  const distinctTasks = new Set(sessions.map((s) => s.taskId)).size;
  const base = { experimentType, baselineArm, distinctTasks, arms: {}, ranking: [], verdict: null };

  if (distinctTasks < C.MIN_TASKS) {
    return { ...base, status: 'collecting', reason: `${distinctTasks}/${C.MIN_TASKS} distinct tasks` };
  }

  // Per-arm accumulation.
  const acc = {};
  for (const a of armIds) acc[a] = { rubric: [], pairedDelta: [], sc: [], conformSessions: 0, totalSessions: 0, costs: [] };
  const claudeRankings = [];  // per-session Claude ranking (best→worst) for τ
  const humanRankings = [];

  for (const s of sessions) {
    const means = sessionArmMeans(s.judge);
    const sc = sessionSelfConsistency(s.judge);
    const conf = s.conformance || {};
    const participating = new Set(Object.values(s.judge?.labelToArm || {}));
    // Conformance is FAIL-CLOSED (audit R2): an arm counts as conformant this
    // session ONLY if explicitly `true`, or (no explicit entry BUT it was
    // actually judged). A missing entry on a non-judged arm is NOT success.
    const isConformant = (a) => conf[a] === true || (conf[a] === undefined && means[a] != null);
    // The paired reference is valid only when the BASELINE was conformant AND
    // judged this session (audit R1 41d26f73).
    const baselineUsable = isConformant(baselineArm) && means[baselineArm] != null;
    for (const a of armIds) {
      // Skip an arm that didn't participate this session and has no conformance
      // entry — it simply wasn't run here (don't inflate its denominator).
      if (!participating.has(a) && !(a in conf)) continue;
      acc[a].totalSessions += 1;
      if (!isConformant(a)) continue;          // non-conformant → counts against the rate only
      acc[a].conformSessions += 1;
      if (means[a] != null) {
        acc[a].rubric.push(means[a]);
        if (baselineUsable) acc[a].pairedDelta.push(means[a] - means[baselineArm]);
      }
      if (sc[a] != null) acc[a].sc.push(sc[a]);
      if (s.costEur && s.costEur[a] != null) acc[a].costs.push(s.costEur[a]);
    }
    // Claude's ranking this session (arms sorted by mean desc) for the τ anchor.
    const ranked = Object.entries(means).sort((x, y) => y[1] - x[1]).map(([a]) => a);
    if (ranked.length >= 2) {
      claudeRankings.push(ranked);
      if (Array.isArray(s.humanRanking) && s.humanRanking.length >= 2) humanRankings.push({ claude: ranked, human: s.humanRanking });
    }
  }

  // Human-agreement anchor (accumulated across tasks — Gemini-R3 small-n note).
  const taus = humanRankings.map((r) => kendallTau(r.claude, r.human)).filter((t) => t != null);
  const topMatch = humanRankings.filter((r) => r.claude[0] === r.human[0]).length;
  const anchorTasks = humanRankings.length;
  const meanTau = taus.length ? round4(mean(taus)) : null;
  const anchored = anchorTasks >= C.MIN_ANCHOR_TASKS && meanTau != null && meanTau >= C.HUMAN_TAU_FLOOR;

  // Per-arm scorecard + Level-1 gate.
  const perArm = {};
  for (const a of armIds) {
    const x = acc[a];
    const conformanceRate = x.totalSessions ? x.conformSessions / x.totalSessions : 0;
    const scDelta = x.sc.length ? mean(x.sc) : null;
    const rubricMean = x.rubric.length ? mean(x.rubric) : null;
    const pairedMean = x.pairedDelta.length ? mean(x.pairedDelta) : null;
    const costEur = x.costs.length ? x.costs.reduce((p, q) => p + q, 0) : null;

    const gateReasons = [];
    let passesGate = true;
    if (conformanceRate < C.CONFORMANCE_FLOOR) { passesGate = false; gateReasons.push(`conformance ${round4(conformanceRate)} < ${C.CONFORMANCE_FLOOR}`); }
    if (scDelta == null) { passesGate = false; gateReasons.push('self-consistency unknown (no double-pass) — cannot certify'); }
    else if (scDelta > C.SELF_CONSISTENCY_FLOOR) { passesGate = false; gateReasons.push(`self-consistency Δ ${round4(scDelta)} > ${C.SELF_CONSISTENCY_FLOOR} → not-credible`); }
    if (passesGate) gateReasons.push('conformance + self-consistency floors met');

    perArm[a] = {
      arm: a, rubricMean: rubricMean == null ? null : round4(rubricMean),
      pairedDeltaVsBaseline: pairedMean == null ? null : round4(pairedMean),
      selfConsistencyDelta: scDelta == null ? null : round4(scDelta),
      conformanceRate: round4(conformanceRate),
      costEur: costEur == null ? null : round4(costEur),
      isBaseline: a === baselineArm,
      gate: { passes: passesGate, reasons: gateReasons },
    };
  }

  // LEVEL 2 — rank gated-in arms by paired delta vs baseline (baseline's own delta is 0).
  const ranking = armIds.map((a) => perArm[a]).filter((a) => a.gate.passes)
    .sort((x, y) => (y.pairedDeltaVsBaseline ?? -Infinity) - (x.pairedDeltaVsBaseline ?? -Infinity));

  // Verdict: does any gated-in OSS (non-baseline) arm meet-or-beat the baseline?
  const baselineIn = perArm[baselineArm]?.gate.passes;
  const bestNonBaseline = ranking.find((a) => !a.isBaseline);
  let verdict;
  if (!baselineIn) verdict = { call: 'insufficient-baseline', note: 'baseline arm did not clear the Level-1 gate' };
  else if (!bestNonBaseline) verdict = { call: 'baseline-wins', note: 'no OSS arm cleared the gate' };
  else {
    const beats = (bestNonBaseline.pairedDeltaVsBaseline ?? -Infinity) >= 0;
    verdict = {
      call: beats ? 'oss-competitive' : 'baseline-wins',
      bestOssArm: bestNonBaseline.arm,
      pairedDelta: bestNonBaseline.pairedDeltaVsBaseline,
      note: beats ? 'an OSS arm meets-or-beats the baseline on paired rubric delta' : 'the baseline leads on paired rubric delta',
    };
  }
  // The human anchor GATES credibility (audit R2 / §10.3): an unanchored verdict
  // is DIRECTIONAL only — never presented as a firm call. `credible` is the
  // machine-readable form of the `confidence` tier below.
  verdict.credible = Boolean(anchored);
  if (!anchored && verdict.call !== 'insufficient-baseline') {
    verdict.call = `${verdict.call}-provisional`;
    verdict.note += ' — PROVISIONAL: human anchor not yet credible (τ/tasks below floor)';
  }

  return {
    ...base,
    status: 'decide',
    arms: perArm,
    ranking,
    anchor: { anchored, meanTau, anchorTasks, topPickMatch: `${topMatch}/${anchorTasks}`, floorTasks: C.MIN_ANCHOR_TASKS, floorTau: C.HUMAN_TAU_FLOOR },
    verdict,
    // Confidence tier is explicit (§9): rubric-based verdicts are softer than the
    // auditor's bug-grounded one, and require the human anchor to be credible.
    confidence: anchored ? 'anchored' : 'unanchored (verdict is directional until ≥8 spot-checked tasks clear τ≥0.6)',
  };
}
