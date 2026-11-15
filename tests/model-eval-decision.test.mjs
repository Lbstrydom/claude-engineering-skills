/**
 * Tier-1/Tier-2 tests for the Fable-vs-Opus decision-eval harness
 * (docs/plans/fable-vs-opus-decision-eval.md). Every client is INJECTED —
 * nothing reaches a provider, nothing is spent.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { CaseSchema, leakScan, freezeManifest, loadCorpus, CorpusIntegrityError, DECISION_EVAL_CONTRACT_EPOCH } from '../scripts/lib/model-eval/decision/corpus.mjs';
import { createMeter, worstCaseCostUsd, toPricingUsage, sumScopeSpend, inputTokenUpperBound, BudgetStop, UnpricedModelError } from '../scripts/lib/model-eval/decision/meter.mjs';
import { buildArmRequest, runArmCall, extractUsage, servedModelMatches, ARM_SYSTEM_PROMPT } from '../scripts/lib/model-eval/decision/arm.mjs';
import { scrubModelNames, quoteIsVerbatim, verifyQuotes, gradeOnce, coverageError, buildJudgeInput } from '../scripts/lib/model-eval/decision/judge.mjs';
import { scoreGrade, combinePasses, withinCaseSpread, proposeReps, pairedBootstrap, decide, credibilityGates, costSummary, costRatioOf, sampleCompleteness } from '../scripts/lib/model-eval/decision/analysis.mjs';
import { runDecisionEval, projectMainCost } from '../scripts/lib/model-eval/decision/runner.mjs';
import { renderSpotSample, parseSpotAgreement, drawSpotSample } from '../scripts/lib/model-eval/decision/spot-sample.mjs';
import { main as decisionCli } from '../scripts/model-eval-decision.mjs';

// ── fixtures ────────────────────────────────────────────────────────────────
const CASE = Object.freeze({
  id: 'fixture-case',
  role: 'review',
  title: 'Fixture decision',
  decisionDate: '2026-11-14',
  context: 'A CI-only failure: the test expects one cause string and the runner printed another. '.repeat(4),
  question: 'Diagnose the failure and decide what to change.',
  rubric: {
    decision: 'It is a real race; fix the cause reporting in code, keep the test.',
    keyPoints: [
      { id: 'kp1', text: 'Identifies the race between exit and the stdin write', weight: 2 },
      { id: 'kp2', text: 'Says the cause string ordering in code is the defect', weight: 1 },
      { id: 'kp3', text: 'Keeps the test unchanged', weight: 1 },
    ],
    traps: [{ id: 'trap1', text: 'Calls it a flake and re-runs CI' }, { id: 'trap2', text: 'Loosens the assertion regex' }],
    leakTerms: ['describeCheckIgnoreFailure'],
  },
  controls: {
    gold: 'GOLDANSWER: this is a real race between the child exiting and the stdin write; the code orders the cause wrong. Keep the test. ## Decision fix the code.',
    trap: 'TRAPANSWER: this is a flake on a loaded runner, nothing in the code is wrong; re-run CI and move on. ## Decision re-run and mark flaky.',
  },
  sources: ['PR #359 (fixture)'],
});
const freshCase = (over = {}) => ({ ...structuredClone(CASE), ...over });

function tmpCorpus(cases = [freshCase()]) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dec-eval-'));
  for (const c of cases) fs.writeFileSync(path.join(dir, `${c.id}.json`), JSON.stringify(c, null, 2) + '\n');
  return dir;
}
const PH = { arm: 'a'.repeat(64), judge: 'b'.repeat(64) };

const fakeZodTextFormat = (schema, name) => ({ type: 'json_schema', name, schema });
const noEgress = () => {};

function fakeAnthropic({ text = 'ARMTEXT a real race between the child exiting and the stdin write. Keep the test. ## Decision fix the code.', model = null, usage = { input_tokens: 3000, output_tokens: 800, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 }, stop_reason = 'end_turn', fail = false } = {}) {
  const calls = [];
  return {
    calls,
    messages: {
      async create(req) {
        calls.push(req);
        if (fail) throw Object.assign(new Error('socket hang up'), { status: 503 });
        return { model: model ?? req.model, stop_reason, usage, content: [{ type: 'thinking', thinking: '' }, { type: 'text', text }] };
      },
    },
  };
}

/** A judge that grades by content: gold/arm text → correct; trap text → wrong + trap1. */
function fakeOpenAI({ fail = false, malformed = false } = {}) {
  const calls = [];
  return {
    calls,
    responses: {
      async parse(params) {
        calls.push(params);
        if (fail === 'auth') throw Object.assign(new Error('invalid api key'), { status: 401 });
        if (fail) throw Object.assign(new Error('ECONNRESET upstream'), { status: 503 });
        const usage = { input_tokens: 1200, output_tokens: 300, input_tokens_details: { cached_tokens: 0 } };
        if (malformed) return { usage, output_parsed: null, output_text: 'not json' };
        const resp = /<<<RESPONSE\n([\s\S]*)\nRESPONSE>>>/.exec(params.input)[1];
        const trap = resp.includes('TRAPANSWER');
        const q = resp.slice(0, 40);
        return {
          usage, model: params.model, output_text: '{}',
          output_parsed: {
            keyPoints: ['kp1', 'kp2', 'kp3'].map((id) => ({ id, hit: !trap, quote: trap ? '' : q })),
            traps: [{ id: 'trap1', fell: trap, quote: trap ? q : '' }, { id: 'trap2', fell: false, quote: '' }],
            decisionCorrect: { value: !trap, quote: trap ? '' : q },
            rationale: 'fixture',
          },
        };
      },
    },
  };
}

// ── corpus ──────────────────────────────────────────────────────────────────
describe('decision-eval corpus — frozen, hashed, leak-scanned', () => {
  it('CaseSchema accepts the fixture and rejects an unknown field (strict)', () => {
    assert.equal(CaseSchema.safeParse(freshCase()).success, true);
    assert.equal(CaseSchema.safeParse({ ...freshCase(), extra: 1 }).success, false);
  });
  it('CaseSchema requires trap1, the main trap both control checks key on (audit H6)', () => {
    const c = freshCase();
    c.rubric.traps = c.rubric.traps.map((t) => ({ ...t, id: t.id === 'trap1' ? 'trap9' : t.id }));
    const v = CaseSchema.safeParse(c);
    assert.equal(v.success, false);
    assert.match(v.error.issues.map((i) => i.message).join(' '), /trap1/);
  });
  it('leakScan finds a leak term in arm-visible text (case-insensitive)', () => {
    assert.deepEqual(leakScan(freshCase()), []);
    assert.deepEqual(leakScan(freshCase({ question: 'Does DESCRIBECHECKIGNOREFAILURE help?' })), ['describeCheckIgnoreFailure']);
  });
  it('freeze → load round-trips; manifest has no clock and is byte-stable', () => {
    const dir = tmpCorpus();
    const m1 = freezeManifest(dir, { promptHashes: PH });
    const b1 = fs.readFileSync(path.join(dir, 'manifest.json'));
    freezeManifest(dir, { promptHashes: PH });
    assert.ok(b1.equals(fs.readFileSync(path.join(dir, 'manifest.json'))), 'two freezes are byte-identical');
    assert.equal(m1.contractEpoch, DECISION_EVAL_CONTRACT_EPOCH);
    const { cases } = loadCorpus(dir, { promptHashes: PH });
    assert.equal(cases.length, 1);
  });
  it('CRLF checkout of the same bytes hashes the same (git owns line endings)', () => {
    const dir = tmpCorpus();
    freezeManifest(dir, { promptHashes: PH });
    const f = path.join(dir, 'fixture-case.json');
    fs.writeFileSync(f, fs.readFileSync(f, 'utf8').replace(/\n/g, '\r\n'));
    assert.doesNotThrow(() => loadCorpus(dir, { promptHashes: PH }));
  });
  it('REFUSES when a case changed after freeze', () => {
    const dir = tmpCorpus();
    freezeManifest(dir, { promptHashes: PH });
    fs.writeFileSync(path.join(dir, 'fixture-case.json'), JSON.stringify(freshCase({ question: 'A different question entirely, same length or not.' }), null, 2) + '\n');
    assert.throws(() => loadCorpus(dir, { promptHashes: PH }), (e) => e instanceof CorpusIntegrityError && e.reason === 'hash-mismatch');
  });
  it('REFUSES a tampered manifest role / file entry even when content hashes match (audit R1 M2)', () => {
    const dir = tmpCorpus();
    freezeManifest(dir, { promptHashes: PH });
    const mp = path.join(dir, 'manifest.json');
    const m = JSON.parse(fs.readFileSync(mp, 'utf8'));
    const id = Object.keys(m.cases)[0];
    const other = m.cases[id].role === 'review' ? 'cross-repo' : 'review';
    fs.writeFileSync(mp, JSON.stringify({ ...m, cases: { ...m.cases, [id]: { ...m.cases[id], role: other } } }));
    assert.throws(() => loadCorpus(dir, { promptHashes: PH }), (e) => e instanceof CorpusIntegrityError && /metadata/.test(e.message));
  });
  it('REFUSES when the arm/judge prompt template changed after freeze', () => {
    const dir = tmpCorpus();
    freezeManifest(dir, { promptHashes: PH });
    assert.throws(() => loadCorpus(dir, { promptHashes: { ...PH, arm: 'c'.repeat(64) } }), (e) => e.reason === 'prompt-drift');
  });
  it('REFUSES a case whose context leaks the answer, at freeze time', () => {
    const dir = tmpCorpus([freshCase({ context: `${CASE.context} see describeCheckIgnoreFailure` })]);
    assert.throws(() => freezeManifest(dir, { promptHashes: PH }), (e) => e.reason === 'leak');
  });
});

// ── meter ───────────────────────────────────────────────────────────────────
describe('decision-eval meter — reservation-based hard cap', () => {
  it('worst case = input token upper bound in + full max_tokens out', () => {
    // opus 5.5: $4 in, $20 out. 1000 tokens at the 2x write margin → $0.008; 1000 out → $0.02.
    assert.ok(Math.abs(worstCaseCostUsd({ model: 'claude-opus-5-5', inputTokensMax: 1000, maxOutputTokens: 1000 }) - 0.028) < 1e-12);
  });
  it('a request big enough to reach a long-prompt tier is reserved wholly at the tier multiplier (audit R1 H5/H16)', () => {
    // haiku 5.5: $0.10 in, $0.50 out in the table (short-prompt row only).
    const short = worstCaseCostUsd({ model: 'claude-haiku-5-5', inputTokensMax: 100000, maxOutputTokens: 1000 });
    const long = worstCaseCostUsd({ model: 'claude-haiku-5-5', inputTokensMax: 100001, maxOutputTokens: 1000 });
    assert.ok(long > 4.9 * short, 'one token past the bound ⇒ ~5x reservation');
  });
  it('refuses the call that COULD breach the cap, before it is made', () => {
    const m = createMeter({ capUsd: 0.03, contractEpoch: 1 });
    m.reserve({ label: 'a', model: 'claude-opus-5-5', inputTokensMax: 1000, maxOutputTokens: 1000 });
    m.settle({ usage: { input_tokens: 1000, output_tokens: 300 }, provider: 'anthropic', responseModel: 'claude-opus-5-5' });
    // spent = 0.004 + 0.006 = 0.010; next worst 0.024 → 0.034 > 0.03 → stop.
    assert.throws(() => m.reserve({ label: 'b', model: 'claude-opus-5-5', inputTokensMax: 1000, maxOutputTokens: 1000 }), BudgetStop);
  });
  it('a scripted sequence never settles past the cap (worst case bounds every call)', () => {
    const m = createMeter({ capUsd: 0.5, contractEpoch: 1 });
    let calls = 0;
    for (;;) {
      try { m.reserve({ label: `c${calls}`, model: 'claude-fable-5-2', inputTokensMax: 8000, maxOutputTokens: 2000 }); } catch (e) { assert.ok(e instanceof BudgetStop); break; }
      m.settle({ usage: { input_tokens: 4000, output_tokens: 2000 }, provider: 'anthropic', responseModel: 'claude-fable-5-2' }); // worst realistic
      calls++;
    }
    assert.ok(calls > 0);
    assert.ok(m.spentUsd <= 0.5, `spent ${m.spentUsd} must stay ≤ cap`);
  });
  it('missing usage stops the run and charges the worst case (never $0)', () => {
    const rows = [];
    const m = createMeter({ capUsd: 1, contractEpoch: 1, append: (r) => rows.push(r) });
    const worst = m.reserve({ label: 'x', model: 'claude-opus-5-5', inputTokensMax: 100, maxOutputTokens: 100 });
    assert.throws(() => m.settle({ usage: null, provider: 'anthropic', responseModel: 'claude-opus-5-5' }), BudgetStop);
    assert.equal(m.spentUsd, worst);
    assert.match(rows.find((r) => r.kind === 'settle').usdBasis, /worst-case/);
  });
  it('input bound is UTF-8 bytes (≥ tokens for byte-level BPE), so multibyte text cannot under-reserve', () => {
    assert.equal(inputTokenUpperBound('abc'), 3);
    assert.equal(inputTokenUpperBound('€'), 3);
  });
  it('a reservation left open by a crash stays charged at worst case in the scope sum', () => {
    const rows = [];
    const m = createMeter({ capUsd: 1, contractEpoch: 1, append: (r) => rows.push({ runId: 'r1', budgetScope: 's', ...r }) });
    m.reserve({ label: 'a', model: 'claude-opus-5-5', inputTokensMax: 1000, maxOutputTokens: 1000 });
    m.settle({ usage: { input_tokens: 500, output_tokens: 100 }, provider: 'anthropic', responseModel: 'claude-opus-5-5' });
    const worst = m.reserve({ label: 'b', model: 'claude-opus-5-5', inputTokensMax: 1000, maxOutputTokens: 1000 });
    // ...process dies here: no settle row for b.
    assert.equal(rows[0].kind, 'reserve', 'the reservation row is written BEFORE the call');
    const settledA = rows.find((r) => r.kind === 'settle').usd;
    assert.ok(Math.abs(sumScopeSpend(rows, 's') - (settledA + worst)) < 1e-12);
  });
  it('an unpriced model is refused at reservation', () => {
    const m = createMeter({ capUsd: 1, contractEpoch: 1 });
    assert.throws(() => m.reserve({ label: 'x', model: 'not-a-real-model-xyz', inputTokensMax: 10, maxOutputTokens: 10 }), UnpricedModelError);
  });
  it('a missing or NaN input bound is refused, never a NaN reservation that bypasses the cap (audit R1 H6/H15)', () => {
    const m = createMeter({ capUsd: 0.000001, contractEpoch: 1 });
    for (const bad of [undefined, NaN, -1, '12']) {
      assert.throws(() => m.reserve({ label: 'x', model: 'claude-opus-5-5', inputTokensMax: bad, maxOutputTokens: 100 }), /input-size bound/);
    }
    assert.throws(() => m.reserve({ label: 'x', model: 'claude-opus-5-5', inputTokensMax: 10, maxOutputTokens: 100 }), BudgetStop, 'control: a valid bound over the cap still stops');
  });
  it('OpenAI usage with a missing billable count is unmeterable, charged at worst case and stopped (audit R1 H4/H18/H21)', () => {
    assert.equal(toPricingUsage({ input_tokens: 1000 }, 'openai'), null);
    assert.equal(toPricingUsage({ output_tokens: 50 }, 'openai'), null);
    assert.equal(toPricingUsage({ input_tokens: '1000', output_tokens: 50 }, 'openai'), null);
    assert.deepEqual(toPricingUsage({ input_tokens: 1000, output_tokens: 50 }, 'openai'), { input_tokens: 1000, cache_read_input_tokens: 0, output_tokens: 50 }, 'control: a complete usage still prices');
    const rows = [];
    const m = createMeter({ capUsd: 1, contractEpoch: 1, append: (r) => rows.push(r) });
    const worst = m.reserve({ label: 'g', model: 'gpt-6.1-terra', inputTokensMax: 1000, maxOutputTokens: 1000 });
    assert.throws(() => m.settle({ usage: { input_tokens: 1000 }, provider: 'openai', responseModel: 'gpt-6.1-terra' }), BudgetStop);
    assert.equal(m.spentUsd, worst, 'partial usage charged at the reservation, not as a cheaper measured call');
  });
  it('OpenAI usage: cached tokens are split out of input_tokens for pricing', () => {
    assert.deepEqual(toPricingUsage({ input_tokens: 1000, output_tokens: 50, input_tokens_details: { cached_tokens: 400 } }, 'openai'), { input_tokens: 600, cache_read_input_tokens: 400, output_tokens: 50 });
  });
});

// ── arm ─────────────────────────────────────────────────────────────────────
describe('decision-eval arm — held-equal request, typed outcome', () => {
  it('request carries effort, and NO thinking/temperature/fallbacks/cache_control', () => {
    const r = buildArmRequest({ model: 'claude-fable-5-2', c: CASE });
    assert.deepEqual(r.output_config, { effort: 'high' });
    for (const k of ['thinking', 'temperature', 'fallbacks', 'cache_control', 'top_p']) assert.ok(!(k in r), `${k} must be absent`);
    assert.equal(r.system, ARM_SYSTEM_PROMPT);
    assert.ok(r.messages[0].content.includes(CASE.question));
    assert.ok(!JSON.stringify(r).includes(CASE.rubric.decision), 'the rubric never reaches an arm');
    assert.deepEqual(buildArmRequest({ model: 'claude-opus-5-5', c: CASE }).messages, r.messages, 'both arms get byte-identical input');
  });
  it('a served model other than the requested one is an instrument failure', async () => {
    const r = await runArmCall({ client: fakeAnthropic({ model: 'claude-opus-4-8' }), model: 'claude-opus-5-5', c: CASE });
    assert.equal(r.status, 'model-mismatch');
    assert.equal(servedModelMatches('claude-opus-5-5', 'claude-opus-5-5-20261101'), true);
  });
  it('a served id that merely extends the requested one is not a snapshot of it (audit R1 M6)', () => {
    assert.equal(servedModelMatches('claude-opus-5', 'claude-opus-5-5'), false);
    assert.equal(servedModelMatches('claude-opus-5-5', 'claude-opus-5-5'), true);
    assert.equal(servedModelMatches('claude-opus-5-5', 'claude-opus-5-5-20261101'), true);
  });
  it('a stop other than end_turn / refusal / max_tokens is not "ok" (audit R1 H8)', async () => {
    for (const stop_reason of ['model_context_window_exceeded', 'pause_turn', null]) {
      const r = await runArmCall({ client: fakeAnthropic({ stop_reason }), model: 'claude-opus-5-5', c: CASE });
      assert.equal(r.status, 'incomplete', `stop_reason ${stop_reason}`);
    }
    assert.equal((await runArmCall({ client: fakeAnthropic({ stop_reason: 'end_turn' }), model: 'claude-opus-5-5', c: CASE })).status, 'ok', 'control: a normal end of turn is ok');
  });
  it('transport failure → arm-error with the HTTP status, never a throw', async () => {
    const r = await runArmCall({ client: fakeAnthropic({ fail: true }), model: 'claude-opus-5-5', c: CASE });
    assert.equal(r.status, 'arm-error');
    assert.match(r.error, /HTTP 503/);
  });
  it('max_tokens with NO text block is a truncation defect, not an empty answer', async () => {
    const client = { messages: { async create(req) { return { model: req.model, stop_reason: 'max_tokens', usage: { input_tokens: 10, output_tokens: 16000 }, content: [{ type: 'thinking', thinking: '' }] }; } } };
    const r = await runArmCall({ client, model: 'claude-opus-5-5', c: CASE });
    assert.equal(r.status, 'truncated-no-text');
    const { sink } = { sink: { call: () => {}, grade: () => {}, ledger: () => {} } };
    const sum = await runDecisionEval({ phase: 'rehearsal', runId: 'tt', cases: [freshCase()], manifest: {}, capUsd: 2, anthropic: client, openai: fakeOpenAI(), judgeModel: 'gpt-6.1-terra', zodTextFormat: fakeZodTextFormat, assertEgressSafe: noEgress, sink });
    assert.equal(sum.perArm['claude-haiku-5-5'].outputs, 0, 'never graded');
    assert.equal(sum.perArm['claude-haiku-5-5'].statuses['truncated-no-text'], 1, 'counted under its own status');
  });
  it('thinking blocks are counted but their text is never graded', async () => {
    const r = await runArmCall({ client: fakeAnthropic(), model: 'claude-opus-5-5', c: CASE });
    assert.equal(r.status, 'ok');
    assert.equal(r.thinkingBlocks, 1);
    assert.ok(r.text.startsWith('ARMTEXT'));
  });
  it('thinking tokens: null + not-reported when absent (never 0), captured when present', () => {
    const a = extractUsage({ input_tokens: 1, output_tokens: 2, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 });
    assert.equal(a.thinkingTokens, null);
    assert.equal(a.thinkingReported, false);
    const b = extractUsage({ input_tokens: 1, output_tokens: 2, output_tokens_details: { thinking_tokens: 7 } });
    assert.equal(b.thinkingTokens, 7);
    assert.equal(b.thinkingField, 'output_tokens_details.thinking_tokens');
  });
});

// ── judge ───────────────────────────────────────────────────────────────────
describe('decision-eval judge — blinded, quote-checked, failure taxonomy', () => {
  it('scrubs model self-names so the judge cannot unblind an arm', () => {
    assert.equal(scrubModelNames('As Claude Opus (Anthropic) I think'), 'As [model] [model] ([model]) I think');
    assert.ok(!buildJudgeInput({ c: CASE, outputText: 'Fable says hi' }).includes('Fable'));
  });
  it('quote check: normalised substring passes, a fabricated quote fails', () => {
    const out = 'The **real** race is between the child exiting and the  stdin write.';
    assert.equal(quoteIsVerbatim('real race is between the child exiting', out), true);
    assert.equal(quoteIsVerbatim('the child never exits at all', out), false);
    assert.equal(quoteIsVerbatim('race', out), false, 'too short to be evidence');
  });
  it('an unverifiable positive claim is marked unverified, not flipped', () => {
    const g = verifyQuotes({ keyPoints: [{ id: 'kp1', hit: true, quote: 'not in the text at all' }, { id: 'kp2', hit: false, quote: '' }], traps: [], decisionCorrect: { value: false, quote: '' }, rationale: '' }, 'some output text');
    assert.equal(g.keyPoints[0].verified, false);
    assert.equal(g.keyPoints[0].hit, true, 'the judge claim is preserved for audit');
    assert.equal(g.keyPoints[1].verified, true, 'a negative needs no quote');
  });
  it('coverage: each rubric id exactly once', () => {
    assert.equal(coverageError(CASE, { keyPoints: [{ id: 'kp1' }, { id: 'kp2' }, { id: 'kp3' }], traps: [{ id: 'trap1' }, { id: 'trap2' }] }), null);
    assert.match(coverageError(CASE, { keyPoints: [{ id: 'kp1' }, { id: 'kp1' }, { id: 'kp3' }], traps: [{ id: 'trap1' }, { id: 'trap2' }] }), /exactly once/);
  });
  it('transport failure → unmeasured:judge-transport after ONE plain retry; error never in the prompt', async () => {
    const oai = fakeOpenAI({ fail: true });
    const r = await gradeOnce({ client: oai, model: 'gpt-6.1-terra', c: CASE, outputText: 'x'.repeat(50), zodTextFormat: fakeZodTextFormat, assertEgressSafe: noEgress });
    assert.equal(r.status, 'unmeasured');
    assert.equal(r.reason, 'judge-transport');
    assert.equal(oai.calls.length, 2);
    assert.equal(oai.calls[0].input, oai.calls[1].input, 'retry is the same prompt');
    assert.ok(!oai.calls[1].input.includes('ECONNRESET'));
  });
  it('a non-429 4xx (auth) is unmeasured and NOT retried', async () => {
    const oai = fakeOpenAI({ fail: 'auth' });
    const r = await gradeOnce({ client: oai, model: 'gpt-6.1-terra', c: CASE, outputText: 'x'.repeat(50), zodTextFormat: fakeZodTextFormat, assertEgressSafe: noEgress });
    assert.equal(r.status, 'unmeasured');
    assert.equal(r.reason, 'judge-transport');
    assert.equal(oai.calls.length, 1);
  });
  it('malformed output → unmeasured:judge-malformed, never a score', async () => {
    const r = await gradeOnce({ client: fakeOpenAI({ malformed: true }), model: 'gpt-6.1-terra', c: CASE, outputText: 'x'.repeat(50), zodTextFormat: fakeZodTextFormat, assertEgressSafe: noEgress });
    assert.equal(r.status, 'unmeasured');
    assert.equal(r.reason, 'judge-malformed');
    assert.equal(r.grade, null);
  });
  it('the egress gate runs before the wire and its refusal propagates', async () => {
    const oai = fakeOpenAI();
    await assert.rejects(gradeOnce({ client: oai, model: 'm', c: CASE, outputText: 'x', zodTextFormat: fakeZodTextFormat, assertEgressSafe: () => { throw new Error('[egress-gate] secret'); } }), /egress-gate/);
    assert.equal(oai.calls.length, 0);
  });
});

// ── analysis ────────────────────────────────────────────────────────────────
describe('decision-eval analysis — score, spread, n, rule', () => {
  const g = (hits, fell, correct, verified = true) => ({
    keyPoints: [{ id: 'kp1', hit: hits[0], verified }, { id: 'kp2', hit: hits[1], verified: true }, { id: 'kp3', hit: hits[2], verified: true }],
    traps: [{ id: 'trap1', fell: fell[0], verified: true }, { id: 'trap2', fell: fell[1], verified: true }],
    decisionCorrect: { value: correct, verified: true },
  });
  it('q = 0.6·correct + 0.4·weighted coverage − 0.2·trap rate', () => {
    assert.equal(scoreGrade(CASE, g([true, true, true], [false, false], true)).q, 1);
    // coverage: kp1 weight 2 of 4 → 0.5; correct false; trapRate 0.5 → 0.2 − 0.1 = 0.1
    assert.ok(Math.abs(scoreGrade(CASE, g([true, false, false], [true, false], false)).q - 0.1) < 1e-12);
  });
  it('ANY unverified positive claim makes the pass unmeasured (cannot reward a fabricated quote)', () => {
    const s = scoreGrade(CASE, g([true, true, false], [false, false], true, false));
    assert.equal(s.unverified, 1);
    assert.equal(s.q, null);
  });
  it('epoch 2: an unmeasured output never counts as correct, even when both passes said correct', () => {
    const c = combinePasses([{ q: 0.95, correct: true }, { q: null, correct: true }]);
    assert.equal(c.q, null);
    assert.equal(c.correct, false);
  });
  it('an output with only one scored pass is unmeasured (q null), not a one-pass score', () => {
    assert.equal(combinePasses([{ q: 0.9, correct: true }]).q, null);
    assert.equal(combinePasses([{ q: 0.9, correct: true }, { q: null, correct: null }]).q, null);
  });
  it('cost ratio: zero-correct cases are pre-registered', () => {
    assert.equal(costRatioOf(0.4, 0.2), 2);
    assert.equal(costRatioOf(0.4, null), 0, 'Opus never correct');
    assert.equal(costRatioOf(null, 0.2), Infinity, 'Fable never correct');
    assert.equal(costRatioOf(null, null), null);
  });
  it('correct (for cost per correct) needs BOTH passes; disagreement is counted', () => {
    const c = combinePasses([{ q: 1, correct: true }, { q: 0.3, correct: false }]);
    assert.equal(c.correct, false);
    assert.equal(c.correctDisagree, true);
    assert.ok(Math.abs(c.judgeDelta - 0.7) < 1e-12);
  });
  it('pooled within-case SD ignores between-case differences', () => {
    const rows = [{ caseId: 'a', q: 0.2 }, { caseId: 'a', q: 0.4 }, { caseId: 'b', q: 0.9 }, { caseId: 'b', q: 0.7 }];
    // each case: SS = 0.02 over 1 dof → pooled var = 0.04 / 2 = 0.02
    assert.ok(Math.abs(withinCaseSpread(rows) - Math.sqrt(0.02)) < 1e-12);
    assert.equal(withinCaseSpread([{ caseId: 'a', q: 1 }]), null);
  });
  it('proposeReps: r = ceil(2·2.8²·s²/(k·Δ²)), Δ = max(s, 0.10), clamped [3,10]', () => {
    assert.equal(proposeReps({ sw: 0.1, k: 5 }).reps, 4);
    assert.equal(proposeReps({ sw: 0.02, k: 5 }).reps, 3, 'tiny spread → floor');
    assert.equal(proposeReps({ sw: 0.3, k: 1 }).infeasible, true);
    assert.equal(proposeReps({ sw: null, k: 5 }).reps, null);
  });
  it('paired bootstrap is deterministic under a seed', () => {
    const rows = [];
    for (const c of ['a', 'b', 'c']) for (let i = 0; i < 3; i++) { rows.push({ caseId: c, arm: 'F', q: 0.8 + i * 0.01 }); rows.push({ caseId: c, arm: 'O', q: 0.5 + i * 0.01 }); }
    const a = pairedBootstrap({ rows, armA: 'F', armB: 'O', seed: 7, B: 500 });
    assert.deepEqual(a, pairedBootstrap({ rows, armA: 'F', armB: 'O', seed: 7, B: 500 }));
    assert.ok(Math.abs(a.delta - 0.3) < 1e-9);
  });
  it('decide: every pre-registered branch', () => {
    const big = { delta: 0.3, lo: 0.2, hi: 0.4 };
    assert.equal(decide({ boot: big, sw: 0.05, meanOpus: 0.5, costRatio: 2, credible: true }).verdict, 'fable-preferred');
    assert.equal(decide({ boot: big, sw: 0.05, meanOpus: 0.5, costRatio: 4, credible: true }).verdict, 'opus:fable-better-but-not-at-that-price');
    assert.equal(decide({ boot: { delta: 0.01, lo: -0.03, hi: 0.05 }, sw: 0.05, meanOpus: 0.5, costRatio: 2, credible: true }).verdict, 'opus:material-gain-ruled-out');
    assert.equal(decide({ boot: { delta: 0.08, lo: -0.05, hi: 0.2 }, sw: 0.05, meanOpus: 0.5, costRatio: 2, credible: true }).verdict, 'inconclusive');
    assert.equal(decide({ boot: big, sw: 0.05, meanOpus: 0.95, costRatio: 2, credible: true }).verdict, 'inconclusive:ceiling');
    assert.equal(decide({ boot: big, sw: 0.05, meanOpus: 0.5, costRatio: 2, credible: false }).verdict, 'not-credible');
    assert.equal(decide({ boot: { delta: 0.12, lo: 0.01, hi: 0.3 }, sw: 0.2, meanOpus: 0.5, costRatio: 2, credible: true }).verdict, 'inconclusive', 'a gain smaller than the spread is not a result');
  });
  it('sample completeness: thin cases, a hollowed-out sample and arm errors each fail', () => {
    const units = [{ caseId: 'a' }, { caseId: 'a' }, { caseId: 'b' }];
    const f = sampleCompleteness({ unitsByScope: { pairs: units }, plannedPerCase: 4, cases: ['a', 'b'], armErrors: { X: 1 }, plannedCallsPerArm: 8 });
    assert.equal(f.length, 3, f.join(' | '));
    assert.deepEqual(sampleCompleteness({ unitsByScope: { pairs: [{ caseId: 'a' }, { caseId: 'a' }, { caseId: 'b' }, { caseId: 'b' }] }, plannedPerCase: 2, cases: ['a', 'b'], armErrors: { X: 0 }, plannedCallsPerArm: 4 }), []);
  });
  it('credibility gates name each failure', () => {
    const r = credibilityGates({ controlsPassed: 9, controlsTotal: 10, sj: 0.3, sw: 0.1, unmeasuredRate: 0.2, modelMismatches: 1 });
    assert.equal(r.credible, false);
    assert.equal(r.failures.length, 4);
    assert.equal(credibilityGates({ controlsPassed: 10, controlsTotal: 10, sj: 0.05, sw: 0.1, unmeasuredRate: 0, modelMismatches: 0 }).credible, true);
    assert.equal(credibilityGates({ controlsPassed: 0, controlsTotal: 0, sj: 0.05, sw: 0.1, unmeasuredRate: 0, modelMismatches: 0 }).credible, false, 'zero controls is not a pass');
  });
  it('cost per correct decision = arm USD ÷ correct outputs', () => {
    const s = costSummary([{ arm: 'X', usd: 0.2, correct: true, usage: {} }, { arm: 'X', usd: 0.2, correct: false, usage: {} }]);
    assert.equal(s.X.usdPerCall, 0.2);
    assert.equal(s.X.usdPerCorrect, 0.4);
  });
});

// ── runner (end to end, offline) ────────────────────────────────────────────
describe('decision-eval runner — end to end with injected clients', () => {
  const sinks = () => { const s = { calls: [], grades: [], ledger: [] }; return { s, sink: { call: (r) => s.calls.push(r), grade: (r) => s.grades.push(r), ledger: (r) => s.ledger.push(r) } }; };
  it('rehearsal: arm → grades (2 passes) → controls pass → spend metered', async () => {
    const { s, sink } = sinks();
    const anthropic = fakeAnthropic();
    const sum = await runDecisionEval({ phase: 'rehearsal', runId: 't1', cases: [freshCase()], manifest: { corpusSha256: 'x' }, capUsd: 1, anthropic, openai: fakeOpenAI(), judgeModel: 'gpt-6.1-terra', zodTextFormat: fakeZodTextFormat, assertEgressSafe: noEgress, sink, now: (() => { let t = 0; return () => (t += 100); })() });
    assert.equal(s.calls.length, 1);
    assert.equal(anthropic.calls[0].model, 'claude-haiku-5-5');
    assert.equal(s.grades.length, 10, '(2 preflight controls + 1 arm + 2 in-run controls) × 2 passes');
    assert.equal(sum.instrument.controls.passed, 4);
    assert.equal(sum.instrument.controls.total, 4);
    assert.equal(sum.status, 'completed');
    assert.equal(sum.perArm['claude-haiku-5-5'].meanQ, 1);
    assert.ok(sum.spend.runSpentUsd > 0 && sum.spend.scopeSpentUsd <= 1);
    assert.equal(sum.fillCheck.ok, true, JSON.stringify(sum.fillCheck.problems));
    assert.ok(s.grades.every((g) => !JSON.stringify(g).includes('claude-haiku')), 'grade rows never carry the arm');
  });
  it('a broken judge control makes the run not-credible (instrument check)', async () => {
    const { sink } = sinks();
    // A judge that says everything is correct: the trap control must catch it.
    const yesJudge = { responses: { async parse(p) {
      const resp = /<<<RESPONSE\n([\s\S]*)\nRESPONSE>>>/.exec(p.input)[1]; const q = resp.slice(0, 40);
      return { usage: { input_tokens: 10, output_tokens: 10 }, output_parsed: { keyPoints: ['kp1', 'kp2', 'kp3'].map((id) => ({ id, hit: true, quote: q })), traps: [{ id: 'trap1', fell: false, quote: '' }, { id: 'trap2', fell: false, quote: '' }], decisionCorrect: { value: true, quote: q }, rationale: '' } };
    } } };
    const anthropic = fakeAnthropic();
    const sum = await runDecisionEval({ phase: 'rehearsal', runId: 't2', cases: [freshCase()], manifest: {}, capUsd: 1, anthropic, openai: yesJudge, judgeModel: 'gpt-6.1-terra', zodTextFormat: fakeZodTextFormat, assertEgressSafe: noEgress, sink });
    assert.equal(sum.stop.kind, 'InstrumentFailure', 'the control checkpoint stops the run');
    assert.match(sum.stop.message, /preflight-trap/);
    assert.equal(anthropic.calls.length, 0, 'no arm is paid for once the judge fails its controls');
    assert.equal(sum.instrument.credible, false);
  });
  it('an UNMEASURED control checkpoint (judge unreachable) also stops before any arm spend', async () => {
    const { sink } = sinks();
    const anthropic = fakeAnthropic();
    const sum = await runDecisionEval({ phase: 'variance', runId: 't8', cases: [freshCase()], manifest: {}, capUsd: 5, anthropic, openai: fakeOpenAI({ fail: true }), judgeModel: 'gpt-6.1-terra', zodTextFormat: fakeZodTextFormat, assertEgressSafe: noEgress, sink });
    assert.equal(sum.stop.kind, 'InstrumentFailure');
    assert.equal(anthropic.calls.length, 0);
  });
  it('egress preflight: a case whose arm payload is refused stops the run before ANY spend (no judge, no arm call)', async () => {
    const { sink } = sinks();
    const anthropic = fakeAnthropic();
    const openai = fakeOpenAI();
    const bad = freshCase({ id: 'bad-case', context: `${CASE.context} SECRET_MARKER` });
    const gate = (p, { label }) => { if (label === 'decision-eval:arm' && p.includes('SECRET_MARKER')) throw new Error('[egress-gate] dsn-password'); };
    const sum = await runDecisionEval({ phase: 'variance', runId: 't9', cases: [freshCase(), bad], manifest: {}, capUsd: 5, anthropic, openai, judgeModel: 'gpt-6.1-terra', zodTextFormat: fakeZodTextFormat, assertEgressSafe: gate, sink });
    assert.equal(sum.stop.kind, 'InstrumentFailure');
    assert.match(sum.stop.message, /egress preflight: case bad-case/);
    assert.equal(anthropic.calls.length, 0);
    assert.equal(openai.calls.length, 0, 'not even the judge checkpoint is paid for');
  });
  it('the arm egress gate runs before the wire and its refusal propagates', async () => {
    const { sink } = sinks();
    const anthropic = fakeAnthropic();
    const gate = (p, { label }) => { if (label === 'decision-eval:arm') throw new Error('[egress-gate] secret in arm payload'); };
    const sum = await runDecisionEval({ phase: 'rehearsal', runId: 't6', cases: [freshCase()], manifest: {}, capUsd: 1, anthropic, openai: fakeOpenAI(), judgeModel: 'gpt-6.1-terra', zodTextFormat: fakeZodTextFormat, assertEgressSafe: gate, sink });
    assert.equal(sum.stop.kind, 'InstrumentFailure', 'caught by the egress preflight, before the wire');
    assert.match(sum.stop.message, /egress-gate/);
    assert.equal(anthropic.calls.length, 0);
  });
  it('a budget scope carries spend across runs (rehearsal + variance share one cap)', async () => {
    const { s, sink } = sinks();
    const anthropic = fakeAnthropic();
    const sum = await runDecisionEval({ phase: 'variance', runId: 't7', budgetScope: 'auto', initialSpentUsd: 0.999, cases: [freshCase()], manifest: {}, capUsd: 1, anthropic, openai: fakeOpenAI(), judgeModel: 'gpt-6.1-terra', zodTextFormat: fakeZodTextFormat, assertEgressSafe: noEgress, sink });
    assert.equal(sum.stop.kind, 'BudgetStop');
    assert.equal(anthropic.calls.length, 0);
    assert.ok(s.ledger.every((r) => r.budgetScope === 'auto'));
    assert.equal(sumScopeSpend([{ kind: 'settle', budgetScope: 'auto', usd: 0.5 }, { kind: 'settle', budgetScope: 'other', usd: 9 }, { kind: 'release', budgetScope: 'auto', usd: 0 }], 'auto'), 0.5);
  });
  it('a cap too small for one call stops BEFORE spending (BudgetStop)', async () => {
    const { s, sink } = sinks();
    const anthropic = fakeAnthropic();
    const sum = await runDecisionEval({ phase: 'variance', runId: 't3', cases: [freshCase()], manifest: {}, capUsd: 0.01, anthropic, openai: fakeOpenAI(), judgeModel: 'gpt-6.1-terra', zodTextFormat: fakeZodTextFormat, assertEgressSafe: noEgress, sink });
    assert.equal(sum.stop.kind, 'BudgetStop');
    assert.equal(anthropic.calls.length, 0);
    assert.equal(s.calls.length, 0);
  });
  it('two consecutive arm errors stop the run (broken route, not a quality result)', async () => {
    const { sink } = sinks();
    const sum = await runDecisionEval({ phase: 'variance', runId: 't4', cases: [freshCase()], manifest: {}, capUsd: 5, anthropic: fakeAnthropic({ fail: true }), openai: fakeOpenAI(), judgeModel: 'gpt-6.1-terra', zodTextFormat: fakeZodTextFormat, assertEgressSafe: noEgress, sink });
    assert.equal(sum.stop.kind, 'ArmRouteBroken');
    assert.equal(sum.instrument.totalGrades, 4, 'only the control checkpoint was graded; nothing after a broken route');
  });
  it('variance phase reports spread, proposed n and a labelled main-run projection', async () => {
    const { sink } = sinks();
    const sum = await runDecisionEval({ phase: 'variance', runId: 't5', cases: [freshCase()], manifest: {}, capUsd: 5, anthropic: fakeAnthropic(), openai: fakeOpenAI(), judgeModel: 'gpt-6.1-terra', zodTextFormat: fakeZodTextFormat, assertEgressSafe: noEgress, sink });
    assert.equal(sum.perArm['claude-opus-5-5'].outputs, 4);
    assert.equal(sum.perArm['claude-opus-5-5'].sw, 0);
    assert.equal(sum.proposedN.reps, 3);
    assert.equal(sum.mainProjection.available, true);
    assert.match(sum.mainProjection.fableUsdPerCall.label, /estimated/);
    assert.match(sum.mainProjection.opusUsdPerCall.label, /measured/);
  });
  it('projectMainCost prices Fable at its own row (2x Opus list)', () => {
    const p = projectMainCost({ cost: { 'claude-opus-5-5': { calls: 1, pricedCalls: 1, inputTokens: 1e6, outputTokens: 0, totalUsd: 4, usdPerCall: 4 } }, arm: 'claude-opus-5-5', spentUsd: 4, grades: 0, k: 1, reps: 3 });
    assert.equal(p.fableUsdPerCall.value, 8);
  });
  it('projectMainCost averages tokens over PRICED calls and counts the checkpoint grades (final gate G1)', () => {
    // 2 calls, one arm-error without usage: the 1M input tokens belong to ONE call.
    const cost = { 'claude-opus-5-5': { calls: 2, pricedCalls: 1, inputTokens: 1e6, outputTokens: 0, totalUsd: 4, usdPerCall: 4 } };
    const p = projectMainCost({ cost, arm: 'claude-opus-5-5', spentUsd: 4, grades: 0, k: 2, reps: 3 });
    assert.equal(p.fableUsdPerCall.value, 8, 'per-call tokens are not halved by the failed call');
    assert.equal(p.gradesMain, 4 * 2 + 2 * (2 * 6) + 2 * (2 * 2 * 3));
  });
});

// ── spot sample ─────────────────────────────────────────────────────────────
describe('decision-eval spot sample — blinded worksheet round trip', () => {
  it('draws ⌈20%⌉ with a floor of 4, deterministically', () => {
    const ids = Array.from({ length: 30 }, (_, i) => `id${i}`);
    assert.equal(drawSpotSample(ids, { seed: 3 }).length, 6);
    assert.equal(drawSpotSample(ids.slice(0, 5), { seed: 3 }).length, 4);
    assert.deepEqual(drawSpotSample(ids, { seed: 3 }), drawSpotSample(ids, { seed: 3 }));
  });
  it('render → fill → parse gives the agreement rate; arm names are scrubbed', () => {
    const md = renderSpotSample([
      { gradeId: 'aaaaaaaa', caseId: 'c1', question: 'q', decision: 'd', text: 'Opus thinks X', judgeCorrect: true },
      { gradeId: 'bbbbbbbb', caseId: 'c1', question: 'q', decision: 'd', text: 'Y', judgeCorrect: false },
    ], { runId: 'r' });
    assert.ok(!md.includes('Opus'));
    const filled = md.replace('| 1 | aaaaaaaa |  |', '| 1 | aaaaaaaa | Y |').replace('| 2 | bbbbbbbb |  |', '| 2 | bbbbbbbb | Y |');
    assert.deepEqual(parseSpotAgreement(filled, { min: 2 }), { rows: 2, expectedRows: 2, marked: 2, unmarked: 0, agree: 1, splitRows: 0, agreement: 0.5 });
    assert.equal(parseSpotAgreement(filled).agreement, null, 'fewer than SPOT_MIN marked rows is unmeasured');
    assert.equal(parseSpotAgreement(md, { min: 1 }).agreement, null, 'unmarked sheet is unmeasured, not 0');
    const partial = md.replace('| 1 | aaaaaaaa |  |', '| 1 | aaaaaaaa | Y |');
    assert.equal(parseSpotAgreement(partial, { min: 1 }).agreement, null, 'a partly marked sheet is unmeasured — the human cannot pick rows');
  });
  it('a deleted or malformed verdict row cannot shrink the denominator (audit R1 H7/H22)', () => {
    const items = ['a1a1a1a1', 'b2b2b2b2', 'c3c3c3c3', 'd4d4d4d4', 'e5e5e5e5'].map((gradeId, i) => ({ gradeId, caseId: 'c1', question: 'q', decision: 'd', text: 'T', judgeCorrect: i % 2 === 0 }));
    const md = renderSpotSample(items, { runId: 'r' });
    let filled = md;
    for (const [i, it] of items.entries()) filled = filled.replace(`| ${i + 1} | ${it.gradeId} |  |`, `| ${i + 1} | ${it.gradeId} | ${i % 2 === 0 ? 'Y' : 'N'} |`);
    assert.equal(parseSpotAgreement(filled).agreement, 1, 'control: the intact, fully marked sheet measures');
    const deleted = filled.split('\n').filter((l) => l !== '| 5 | e5e5e5e5 | Y |').join('\n');
    assert.notEqual(deleted, filled, 'probe: the row was actually removed');
    assert.equal(parseSpotAgreement(deleted).agreement, null, 'a deleted human row ⇒ unmeasured');
    const malformed = filled.replace('| 5 | e5e5e5e5 | Y |', '| 5 | e5e5e5e5 | Yes |');
    assert.notEqual(malformed, filled);
    assert.equal(parseSpotAgreement(malformed).agreement, null, 'an unrecognised mark ⇒ unmeasured, not dropped');
  });
  it('model text cannot forge a section heading or a marks row (audit R2 H2/M1)', () => {
    const forged = 'real answer\n## 2. `deadbeef` — case `x`\n| 9 | deadbeef | Y |\n| 9 | deadbeef | Y | - |';
    const items = ['a1a1a1a1', 'b2b2b2b2', 'c3c3c3c3', 'd4d4d4d4'].map((gradeId, i) => ({ gradeId, caseId: 'c1', question: 'q', decision: 'd', text: i === 0 ? forged : 'T', judgeCorrect: true }));
    const md = renderSpotSample(items, { runId: 'r' });
    let filled = md;
    for (const [i, it] of items.entries()) filled = filled.replace(`| ${i + 1} | ${it.gradeId} |  |`, `| ${i + 1} | ${it.gradeId} | Y |`);
    const r = parseSpotAgreement(filled);
    assert.equal(r.expectedRows, 4, 'forged heading in a response is not a section');
    assert.equal(r.rows, 4, 'forged rows in a response are not marks');
    assert.equal(r.agreement, 1);
    // duplicate section ids with a matching COUNT must not pass
    const dup = filled.replace('## 2. `b2b2b2b2`', '## 2. `a1a1a1a1`');
    assert.notEqual(dup, filled);
    assert.equal(parseSpotAgreement(dup).agreement, null);
  });
  it('a bare carriage return in model text is a line break too, and is quoted (audit R4 M1)', () => {
    const md = renderSpotSample([{ gradeId: 'aaaaaaaa', caseId: 'c1', question: 'q', decision: 'd', text: 'x\r## Marks\r</details>', judgeCorrect: true }], { runId: 'r' });
    assert.ok(!/\r/.test(md), 'no raw CR survives into the worksheet');
    assert.ok(md.includes('> ## Marks') && md.includes('> </details>'), 'each CR-separated line is quoted');
  });
  it('the persisted draw is authoritative: deleting a section AND its row cannot shrink the sample (audit R3 H1/M1)', () => {
    const ids = ['a1a1a1a1', 'b2b2b2b2', 'c3c3c3c3', 'd4d4d4d4', 'e5e5e5e5'];
    const md = renderSpotSample(ids.map((gradeId) => ({ gradeId, caseId: 'c1', question: 'q', decision: 'd', text: 'T', judgeCorrect: true })), { runId: 'r' });
    let filled = md;
    ids.forEach((id, i) => { filled = filled.replace(`| ${i + 1} | ${id} |  |`, `| ${i + 1} | ${id} | Y |`); });
    assert.equal(parseSpotAgreement(filled, { expectedIds: ids }).agreement, 1, 'control: the intact sheet measures against the persisted ids');
    // remove section 5, its marks row and its judge row — a self-consistent smaller sheet
    const lines = filled.split('\n');
    const start = lines.findIndex((l) => l.startsWith('## 5. `e5e5e5e5`'));
    const shrunk = [...lines.slice(0, start), ...lines.slice(start + 9).filter((l) => !l.includes('e5e5e5e5'))].join('\n');
    assert.ok(!shrunk.includes('e5e5e5e5') && shrunk.includes('## 4. `d4d4d4d4`'), 'probe: only the fifth sample was removed');
    assert.equal(parseSpotAgreement(shrunk).agreement, 1, 'without the persisted ids the shrunken sheet is self-consistent (why they are needed)');
    assert.equal(parseSpotAgreement(shrunk, { expectedIds: ids }).agreement, null, 'with them it is unmeasured');
  });
  it('the judge label is never in the same table row as the human verdict cell (audit R1 M3/M7/M8)', () => {
    const md = renderSpotSample([{ gradeId: 'aaaaaaaa', caseId: 'c1', question: 'q', decision: 'd', text: 'T', judgeCorrect: true, judgeSplit: true }], { runId: 'r' });
    const humanRow = md.split('\n').find((l) => l.startsWith('| 1 | aaaaaaaa |  |'));
    assert.ok(humanRow, 'probe: the human row exists');
    assert.ok(!/split|\| Y \|/.test(humanRow), 'no judge data on the human row');
    assert.ok(md.indexOf('<details><summary>Judge labels') > md.indexOf(humanRow), 'judge labels follow, collapsed');
  });
});

// ── CLI preflight ───────────────────────────────────────────────────────────
describe('decision-eval CLI — budget scope and run identity', () => {
  async function runCli(args) {
    const lines = [];
    const orig = process.stderr.write;
    process.stderr.write = (s) => { lines.push(String(s)); return true; };
    try { return { code: await decisionCli(['node', 'cli', ...args]), err: lines.join('') }; } finally { process.stderr.write = orig; }
  }
  it('rehearsal and variance must NAME their budget scope (audit R1 H2/H13)', async () => {
    for (const phase of ['rehearsal', 'variance']) {
      const r = await runCli(['run', '--phase', phase, '--cap-usd', '10', '--root', os.tmpdir()]);
      assert.equal(r.code, 2);
      assert.match(r.err, /--budget-scope/, phase);
    }
    const ok = await runCli(['run', '--phase', 'variance', '--cap-usd', '10', '--budget-scope', 'autonomous', '--root', fs.mkdtempSync(path.join(os.tmpdir(), 'dec-cli-'))]);
    assert.ok(!/--budget-scope/.test(ok.err), 'control: with a scope the run gets past this check (and stops at the missing manifest)');
    assert.match(ok.err, /manifest/);
  });
  it('cross-grade refuses a scope other than the main run scope, and a run produced under another corpus (focused audit H1/H3)', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dec-xg-'));
    fs.mkdirSync(path.join(root, 'corpus'));
    const c = freshCase();
    fs.writeFileSync(path.join(root, 'corpus', `${c.id}.json`), JSON.stringify(c, null, 2) + '\n');
    assert.equal((await runCli(['freeze', '--root', root])).code, 0);
    const m = JSON.parse(fs.readFileSync(path.join(root, 'corpus', 'manifest.json'), 'utf8'));
    fs.mkdirSync(path.join(root, 'runs', 'main'), { recursive: true });
    const writeSummary = (over) => fs.writeFileSync(path.join(root, 'runs', 'main', 'summary.json'), JSON.stringify({
      phase: 'main', runId: 'main', spotSampleIds: ['g1'], spend: { budgetScope: 'main', capUsd: 25 },
      corpusSha256: m.corpusSha256, contractEpoch: m.contractEpoch, promptHashes: m.promptHashes, ...over }));
    const xg = (scope) => runCli(['cross-grade', '--run-id', 'main', '--cap-usd', '25', '--budget-scope', scope, '--confirm-cross-grade', '--root', root]);
    // Hermetic: no calls.jsonl exists, so every path stops at a preflight BEFORE credentials or clients,
    // whatever keys the developer's environment holds.
    {
      writeSummary({});
      assert.match((await xg('elsewhere')).err, /not the main run's scope/);
      writeSummary({ corpusSha256: 'f'.repeat(64) });
      assert.match((await xg('main')).err, /different corpus/);
      writeSummary({ contractEpoch: 1 });
      assert.match((await xg('main')).err, /different corpus/);
      writeSummary({});
      const ok = await xg('main');
      assert.ok(!/different corpus|not the main run/.test(ok.err), 'positive control: matching scope + corpus gets past both checks');
      assert.match(ok.err, /no persisted arm output/, 'and stops at the sample preflight, before credentials or any spend');
      assert.match((await runCli(['cross-grade', '--run-id', 'main', '--cap-usd', '40', '--budget-scope', 'main', '--confirm-cross-grade', '--root', root])).err, /approved cap/, 'a fresh cap is refused');
      assert.ok(!fs.existsSync(path.join(root, 'runs', 'main', 'cross-grades.jsonl')), 'nothing was graded');
      writeSummary({ corpusSha256: 'f'.repeat(64) });
      assert.match((await runCli(['report', '--run-id', 'main', '--root', root])).err, /different corpus/, 'report refuses too');
    }
  });
  it('a run id or scope that is not a plain name is refused before anything is written (audit R2 H1)', async () => {
    for (const bad of ['../escaped', 'a/b', '..', 'a\\b']) {
      const r = await runCli(['run', '--phase', 'variance', '--cap-usd', '10', '--budget-scope', 'autonomous', '--run-id', bad, '--root', os.tmpdir()]);
      assert.equal(r.code, 2, bad);
      assert.match(r.err, /plain name/, bad);
      const s = await runCli(['run', '--phase', 'variance', '--cap-usd', '10', '--budget-scope', bad, '--root', os.tmpdir()]);
      assert.match(s.err, /plain name/, `scope ${bad}`);
    }
  });
});
