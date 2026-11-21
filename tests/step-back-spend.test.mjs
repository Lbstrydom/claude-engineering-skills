import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { freezeFromExport } from '../scripts/lib/audit/step-back-export.mjs';
import { scoringPathFor } from '../scripts/lib/audit/step-back-dataset.mjs';
import { createRevisionFs } from '../scripts/lib/audit/step-back-gitfs.mjs';
import { runReplay, upperBoundUsd } from '../scripts/lib/audit/step-back-replay.mjs';
import { main, EXIT_BUDGET_STOP } from '../scripts/step-back-replay.mjs';

const at = (h) => `2026-11-20T${String(h).padStart(2, '0')}:00:00.000Z`;
const SHA = (c) => c.repeat(40);

function world() {
  const runs = [1, 2, 3].map((n) => ({ id: `r${n}`, branch: 'bb', audited_sha: SHA(String(n)), created_at: at(9 + n), plan_file: 'plan.md' }));
  const findings = [{ id: 'F1', run_id: 'r1', finding_fingerprint: 'fp1', severity: 'HIGH', category: 'c', primary_file: 'src/a.mjs', detail_snapshot: 'd', round_raised: 1, created_at: at(10) }];
  const exp = { version: 1, since: '2026-11-19', branches: ['bb'], runs, findings, events: [] };
  const { dataset, scoring } = freezeFromExport({ exp, exportPath: 'x.json', spec: { prs: [{ pr: 1, label: 'bad', branch: 'bb', runIds: ['r1', 'r2', 'r3'] }] } });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-spend-'));
  const dsPath = path.join(dir, 'dataset.json');
  fs.writeFileSync(dsPath, JSON.stringify(dataset));
  fs.mkdirSync(path.join(dir, 'scoring'));
  fs.writeFileSync(scoringPathFor(dsPath), JSON.stringify(scoring));
  const files = [{ path: 'src/a.mjs', oid: 'o1', body: 'export const a = 1;\n' }, { path: 'plan.md', oid: 'o2', body: '# plan\n' }];
  const tree = `${files.map((f) => `100644 blob ${f.oid}\t${f.path}`).join('\0')}\0`;
  const openRevision = ({ sha }) => createRevisionFs({ sha, git: (a) => (a[0] === 'ls-tree' ? { status: 0, stdout: tree } : { status: 1, stdout: '' }), readBatch: (o) => new Map(files.filter((f) => o.includes(f.oid)).map((f) => [f.oid, f.body])) });
  return { dir, dsPath, dataset, exp, openRevision };
}
const provider = (model, call) => ({ model, call });
const GOOD = '{"action":"structural","files":["src/a.mjs"]}';

test('H5: the upper bound is chars/3 tokens at the input price plus the output ceiling at the output price', () => {
  // gpt-5.5: $5/M in, $30/M out. 30000 chars -> 10000 tokens -> $0.05 + 4000 x $30/M = $0.12 -> $0.17.
  assert.ok(Math.abs(upperBoundUsd({ modelId: 'gpt-5.5', inputChars: 30000, outputCeilingTokens: 4000 }) - 0.17) < 1e-9);
  // An unpriced model never gets a zero bound.
  assert.ok(upperBoundUsd({ modelId: 'no-such-model', inputChars: 3000 }) > 0);
});

test('H5/H15: the stop uses the UPPER bound: a call whose bound would cross the cap is never made, even when its real cost would not', async () => {
  const w = world(); let calls = 0;
  const makeProvider = () => provider('gpt-5.5', async () => { calls++; return { text: GOOD, usage: { input_tokens: 10, output_tokens: 10 } }; });
  // Each call costs ~$0.00 in reality but its bound is >= $0.12 (4000 output tokens at $30/M): a $0.10 cap forbids every call.
  const res = await runReplay({ dataset: w.dataset, arms: ['same'], maxUsd: 0.1, deps: { readExport: () => w.exp, openRevision: w.openRevision, makeProvider } });
  assert.equal(calls, 0);
  assert.equal(res.stopped.reason, 'max-usd');
});

test('H6/H16: a provider that returns NO usage is charged its upper bound, never $0; so is one that throws', async () => {
  const w = world();
  const none = await runReplay({ dataset: w.dataset, arms: ['same'], maxUsd: 5, deps: { readExport: () => w.exp, openRevision: w.openRevision, makeProvider: () => provider('gpt-5.5', async () => ({ text: GOOD })) } });
  assert.equal(none.calls.length, 1);
  assert.equal(none.calls[0].spendSource, 'upper-bound');
  assert.ok(none.calls[0].costUsd >= 0.12, `charged ${none.calls[0].costUsd}`);
  assert.equal(none.spentUsd, none.calls[0].costUsd);
  const thrown = await runReplay({ dataset: w.dataset, arms: ['same'], maxUsd: 5, deps: { readExport: () => w.exp, openRevision: w.openRevision, makeProvider: () => provider('gpt-5.5', async () => { throw new Error('socket closed'); }) } });
  assert.equal(thrown.calls[0].status, 'unavailable');
  assert.ok(thrown.calls[0].costUsd >= 0.12 && thrown.spentUsd === thrown.calls[0].costUsd);
  const flagged = await runReplay({ dataset: w.dataset, arms: ['same'], maxUsd: 5, deps: { readExport: () => w.exp, openRevision: w.openRevision, makeProvider: () => provider('gpt-5.5', async () => ({ text: GOOD, usage: { input_tokens: 1, output_tokens: 1, usageMissing: true } })) } });
  assert.equal(flagged.calls[0].spendSource, 'upper-bound');
});

test('H13/H18: every call is appended to the JSONL before scoring; a scoring failure loses nothing and `score` rescoring works', async () => {
  const w = world();
  const results = path.join(w.dir, 'calls.jsonl');
  const deps = { readExport: () => w.exp, openRevision: w.openRevision, makeProvider: () => provider('gpt-5.5', async () => ({ text: GOOD, usage: { input_tokens: 100, output_tokens: 50 } })) };
  const orig = console.log; console.log = () => {};
  try {
    await assert.rejects(() => main(['run', '--dataset', w.dsPath, '--arms', 'same', '--max-usd', '5', '--confirm-spend', '--results', results], { ...deps, readScoring: () => { throw new Error('scoring blew up'); } }), /scoring blew up/);
    const lines = fs.readFileSync(results, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    assert.equal(lines[0].type, 'plan');
    const call = lines.find((l) => l.type === 'call');
    assert.deepEqual([call.arm, call.checkpoint, call.action, call.status], ['same', 3, 'structural', 'ok']);
    assert.ok(call.usage.input_tokens === 100 && call.costUsd > 0, 'usage and charged cost are in the record');
    const out = path.join(w.dir, 'scores.json');
    assert.equal(await main(['score', '--dataset', w.dsPath, '--results', results, '--out', out]), 0);
    const scored = JSON.parse(fs.readFileSync(out, 'utf8'));
    assert.ok(scored.spentUsd > 0 && scored.score.arms.same);
  } finally { console.log = orig; }
});

test('budget stop through the CLI still exits 5 and leaves the skipped calls in the JSONL', async () => {
  const w = world(); const results = path.join(w.dir, 'c.jsonl');
  const orig = console.log; console.log = () => {};
  let code;
  try { code = await main(['run', '--dataset', w.dsPath, '--arms', 'same', '--max-usd', '0.05', '--confirm-spend', '--results', results], { readExport: () => w.exp, openRevision: w.openRevision, makeProvider: () => provider('gpt-5.5', async () => ({ text: GOOD })) }); } finally { console.log = orig; }
  assert.equal(code, EXIT_BUDGET_STOP);
  assert.match(fs.readFileSync(results, 'utf8'), /skipped-budget/);
});
