/**
 * @fileoverview Orchestration for one decision-eval run (rehearsal / variance /
 * main): arm calls → blinded double-pass grading with controls → summary.
 * Clients, clock, and file sinks are injected, so the whole run is testable
 * offline; the CLI (scripts/model-eval-decision.mjs) only wires real ones.
 *
 * Plan: docs/plans/fable-vs-opus-decision-eval.md §2, §12, Campaign Contract.
 *
 * Persisted (append-only JSONL, written as it happens, so a crash loses at most
 * the in-flight call): calls.jsonl (raw arm output + usage), grades.jsonl (raw
 * judge output + verified items), ledger.jsonl (every reservation settlement).
 *
 * @module scripts/lib/model-eval/decision/runner
 */

import { mulberry32, seededShuffleCopy } from '../../rng.mjs';
import { DECISION_EVAL_CONTRACT_EPOCH } from './corpus.mjs';
import { runArmCall, buildArmRequest, requestInputBytes, servedModelMatches, DEFAULT_EFFORT, DEFAULT_MAX_TOKENS } from './arm.mjs';
import { gradeOnce, DEFAULT_JUDGE_MAX_OUTPUT_TOKENS, DEFAULT_JUDGE_REASONING } from './judge.mjs';
import { createMeter, BudgetStop, UnpricedModelError } from './meter.mjs';
import {
  scoreGrade, combinePasses, withinCaseSpread, perCaseRange, proposeReps, pairedBootstrap,
  credibilityGates, decide, costSummary, costRatioOf, sampleCompleteness, DECISION_RULE,
} from './analysis.mjs';
import { drawSpotSample } from './spot-sample.mjs';
import { priceFor as defaultPriceFor } from '../../model-pricing.mjs';

export const PHASES = Object.freeze({
  rehearsal: { arms: ['claude-haiku-5-5'], reps: 1 },
  variance: { arms: ['claude-opus-5-5'], reps: 4 },
  main: { arms: ['claude-opus-5-5', 'claude-fable-5-2'], reps: null },
});
export const FABLE = 'claude-fable-5-2';
export const OPUS = 'claude-opus-5-5';
/** Two consecutive arm transport errors ⇒ the route is broken; stop before burning the cap. */
const MAX_CONSECUTIVE_ARM_ERRORS = 2;

function hex8(rnd) { return Math.floor(rnd() * 0xffffffff).toString(16).padStart(8, '0'); }

/**
 * @param {{
 *   phase: 'rehearsal'|'variance'|'main', runId: string, cases: object[], manifest: object,
 *   capUsd: number, reps?: number, arms?: string[], seed?: number, effort?: string,
 *   maxTokens?: number, gitSha?: string|null,
 *   anthropic: object, openai: object, judgeModel: string, judgeReasoning?: string|null,
 *   zodTextFormat: Function, assertEgressSafe: Function,
 *   sink: { call: Function, grade: Function, ledger: Function },
 *   now?: Function, log?: Function,
 * }} o
 */
export async function runDecisionEval(o) {
  const cfg = PHASES[o.phase];
  if (!cfg) throw new Error(`unknown phase "${o.phase}"`);
  const arms = o.arms ?? cfg.arms;
  const reps = o.reps ?? cfg.reps;
  if (!Number.isInteger(reps) || reps < 1) throw new Error(`phase ${o.phase} needs --reps (positive integer)`);
  const seed = o.seed ?? 20261115;
  const effort = o.effort ?? DEFAULT_EFFORT;
  const maxTokens = o.maxTokens ?? DEFAULT_MAX_TOKENS;
  const now = o.now ?? (() => Date.now());
  const log = o.log ?? (() => {});
  const epoch = DECISION_EVAL_CONTRACT_EPOCH;
  const rnd = mulberry32(seed);
  // One cap per budget SCOPE (rehearsal + variance share the autonomous $10):
  // the meter starts from what earlier runs in the scope already spent.
  const budgetScope = o.budgetScope ?? o.runId;
  const meter = createMeter({ capUsd: o.capUsd, initialSpentUsd: o.initialSpentUsd ?? 0, append: (row) => o.sink.ledger({ runId: o.runId, budgetScope, ...row }), contractEpoch: epoch });
  const caseById = Object.fromEntries(o.cases.map((c) => [c.id, c]));

  const calls = [];
  const grades = [];
  let stop = null;
  let consecutiveErrors = 0;

  /** Grade a list twice (each pass in its own seeded order). Returns a stop or null. */
  async function gradeItems(list) {
    for (let pass = 1; pass <= 2; pass++) {
      for (const it of seededShuffleCopy(list, rnd)) {
        const c = caseById[it.caseId];
        if (!it.text || !it.text.trim()) {
          const g = { contractEpoch: epoch, runId: o.runId, gradeId: it.gradeId, kind: it.kind, caseId: it.caseId, rep: it.rep, pass, status: 'auto-zero', reason: 'empty response text', judgeModel: null, grade: null, score: { q: 0, correct: false, coverage: 0, trapRate: 0, unverified: 0 }, attempts: [] };
          grades.push(g); o.sink.grade(g); continue;
        }
        const label = `grade:${it.gradeId}:p${pass}`;
        let res;
        try {
          res = await gradeOnce({
            client: o.openai, model: o.judgeModel, c, outputText: it.text,
            reasoningEffort: o.judgeReasoning === undefined ? DEFAULT_JUDGE_REASONING : o.judgeReasoning,
            maxOutputTokens: DEFAULT_JUDGE_MAX_OUTPUT_TOKENS,
            zodTextFormat: o.zodTextFormat, assertEgressSafe: o.assertEgressSafe, now,
            hooks: {
              before: ({ attempt, inputTokensMax, maxOutputTokens }) => meter.reserve({ label: `${label}:a${attempt}`, model: o.judgeModel, inputTokensMax, maxOutputTokens }),
              after: ({ usageRaw, served }) => {
                if (!served || !usageRaw) meter.chargeWorstCase({ meta: { gradeId: it.gradeId, pass, note: served ? 'judge usage missing' : 'judge transport failure' } });
                else meter.settle({ usage: usageRaw, provider: 'openai', responseModel: o.judgeModel, meta: { gradeId: it.gradeId, pass } });
              },
            },
          });
        } catch (err) {
          if (err instanceof BudgetStop || err instanceof UnpricedModelError) return { kind: err.name, message: err.message };
          throw err;
        }
        const score = res.status === 'scored' ? scoreGrade(c, res.grade) : null;
        const g = { contractEpoch: epoch, runId: o.runId, gradeId: it.gradeId, kind: it.kind, caseId: it.caseId, rep: it.rep, pass, status: res.status, reason: res.reason, judgeModel: o.judgeModel, grade: res.grade, score, attempts: res.attempts };
        grades.push(g); o.sink.grade(g);
      }
    }
    return null;
  }

  // ── Egress preflight BEFORE any spend ──────────────────────────────────────
  // Every case's arm payload is known up front, so check them all now: a
  // refusal found at the Nth case mid-run (2026-11-15, variance-e2b: a quoted
  // local-dev DSN tripped `dsn-password` after 5 paid arm calls) is spend for
  // a run that cannot complete. A refusal still propagates from the per-call
  // check below — this only moves the discovery to before the first call.
  for (const c of o.cases) {
    for (const model of arms) {
      const req = buildArmRequest({ model, c, effort, maxTokens });
      try { o.assertEgressSafe(`${req.system}\n${req.messages[0].content}`, { label: 'decision-eval:arm' }); } catch (err) {
        stop = { kind: 'InstrumentFailure', message: `egress preflight: case ${c.id} arm payload refused before any spend — ${err.message}` };
        break;
      }
    }
    if (stop) break;
  }

  // ── Control checkpoint BEFORE any arm spend (plan §C4/§C8) ─────────────────
  // Judge-only cost: if the judge cannot tell each case's frozen gold answer
  // from its frozen confident-wrong answer, no arm output it grades means
  // anything, so stop before paying for arms.
  const preflightItems = o.cases.flatMap((c) => [
    { gradeId: hex8(rnd), kind: 'preflight-gold', caseId: c.id, rep: 0, text: c.controls.gold },
    { gradeId: hex8(rnd), kind: 'preflight-trap', caseId: c.id, rep: 0, text: c.controls.trap },
  ]);
  if (!stop) stop = await gradeItems(preflightItems);
  if (!stop) {
    const pf = controlOutcomes(preflightItems, grades);
    if (pf.total !== preflightItems.length || pf.passed !== pf.total) {
      stop = { kind: 'InstrumentFailure', message: `control checkpoint: ${pf.passed}/${preflightItems.length} judge controls passed before any arm spend — the judge or a rubric is broken; failed: ${pf.failures.map((f) => `${f.kind}:${f.caseId}`).join(', ') || 'unmeasured'}` };
    }
  }

  // ── Arms ────────────────────────────────────────────────────────────────────
  outer:
  for (let rep = 1; rep <= (stop ? 0 : reps); rep++) {
    for (const c of seededShuffleCopy(o.cases, rnd)) {
      for (const model of seededShuffleCopy(arms, rnd)) {
        const callId = `${o.runId}:${c.id}:r${rep}:${model}`;
        const req = buildArmRequest({ model, c, effort, maxTokens });
        o.assertEgressSafe(`${req.system}\n${req.messages[0].content}`, { label: 'decision-eval:arm' });
        try {
          meter.reserve({ label: callId, model, inputTokensMax: requestInputBytes(req), maxOutputTokens: maxTokens });
        } catch (err) {
          if (err instanceof BudgetStop || err instanceof UnpricedModelError) { stop = { kind: err.name, message: err.message }; break outer; }
          throw err;
        }
        log(`arm ${callId}`);
        const r = await runArmCall({ client: o.anthropic, model, c, effort, maxTokens, now });
        let usd = null;
        try {
          if (r.status === 'arm-error') meter.chargeWorstCase({ meta: { callId, note: 'arm-error, usage unknown' } });
          else usd = meter.settle({ usage: r.usageRaw, provider: 'anthropic', responseModel: servedModelMatches(model, r.responseModel) ? model : r.responseModel, meta: { callId } });
        } catch (err) {
          if (err instanceof BudgetStop || err instanceof UnpricedModelError) stop = { kind: err.name, message: err.message };
          else throw err;
        }
        const row = {
          contractEpoch: epoch, runId: o.runId, phase: o.phase, callId, caseId: c.id, role: c.role, rep,
          arm: model, requestedModel: model, responseModel: r.responseModel, effort, maxTokens,
          status: r.status, stopReason: r.stopReason, stopDetails: r.stopDetails,
          usage: r.usage, usageRaw: r.usageRaw, usd, usdBasis: usd == null ? null : 'derived',
          latencyMs: r.latencyMs, thinkingBlocks: r.thinkingBlocks, outputChars: r.text.length,
          text: r.text, error: r.error,
          // Opaque grade id for gradeable outputs; the judge never sees this file.
          // Not gradeable: no answer reached us (transport, wrong model, or a
          // thinking-only truncation). Excluded, and counted by sampleCompleteness.
          gradeId: (r.status === 'arm-error' || r.status === 'model-mismatch' || r.status === 'truncated-no-text') ? null : hex8(rnd),
        };
        calls.push(row);
        o.sink.call(row); // persisted immediately — a crash loses at most the in-flight call
        if (r.status === 'model-mismatch') stop = { kind: 'InstrumentFailure', message: `${callId}: requested ${model}, served ${r.responseModel}` };
        consecutiveErrors = r.status === 'arm-error' ? consecutiveErrors + 1 : 0;
        if (consecutiveErrors >= MAX_CONSECUTIVE_ARM_ERRORS) stop = { kind: 'ArmRouteBroken', message: `${consecutiveErrors} consecutive arm errors; last: ${r.error}` };
        if (stop) break outer;
      }
    }
  }

  // ── Grading list: arm outputs + per-rep controls, opaque ids, shuffled ─────
  const items = calls.filter((r) => r.gradeId).map((r) => ({ gradeId: r.gradeId, kind: 'arm', caseId: r.caseId, rep: r.rep, text: r.text }));
  const repsRun = [...new Set(calls.map((r) => r.rep))];
  for (const rep of repsRun) {
    for (const c of o.cases) {
      if (!calls.some((r) => r.rep === rep && r.caseId === c.id && r.gradeId)) continue;
      items.push({ gradeId: hex8(rnd), kind: 'control-gold', caseId: c.id, rep, text: c.controls.gold });
      items.push({ gradeId: hex8(rnd), kind: 'control-trap', caseId: c.id, rep, text: c.controls.trap });
    }
  }

  // ── Grade: two passes, each over its own seeded order ──────────────────────
  // After a stop no further grading spend is made; graded-so-far rows remain
  // on disk, and the summary marks the run incomplete.
  if (!stop) stop = await gradeItems(items);

  return buildSummary({
    phase: o.phase, runId: o.runId, manifest: o.manifest, cases: o.cases, arms, reps, seed, effort, maxTokens,
    judgeModel: o.judgeModel, judgeReasoning: o.judgeReasoning === undefined ? DEFAULT_JUDGE_REASONING : o.judgeReasoning,
    gitSha: o.gitSha ?? null, calls, grades, items: [...preflightItems, ...items], spentUsd: meter.spentUsd, capUsd: o.capUsd, stop,
    budgetScope, scopeSpentBeforeUsd: o.initialSpentUsd ?? 0,
  });
}

/**
 * Judge-control outcomes over control items (preflight or in-run). Gold must be
 * correct in BOTH passes with mean coverage ≥ 0.8; trap must be incorrect in
 * both AND fall into trap1 (the main trap) in both. A control with < 2 scored
 * passes is not counted here (it is counted as unmeasured).
 */
export function controlOutcomes(items, grades) {
  const out = { total: 0, passed: 0, failures: [] };
  for (const it of items.filter((i) => i.kind !== 'arm')) {
    const scored = grades.filter((g) => g.gradeId === it.gradeId && g.status === 'scored');
    if (scored.length < 2) continue;
    out.total += 1;
    const ok = /gold$/.test(it.kind)
      ? scored.every((g) => g.score.correct === true) && (scored.reduce((n, g) => n + (g.score.coverage ?? 0), 0) / scored.length) >= 0.8
      : scored.every((g) => g.score.correct === false && g.grade.traps.find((t) => t.id === 'trap1')?.fell === true);
    if (ok) out.passed += 1; else out.failures.push({ kind: it.kind, caseId: it.caseId, rep: it.rep, gradeId: it.gradeId });
  }
  return out;
}

/** Pure: everything in summary.json is derived from the persisted rows. */
export function buildSummary({ phase, runId, manifest, cases, arms, reps, seed, effort, maxTokens, judgeModel, judgeReasoning, gitSha, calls, grades, items, spentUsd, capUsd, stop, spotAgreement = undefined, budgetScope = null, scopeSpentBeforeUsd = 0 }) {
  const byGrade = new Map();
  for (const g of grades) { if (!byGrade.has(g.gradeId)) byGrade.set(g.gradeId, []); byGrade.get(g.gradeId).push(g); }
  const combined = (gradeId) => {
    const gs = (byGrade.get(gradeId) || []).filter((g) => g.score);
    return combinePasses(gs.map((g) => g.score));
  };

  // Arm outputs.
  const outputs = calls.filter((r) => r.gradeId).map((r) => ({ ...combined(r.gradeId), arm: r.arm, caseId: r.caseId, rep: r.rep, role: r.role, usd: r.usd, usage: r.usage, latencyMs: r.latencyMs, outputChars: r.outputChars, status: r.status }));

  const controls = controlOutcomes(items, grades);

  const unmeasured = grades.filter((g) => g.status === 'unmeasured').length;
  const unmeasuredRate = grades.length ? unmeasured / grades.length : 0;
  const unverifiedItems = grades.reduce((n, g) => n + (g.score?.unverified || 0), 0);
  const correctDisagreements = outputs.filter((o) => o.correctDisagree).length;
  const modelMismatches = calls.filter((r) => r.status === 'model-mismatch').length;
  const judgeDeltas = outputs.map((o) => o.judgeDelta).filter((x) => x != null);
  const sj = judgeDeltas.length ? judgeDeltas.reduce((a, b) => a + b, 0) / judgeDeltas.length : null;

  const perArm = {};
  for (const arm of arms) {
    const rows = outputs.filter((o) => o.arm === arm);
    const qs = rows.map((r) => r.q).filter((x) => x != null);
    perArm[arm] = {
      outputs: rows.length,
      meanQ: qs.length ? round4(qs.reduce((a, b) => a + b, 0) / qs.length) : null,
      correct: rows.filter((r) => r.correct).length,
      sw: round4(withinCaseSpread(rows)),
      perCase: perCaseRange(rows),
      statuses: countBy(calls.filter((r) => r.arm === arm), 'status'),
    };
  }
  const cost = costSummary(calls.map((r) => ({ arm: r.arm, usd: r.usd, usage: r.usage, latencyMs: r.latencyMs, correct: outputs.find((o) => o.caseId === r.caseId && o.rep === r.rep && o.arm === r.arm)?.correct })));
  const k = cases.length;
  const swMax = Math.max(...arms.map((a) => perArm[a].sw ?? -1));
  const sw = swMax >= 0 ? swMax : null;
  // Sample completeness: per arm in a single-arm phase; per measured PAIR in main.
  const caseIds = cases.map((c) => c.id);
  const measuredOutputs = outputs.filter((x) => x.q != null);
  let unitsByScope;
  if (phase === 'main' && arms.includes(FABLE) && arms.includes(OPUS)) {
    const pairs = new Map();
    for (const x of measuredOutputs) { const kk = `${x.caseId}:${x.rep}`; (pairs.get(kk) || pairs.set(kk, { caseId: x.caseId, arms: new Set() }).get(kk)).arms.add(x.arm); }
    unitsByScope = { pairs: [...pairs.values()].filter((p) => p.arms.has(FABLE) && p.arms.has(OPUS)) };
  } else {
    unitsByScope = Object.fromEntries(arms.map((a) => [a, measuredOutputs.filter((x) => x.arm === a)]));
  }
  const armErrors = Object.fromEntries(arms.map((a) => [a, calls.filter((r) => r.arm === a && r.status === 'arm-error').length]));
  // The rehearsal is a 1-rep pipeline check: it measures no spread, so the
  // completeness floor (≥ 2 per case) does not apply to it.
  const sampleFailures = phase === 'rehearsal' ? [] : sampleCompleteness({ unitsByScope, plannedPerCase: reps, cases: caseIds, armErrors, plannedCallsPerArm: reps * caseIds.length });
  const gates = credibilityGates({ controlsPassed: controls.passed, controlsTotal: controls.total, sj, sw, unmeasuredRate, modelMismatches, spotAgreement, requireSpot: phase === 'main', sampleFailures });

  const summary = {
    contractEpoch: DECISION_EVAL_CONTRACT_EPOCH, phase, runId, gitSha,
    corpusSha256: manifest?.corpusSha256 ?? null, promptHashes: manifest?.promptHashes ?? null,
    design: { arms, reps, cases: k, seed, effort, maxTokens, judgeModel, judgeReasoning, rule: DECISION_RULE },
    status: stop ? `stopped:${stop.kind}` : 'completed',
    spend: { runSpentUsd: round4(spentUsd - scopeSpentBeforeUsd), scopeSpentUsd: round4(spentUsd), scopeSpentBeforeUsd: round4(scopeSpentBeforeUsd), budgetScope, capUsd, basis: 'derived: measured tokens × published price (model-pricing-table.mjs)' },
    stop,
    instrument: { controls, unmeasuredGrades: unmeasured, totalGrades: grades.length, unmeasuredRate: round4(unmeasuredRate), unverifiedItems, correctDisagreements, modelMismatches, judgeNoise: round4(sj), credible: gates.credible, gateFailures: gates.failures },
    perArm, cost,
    fillCheck: fillCheck(calls, grades),
  };

  if (phase === 'variance' || phase === 'rehearsal') {
    summary.proposedN = proposeReps({ sw, k });
    summary.mainProjection = projectMainCost({ cost, arm: arms[0], spentUsd: spentUsd - scopeSpentBeforeUsd, grades: grades.length, k, reps: summary.proposedN.reps });
  }
  if (phase === 'main' && arms.includes(FABLE) && arms.includes(OPUS)) {
    const rows = outputs.map((o) => ({ caseId: o.caseId, arm: o.arm, q: o.q, role: o.role }));
    const ratio = costRatioOf(cost[FABLE]?.usdPerCorrect ?? null, cost[OPUS]?.usdPerCorrect ?? null);
    // Pairing: a case-rep counts only when BOTH arms have a measured q.
    const key = (o) => `${o.caseId}:${o.rep}`;
    const measured = new Map();
    for (const o of outputs) if (o.q != null) { (measured.get(key(o)) || measured.set(key(o), new Set()).get(key(o))).add(o.arm); }
    const caseReps = new Set(outputs.map(key));
    const unpaired = [...caseReps].filter((kk) => !(measured.get(kk)?.has(FABLE) && measured.get(kk)?.has(OPUS)));
    const pairedKeys = new Set([...caseReps].filter((kk) => !unpaired.includes(kk)));
    const pairedRows = rows.filter((r, i) => pairedKeys.has(key(outputs[i])));
    const boot = pairedBootstrap({ rows: pairedRows, armA: FABLE, armB: OPUS, seed });
    // Feasibility re-check: the main run's own spread may exceed the planning assumption.
    const needed = proposeReps({ sw, k });
    summary.verdict = { unpairedCaseReps: unpaired, underpowered: needed.reps != null && (needed.infeasible || needed.reps > reps), repsNeededAtObservedSpread: needed, pooled: { boot, costRatio: Number.isFinite(ratio) ? round4(ratio) : ratio, ...decide({ boot, sw, meanOpus: perArm[OPUS].meanQ, costRatio: ratio, credible: gates.credible }) }, byRole: {} };
    for (const role of [...new Set(cases.map((c) => c.role))]) {
      const roleCases = cases.filter((c) => c.role === role).map((c) => c.id);
      if (roleCases.length < 2) { summary.verdict.byRole[role] = { verdict: 'untested', reason: `${roleCases.length} case(s) < 2` }; continue; }
      const rb = pairedBootstrap({ rows: pairedRows.filter((r) => roleCases.includes(r.caseId)), armA: FABLE, armB: OPUS, seed });
      const om = rows.filter((r) => r.arm === OPUS && roleCases.includes(r.caseId) && r.q != null).map((r) => r.q);
      summary.verdict.byRole[role] = { boot: rb, ...decide({ boot: rb, sw, meanOpus: om.length ? om.reduce((a, b) => a + b, 0) / om.length : null, costRatio: ratio, credible: gates.credible }) };
    }
  }
  summary.spotSampleIds = drawSpotSample(calls.filter((r) => r.gradeId).map((r) => r.gradeId), { seed });
  return summary;
}

/**
 * Projected main-run cost from the variance phase. Opus per call is MEASURED;
 * Fable per call is ESTIMATED as Opus's measured mean tokens at Fable's prices,
 * with a high band at 1.5× output (Fable may think longer); judge per grade is
 * MEASURED (all judge spend ÷ grades). Labelled so no figure is read as billed.
 */
export function projectMainCost({ cost, arm, spentUsd, grades, k, reps, priceFor = defaultPriceFor }) {
  const a = cost[arm];
  if (!a || !a.pricedCalls || !Number.isInteger(reps)) return { available: false, reason: 'no priced arm calls or no proposed n' };
  const inTok = a.inputTokens / a.pricedCalls; // token sums only cover calls that returned usage (audit final gate G1)
  const outTok = a.outputTokens / a.pricedCalls;
  const fx = priceFor(FABLE);
  const fable = (mult) => (inTok * fx.input + outTok * mult * fx.output) / 1e6;
  const judgeUsd = Math.max(0, spentUsd - a.totalUsd);
  const judgePerGrade = grades ? judgeUsd / grades : null;
  const callsPerArm = k * reps;
  // per arm output: 2 passes; controls: 2 per case per rep, 2 passes each; plus the checkpoint.
  const gradesMain = 4 * k + 2 * (2 * callsPerArm) + 2 * (2 * k * reps); // + the pre-arm control checkpoint (2 controls x 2 passes per case)
  const opusTotal = a.usdPerCall * callsPerArm;
  const judgeTotal = judgePerGrade == null ? null : judgePerGrade * gradesMain;
  const at = (mult) => round4(opusTotal + fable(mult) * callsPerArm + (judgeTotal ?? 0));
  return {
    available: true, reps, callsPerArm, gradesMain,
    opusUsdPerCall: { value: a.usdPerCall, label: 'measured (derived from measured tokens)' },
    fableUsdPerCall: { value: round4(fable(1)), high: round4(fable(1.5)), label: 'estimated (Opus measured tokens × Fable price; high = 1.5× output)' },
    judgeUsdPerGrade: { value: round4(judgePerGrade), label: 'measured (derived)' },
    totalUsd: { value: at(1), high: at(1.5), label: 'estimated' },
    suggestedCapUsd: { value: Math.ceil(at(1.5) * 1.5), label: 'estimated: high band × 1.5 headroom' },
  };
}

function countBy(rows, key) { const o = {}; for (const r of rows) o[r[key]] = (o[r[key]] || 0) + 1; return o; }
function round4(x) { return Number.isFinite(x) ? Math.round(x * 1e4) / 1e4 : (x ?? null); }

/** C5 fill-check: every declared field on a completed call is a real value. */
export function fillCheck(calls, grades) {
  const problems = [];
  for (const r of calls) {
    if (r.status === 'arm-error') continue;
    for (const f of ['inputTokens', 'outputTokens']) if (!(r.usage?.[f] > 0)) problems.push(`${r.callId}: usage.${f}=${r.usage?.[f]}`);
    for (const f of ['cacheWriteTokens', 'cacheReadTokens']) if (r.usage?.[f] == null) problems.push(`${r.callId}: usage.${f} not reported`);
    if (!r.responseModel) problems.push(`${r.callId}: responseModel missing`);
    if (!Number.isFinite(r.latencyMs) || r.latencyMs <= 0) problems.push(`${r.callId}: latency ${r.latencyMs}`);
    if (r.usd == null) problems.push(`${r.callId}: usd not derived`);
  }
  for (const g of grades) {
    if (g.status !== 'scored') continue;
    const last = g.attempts[g.attempts.length - 1];
    if (!last?.usageRaw) problems.push(`${g.gradeId}/p${g.pass}: judge usage missing`);
  }
  const thinkingReported = calls.filter((r) => r.usage?.thinkingReported).length;
  return { ok: problems.length === 0, problems, thinkingTokensReportedOnCalls: thinkingReported, thinkingNote: thinkingReported ? null : 'API reported no thinking-token field; thinking is billed inside output_tokens (recorded as null, not 0)' };
}
