/**
 * Budget ledger (docs/plans/seeded-defect-benchmark.md §2.6, §6 row for this file).
 * Covers: reservation bound, refusal before send, unpriced/uncapped refusal, two real
 * processes sharing a cap, killed-process reconcile gate, failure-state evidence rules,
 * the seam inventory (derived from scripts/**), and inertness when the env is unset.
 */
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { z } from 'zod';
import {
  BUDGET_LEDGER_ENV, BUDGET_STOP_EXIT_CODE, BudgetStopError, SEAM_INVENTORY, UNMETERED_REQUEST_SITES, METERED_VIA_SEAM,
  initLedger, readLedgerSummary, reserveCall, settleCall, failCall, reconcileCall, estimateReservation,
  withBudget, isBudgetActive, budgetStopOccurred, _resetBudgetStopLatch,
} from '../scripts/lib/llm-budget.mjs';
import { costFromUsage } from '../scripts/lib/model-pricing.mjs';
import { callGemini, callClaude, safeCallGPT } from '../scripts/lib/llm-wrappers.mjs';
import { _callGPTOnce, wireModel } from '../scripts/lib/audit/llm-helpers.mjs';
import { callReviewer } from '../scripts/lib/final-review/transport.mjs';
import { createAnthropicClient, _internals as anthropicInternals } from '../scripts/lib/anthropic-client.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BUDGET_URL = pathToFileURL(path.join(ROOT, 'scripts/lib/llm-budget.mjs')).href;

let dir; let file; let savedEnv;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'budget-'));
  file = path.join(dir, 'ledger.jsonl');
  savedEnv = { ledger: process.env[BUDGET_LEDGER_ENV], key: process.env.ANTHROPIC_API_KEY, backend: process.env.CLAUDE_BACKEND };
  delete process.env[BUDGET_LEDGER_ENV];
  _resetBudgetStopLatch();
});
afterEach(() => {
  for (const [k, v] of [[BUDGET_LEDGER_ENV, savedEnv.ledger], ['ANTHROPIC_API_KEY', savedEnv.key], ['CLAUDE_BACKEND', savedEnv.backend]]) {
    if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
  fs.rmSync(dir, { recursive: true, force: true });
});

const arm = (capUsd) => { initLedger({ file, capUsd, runId: 't' }); process.env[BUDGET_LEDGER_ENV] = file; };
const spec = (over = {}) => ({ seam: 'test', provider: 'openai', model: 'gpt-5.4', body: { input: 'x'.repeat(400) }, outputCap: 1000, ...over });
const stateOf = () => readLedgerSummary(file).calls.map((c) => c.state);
const micro = (usd) => Math.ceil(usd * 1e6 - 1e-9);

describe('reservation is an upper bound', () => {
  // Real-shaped requests: a long audit prompt, a tool-forced Opus review, a Gemini review with a schema.
  const cases = [
    { model: 'gpt-5.4', body: { model: 'gpt-5.4', input: [{ role: 'system', content: 'S'.repeat(4000) }, { role: 'user', content: 'diff --git a/x b/x\n'.repeat(3000) }], text: { format: { type: 'json_schema' } } }, cap: 16000 },
    { model: 'claude-opus-5', body: { model: 'claude-opus-5', max_tokens: 32000, system: 'review', messages: [{ role: 'user', content: 'ünïcode 変更 '.repeat(5000) }], tools: [{ name: 'submit_review' }] }, cap: 32000 },
    { model: 'gemini-3-flash-preview', body: { contents: 'z'.repeat(90000), config: { responseSchema: { type: 'OBJECT' } } }, cap: 32000 },
    { model: 'gemini-3.1-pro-preview', body: { contents: 'y'.repeat(900000) }, cap: 32000 },
  ];
  for (const c of cases) {
    it(`reservation >= metered cost at the worst case and at a typical case (${c.model})`, () => {
      const est = estimateReservation({ model: c.model, body: c.body, outputCap: c.cap });
      assert.equal(est.inputBytes, Buffer.byteLength(JSON.stringify(c.body), 'utf8'));
      const typical = { input_tokens: Math.floor(est.inputBytes / 4), output_tokens: Math.floor(c.cap / 2) };
      // Worst case: one token per byte, every input token a cache WRITE, the whole output cap spent.
      const worst = { input_tokens: 0, cache_creation_input_tokens: est.inputBytes, output_tokens: c.cap };
      for (const usage of [typical, worst]) {
        const cost = costFromUsage(usage, c.model);
        assert.ok(cost.priced && !cost.unmeterable);
        assert.ok(est.reservedMicro >= micro(cost.totalUsd), `reserved ${est.reservedMicro} < metered ${micro(cost.totalUsd)}`);
      }
    });
  }
});

describe('refusal before send', () => {
  it('a call over the remaining cap is refused and never sent', async () => {
    arm(0.001);
    let sent = false;
    await assert.rejects(withBudget(spec(), async () => { sent = true; return {}; }), (e) => {
      assert.ok(e instanceof BudgetStopError);
      assert.equal(e.code, 'budget-stop'); assert.equal(e.reason, 'would-exceed-cap'); assert.equal(e.exitCode, BUDGET_STOP_EXIT_CODE);
      return true;
    });
    assert.equal(sent, false);
    assert.equal(readLedgerSummary(file).calls.length, 0, 'a refusal leaves no record');
    assert.equal(budgetStopOccurred(), true);
  });

  it('an unpriced model is refused and never sent', async () => {
    arm(100);
    let sent = false;
    await assert.rejects(withBudget(spec({ model: 'no-such-model-xyz' }), async () => { sent = true; }), (e) => e.reason === 'unpriced-model');
    assert.equal(sent, false);
  });

  for (const outputCap of [undefined, null, 0, -5, 1.5, '1000', Infinity]) {
    it(`a request with no enforced output cap (${String(outputCap)}) is refused and never sent`, async () => {
      arm(100);
      let sent = false;
      await assert.rejects(withBudget(spec({ outputCap }), async () => { sent = true; }), (e) => e.reason === 'uncapped-request');
      assert.equal(sent, false);
    });
  }

  it('the cli backend (no enforced max_tokens) is refused when a budget is active, and says why', async () => {
    arm(100);
    const adapter = anthropicInternals.createCliAdapter({ claudeBin: 'definitely-not-a-real-binary' });
    await assert.rejects(
      adapter.messages.create({ model: 'claude-opus-5', max_tokens: 100, messages: [{ role: 'user', content: 'hi' }] }),
      (e) => e instanceof BudgetStopError && e.reason === 'uncapped-request' && /cannot enforce max_tokens/.test(e.message),
    );
  });

  it('a streamed sdk request outside a metered call is refused (its usage cannot be settled here)', async () => {
    arm(100);
    process.env.ANTHROPIC_API_KEY = 'sk-test';
    const client = await createAnthropicClient({ backend: 'sdk', fetch: async () => { throw new Error('must not be sent'); }, fresh: true });
    await assert.rejects(
      client.messages.create({ model: 'claude-opus-5', max_tokens: 10, stream: true, messages: [{ role: 'user', content: 'x' }] }),
      (e) => e instanceof BudgetStopError && e.reason === 'unmetered-stream',
    );
  });
});

describe('failure states need positive evidence', () => {
  const run = async (err, opts) => {
    arm(100);
    await assert.rejects(withBudget(spec(), async () => { throw err; }), (e) => e === err);
    const s = readLedgerSummary(file);
    return { s, call: s.calls[0], opts };
  };

  it('a timeout after the provider accepted the request keeps the FULL reservation as spent', async () => {
    const { s, call } = await run(Object.assign(new Error('Timeout after 270s'), { name: 'AbortError' }));
    assert.equal(call.state, 'failed-unknown');
    assert.ok(call.reservedUsd > 0 && s.spentUsd === call.reservedUsd);
    assert.equal(s.remainingUsd, 100 - call.reservedUsd);
  });

  for (const status of [500, 502, 503, 408, 429]) {
    it(`HTTP ${status} is failed-unknown (providers may have processed it)`, async () => {
      const { s, call } = await run(Object.assign(new Error('x'), { status }));
      assert.equal(call.state, 'failed-unknown'); assert.equal(s.spentUsd, call.reservedUsd);
    });
  }
  it('an error with no status and no usage is failed-unknown', async () => {
    const { call } = await run(new Error('socket hang up'));
    assert.equal(call.state, 'failed-unknown');
  });
  for (const status of [400, 401, 404, 413, 422]) {
    it(`a synchronous HTTP ${status} refusal is failed-unbilled (cost 0)`, async () => {
      const { s, call } = await run(Object.assign(new Error('x'), { status }));
      assert.equal(call.state, 'failed-unbilled'); assert.equal(s.spentUsd, 0);
    });
  }
  it('a request that never left the process (budgetNotSent) is failed-unbilled', async () => {
    const { s, call } = await run(Object.assign(new Error('local'), { budgetNotSent: true }));
    assert.equal(call.state, 'failed-unbilled'); assert.equal(s.spentUsd, 0);
  });
  it('an error carrying usage is failed-billed at the metered cost, not the reservation', async () => {
    const { s, call } = await run(Object.assign(new Error('truncated'), { usage: { input_tokens: 100, output_tokens: 50 } }));
    assert.equal(call.state, 'failed-billed');
    assert.ok(call.costUsd > 0 && call.costUsd < call.reservedUsd);
    assert.equal(s.spentUsd, call.costUsd);
  });
  it('LlmError-shaped usage (llmUsage) is recognised as billed', async () => {
    const { call } = await run(Object.assign(new Error('incomplete'), { llmUsage: { input_tokens: 10, output_tokens: 5 } }));
    assert.equal(call.state, 'failed-billed');
  });
});

describe('settlement', () => {
  it('settles at metered cost, recording provider, model requested and served, tokens, seam', async () => {
    arm(100);
    const r = await withBudget(spec({ seam: 'seam-a' }), async () => ({ usage: { input_tokens: 120, output_tokens: 30 }, model: 'gpt-5.4-2026-01-01' }));
    assert.deepEqual(r.usage, { input_tokens: 120, output_tokens: 30 });
    const s = readLedgerSummary(file); const c = s.calls[0];
    assert.equal(c.state, 'settled'); assert.equal(c.seam, 'seam-a'); assert.equal(c.provider, 'openai');
    assert.equal(c.model, 'gpt-5.4'); assert.equal(c.modelServed, 'gpt-5.4-2026-01-01');
    assert.deepEqual(c.tokens, { input: 120, output: 30 });
    assert.ok(c.costUsd > 0 && c.costUsd < c.reservedUsd);
    assert.equal(s.spentUsd, c.costUsd); assert.equal(s.settledUsd, c.costUsd);
  });

  for (const [label, usage] of [['no usage', undefined], ['usageMissing', { input_tokens: 5, output_tokens: 5, usageMissing: true }], ['zero input tokens', { input_tokens: 0, output_tokens: 0 }]]) {
    it(`a settled call with ${label} keeps its reservation as cost and is flagged`, async () => {
      arm(100);
      await withBudget(spec(), async () => ({ usage, model: 'gpt-5.4' }));
      const s = readLedgerSummary(file); const c = s.calls[0];
      assert.equal(c.state, 'settled'); assert.equal(c.costUsd, c.reservedUsd);
      assert.deepEqual(c.flags, ['unmetered-kept-reservation']);
      assert.equal(s.flagged.length, 1);
    });
  }

  it('an enclosing metered call covers an inner seam (one reservation, not two)', async () => {
    arm(100);
    await withBudget(spec({ seam: 'outer' }), async () => withBudget(spec({ seam: 'inner' }), async () => ({ usage: { input_tokens: 1, output_tokens: 1 } })), () => ({ usage: { input_tokens: 9, output_tokens: 9 } }));
    const calls = readLedgerSummary(file).calls;
    assert.equal(calls.length, 1); assert.equal(calls[0].seam, 'outer');
  });
});

describe('ledger file', () => {
  it('has a header with capUsd, runId, createdAt; resuming with a different cap is refused', () => {
    const h = initLedger({ file, capUsd: 10, runId: 'r1' });
    assert.equal(h.capUsd, 10); assert.equal(h.runId, 'r1'); assert.ok(Date.parse(h.createdAt) > 0);
    assert.deepEqual(initLedger({ file, capUsd: 10 }), h, 'same cap resumes');
    assert.throws(() => initLedger({ file, capUsd: 20 }), /refusing to change/);
  });
  it('is durable: reserve is on disk BEFORE the request runs', async () => {
    arm(100);
    let seenDuringSend;
    await withBudget(spec(), async () => { seenDuringSend = stateOf(); return { usage: { input_tokens: 1, output_tokens: 1 } }; });
    assert.deepEqual(seenDuringSend, ['reserved']);
    assert.deepEqual(stateOf(), ['settled']);
  });
  it('a missing ledger refuses instead of running unmetered', async () => {
    process.env[BUDGET_LEDGER_ENV] = path.join(dir, 'nope.jsonl');
    await assert.rejects(withBudget(spec(), async () => ({})), (e) => e.reason === 'ledger-missing');
  });
  it('a torn final line (crash mid-append) is ignored; an interior corrupt line refuses', async () => {
    arm(100);
    fs.appendFileSync(file, '{"type":"reserve","callI');
    assert.equal(readLedgerSummary(file).calls.length, 0);
    fs.appendFileSync(file, '\n{"type":"x"}\n');
    assert.throws(() => readLedgerSummary(file), (e) => e.reason === 'ledger-corrupt');
  });
});

const WORKER = `
import fs from 'node:fs';
const { reserveCall, settleCall, BudgetStopError } = await import(${JSON.stringify(BUDGET_URL)});
const mode = process.argv[2];
const spec = { seam: 'worker', provider: 'openai', model: 'gpt-5.4', body: { input: 'x'.repeat(400) }, outputCap: 1000 };
if (mode === 'die') { const h = await reserveCall(spec); process.stdout.write(h.callId); process.exit(9); }
let ok = 0, refused = 0;
for (let i = 0; i < 25; i++) {
  try { const h = await reserveCall(spec); await settleCall(h, {}); ok++; }
  catch (e) { if (e instanceof BudgetStopError && e.reason === 'would-exceed-cap') refused++; else throw e; }
}
process.stdout.write(JSON.stringify({ ok, refused }));
`;

function child(args) {
  const w = path.join(dir, 'worker.mjs');
  if (!fs.existsSync(w)) fs.writeFileSync(w, WORKER);
  return new Promise((resolve, reject) => {
    const p = spawn(process.execPath, [w, ...args], { env: { ...process.env, [BUDGET_LEDGER_ENV]: file }, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = ''; let err = '';
    p.stdout.on('data', (d) => { out += d; }); p.stderr.on('data', (d) => { err += d; });
    p.on('close', (code) => (code === 0 || args[0] === 'die' ? resolve({ code, out }) : reject(new Error(`worker exit ${code}: ${err}`))));
  });
}

describe('two real processes', () => {
  it('concurrent reservations never exceed the cap (exactly floor(cap / reservation) succeed)', async () => {
    const r = estimateReservation(spec()).reservedMicro;
    const capUsd = (r * 10.5) / 1e6;
    initLedger({ file, capUsd, runId: 'conc' });
    const [a, b] = (await Promise.all([child(['go']), child(['go'])])).map((x) => JSON.parse(x.out));
    assert.equal(a.ok + b.ok, 10, `successes ${a.ok}+${b.ok}`);
    assert.equal(a.refused + b.refused, 40);
    const s = readLedgerSummary(file);
    assert.ok(s.spentUsd <= capUsd + 1e-12, `spent ${s.spentUsd} > cap ${capUsd}`);
    assert.equal(s.calls.length, 10);
  });

  it('a `reserved` record left by a killed process blocks resume until reconciled', async () => {
    initLedger({ file, capUsd: 100, runId: 'dead' });
    const { out: deadCallId } = await child(['die']);
    process.env[BUDGET_LEDGER_ENV] = file;
    const s0 = readLedgerSummary(file);
    assert.deepEqual(s0.indeterminate, [deadCallId]);
    assert.ok(s0.spentUsd > 0, 'its full reservation is counted as spent');
    let sent = false;
    await assert.rejects(withBudget(spec(), async () => { sent = true; }), (e) => e.reason === 'indeterminate-reserved' && e.details.callIds[0] === deadCallId);
    assert.equal(sent, false);

    await assert.rejects(reconcileCall({ file, callId: deadCallId, evidence: '  ', costUsd: 0 }), /evidence/);
    await assert.rejects(reconcileCall({ file, callId: deadCallId, evidence: 'dashboard', costUsd: -1 }), /costUsd/);
    await reconcileCall({ file, callId: deadCallId, evidence: 'OpenAI usage dashboard 2026-11-23: no request logged', costUsd: 0 });
    const s1 = readLedgerSummary(file);
    assert.deepEqual(s1.indeterminate, []); assert.equal(s1.spentUsd, 0);
    assert.equal(s1.calls[0].state, 'reconciled'); assert.match(s1.calls[0].evidence, /dashboard/);
    await withBudget(spec(), async () => ({ usage: { input_tokens: 1, output_tokens: 1 } })); // resumes
    await assert.rejects(reconcileCall({ file, callId: s1.calls[0].callId, evidence: 'again', costUsd: 0 }), /not indeterminate/);
  });

  it('a failed-unknown call stays counted until reconciled, and reconcile replaces it with the evidence', async () => {
    arm(100);
    await assert.rejects(withBudget(spec(), async () => { throw Object.assign(new Error('t'), { name: 'AbortError' }); }));
    const c = readLedgerSummary(file).calls[0];
    assert.equal(c.state, 'failed-unknown');
    await reconcileCall({ file, callId: c.callId, evidence: 'billed per console', costUsd: 0.0123 });
    const s = readLedgerSummary(file);
    assert.equal(s.calls[0].state, 'reconciled'); assert.equal(s.spentUsd, 0.0123);
  });
});

describe('seam inventory', () => {
  const walk = (d, out = []) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      if (e.name === 'node_modules' || e.name === '.git') continue;
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p, out); else if (/\.(mjs|js|cjs)$/.test(e.name)) out.push(p);
    }
    return out;
  };
  // A code line that CALLS a provider request method. Comment lines are skipped (the pin census and faithfulness
  // modules talk about messages.create in prose).
  const REQUEST_CALL = /\.(responses\.(parse|create)|messages\.(create|stream)|models\.generateContent(Stream)?|chat\.completions\.(create|parse))\s*\(/;
  const constructing = () => {
    const found = [];
    for (const f of walk(path.join(ROOT, 'scripts'))) {
      if (f.endsWith(path.join('scripts', 'lib', 'llm-budget.mjs'))) continue; // the seam helper itself (budgetedMessagesCreate)
      const code = fs.readFileSync(f, 'utf8').split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l));
      if (code.some((l) => REQUEST_CALL.test(l))) found.push(path.relative(ROOT, f).split(path.sep).join('/'));
    }
    return found.sort();
  };

  it('every file under scripts/** that constructs a provider request is a wired seam or a declared unmetered site', () => {
    const declared = new Set([...SEAM_INVENTORY.map((s) => s.file), ...UNMETERED_REQUEST_SITES.map((s) => s.file), ...METERED_VIA_SEAM.map((s) => s.file)]);
    const unlisted = constructing().filter((f) => !declared.has(f));
    assert.deepEqual(unlisted, [], `provider-request site(s) outside the budget inventory — wire them through withBudget() or declare them in scripts/lib/llm-budget.mjs: ${unlisted.join(', ')}`);
  });

  it('the inventory has no stale entries, no overlap, and a reason on every unmetered site', () => {
    const found = new Set(constructing());
    const seams = SEAM_INVENTORY.map((s) => s.file); const un = UNMETERED_REQUEST_SITES.map((s) => s.file); const via = METERED_VIA_SEAM.map((s) => s.file);
    assert.deepEqual([...seams, ...un, ...via].filter((f) => !found.has(f)), [], 'listed file no longer constructs a provider request');
    assert.deepEqual([...seams, ...via].filter((f) => un.includes(f)), []);
    assert.deepEqual(seams.filter((f) => via.includes(f)), []);
    assert.equal(new Set(un).size, un.length);
    for (const u of UNMETERED_REQUEST_SITES) assert.ok(u.reason && u.reason.length > 10, u.file);
  });

  it('every wired seam file actually routes through withBudget', () => {
    for (const s of SEAM_INVENTORY) {
      assert.match(fs.readFileSync(path.join(ROOT, s.file), 'utf8'), /\b(withBudget|budgetedMessagesCreate)\(/, s.file);
    }
  });

  it('a file metered via a seam really imports that seam', () => {
    for (const v of METERED_VIA_SEAM) {
      const text = fs.readFileSync(path.join(ROOT, v.file), 'utf8');
      assert.ok(v.via.some((name) => text.includes(name)), `${v.file} uses none of ${v.via.join(', ')}`);
    }
  });

  it('the scan sees a synthetic new request site (negative control)', () => {
    assert.ok(REQUEST_CALL.test('const r = await client.messages.create({ model })'));
    assert.ok(REQUEST_CALL.test('await ai.models.generateContentStream(p)'));
    assert.ok(REQUEST_CALL.test('openai.responses.parse(req)'));
    assert.ok(!REQUEST_CALL.test('const created = messages.created(x)'));
  });
});

describe('seams: inert when AUDIT_BUDGET_LEDGER is unset, metered when set', () => {
  const geminiResponse = { text: '{"ok":true}', usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 20, totalTokenCount: 120 } };

  it('unset: callGemini sends the identical request, returns the identical envelope, creates no ledger', async () => {
    assert.equal(isBudgetActive(), false);
    const seen = [];
    const ai = { models: { generateContent: async (req) => { seen.push(req); return geminiResponse; } } };
    const r = await callGemini(ai, 'SYS', 'USER', { type: 'OBJECT' }, { model: 'gemini-3-flash-preview', maxOutputTokens: 123 });
    assert.deepEqual(seen, [{ model: 'gemini-3-flash-preview', contents: 'USER', config: { systemInstruction: 'SYS', maxOutputTokens: 123, responseMimeType: 'application/json', responseSchema: { type: 'OBJECT' } } }]);
    assert.deepEqual(r.result, { ok: true });
    assert.equal(r.usage.input_tokens, 100);
    assert.equal(fs.existsSync(file), false);
  });

  it('unset: withBudget hands back the very value fn() returns (no wrapping, same thenable)', () => {
    const p = Promise.resolve(1);
    assert.equal(withBudget(spec(), () => p), p);
  });

  it('unset: callClaude / safeCallGPT requests are unchanged', async () => {
    const seen = [];
    const anthropic = { messages: { create: async (req) => { seen.push(req); return { content: [{ text: '{"a":1}' }], usage: { input_tokens: 5, output_tokens: 5 } }; } } };
    const c = await callClaude(anthropic, 'S', 'U', null, { model: 'claude-opus-5', maxTokens: 77 });
    assert.deepEqual(seen[0], { model: 'claude-opus-5', max_tokens: 77, system: 'S', messages: [{ role: 'user', content: 'U' }] });
    assert.deepEqual(c.result, { a: 1 });
    const gseen = [];
    const openai = { responses: { parse: async (req) => { gseen.push(req); return { output_parsed: { v: 1 }, usage: { input_tokens: 3, output_tokens: 3 } }; } } };
    const g = await safeCallGPT(openai, 'S', 'U', z.object({ v: z.number() }), { model: 'gpt-5.4', maxOutputTokens: 55, timeoutMs: 9 });
    assert.deepEqual(Object.keys(gseen[0]), ['model', 'instructions', 'input', 'text', 'max_output_tokens', 'timeout']);
    assert.equal(gseen[0].max_output_tokens, 55);
    assert.deepEqual(g.result, { v: 1 });
  });

  it('unset: _callGPTOnce passes ONLY { signal } to the SDK (no maxRetries)', async () => {
    const calls = [];
    const openai = { responses: { parse: async (req, opts) => { calls.push({ req, opts }); return { output_parsed: { findings: [] }, status: 'completed', output: [], usage: { input_tokens: 10, output_tokens: 5 } }; } } };
    await _callGPTOnce(openai, { schema: z.object({ findings: z.array(z.string()) }), schemaName: 's', systemPrompt: 'S', userPrompt: 'U' });
    assert.deepEqual(Object.keys(calls[0].opts), ['signal']);
    assert.equal(fs.existsSync(file), false);
  });

  it('unset: a pinned sdk client returns the SDK promise (withResponse intact) and sends the same body', async () => {
    process.env.ANTHROPIC_API_KEY = 'sk-test';
    const seen = [];
    const fetchImpl = async (_u, init) => { seen.push(JSON.parse(init.body)); return new Response(JSON.stringify({ id: 'm', type: 'message', role: 'assistant', model: 'claude-opus-5', content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn', usage: { input_tokens: 7, output_tokens: 3 } }), { status: 200, headers: { 'content-type': 'application/json' } }); };
    const client = await createAnthropicClient({ backend: 'sdk', fetch: fetchImpl, fresh: true });
    const pending = client.messages.create({ model: 'claude-opus-5', max_tokens: 10, messages: [{ role: 'user', content: 'x' }] });
    assert.equal(typeof pending.withResponse, 'function', 'APIPromise must pass through untouched');
    await pending;
    assert.deepEqual(seen[0], { model: 'claude-opus-5', max_tokens: 10, messages: [{ role: 'user', content: 'x' }] });
    assert.equal(fs.existsSync(file), false);
  });

  it('set: the sdk messages seam reserves, settles from response.usage, and turns SDK retries off', async () => {
    arm(100);
    process.env.ANTHROPIC_API_KEY = 'sk-test';
    let attempts = 0;
    const fetchImpl = async () => { attempts++; return new Response('{"error":{"type":"overloaded_error","message":"x"}}', { status: 529, headers: { 'content-type': 'application/json' } }); };
    const client = await createAnthropicClient({ backend: 'sdk', fetch: fetchImpl, fresh: true });
    await assert.rejects(client.messages.create({ model: 'claude-opus-5', max_tokens: 10, messages: [{ role: 'user', content: 'x' }] }));
    assert.equal(attempts, 1, 'no hidden SDK retry while a budget is active');
    assert.deepEqual(stateOf(), ['failed-unknown']);

    const ok = async () => new Response(JSON.stringify({ id: 'm', type: 'message', role: 'assistant', model: 'claude-opus-5-20260101', content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn', usage: { input_tokens: 40, output_tokens: 8 } }), { status: 200, headers: { 'content-type': 'application/json' } });
    const client2 = await createAnthropicClient({ backend: 'sdk', fetch: ok, fresh: true });
    await client2.messages.create({ model: 'claude-opus-5', max_tokens: 10, messages: [{ role: 'user', content: 'x' }] });
    const last = readLedgerSummary(file).calls.at(-1);
    assert.equal(last.state, 'settled'); assert.equal(last.provider, 'anthropic');
    assert.equal(last.modelServed, 'claude-opus-5-20260101'); assert.deepEqual(last.tokens, { input: 40, output: 8 });
  });

  it('set: callGemini reserves/settles; an over-cap call propagates BudgetStopError instead of degrading to null', async () => {
    arm(100);
    const ai = { models: { generateContent: async () => geminiResponse } };
    await callGemini(ai, 'SYS', 'USER', {}, { model: 'gemini-3-flash-preview', maxOutputTokens: 100 });
    const c = readLedgerSummary(file).calls[0];
    assert.equal(c.state, 'settled'); assert.equal(c.provider, 'google'); assert.deepEqual(c.tokens, { input: 100, output: 20 });
    fs.rmSync(file); arm(0.0000001);
    let sent = false;
    await assert.rejects(callGemini({ models: { generateContent: async () => { sent = true; return geminiResponse; } } }, 'S', 'U', {}, { model: 'gemini-3-flash-preview' }), BudgetStopError);
    assert.equal(sent, false);
  });

  it('set: _callGPTOnce reserves under the wire model and disables SDK retries', async () => {
    arm(100);
    const calls = [];
    const openai = { responses: { parse: async (req, opts) => { calls.push({ req, opts }); return { output_parsed: { findings: [] }, status: 'completed', model: 'served-snapshot', output: [], usage: { input_tokens: 10, output_tokens: 5 } }; } } };
    await _callGPTOnce(openai, { schema: z.object({ findings: z.array(z.string()) }), schemaName: 's', systemPrompt: 'S', userPrompt: 'U' });
    assert.equal(calls[0].opts.maxRetries, 0);
    const c = readLedgerSummary(file).calls[0];
    assert.equal(c.state, 'settled'); assert.equal(c.model, wireModel()); assert.equal(c.provider, 'openai'); assert.equal(c.modelServed, 'served-snapshot');
  });

  it('set: callReviewer (gemini transport) reserves around the adapter and settles from its usage; a hang-then-error is failed-unknown', async () => {
    arm(100);
    const stream = async function* () { yield { text: '{"verdict":"APPROVE"}', usageMetadata: { promptTokenCount: 200, candidatesTokenCount: 30, totalTokenCount: 230 } }; };
    await callReviewer({ models: { generateContentStream: async () => stream() } }, { transportKind: 'gemini', model: 'gemini-3-flash-preview', systemPrompt: 'S', userPrompt: 'U', passName: 'fr' });
    const c = readLedgerSummary(file).calls[0];
    assert.equal(c.state, 'settled'); assert.equal(c.provider, 'google'); assert.equal(c.seam, 'final-review.callReviewer');
    assert.deepEqual(c.tokens, { input: 200, output: 30 });
    await assert.rejects(callReviewer({ models: { generateContentStream: async () => { throw Object.assign(new Error('connection reset'), { code: 'ECONNRESET' }); } } }, { transportKind: 'gemini', model: 'gemini-3-flash-preview', systemPrompt: 'S', userPrompt: 'U', passName: 'fr' }));
    assert.equal(readLedgerSummary(file).calls[1].state, 'failed-unknown');
    // A refusal is never relabelled as a provider error.
    fs.rmSync(file); arm(0.0000001);
    await assert.rejects(callReviewer({ models: { generateContentStream: async () => stream() } }, { transportKind: 'gemini', model: 'gemini-3-flash-preview', systemPrompt: 'S', userPrompt: 'U', passName: 'fr' }), BudgetStopError);
  });
});
