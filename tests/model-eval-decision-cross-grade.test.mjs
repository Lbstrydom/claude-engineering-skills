/**
 * Tests for the decision-eval cross-vendor spot graders (GPT + Gemini), the
 * rule pre-registered 2026-11-15T15:52Z in
 * docs/research/fable-vs-opus-decision-eval/deviations.md. Every client is
 * injected: nothing reaches a provider, nothing is spent.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { evaluateCrossGrade, controlPassesSingle, makeGeminiInvoker, runCrossGrade, CROSS_GRADE_RULE } from '../scripts/lib/model-eval/decision/cross-grade.mjs';
import { gradeOnce } from '../scripts/lib/model-eval/decision/judge.mjs';
import { createMeter } from '../scripts/lib/model-eval/decision/meter.mjs';

const CASE = Object.freeze({
  id: 'fx',
  rubric: {
    decision: 'Fix the cause reporting in code; keep the test.',
    keyPoints: [{ id: 'kp1', text: 'names the race', weight: 1 }, { id: 'kp2', text: 'keeps the test', weight: 1 }],
    traps: [{ id: 'trap1', text: 'calls it a flake' }],
  },
  question: 'Diagnose the failure.',
});
const GOOD_TEXT = 'a real race between exit and the stdin write; keep the test as it is.';
const goodGrade = {
  keyPoints: [{ id: 'kp1', hit: true, quote: 'a real race between exit' }, { id: 'kp2', hit: true, quote: 'keep the test as it is' }],
  traps: [{ id: 'trap1', fell: false, quote: '' }],
  decisionCorrect: { value: true, quote: 'keep the test as it is' },
  rationale: 'ok',
};
const noEgress = () => {};
const fakeZodTextFormat = (schema, name) => ({ type: 'json_schema', name, schema });

// ── evaluateCrossGrade: pure rule ───────────────────────────────────────────
const prim = (gradeId, q1, c1, q2 = q1, c2 = c1) => [
  { gradeId, kind: 'arm', pass: 1, score: { q: q1, correct: c1 } },
  { gradeId, kind: 'arm', pass: 2, score: { q: q2, correct: c2 } },
];
const xrow = (grader, gradeId, q, correct, status = 'scored') => ({ grader, role: 'sample', gradeId, status, score: status === 'scored' ? { q, correct } : null, reason: status === 'scored' ? null : 'judge-transport' });
const ctlRows = (grader, n, passed = n) => Array.from({ length: n }, (_, i) => ({ grader, role: 'control', gradeId: `c${i}`, controlPassed: i < passed }));
const G = ['gpt', 'gemini'];
const CIDS = (n) => Array.from({ length: n }, (_, i) => `c${i}`);

describe('evaluateCrossGrade (pre-registered rule)', () => {
  const base = (sampleRows, primaries, ids, { ctlPassedGpt = 4 } = {}) => evaluateCrossGrade({
    rows: [...ctlRows('gpt', 4, ctlPassedGpt), ...ctlRows('gemini', 4), ...sampleRows],
    primaryGrades: primaries, sampleIds: ids, graders: G, controlIds: CIDS(4),
  });

  it('certifies when both graders agree with the primary', () => {
    const ids = ['a1', 'a2', 'a3', 'a4', 'a5'];
    const ev = base(ids.flatMap((id) => [xrow('gpt', id, 0.8, true), xrow('gemini', id, 0.7, true)]), ids.flatMap((id) => prim(id, 0.75, true)), ids);
    assert.equal(ev.exceptions, 0);
    assert.equal(ev.certified, true);
    assert.equal(ev.spotAgreement, 1);
    assert.equal(ev.correctAgreement.gpt, 1);
  });

  it('E1: both graders disagree on correct → exception; one dissenter is not', () => {
    const ids = ['a1', 'a2'];
    const ev = base([xrow('gpt', 'a1', 0.7, false), xrow('gemini', 'a1', 0.7, false), xrow('gpt', 'a2', 0.7, false), xrow('gemini', 'a2', 0.7, true)], [...prim('a1', 0.7, true), ...prim('a2', 0.7, true)], ids);
    assert.deepEqual(ev.items.map((i) => i.exception), [true, false]);
    assert.match(ev.items[0].reasons.join(' '), /E1/);
  });

  it('E2: mean cross q more than 0.25 from primary q → exception; exactly 0.25 is not', () => {
    const ids = ['a1', 'a2'];
    const ev = base([xrow('gpt', 'a1', 0.3, true), xrow('gemini', 'a1', 0.3, true), xrow('gpt', 'a2', 0.5, true), xrow('gemini', 'a2', 0.5, true)], [...prim('a1', 0.6, true), ...prim('a2', 0.75, true)], ids);
    assert.equal(ev.items[0].exception, true, '0.30 > 0.25');
    assert.equal(ev.items[1].exception, false, '0.25 is at the bar, not above it');
    assert.equal(CROSS_GRADE_RULE.qDelta, 0.25);
  });

  it('E3: an unmeasured cross grade or primary is an exception, never agreement', () => {
    const ids = ['a1', 'a2'];
    const ev = base([xrow('gpt', 'a1', null, null, 'unmeasured'), xrow('gemini', 'a1', 0.7, true), xrow('gpt', 'a2', 0.7, true), xrow('gemini', 'a2', 0.7, true)], [...prim('a1', 0.7, true), ...prim('a2', null, true, 0.7, true)], ids);
    assert.deepEqual(ev.items.map((i) => i.exception), [true, true]);
    // a missing row (never graded) is unmeasured too
    const ev2 = base([xrow('gemini', 'a1', 0.7, true)], prim('a1', 0.7, true), ['a1']);
    assert.equal(ev2.items[0].cross.gpt.unmeasured, 'not-graded');
    assert.equal(ev2.items[0].exception, true);
  });

  it('sample rule: 2/10 certifies, 3/10 does not (threshold 0.20)', () => {
    const ids = Array.from({ length: 10 }, (_, i) => `a${i}`);
    const mk = (nBad) => base(ids.flatMap((id, i) => [xrow('gpt', id, i < nBad ? 0 : 0.7, true), xrow('gemini', id, i < nBad ? 0 : 0.7, true)]), ids.flatMap((id) => prim(id, 0.7, true)), ids);
    assert.equal(mk(2).certified, true);
    assert.equal(mk(3).certified, false);
    assert.equal(mk(3).spotAgreement, 0.7);
  });

  it('a grader failing one control blocks certification and nulls spotAgreement', () => {
    const ids = ['a1'];
    const ev = base([xrow('gpt', 'a1', 0.7, true), xrow('gemini', 'a1', 0.7, true)], prim('a1', 0.7, true), ids, { ctlPassedGpt: 3 });
    assert.equal(ev.allControlsOk, false);
    assert.equal(ev.certified, false);
    assert.equal(ev.spotAgreement, null);
  });

  it('a grader with too few control rows is not ok (incomplete ≠ passed)', () => {
    const ev = evaluateCrossGrade({ rows: [...ctlRows('gpt', 3), ...ctlRows('gemini', 4)], primaryGrades: [], sampleIds: [], graders: G, controlIds: CIDS(4) });
    assert.equal(ev.graderControls.gpt.ok, false);
    assert.equal(ev.certified, false);
  });

  it('controls count by IDENTITY: a duplicated passing row cannot stand in for a missing control', () => {
    const dup = [{ grader: 'gpt', role: 'control', gradeId: 'c0', controlPassed: true }, { grader: 'gpt', role: 'control', gradeId: 'c0', controlPassed: true }];
    const ev = evaluateCrossGrade({ rows: [...dup, ...ctlRows('gemini', 2)], primaryGrades: [], sampleIds: [], graders: G, controlIds: CIDS(2) });
    assert.equal(ev.graderControls.gpt.ok, false, 'c1 never graded');
    assert.equal(ev.graderControls.gemini.ok, true, 'positive control: the complete set passes');
  });

  it('an empty expected control set never passes', () => {
    const ev = evaluateCrossGrade({ rows: [], primaryGrades: [], sampleIds: [], graders: G, controlIds: [] });
    assert.equal(ev.allControlsOk, false);
    assert.throws(() => evaluateCrossGrade({ rows: [], primaryGrades: [], sampleIds: [], graders: G }), /controlIds/);
  });
});

describe('controlPassesSingle', () => {
  it('gold needs correct and coverage ≥ 0.8; trap needs incorrect and trap1 fell', () => {
    assert.equal(controlPassesSingle('control-gold', { q: 0.9, correct: true, coverage: 0.8 }, null), true);
    assert.equal(controlPassesSingle('control-gold', { q: 0.9, correct: true, coverage: 0.79 }, null), false);
    assert.equal(controlPassesSingle('control-trap', { q: 0.1, correct: false }, { traps: [{ id: 'trap1', fell: true }] }), true);
    assert.equal(controlPassesSingle('control-trap', { q: 0.1, correct: false }, { traps: [{ id: 'trap1', fell: false }] }), false);
    assert.equal(controlPassesSingle('control-gold', { q: null, correct: true, coverage: 1 }, null), false, 'a quote-voided grade (q null) is unmeasured, never a pass');
    assert.equal(controlPassesSingle('control-gold', null, null), false, 'unmeasured never passes');
  });
});

// ── Gemini transport through the shared grading loop ────────────────────────
function fakeGenai(replies) {
  const calls = [];
  return { calls, models: { generateContent: async (req) => { calls.push(req); const r = replies.shift(); if (r instanceof Error) throw r; return r; } } };
}
const geminiReply = (obj, { finish = 'STOP', usage = { promptTokenCount: 4000, candidatesTokenCount: 900, thoughtsTokenCount: 600 } } = {}) => ({ text: typeof obj === 'string' ? obj : JSON.stringify(obj), candidates: [{ finishReason: finish }], usageMetadata: usage, modelVersion: 'gemini-pro-latest' });

describe('makeGeminiInvoker + gradeOnce', () => {
  const toGeminiSchema = () => ({ type: 'object' });

  it('scores a valid JSON reply and maps billed usage (candidates + thoughts)', async () => {
    const genai = fakeGenai([geminiReply(goodGrade)]);
    const settled = [];
    const r = await gradeOnce({ invoke: makeGeminiInvoker({ genai, toGeminiSchema }), model: 'gemini-pro-latest', c: CASE, outputText: GOOD_TEXT, maxOutputTokens: 14192, reasoningEffort: null, zodTextFormat: fakeZodTextFormat, assertEgressSafe: noEgress, hooks: { after: (a) => settled.push(a) } });
    assert.equal(r.status, 'scored');
    assert.equal(genai.calls[0].config.responseMimeType, 'application/json');
    assert.equal(genai.calls[0].config.systemInstruction.length > 50, true);
    assert.equal(genai.calls[0].config.maxOutputTokens, 14192);
    assert.deepEqual(settled[0].usageRaw, { input_tokens: 4000, output_tokens: 1500 });
  });

  it('reserves against the Gemini request ACTUALLY sent, not the OpenAI-shaped params (focused audit H8)', async () => {
    const genai = fakeGenai([geminiReply(goodGrade)]);
    const bigSchema = () => ({ type: 'object', description: 'x'.repeat(200_000) });
    const reserved = [];
    await gradeOnce({ invoke: makeGeminiInvoker({ genai, toGeminiSchema: bigSchema }), model: 'g', c: CASE, outputText: GOOD_TEXT, maxOutputTokens: 14192, reasoningEffort: null, zodTextFormat: fakeZodTextFormat, assertEgressSafe: noEgress, hooks: { before: (a) => reserved.push(a) } });
    const sentBytes = Buffer.byteLength(JSON.stringify(genai.calls[0]), 'utf8');
    assert.ok(reserved[0].inputTokensMax >= sentBytes, `bound ${reserved[0].inputTokensMax} must cover the ${sentBytes} bytes sent`);
    assert.equal(reserved[0].maxOutputTokens, genai.calls[0].config.maxOutputTokens, 'output cap reserved = output cap sent');
  });

  it('non-JSON twice → unmeasured judge-malformed, never a score', async () => {
    const genai = fakeGenai([geminiReply('not json'), geminiReply('still not')]);
    const r = await gradeOnce({ invoke: makeGeminiInvoker({ genai, toGeminiSchema }), model: 'g', c: CASE, outputText: GOOD_TEXT, zodTextFormat: fakeZodTextFormat, assertEgressSafe: noEgress });
    assert.equal(r.status, 'unmeasured');
    assert.equal(r.reason, 'judge-malformed');
  });

  it('a MAX_TOKENS finish is malformed, not a truncated score', async () => {
    const genai = fakeGenai([geminiReply(goodGrade, { finish: 'MAX_TOKENS' }), geminiReply(goodGrade, { finish: 'MAX_TOKENS' })]);
    const r = await gradeOnce({ invoke: makeGeminiInvoker({ genai, toGeminiSchema }), model: 'g', c: CASE, outputText: GOOD_TEXT, zodTextFormat: fakeZodTextFormat, assertEgressSafe: noEgress });
    assert.equal(r.status, 'unmeasured');
    assert.equal(r.reason, 'judge-malformed');
  });

  it('missing usage metadata reaches the meter as null (worst case), never zero', async () => {
    const genai = fakeGenai([geminiReply(goodGrade, { usage: null })]);
    const settled = [];
    await gradeOnce({ invoke: makeGeminiInvoker({ genai, toGeminiSchema }), model: 'g', c: CASE, outputText: GOOD_TEXT, zodTextFormat: fakeZodTextFormat, assertEgressSafe: noEgress, hooks: { after: (a) => settled.push(a) } });
    assert.equal(settled[0].usageRaw, null);
  });
});

// ── runCrossGrade orchestration ─────────────────────────────────────────────
describe('runCrossGrade', () => {
  const trapGrade = { ...goodGrade, keyPoints: goodGrade.keyPoints.map((k) => ({ ...k, hit: false, quote: '' })), traps: [{ id: 'trap1', fell: true, quote: 'a real race between exit' }], decisionCorrect: { value: false, quote: '' } };
  const mkInvoke = (sequence) => async () => { const g = sequence.shift(); return { output_parsed: g, output_text: JSON.stringify(g), usage: { input_tokens: 1000, output_tokens: 500 }, model: 'm' }; };
  const meterRows = [];
  const mkMeter = () => createMeter({ capUsd: 5, contractEpoch: 2, append: (r) => meterRows.push(r), priceFor: () => ({ input: 1, output: 1 }), costFromUsage: () => ({ priced: true, totalUsd: 0.001 }) });
  const controls = [{ gradeId: 'xc-fx-gold', kind: 'control-gold', caseId: 'fx', text: GOOD_TEXT }, { gradeId: 'xc-fx-trap', kind: 'control-trap', caseId: 'fx', text: GOOD_TEXT }];
  const sample = [{ gradeId: 'g1', kind: 'arm', caseId: 'fx', text: GOOD_TEXT }];

  it('grades controls then the sample, for each grader, metered', async () => {
    const out = [];
    const { rows, stop } = await runCrossGrade({
      graders: [{ name: 'gpt', model: 'm', invoke: mkInvoke([goodGrade, trapGrade, goodGrade]), maxOutputTokens: 100 }, { name: 'gemini', model: 'm2', invoke: mkInvoke([goodGrade, trapGrade, goodGrade]), maxOutputTokens: 100 }],
      controls, sample, caseById: { fx: CASE }, meter: mkMeter(), sink: (r) => out.push(r), zodTextFormat: fakeZodTextFormat, assertEgressSafe: noEgress, epoch: 2, runId: 'main-xgrade',
    });
    assert.equal(stop, null);
    assert.deepEqual(rows.map((r) => `${r.grader}:${r.role}`), ['gpt:control', 'gpt:control', 'gpt:sample', 'gemini:control', 'gemini:control', 'gemini:sample']);
    assert.equal(rows.filter((r) => r.role === 'control').every((r) => r.controlPassed), true);
    assert.equal(out.length, 6);
    assert.equal(meterRows.filter((r) => r.kind === 'settle').length, 6);
  });

  it('a grader that fails a control grades no sample (pre-registered), the other still runs', async () => {
    const { rows } = await runCrossGrade({
      graders: [{ name: 'gpt', model: 'm', invoke: mkInvoke([trapGrade, trapGrade]), maxOutputTokens: 100 }, { name: 'gemini', model: 'm2', invoke: mkInvoke([goodGrade, trapGrade, goodGrade]), maxOutputTokens: 100 }],
      controls, sample, caseById: { fx: CASE }, meter: mkMeter(), sink: () => {}, zodTextFormat: fakeZodTextFormat, assertEgressSafe: noEgress, epoch: 2, runId: 'x',
    });
    assert.equal(rows.filter((r) => r.grader === 'gpt' && r.role === 'sample').length, 0);
    assert.equal(rows.filter((r) => r.grader === 'gemini' && r.role === 'sample').length, 1);
  });

  it('a budget stop returns a stop, keeping the rows graded so far', async () => {
    const meter = createMeter({ capUsd: 0.0001, contractEpoch: 2, priceFor: () => ({ input: 1000, output: 1000 }) });
    const { rows, stop } = await runCrossGrade({
      graders: [{ name: 'gpt', model: 'm', invoke: mkInvoke([goodGrade]), maxOutputTokens: 100 }],
      controls, sample, caseById: { fx: CASE }, meter, sink: () => {}, zodTextFormat: fakeZodTextFormat, assertEgressSafe: noEgress, epoch: 2, runId: 'x',
    });
    assert.equal(stop.kind, 'BudgetStop');
    assert.equal(rows.length, 0);
  });
});
