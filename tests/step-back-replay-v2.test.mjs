import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { freezeFromExport } from '../scripts/lib/audit/step-back-export.mjs';
import { scoringPathFor } from '../scripts/lib/audit/step-back-dataset.mjs';
import { createRevisionFs } from '../scripts/lib/audit/step-back-gitfs.mjs';
import { runReplay, scoreReplay, readResultsJsonl, renderDryRun, renderScoreTable, REPLAY_ARMS } from '../scripts/lib/audit/step-back-replay.mjs';
import { createStepBackProvider, STEP_BACK_ARM_MODELS, STEP_BACK_MAX_OUTPUT_TOKENS, STEP_BACK_GEMINI_THINKING_BUDGET, STEP_BACK_GEMINI_MAX_OUTPUT_TOKENS } from '../scripts/lib/audit/step-back-provider.mjs';
import { runStepBack, initialStepBackRecord } from '../scripts/lib/audit/step-back.mjs';
import { main } from '../scripts/step-back-replay.mjs';

const at = (h) => `2026-11-20T${String(h).padStart(2, '0')}:00:00.000Z`;
const SHA = (c) => c.repeat(40);
const GOOD = '{"action":"structural","files":["src/a.mjs"]}';

function world() {
  const runs = [1, 2, 3].map((n) => ({ id: `r${n}`, branch: 'bb', audited_sha: SHA(String(n)), created_at: at(9 + n), plan_file: 'plan.md' }));
  const findings = [{ id: 'F1', run_id: 'r1', finding_fingerprint: 'fp1', severity: 'HIGH', category: 'c', primary_file: 'src/a.mjs', detail_snapshot: 'd', round_raised: 1, created_at: at(10) }];
  const exp = { version: 1, since: '2026-11-19', branches: ['bb'], runs, findings, events: [] };
  const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
  const inputs = { exportSha256: sha('EXPORT-BYTES'), specPath: 'spec.json', specSha256: sha('SPEC-BYTES') };
  const { dataset, scoring } = freezeFromExport({ exp, exportPath: 'x.json', inputs, spec: { prs: [{ pr: 1, label: 'bad', branch: 'bb', runIds: ['r1', 'r2', 'r3'] }] } });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-v2-'));
  const dsPath = path.join(dir, 'dataset.json');
  fs.writeFileSync(dsPath, JSON.stringify(dataset));
  fs.mkdirSync(path.join(dir, 'scoring'));
  fs.writeFileSync(scoringPathFor(dsPath), JSON.stringify(scoring));
  const files = [{ path: 'src/a.mjs', oid: 'o1', body: 'export const a = 1;\n' }, { path: 'plan.md', oid: 'o2', body: '# plan\n' }];
  const tree = `${files.map((f) => `100644 blob ${f.oid}\t${f.path}`).join('\0')}\0`;
  const openRevision = ({ sha: s }) => createRevisionFs({ sha: s, git: (a) => (a[0] === 'ls-tree' ? { status: 0, stdout: tree } : { status: 1, stdout: '' }), readBatch: (o) => new Map(files.filter((f) => o.includes(f.oid)).map((f) => [f.oid, f.body])) });
  const readBytes = (p) => (p === 'x.json' ? Buffer.from('EXPORT-BYTES') : p === 'spec.json' ? Buffer.from('SPEC-BYTES') : fs.readFileSync(p));
  return { dir, dsPath, dataset, scoring, exp, openRevision, readBytes };
}

// ---- 1. Gemini instrument defect -------------------------------------------------------------

test('gemini: explicit thinking config, output cap covers thinking + answer, ceiling is the real cap', async () => {
  let seen;
  const ai = { models: { generateContent: async (a) => { seen = a; return { text: GOOD, candidates: [{ finishReason: 'STOP' }], usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 2 } }; } } };
  const p = createStepBackProvider('different', { client: ai, resolve: (m) => m });
  const r = await p.call({ system: 's', user: 'u' });
  assert.deepEqual(seen.config.thinkingConfig, { thinkingBudget: STEP_BACK_GEMINI_THINKING_BUDGET, includeThoughts: false });
  assert.equal(seen.config.maxOutputTokens, STEP_BACK_GEMINI_THINKING_BUDGET + STEP_BACK_MAX_OUTPUT_TOKENS);
  assert.ok(STEP_BACK_GEMINI_THINKING_BUDGET < seen.config.maxOutputTokens / 2 + 1);
  assert.equal(p.outputCeilingTokens, seen.config.maxOutputTokens);
  assert.equal(r.truncated, false);
});

test('gemini: a MAX_TOKENS reply is truncated:true and replays as an instrument failure, not an invalid answer', async () => {
  const ai = { models: { generateContent: async () => ({ text: '{"action":"struct', candidates: [{ finishReason: 'MAX_TOKENS' }], usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 7000 } }) } };
  const p = createStepBackProvider('different', { client: ai, resolve: (m) => m });
  const r = await p.call({ system: 's', user: 'u' });
  assert.equal(r.truncated, true);
  const out = await runStepBack({ record: initialStepBackRecord({ round: 3, signals: { anyFires: true, unmeasured: [] } }), pack: { text: 'P', topics: null }, provider: p.call });
  assert.equal(out.truncated, true);
  assert.notEqual(out.record.state, 'step-back-invalid');
  const w = world();
  const res = await runReplay({ dataset: w.dataset, arms: ['different'], maxUsd: 5, deps: { readExport: () => w.exp, openRevision: w.openRevision, makeProvider: () => ({ model: 'gemini-3.1-pro-preview', call: p.call, outputCeilingTokens: p.outputCeilingTokens }) } });
  assert.equal(res.calls[0].status, 'truncated');
  assert.equal(res.calls[0].truncated, true);
  const score = scoreReplay({ calls: res.calls, truth: w.scoring.truth, arms: ['different'], plan: res.plan });
  assert.equal(score.arms.different.truncated, 1);
  assert.equal(score.arms.different.invalidOutputs, 0);
  assert.equal(score.arms.different.complete, false);
  assert.match(score.arms.different.verdict, /incomplete/);
});

// ---- 2. higher arm ---------------------------------------------------------------------------

test('higher: latest-opus sentinel, listed as an arm', () => {
  assert.equal(STEP_BACK_ARM_MODELS.higher, 'latest-opus');
  assert.ok(REPLAY_ARMS.includes('higher'));
});

test('higher: sdk unavailable => unmeasured with a reason, NO client constructed, NO call', async () => {
  let constructed = 0;
  const p = createStepBackProvider('higher', { resolve: (m) => m, createClient: async () => { constructed++; return {}; }, sdkAvailability: () => ({ available: false, error: null }) });
  assert.match(p.unmeasuredReason, /sdk backend unavailable/);
  await assert.rejects(() => p.call({ system: 's', user: 'u' }), /unavailable/);
  assert.equal(constructed, 0);

  const w = world(); const records = [];
  const res = await runReplay({ dataset: w.dataset, arms: ['higher'], maxUsd: 5, deps: { readExport: () => w.exp, openRevision: w.openRevision, onRecord: (r) => records.push(r), providerSeams: { resolve: (m) => m, createClient: async () => { constructed++; return {}; }, sdkAvailability: () => ({ available: false, error: null }) } } });
  assert.equal(constructed, 0);
  assert.equal(res.calls.length, 0);
  assert.match(res.unmeasured.higher, /sdk backend unavailable/);
  assert.equal(records.find((r) => r.type === 'unmeasured').arm, 'higher');
  const parsed = readResultsJsonl(records.map((r) => JSON.stringify(r)).join('\n'));
  const score = scoreReplay({ calls: parsed.calls, truth: w.scoring.truth, arms: ['higher'], plan: parsed.plan, unmeasured: parsed.unmeasured });
  assert.equal(score.arms.higher.unmeasured, true);
  assert.match(score.arms.higher.verdict, /^unmeasured/);
});

test('higher: sdk available => the client is built with backend sdk and messages.create carries a system prompt', async () => {
  let opts; let req;
  const client = { messages: { create: async (r) => { req = r; return { content: [{ type: 'text', text: GOOD }], stop_reason: 'end_turn', usage: { input_tokens: 11, output_tokens: 4 } }; } } };
  const p = createStepBackProvider('higher', { resolve: (m) => `resolved:${m}`, createClient: async (o) => { opts = o; return client; }, sdkAvailability: () => ({ available: true, error: null }) });
  assert.equal(p.unmeasuredReason, undefined);
  const r = await p.call({ system: 'SYS', user: 'USR' });
  assert.deepEqual(opts, { backend: 'sdk' });
  assert.equal(req.system, 'SYS');
  assert.equal(req.model, 'resolved:latest-opus');
  assert.equal(req.max_tokens, STEP_BACK_MAX_OUTPUT_TOKENS);
  assert.equal(r.text, GOOD); assert.equal(r.truncated, false); assert.equal(r.usage.input_tokens, 11);
  const cut = createStepBackProvider('higher', { resolve: (m) => m, client: { messages: { create: async () => ({ content: [{ type: 'text', text: '{' }], stop_reason: 'max_tokens', usage: { input_tokens: 1, output_tokens: 1 } }) } }, sdkAvailability: () => ({ available: true, error: null }) });
  assert.equal((await cut.call({ system: 's', user: 'u' })).truncated, true);
});

// ---- 3. cost is a first-class result --------------------------------------------------------

test('cost: per-arm totals, per-call tokens, $/early stop, null when no stops, per-checkpoint cost next to action', async () => {
  const w = world();
  const usage = { input_tokens: 2000, output_tokens: 500 };
  const makeProvider = (arm) => ({ model: 'gpt-5.5', call: async () => ({ text: arm === 'same' ? GOOD : '{"action":"continue"}', usage }) });
  const res = await runReplay({ dataset: w.dataset, arms: ['none', 'same', 'different'], maxUsd: 5, deps: { readExport: () => w.exp, openRevision: w.openRevision, makeProvider } });
  const score = scoreReplay({ calls: res.calls, truth: w.scoring.truth, arms: ['none', 'same', 'different'], plan: res.plan });
  const perCall = (2000 * 5 + 500 * 30) / 1e6;
  const same = score.arms.same.cost;
  assert.equal(score.arms.same.earlyStops, 1);
  assert.ok(Math.abs(same.totalUsd - perCall * same.calls) < 1e-12);
  assert.equal(same.inputTokens, 2000 * same.calls);
  assert.equal(same.outputTokens, 500 * same.calls);
  assert.ok(Math.abs(same.costPerEarlyStop - same.totalUsd) < 1e-12);
  assert.equal(same.costPerFalseStop, null);
  assert.ok(Math.abs(same.costPerValidDecision - same.totalUsd / same.valid) < 1e-12);
  assert.equal(same.perCheckpoint[0].action, 'structural');
  assert.equal(same.perCheckpoint[0].costUsd, perCall);
  const diff = score.arms.different.cost;
  assert.equal(diff.costPerEarlyStop, null);
  assert.equal(score.arms.none.cost.totalUsd, 0);
  const table = renderScoreTable(score, { same: 'gpt-5.5', different: 'gpt-5.5' });
  assert.match(table.split('\n')[0], /arm +\| model +\| calls +\| valid +\| early +\| false +\| invalid +\| truncated +\| USD +\| \$\/early stop +\| \$\/false stop/);
  assert.match(table, /same +\| gpt-5\.5/);
});

// ---- 4. --arms and dry-run ------------------------------------------------------------------

test('dry-run: per-arm planned calls and bounds, and the "higher arm: sdk available" line; no call', async () => {
  const w = world(); let calls = 0;
  const makeProvider = (arm) => ({ model: arm === 'higher' ? 'claude-opus-5-5' : 'gpt-5.5', call: async () => { calls++; return { text: GOOD }; } });
  const lines = []; const orig = console.log; console.log = (...a) => lines.push(a.join(' '));
  let code;
  try { code = await main(['run', '--dataset', w.dsPath, '--arms', 'none,same,different,higher', '--dry-run'], { readExport: () => w.exp, readBytes: w.readBytes, openRevision: w.openRevision, makeProvider, sdkAvailable: false }); } finally { console.log = orig; }
  assert.equal(code, 0); assert.equal(calls, 0);
  const text = lines.join('\n');
  assert.match(text, /arm higher: model=claude-opus-5-5 planned calls 1, upper bound \$/);
  assert.match(text, /arm same: model=gpt-5\.5 planned calls 1/);
  assert.match(text, /higher arm: sdk available = false/);
  assert.match(renderDryRun({ plan: [], unrecoverable: [], estimatedUsd: 0, sdkAvailable: true }), /higher arm: sdk available = true/);
});

test('--arms rejects an unknown arm; higher is accepted', async () => {
  const w = world();
  await assert.rejects(() => main(['run', '--dataset', w.dsPath, '--arms', 'none,bogus', '--dry-run'], { readBytes: w.readBytes }), /unknown arm "bogus"/);
});

// ---- 5. adoption rule unchanged -------------------------------------------------------------

test('adoption rule unchanged: falseStops 0 and earlyStops >= 2', () => {
  const truth = { 1: { label: 'bad', acceptedHighRounds: [1] }, 2: { label: 'bad', acceptedHighRounds: [1] } };
  const mk = (pr) => ({ pr, checkpoint: 3, arm: 'higher', status: 'ok', action: 'stop', costUsd: 0.1, inputTokens: 10, outputTokens: 5 });
  const plan = [1, 2].map((pr) => ({ pr, checkpoint: 3, arm: 'higher' }));
  assert.equal(scoreReplay({ calls: [mk(1), mk(2)], truth, arms: ['higher'], plan }).arms.higher.verdict, 'adopted');
  assert.equal(scoreReplay({ calls: [mk(1)], truth, arms: ['higher'], plan: plan.slice(0, 1) }).arms.higher.verdict, 'not adopted');
});
