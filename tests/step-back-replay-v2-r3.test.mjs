import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { freezeFromExport } from '../scripts/lib/audit/step-back-export.mjs';
import { scoringPathFor } from '../scripts/lib/audit/step-back-dataset.mjs';
import { createRevisionFs } from '../scripts/lib/audit/step-back-gitfs.mjs';
import { runReplay, readResultsJsonl } from '../scripts/lib/audit/step-back-replay.mjs';
import { createStepBackProvider } from '../scripts/lib/audit/step-back-provider.mjs';
import { main } from '../scripts/step-back-replay.mjs';

const at = (h) => `2026-11-20T${String(h).padStart(2, '0')}:00:00.000Z`;
const SHA = (c) => c.repeat(40);
const GOOD = '{"action":"structural","files":["src/a.mjs"]}';
const U = { input_tokens: 10, output_tokens: 10 };

/** Two PRs so a run has several planned calls (3 runs each => one R3 checkpoint per PR). */
function world() {
  const runs = [1, 2, 3, 4, 5, 6].map((n) => ({ id: `r${n}`, branch: n <= 3 ? 'bb' : 'cc', audited_sha: SHA(String(n)), created_at: at(8 + n), plan_file: 'plan.md' }));
  const exp = { version: 1, since: '2026-11-19', branches: ['bb', 'cc'], runs, findings: [], events: [] };
  const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
  const inputs = { exportSha256: sha('EXPORT-BYTES'), specPath: 'spec.json', specSha256: sha('SPEC-BYTES') };
  const { dataset, scoring } = freezeFromExport({ exp, exportPath: 'x.json', inputs, spec: { prs: [
    { pr: 1, label: 'bad', branch: 'bb', runIds: ['r1', 'r2', 'r3'] }, { pr: 2, label: 'bad', branch: 'cc', runIds: ['r4', 'r5', 'r6'] }] } });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-v2r3-'));
  const dsPath = path.join(dir, 'dataset.json');
  fs.writeFileSync(dsPath, JSON.stringify(dataset));
  fs.mkdirSync(path.join(dir, 'scoring'));
  fs.writeFileSync(scoringPathFor(dsPath), JSON.stringify(scoring));
  const files = [{ path: 'src/a.mjs', oid: 'o1', body: 'export const a = 1;\n' }, { path: 'plan.md', oid: 'o2', body: '# plan\n' }];
  const tree = `${files.map((f) => `100644 blob ${f.oid}\t${f.path}`).join('\0')}\0`;
  const openRevision = ({ sha: s }) => createRevisionFs({ sha: s, git: (a) => (a[0] === 'ls-tree' ? { status: 0, stdout: tree } : { status: 1, stdout: '' }), readBatch: (o) => new Map(files.filter((f) => o.includes(f.oid)).map((f) => [f.oid, f.body])) });
  const readBytes = (p) => (p === 'x.json' ? Buffer.from('EXPORT-BYTES') : p === 'spec.json' ? Buffer.from('SPEC-BYTES') : fs.readFileSync(p));
  return { dir, dsPath, dataset, exp, openRevision, readBytes };
}

test('H2/M6/M7: a response with no completion state is a provider-failure (no-completion-state), never success', async () => {
  const gem = createStepBackProvider('different', { resolve: (m) => m, client: { models: { generateContent: async () => ({ text: GOOD, candidates: [{}], usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1 } }) } } });
  assert.match((await gem.call({ system: 's', user: 'u' })).failure, /no-completion-state/);
  const oai = createStepBackProvider('same', { resolve: (m) => m, client: { responses: { create: async () => ({ output_text: GOOD, usage: U }) } } });
  assert.match((await oai.call({ system: 's', user: 'u' })).failure, /no-completion-state/);
});

test('H3/M2: a 401 aborts the run: stopped record, no further calls for ANY arm, exit 1', async () => {
  const w = world(); let calls = 0;
  const makeProvider = () => ({ model: 'gpt-5.5', call: async () => { calls++; const e = new Error('invalid api key'); e.status = 401; e.code = 'invalid_api_key'; throw e; } });
  const res = await runReplay({ dataset: w.dataset, arms: ['same', 'different'], maxUsd: 50, deps: { readExport: () => w.exp, openRevision: w.openRevision, makeProvider } });
  assert.equal(calls, 1);
  assert.equal(res.stopped.reason, 'provider-auth-or-config: same 401');
  assert.equal(res.calls[0].status, 'provider-failure');
  assert.equal(res.calls[0].httpStatus, 401); assert.equal(res.calls[0].errorCode, 'invalid_api_key');
  assert.ok(res.calls.length > 1 && res.calls.slice(1).every((c) => c.status === 'skipped-aborted' && c.costUsd === 0));

  const results = path.join(w.dir, 'o.jsonl');
  const orig = console.log; console.log = () => {}; let code;
  try { code = await main(['run', '--dataset', w.dsPath, '--arms', 'same', '--max-usd', '50', '--confirm-spend', '--results', results], { readExport: () => w.exp, readBytes: w.readBytes, openRevision: w.openRevision, makeProvider }); } finally { console.log = orig; }
  assert.equal(code, 1);
  assert.equal(readResultsJsonl(fs.readFileSync(results, 'utf8')).stopped.reason, 'provider-auth-or-config: same 401');
});

test('H3/M2: 403 and 404 abort too; any other exception is a per-call provider-failure that keeps status and code and does not abort', async () => {
  for (const status of [403, 404]) {
    const w = world(); let calls = 0;
    const res = await runReplay({ dataset: w.dataset, arms: ['same'], maxUsd: 50, deps: { readExport: () => w.exp, openRevision: w.openRevision, makeProvider: () => ({ model: 'm', call: async () => { calls++; throw Object.assign(new Error('x'), { status }); } }) } });
    assert.equal(calls, 1); assert.match(res.stopped.reason, new RegExp(`provider-auth-or-config: same ${status}`));
  }
  const w = world(); let calls = 0;
  const res = await runReplay({ dataset: w.dataset, arms: ['same'], maxUsd: 50, deps: { readExport: () => w.exp, openRevision: w.openRevision, makeProvider: () => ({ model: 'gpt-5.5', call: async () => { calls++; throw Object.assign(new Error('overloaded'), { status: 529, code: 'overloaded' }); } }) } });
  assert.equal(calls, 2);
  assert.equal(res.stopped, null);
  assert.ok(res.calls.every((c) => c.status === 'provider-failure' && c.httpStatus === 529 && c.errorCode === 'overloaded'));
  assert.match(res.calls[0].error, /status 529, code overloaded/);
});
