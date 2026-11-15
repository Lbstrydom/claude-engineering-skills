/**
 * @fileoverview Pure analysis for the decision-eval: per-output score, within-arm
 * spread, judge noise, the n the spread implies, a seeded paired bootstrap, the
 * pre-registered decision rule, and cost per call / per correct decision.
 *
 * Plan: docs/plans/fable-vs-opus-decision-eval.md §2.2 "Score", §12, §C3.
 * Every constant here is the pre-registered value; changing one is a contract
 * change (bump DECISION_EVAL_CONTRACT_EPOCH).
 *
 * @module scripts/lib/model-eval/decision/analysis
 */

import { mulberry32 } from '../../rng.mjs';

export const SCORE_WEIGHTS = Object.freeze({ correct: 0.6, coverage: 0.4, trap: 0.2 });
export const DECISION_RULE = Object.freeze({
  deltaFloor: 0.10,          // smallest gain that counts on the 0–1 scale
  costRatioMax: 3.0,         // X: Fable cost per correct ≤ 3× Opus's
  unmeasuredMax: 0.10,       // > 10% unmeasured grades ⇒ not-credible
  judgeNoiseFactor: 0.5,     // s_j ≤ max(0.5·s_w, deltaFloor)
  spotAgreementMin: 0.8,
  powerZ: 2.8,               // z_{α/2}+z_β for α=0.05 two-sided, 80% power
  minMeasuredPerCase: 2,     // per arm (variance) / per pair (main): fewer ⇒ no spread, no paired mean
  minMeasuredFraction: 0.75, // of planned outputs (variance) or pairs (main)
  armErrorRateMax: 0.10,     // per arm, of planned calls
  repsMin: 3,
  repsMax: 10,
  bootstrapB: 10000,
});

const clamp01 = (x) => Math.max(0, Math.min(1, x));
const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
const round4 = (x) => (Number.isFinite(x) ? Math.round(x * 1e4) / 1e4 : x);

/**
 * Score ONE judge pass for one output. A pass with ANY unverified positive
 * claim scores `q: null` (unmeasured; counted in `unverified`). `correct` is
 * null when the judge said true but could not quote it.
 */
export function scoreGrade(c, grade) {
  const weightOf = Object.fromEntries(c.rubric.keyPoints.map((k) => [k.id, k.weight]));
  const kp = grade.keyPoints.filter((k) => k.verified);
  const traps = grade.traps.filter((t) => t.verified);
  const unverified = (grade.keyPoints.length - kp.length) + (grade.traps.length - traps.length) + (grade.decisionCorrect.verified ? 0 : 1);
  const wTotal = kp.reduce((n, k) => n + (weightOf[k.id] ?? 0), 0);
  const coverage = wTotal > 0 ? kp.filter((k) => k.hit).reduce((n, k) => n + weightOf[k.id], 0) / wTotal : null;
  const trapRate = traps.length ? traps.filter((t) => t.fell).length / traps.length : 0;
  const correct = grade.decisionCorrect.verified ? Boolean(grade.decisionCorrect.value) : null;
  // ANY positive claim the judge could not quote makes the whole pass unmeasured
  // (plan audit R3 H3): excluding just that item would let a fabricated quote
  // raise coverage or erase a trap penalty while the pass still scored.
  const q = (unverified > 0 || coverage == null || correct == null)
    ? null
    : clamp01(SCORE_WEIGHTS.correct * (correct ? 1 : 0) + SCORE_WEIGHTS.coverage * coverage - SCORE_WEIGHTS.trap * trapRate);
  return { q, correct, coverage, trapRate, unverified };
}

/**
 * Combine an output's two passes. An output is MEASURED only when both passes
 * scored a non-null q (plan §2.2 scoring contract): one missing / unmeasured /
 * zero-denominator pass ⇒ q null (excluded, counted) — never a one-pass score
 * silently mixed with two-pass ones. `correct` (cost per correct) needs BOTH true.
 */
export function combinePasses(scores) {
  const qs = scores.map((s) => s.q).filter((x) => x != null);
  const cs = scores.map((s) => s.correct);
  return {
    q: qs.length === 2 ? mean(qs) : null,
    // Epoch 2 (deviations.md, variance phase): `correct` requires a MEASURED
    // output too — an output excluded from meanQ / s_w must not still count
    // toward cost per correct decision.
    correct: qs.length === 2 && cs.length === 2 && cs.every((x) => x === true),
    correctDisagree: cs.length === 2 && cs[0] != null && cs[1] != null && cs[0] !== cs[1],
    judgeDelta: qs.length === 2 ? Math.abs(qs[0] - qs[1]) : null,
    passesScored: qs.length,
  };
}

/** Pooled within-case SD over rows {caseId, q} (q non-null). null when no case has ≥2 reps. */
export function withinCaseSpread(rows) {
  const byCase = new Map();
  for (const r of rows) if (r.q != null) { if (!byCase.has(r.caseId)) byCase.set(r.caseId, []); byCase.get(r.caseId).push(r.q); }
  let ss = 0; let dof = 0;
  for (const qs of byCase.values()) {
    if (qs.length < 2) continue;
    const m = mean(qs);
    ss += qs.reduce((n, q) => n + (q - m) ** 2, 0);
    dof += qs.length - 1;
  }
  return dof > 0 ? Math.sqrt(ss / dof) : null;
}

/** Per-case range (max−min) of q — the plain-language view of the spread. */
export function perCaseRange(rows) {
  const out = {};
  for (const r of rows) if (r.q != null) { (out[r.caseId] ||= []).push(r.q); }
  return Object.fromEntries(Object.entries(out).map(([k, qs]) => [k, { n: qs.length, mean: round4(mean(qs)), min: round4(Math.min(...qs)), max: round4(Math.max(...qs)), range: round4(Math.max(...qs) - Math.min(...qs)) }]));
}

/**
 * Reps per arm per case the measured spread implies (plan §C3):
 * r = ceil(2·z²·s_w² / (k·Δ_target²)), Δ_target = max(s_w, deltaFloor), clamped.
 */
export function proposeReps({ sw, k, rule = DECISION_RULE }) {
  if (!Number.isFinite(sw) || !(k > 0)) return { reps: null, deltaTarget: null, raw: null, infeasible: false, reason: 'spread unmeasured' };
  const deltaTarget = Math.max(sw, rule.deltaFloor);
  const raw = Math.ceil((2 * rule.powerZ ** 2 * sw ** 2) / (k * deltaTarget ** 2));
  const infeasible = raw > rule.repsMax;
  const reps = Math.min(rule.repsMax, Math.max(rule.repsMin, raw));
  return { reps, deltaTarget: round4(deltaTarget), raw, infeasible, reason: infeasible ? `needs ${raw} reps/case > ${rule.repsMax}: enlarge the corpus instead` : null };
}

/**
 * Seeded paired bootstrap of Δ = mean_c(meanF_c − meanO_c): resample cases with
 * replacement, then reps within each case. rows: {caseId, arm, q}.
 */
export function pairedBootstrap({ rows, armA, armB, seed = 1, B = DECISION_RULE.bootstrapB }) {
  const byCase = new Map();
  for (const r of rows) {
    if (r.q == null) continue;
    if (!byCase.has(r.caseId)) byCase.set(r.caseId, { [armA]: [], [armB]: [] });
    if (r.arm === armA || r.arm === armB) byCase.get(r.caseId)[r.arm].push(r.q);
  }
  const cases = [...byCase.entries()].filter(([, v]) => v[armA].length && v[armB].length).sort(([a], [b]) => a.localeCompare(b));
  if (!cases.length) return { delta: null, lo: null, hi: null, cases: 0 };
  const point = mean(cases.map(([, v]) => mean(v[armA]) - mean(v[armB])));
  const rnd = mulberry32(seed);
  const pick = (xs) => xs[Math.floor(rnd() * xs.length)];
  const resample = (xs) => xs.map(() => pick(xs));
  const deltas = [];
  for (let b = 0; b < B; b++) {
    const cs = resample(cases);
    deltas.push(mean(cs.map(([, v]) => mean(resample(v[armA])) - mean(resample(v[armB])))));
  }
  deltas.sort((x, y) => x - y);
  const at = (p) => deltas[Math.min(deltas.length - 1, Math.max(0, Math.floor(p * deltas.length)))];
  return { delta: round4(point), lo: round4(at(0.025)), hi: round4(at(0.975)), cases: cases.length };
}

/**
 * Sample completeness (plan §12, audit R2 H1): exclusions must not silently
 * hollow out the sample. `units` are the measured units — arm outputs (variance,
 * per arm) or paired case-reps (main) — as {caseId}. Returns failure strings.
 */
export function sampleCompleteness({ unitsByScope, plannedPerCase, cases, armErrors = {}, plannedCallsPerArm, rule = DECISION_RULE }) {
  const failures = [];
  for (const [scope, units] of Object.entries(unitsByScope)) {
    const perCase = Object.fromEntries(cases.map((c) => [c, 0]));
    for (const u of units) if (u.caseId in perCase) perCase[u.caseId] += 1;
    const thin = Object.entries(perCase).filter(([, n]) => n < rule.minMeasuredPerCase);
    if (thin.length) failures.push(`${scope}: ${thin.length} case(s) with < ${rule.minMeasuredPerCase} measured (${thin.map(([c, n]) => `${c}=${n}`).join(', ')})`);
    const planned = plannedPerCase * cases.length;
    if (planned > 0 && units.length / planned < rule.minMeasuredFraction) failures.push(`${scope}: ${units.length}/${planned} measured < ${rule.minMeasuredFraction}`);
  }
  for (const [arm, n] of Object.entries(armErrors)) {
    if (plannedCallsPerArm > 0 && n / plannedCallsPerArm > rule.armErrorRateMax) failures.push(`${arm}: arm-error rate ${round4(n / plannedCallsPerArm)} > ${rule.armErrorRateMax}`);
  }
  return failures;
}

/**
 * Credibility gates (plan §12) — any failure ⇒ not-credible, no verdict.
 * @returns {{credible:boolean, failures:string[]}}
 */
export function credibilityGates({ controlsPassed, controlsTotal, sj, sw, unmeasuredRate, modelMismatches, spotAgreement = undefined, requireSpot = false, sampleFailures = [], rule = DECISION_RULE }) {
  const failures = [...sampleFailures];
  if (controlsTotal === 0 || controlsPassed !== controlsTotal) failures.push(`judge controls ${controlsPassed}/${controlsTotal} passed`);
  const sjMax = Math.max(rule.judgeNoiseFactor * (sw ?? 0), rule.deltaFloor);
  if (sj == null || sj > sjMax) failures.push(`judge noise s_j=${sj == null ? 'unmeasured' : round4(sj)} > ${round4(sjMax)}`);
  if (!(unmeasuredRate <= rule.unmeasuredMax)) failures.push(`unmeasured grades ${round4(unmeasuredRate)} > ${rule.unmeasuredMax}`);
  if (modelMismatches > 0) failures.push(`${modelMismatches} call(s) served by a model other than the one requested`);
  if (requireSpot && !(spotAgreement >= rule.spotAgreementMin)) failures.push(`spot-sample agreement ${spotAgreement ?? 'absent'} < ${rule.spotAgreementMin}`);
  return { credible: failures.length === 0, failures };
}

/**
 * R = cpc_F / cpc_O with the zero-correct cases pre-registered (plan §12):
 * Opus never correct but Fable is ⇒ 0 (no Opus price buys a correct decision);
 * Fable never correct ⇒ +∞; neither ⇒ null (no cost verdict).
 */
export function costRatioOf(cpcF, cpcO) {
  if (cpcF == null && cpcO == null) return null;
  if (cpcO == null) return 0;
  if (cpcF == null) return Infinity;
  return cpcF / cpcO;
}

/**
 * The pre-registered verdict (plan §12). Pure. `boot` from pairedBootstrap with
 * armA = Fable, armB = Opus. `meanOpus` is Opus's mean q; `costRatio` = costRatioOf(...).
 * Branch precedence is fixed and mutually exclusive: not-credible → ceiling →
 * fable-preferred → better-but-not-at-that-price → gain-ruled-out → inconclusive.
 */
export function decide({ boot, sw, meanOpus, costRatio, credible, rule = DECISION_RULE }) {
  if (!credible) return { verdict: 'not-credible' };
  if (boot.delta == null) return { verdict: 'inconclusive', reason: 'no paired cases' };
  const deltaTarget = Math.max(sw ?? 0, rule.deltaFloor);
  if (meanOpus != null && meanOpus >= 1 - deltaTarget) return { verdict: 'inconclusive:ceiling', deltaTarget, reason: `Opus mean q ${round4(meanOpus)} ≥ ${round4(1 - deltaTarget)} — no headroom to show a gain` };
  const materialGain = boot.delta >= deltaTarget && boot.lo > 0;
  if (materialGain && costRatio != null && costRatio <= rule.costRatioMax) return { verdict: 'fable-preferred', deltaTarget };
  if (materialGain) return { verdict: 'opus:fable-better-but-not-at-that-price', deltaTarget, reason: `cost ratio ${costRatio == null ? 'undefined (no correct decision on either arm)' : round4(costRatio)} > ${rule.costRatioMax}` };
  if (boot.hi < deltaTarget) return { verdict: 'opus:material-gain-ruled-out', deltaTarget };
  return { verdict: 'inconclusive', deltaTarget };
}

/**
 * Cost per arm from call records {arm, usd, correct} (usd = derived, may be null
 * only if a call never settled — those are counted, not summed silently).
 */
export function costSummary(calls) {
  const out = {};
  for (const c of calls) {
    const a = (out[c.arm] ||= { calls: 0, pricedCalls: 0, totalUsd: 0, correct: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, thinkingTokens: 0, thinkingReportedCalls: 0, latencyMs: [] });
    a.calls += 1;
    if (Number.isFinite(c.usd)) { a.pricedCalls += 1; a.totalUsd += c.usd; }
    if (c.correct) a.correct += 1;
    const u = c.usage || {};
    a.inputTokens += u.inputTokens || 0;
    a.outputTokens += u.outputTokens || 0;
    a.cacheReadTokens += u.cacheReadTokens || 0;
    a.cacheWriteTokens += u.cacheWriteTokens || 0;
    if (u.thinkingReported) { a.thinkingTokens += u.thinkingTokens; a.thinkingReportedCalls += 1; }
    if (Number.isFinite(c.latencyMs)) a.latencyMs.push(c.latencyMs);
  }
  for (const a of Object.values(out)) {
    a.totalUsd = round4(a.totalUsd);
    a.usdPerCall = a.pricedCalls ? round4(a.totalUsd / a.pricedCalls) : null;
    a.usdPerCorrect = a.correct ? round4(a.totalUsd / a.correct) : null;
    const l = a.latencyMs.slice().sort((x, y) => x - y);
    a.latencyMedianMs = l.length ? l[Math.floor(l.length / 2)] : null;
    delete a.latencyMs;
  }
  return out;
}
