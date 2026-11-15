/**
 * @fileoverview Cross-vendor spot grading for the decision-eval. Two independent
 * LLM graders (GPT, Gemini) re-grade the main run's persisted spot sample. This
 * replaces the human-marked worksheet. Louis sees only the exceptions.
 *
 * Pre-registered rule: docs/research/fable-vs-opus-decision-eval/deviations.md,
 * entry 2026-11-15T15:52Z (written before any main-run output was read).
 *
 * - Each grader grades every case's gold + trap control FIRST (single pass, the
 *   primary checkpoint's definition). A grader that fails any control
 *   contributes no sample grades.
 * - Each grader then grades every sampled output ONCE, blind to the primary's
 *   grade, the other grader's grade and the arm: same judge input, schema and
 *   quote check as the primary (`gradeOnce`).
 * - `evaluateCrossGrade` is pure over the persisted rows.
 *
 * @module scripts/lib/model-eval/decision/cross-grade
 */

import { gradeOnce, DEFAULT_JUDGE_REASONING } from './judge.mjs';
import { scoreGrade } from './analysis.mjs';
import { BudgetStop, UnpricedModelError } from './meter.mjs';
import { normalizeGeminiUsage } from '../../gemini-usage.mjs';

export const CROSS_GRADE_RULE = Object.freeze({
  /** E2: |mean(q_S1, q_S2) − q_p| above this is an exception. */
  qDelta: 0.25,
  /** Sample certifies only at or below this exception rate. */
  maxExceptionRate: 0.2,
  controlCoverageMin: 0.8,
});

/** Gemini thinking budget at the primary judge's effort (medium), mirroring final-review. */
export const GEMINI_THINKING_BUDGET = 8192;
export const GEMINI_MAX_OUTPUT_TOKENS = GEMINI_THINKING_BUDGET + 6000;

/**
 * An `invoke` for `gradeOnce` that sends the OpenAI-shaped params to Gemini with a
 * JSON response schema, and maps the reply back to the Responses shape.
 * A reply that is not JSON throws SyntaxError, so `gradeOnce` files it as
 * judge-malformed, never as a score.
 */
export function makeGeminiInvoker({ genai, toGeminiSchema }) {
  return async (params, { schema }) => {
    const resp = await genai.models.generateContent({
      model: params.model,
      contents: params.input,
      config: {
        systemInstruction: params.instructions,
        responseMimeType: 'application/json',
        responseSchema: toGeminiSchema(schema),
        maxOutputTokens: params.max_output_tokens,
        thinkingConfig: { thinkingBudget: GEMINI_THINKING_BUDGET },
      },
    });
    const g = normalizeGeminiUsage(resp?.usageMetadata);
    // Unmeterable usage is UNKNOWN, never zero: null ⇒ the meter charges the worst case.
    const usage = g.usageMissing ? null : { input_tokens: g.input_tokens, output_tokens: g.output_tokens };
    const text = resp?.text ?? null;
    const finish = resp?.candidates?.[0]?.finishReason ?? null;
    if (finish && finish !== 'STOP') {
      const e = new SyntaxError(`gemini finishReason ${finish}`); e.usage = usage; throw e;
    }
    let parsed = null;
    try { parsed = text ? JSON.parse(text) : null; } catch (err) { err.usage = usage; throw err; }
    return { output_parsed: parsed, output_text: text, usage, model: resp?.modelVersion ?? params.model };
  };
}

/** Single-pass control verdict, the primary checkpoint's definition applied to one grade. */
export function controlPassesSingle(kind, score, grade, rule = CROSS_GRADE_RULE) {
  if (!score) return false;
  if (/gold$/.test(kind)) return score.correct === true && (score.coverage ?? 0) >= rule.controlCoverageMin;
  return score.correct === false && grade?.traps?.find((t) => t.id === 'trap1')?.fell === true;
}

/**
 * Grade controls then the sample, per grader, sequentially, metered.
 * @param {{ graders: Array<{name:string, model:string, provider:'openai', invoke?:Function, client?:object, reasoningEffort?:string|null, maxOutputTokens:number}>,
 *   controls: Array<{gradeId:string, kind:string, caseId:string, text:string}>,
 *   sample: Array<{gradeId:string, caseId:string, text:string}>,
 *   caseById: Record<string, object>, meter: object, sink: (row:object)=>void,
 *   zodTextFormat: Function, assertEgressSafe: Function, epoch: number, runId: string,
 *   log?: Function, now?: Function }} o
 * @returns {Promise<{rows: object[], stop: object|null}>}
 */
export async function runCrossGrade(o) {
  const log = o.log ?? (() => {});
  const rows = [];
  const gradeOne = async (gr, it, role) => {
    const c = o.caseById[it.caseId];
    const label = `xgrade:${gr.name}:${role}:${it.gradeId}`;
    const res = await gradeOnce({
      client: gr.client, invoke: gr.invoke ?? null, model: gr.model, c, outputText: it.text,
      reasoningEffort: gr.reasoningEffort === undefined ? DEFAULT_JUDGE_REASONING : gr.reasoningEffort,
      maxOutputTokens: gr.maxOutputTokens,
      zodTextFormat: o.zodTextFormat, assertEgressSafe: o.assertEgressSafe, now: o.now,
      hooks: {
        before: ({ attempt, inputTokensMax, maxOutputTokens }) => o.meter.reserve({ label: `${label}:a${attempt}`, model: gr.model, inputTokensMax, maxOutputTokens }),
        after: ({ usageRaw, served }) => {
          if (!served || !usageRaw) o.meter.chargeWorstCase({ meta: { grader: gr.name, gradeId: it.gradeId, note: served ? 'usage missing' : 'transport failure' } });
          else o.meter.settle({ usage: usageRaw, provider: 'openai', responseModel: gr.model, meta: { grader: gr.name, gradeId: it.gradeId } });
        },
      },
    });
    const score = res.status === 'scored' ? scoreGrade(c, res.grade) : null;
    const row = { contractEpoch: o.epoch, runId: o.runId, grader: gr.name, graderModel: gr.model, role, gradeId: it.gradeId, kind: it.kind ?? 'arm', caseId: it.caseId, status: res.status, reason: res.reason, grade: res.grade, score, attempts: res.attempts };
    if (role === 'control') row.controlPassed = controlPassesSingle(row.kind, score, res.grade);
    rows.push(row); o.sink(row);
    return row;
  };
  try {
    for (const gr of o.graders) {
      let failed = 0;
      for (const it of o.controls) { const r = await gradeOne(gr, it, 'control'); if (!r.controlPassed) failed += 1; }
      log(`${gr.name}: controls ${o.controls.length - failed}/${o.controls.length}`);
      // Pre-registered: a grader that fails any control contributes no sample grades.
      if (failed > 0) { log(`${gr.name}: failed ${failed} control(s) — sample not graded by this grader`); continue; }
      for (const it of o.sample) await gradeOne(gr, it, 'sample');
    }
  } catch (err) {
    if (err instanceof BudgetStop || err instanceof UnpricedModelError) return { rows, stop: { kind: err.name, message: err.message } };
    throw err;
  }
  return { rows, stop: null };
}

/**
 * Pure verdict over persisted rows.
 * @param {{ rows: object[], primaryGrades: object[], sampleIds: string[], graders: string[], controlsExpected: number, rule?: object }} a
 */
export function evaluateCrossGrade({ rows, primaryGrades, sampleIds, graders, controlsExpected, rule = CROSS_GRADE_RULE }) {
  const graderControls = Object.fromEntries(graders.map((g) => {
    const cs = rows.filter((r) => r.grader === g && r.role === 'control');
    const passed = cs.filter((r) => r.controlPassed).length;
    return [g, { graded: cs.length, passed, ok: cs.length === controlsExpected && passed === controlsExpected }];
  }));
  const allControlsOk = graders.every((g) => graderControls[g].ok);
  const items = sampleIds.map((gid) => {
    const prim = primaryGrades.filter((g) => g.gradeId === gid && g.score);
    const pq = prim.map((g) => g.score.q).filter((q) => Number.isFinite(q));
    const primary = {
      correct: prim.length === 2 && prim.every((g) => g.score.correct === true),
      q: pq.length === 2 ? (pq[0] + pq[1]) / 2 : null,
      split: prim.length === 2 && prim[0].score.correct !== prim[1].score.correct,
    };
    const sec = Object.fromEntries(graders.map((g) => {
      const r = rows.find((x) => x.grader === g && x.role === 'sample' && x.gradeId === gid);
      const measured = Boolean(r && r.status === 'scored' && Number.isFinite(r.score?.q) && r.score.correct != null);
      return [g, measured ? { q: r.score.q, correct: r.score.correct } : { q: null, correct: null, unmeasured: r ? (r.reason ?? 'quote-voided') : 'not-graded' }];
    }));
    const reasons = [];
    const vals = graders.map((g) => sec[g]);
    if (primary.q == null) reasons.push('E3: primary grade unmeasured');
    if (vals.some((v) => v.q == null)) reasons.push('E3: a cross-grader grade is unmeasured');
    if (vals.every((v) => v.correct != null) && vals.every((v) => v.correct !== primary.correct)) reasons.push('E1: both cross-graders disagree with the primary on correct');
    if (primary.q != null && vals.every((v) => v.q != null)) {
      const m = vals.reduce((n, v) => n + v.q, 0) / vals.length;
      if (Math.abs(m - primary.q) > rule.qDelta) reasons.push(`E2: |mean cross q ${m.toFixed(2)} − primary q ${primary.q.toFixed(2)}| > ${rule.qDelta}`);
    }
    return { gradeId: gid, primary, cross: sec, exception: reasons.length > 0, reasons };
  });
  const exceptions = items.filter((i) => i.exception).length;
  const exceptionRate = items.length ? exceptions / items.length : null;
  const measuredPairs = items.filter((i) => i.primary.q != null && graders.every((g) => i.cross[g].q != null));
  const agreeOn = (g) => measuredPairs.filter((i) => i.cross[g].correct === i.primary.correct).length;
  const certified = allControlsOk && exceptionRate != null && exceptionRate <= rule.maxExceptionRate;
  return {
    rule, graders, graderControls, allControlsOk,
    sampleSize: items.length, exceptions, exceptionRate,
    // Fed to the existing ≥ 0.8 credibility gate. null (absent) unless every control passed.
    spotAgreement: allControlsOk && exceptionRate != null ? 1 - exceptionRate : null,
    correctAgreement: Object.fromEntries(graders.map((g) => [g, measuredPairs.length ? agreeOn(g) / measuredPairs.length : null])),
    meanAbsQDiff: Object.fromEntries(graders.map((g) => [g, measuredPairs.length ? measuredPairs.reduce((n, i) => n + Math.abs(i.cross[g].q - i.primary.q), 0) / measuredPairs.length : null])),
    certified,
    items,
  };
}
