import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { freezeFromExport } from '../scripts/lib/audit/step-back-export.mjs';
import { scoringPathFor } from '../scripts/lib/audit/step-back-dataset.mjs';
import { createRevisionFs } from '../scripts/lib/audit/step-back-gitfs.mjs';
import { runReplay, scoreReplay, readResultsJsonl, renderScoreTable } from '../scripts/lib/audit/step-back-replay.mjs';
import { createStepBackProvider } from '../scripts/lib/audit/step-back-provider.mjs';
import { isCount } from '../scripts/lib/gemini-usage.mjs';
import { main, EXIT_BUDGET_STOP } from '../scripts/step-back-replay.mjs';

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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-v2r2-'));
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
const U = { input_tokens: 10, output_tokens: 10 };

test('H5: a FINAL call that overruns the cap stops the run (over-cap-after-call) and exits 5', async () => {
  const w = world();
  // bound ~0.12 fits a $0.2 cap, the call MEASURES $0.30 (10000 out @ $30/M): spent > cap after the only call.
  const makeProvider = () => ({ model: 'gpt-5.5', call: async () => ({ text: GOOD, usage: { input_tokens: 0, output_tokens: 10000 } }) });
  const res = await runReplay({ dataset: w.dataset, arms: ['same'], maxUsd: 0.2, deps: { readExport: () => w.exp, openRevision: w.openRevision, makeProvider } });
  assert.equal(res.calls.length, 1);
  assert.equal(res.stopped.reason, 'over-cap-after-call');
  const results = path.join(w.dir, 'o.jsonl');
  const orig = console.log; console.log = () => {};
  let code;
  try { code = await main(['run', '--dataset', w.dsPath, '--arms', 'same', '--max-usd', '0.2', '--confirm-spend', '--results', results], { readExport: () => w.exp, readBytes: w.readBytes, openRevision: w.openRevision, makeProvider }); } finally { console.log = orig; }
  assert.equal(code, EXIT_BUDGET_STOP);
  assert.equal(readResultsJsonl(fs.readFileSync(results, 'utf8')).stopped.reason, 'over-cap-after-call');
});

test('H3: every provider reports a non-success response as `failure`, and the replay never parses it as a decision', async () => {
  const gem = (r) => createStepBackProvider('different', { resolve: (m) => m, client: { models: { generateContent: async () => r } } });
  const um = { promptTokenCount: 1, candidatesTokenCount: 1 };
  assert.match((await gem({ text: GOOD, promptFeedback: { blockReason: 'SAFETY' }, candidates: [], usageMetadata: um }).call({ system: 's', user: 'u' })).failure, /blocked.*SAFETY/);
  assert.match((await gem({ text: GOOD, candidates: [], usageMetadata: um }).call({ system: 's', user: 'u' })).failure, /empty candidate/);
  assert.match((await gem({ text: GOOD, candidates: [{ finishReason: 'SAFETY' }], usageMetadata: um }).call({ system: 's', user: 'u' })).failure, /finishReason SAFETY/);
  assert.equal((await gem({ text: GOOD, candidates: [{ finishReason: 'STOP' }], usageMetadata: um }).call({ system: 's', user: 'u' })).failure, null);
  const ant = (stop) => createStepBackProvider('higher', { resolve: (m) => m, sdkAvailability: () => ({ available: true, error: null }), client: { messages: { create: async () => ({ content: [{ type: 'text', text: GOOD }], stop_reason: stop, usage: U }) } } });
  assert.match((await ant('refusal').call({ system: 's', user: 'u' })).failure, /refusal/);
  assert.equal((await ant('end_turn').call({ system: 's', user: 'u' })).failure, null);
  const oai = (r) => createStepBackProvider('same', { resolve: (m) => m, client: { responses: { create: async () => ({ output_text: GOOD, usage: U, ...r }) } } });
  assert.match((await oai({ status: 'incomplete', incomplete_details: { reason: 'content_filter' } }).call({ system: 's', user: 'u' })).failure, /content_filter/);
  assert.equal((await oai({ status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' } }).call({ system: 's', user: 'u' })).failure, null);
  assert.equal((await oai({ status: 'completed' }).call({ system: 's', user: 'u' })).failure, null);

  const w = world();
  const bad = gem({ text: GOOD, candidates: [{ finishReason: 'SAFETY' }], usageMetadata: um });
  const res = await runReplay({ dataset: w.dataset, arms: ['different'], maxUsd: 5, deps: { readExport: () => w.exp, openRevision: w.openRevision, makeProvider: () => ({ model: 'gemini-x', call: bad.call }) } });
  assert.equal(res.calls[0].status, 'provider-failure');
  assert.match(res.calls[0].error, /SAFETY/);
  assert.equal(res.calls[0].action, null);
  const s = scoreReplay({ calls: res.calls, truth: w.scoring.truth, arms: ['different'], plan: res.plan });
  assert.equal(s.arms.different.complete, false);
  assert.equal(s.arms.different.providerFailures, 1);
  assert.equal(s.arms.different.earlyStops, 0);
});

test('M1/M3/M4: token totals skip missing-usage calls; measured vs estimated USD, callsWithMissingUsage, basis column, costBasis per checkpoint', async () => {
  const w = world();
  let n = 0;
  const makeProvider = () => ({ model: 'gpt-5.5', call: async () => { n++; return { text: GOOD, usage: n === 1 ? { input_tokens: 1000, output_tokens: 100, usageMissing: false } : { input_tokens: 0, output_tokens: 0, usageMissing: true } }; } });
  const dataset = w.dataset;
  const res = await runReplay({ dataset, arms: ['same'], maxUsd: 5, deps: { readExport: () => w.exp, openRevision: w.openRevision, makeProvider } });
  // synthesize a second checkpoint from the same call to exercise mixed basis
  const mixed = [res.calls[0], { ...res.calls[0], checkpoint: 6, spendSource: 'upper-bound', costUsd: 0.2, inputTokens: null, outputTokens: null }];
  const plan = mixed.map((c) => ({ pr: c.pr, checkpoint: c.checkpoint, arm: 'same' }));
  const s = scoreReplay({ calls: mixed, truth: w.scoring.truth, arms: ['same'], plan });
  const c = s.arms.same.cost;
  assert.equal(c.inputTokens, 1000); assert.equal(c.outputTokens, 100);
  assert.equal(c.callsWithMissingUsage, 1);
  assert.ok(Math.abs(c.estimatedUsd - 0.2) < 1e-12);
  assert.ok(Math.abs(c.measuredUsd + c.estimatedUsd - c.totalUsd) < 1e-12);
  assert.deepEqual(c.perCheckpoint.map((p) => p.costBasis), ['measured', 'bound']);
  assert.match(c.basis, /^mixed/);
  assert.match(renderScoreTable(s, { same: 'gpt-5.5' }), /basis/);
});

test('H1/M2: appendDurably loops short writes until every byte is out, then fsyncs', async () => {
  const w = world();
  const results = path.join(w.dir, 'short.jsonl');
  const realWrite = fs.writeSync; const realFsync = fs.fsyncSync; let shorts = 0; let synced = 0;
  fs.writeSync = (fd, buf, off, len, ...r) => { if (Buffer.isBuffer(buf) && len > 1) { shorts++; return realWrite(fd, buf, off, 1); } return realWrite(fd, buf, off, len, ...r); };
  fs.fsyncSync = (fd) => { synced++; return realFsync(fd); };
  const orig = console.log; console.log = () => {};
  try {
    await main(['run', '--dataset', w.dsPath, '--arms', 'same', '--max-usd', '5', '--confirm-spend', '--results', results], { readExport: () => w.exp, readBytes: w.readBytes, openRevision: w.openRevision, makeProvider: () => ({ model: 'gpt-5.5', call: async () => ({ text: GOOD, usage: U }) }) });
  } finally { console.log = orig; fs.writeSync = realWrite; fs.fsyncSync = realFsync; }
  assert.ok(shorts > 0 && synced > 0);
  const lines = fs.readFileSync(results, 'utf8').trim().split('\n');
  for (const l of lines) JSON.parse(l); // every record intact despite 1-byte writes
});

test('M5: only a torn FINAL line is tolerated (and reported); a torn middle line is an error', () => {
  const good = JSON.stringify({ type: 'plan', plan: [], maxUsd: 1, arms: ['same'] });
  const call = JSON.stringify({ type: 'call', pr: 1, checkpoint: 3, arm: 'same', status: 'ok', costUsd: 0.1 });
  const torn = readResultsJsonl(`${good}\n${call}\n{"type":"call","pr":2,"chec`);
  assert.equal(torn.tornFinalRecord, true);
  assert.equal(torn.calls.length, 1);
  assert.equal(readResultsJsonl(`${good}\n${call}\n`).tornFinalRecord, false);
  assert.throws(() => readResultsJsonl(`${good}\n{"type":"call","pr":2,"chec\n${call}\n`), /not valid JSON/);
  assert.throws(() => readResultsJsonl(`${good}\n${call}\n{"torn":\n`), /not valid JSON/); // newline-terminated bad last line is not a torn write
});

test('M6: the provider reuses the single isCount from gemini-usage', () => {
  assert.equal(isCount(0), true); assert.equal(isCount('1'), false);
  assert.equal(/const isCount\s*=|function isCount/.test(fs.readFileSync('scripts/lib/audit/step-back-provider.mjs', 'utf8')), false);
});
