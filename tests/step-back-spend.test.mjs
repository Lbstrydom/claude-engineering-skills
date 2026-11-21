import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { freezeFromExport } from '../scripts/lib/audit/step-back-export.mjs';
import { scoringPathFor } from '../scripts/lib/audit/step-back-dataset.mjs';
import { createRevisionFs } from '../scripts/lib/audit/step-back-gitfs.mjs';
import { runReplay, upperBoundUsd } from '../scripts/lib/audit/step-back-replay.mjs';
import crypto from 'node:crypto';
import { main, EXIT_BUDGET_STOP } from '../scripts/step-back-replay.mjs';

const at = (h) => `2026-11-20T${String(h).padStart(2, '0')}:00:00.000Z`;
const SHA = (c) => c.repeat(40);

function world() {
  const runs = [1, 2, 3].map((n) => ({ id: `r${n}`, branch: 'bb', audited_sha: SHA(String(n)), created_at: at(9 + n), plan_file: 'plan.md' }));
  const findings = [{ id: 'F1', run_id: 'r1', finding_fingerprint: 'fp1', severity: 'HIGH', category: 'c', primary_file: 'src/a.mjs', detail_snapshot: 'd', round_raised: 1, created_at: at(10) }];
  const exp = { version: 1, since: '2026-11-19', branches: ['bb'], runs, findings, events: [] };
  const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
  const inputs = { exportSha256: sha('EXPORT-BYTES'), specPath: 'spec.json', specSha256: sha('SPEC-BYTES') };
  const { dataset, scoring } = freezeFromExport({ exp, exportPath: 'x.json', inputs, spec: { prs: [{ pr: 1, label: 'bad', branch: 'bb', runIds: ['r1', 'r2', 'r3'] }] } });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-spend-'));
  const dsPath = path.join(dir, 'dataset.json');
  fs.writeFileSync(dsPath, JSON.stringify(dataset));
  fs.mkdirSync(path.join(dir, 'scoring'));
  fs.writeFileSync(scoringPathFor(dsPath), JSON.stringify(scoring));
  const files = [{ path: 'src/a.mjs', oid: 'o1', body: 'export const a = 1;\n' }, { path: 'plan.md', oid: 'o2', body: '# plan\n' }];
  const tree = `${files.map((f) => `100644 blob ${f.oid}\t${f.path}`).join('\0')}\0`;
  const openRevision = ({ sha }) => createRevisionFs({ sha, git: (a) => (a[0] === 'ls-tree' ? { status: 0, stdout: tree } : { status: 1, stdout: '' }), readBatch: (o) => new Map(files.filter((f) => o.includes(f.oid)).map((f) => [f.oid, f.body])) });
  const readBytes = (p) => (p === 'x.json' ? Buffer.from('EXPORT-BYTES') : p === 'spec.json' ? Buffer.from('SPEC-BYTES') : fs.readFileSync(p));
  return { dir, dsPath, dataset, exp, openRevision, readBytes };
}
const provider = (model, call) => ({ model, call });
const GOOD = '{"action":"structural","files":["src/a.mjs"]}';

test('H2: the preflight bound is chars/2 tokens at the input price plus the output ceiling at the output price', () => {
  // gpt-5.5: $5/M in, $30/M out. 30000 chars -> 15000 tokens -> $0.075 + 4000 x $30/M = $0.12 -> $0.195.
  assert.ok(Math.abs(upperBoundUsd({ modelId: 'gpt-5.5', inputChars: 30000, outputCeilingTokens: 4000 }) - 0.195) < 1e-9);
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
  const deps = { readExport: () => w.exp, readBytes: w.readBytes, openRevision: w.openRevision, makeProvider: () => provider('gpt-5.5', async () => ({ text: GOOD, usage: { input_tokens: 100, output_tokens: 50 } })) };
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
  try { code = await main(['run', '--dataset', w.dsPath, '--arms', 'same', '--max-usd', '0.05', '--confirm-spend', '--results', results], { readExport: () => w.exp, readBytes: w.readBytes, openRevision: w.openRevision, makeProvider: () => provider('gpt-5.5', async () => ({ text: GOOD })) }); } finally { console.log = orig; }
  assert.equal(code, EXIT_BUDGET_STOP);
  assert.match(fs.readFileSync(results, 'utf8'), /skipped-budget/);
});

test('R2-H6/H8: a paid run refuses an existing results path and never truncates it; nor an input path', async () => {
  const w = world();
  const deps = { readExport: () => w.exp, readBytes: w.readBytes, openRevision: w.openRevision, makeProvider: () => provider('gpt-5.5', async () => ({ text: GOOD })) };
  const results = path.join(w.dir, 'precious.jsonl');
  fs.writeFileSync(results, 'PAID-OUTPUT-FROM-AN-EARLIER-RUN\n');
  await assert.rejects(() => main(['run', '--dataset', w.dsPath, '--arms', 'same', '--max-usd', '5', '--confirm-spend', '--results', results], deps), /already exists/);
  assert.equal(fs.readFileSync(results, 'utf8'), 'PAID-OUTPUT-FROM-AN-EARLIER-RUN\n', 'untouched');
  await assert.rejects(() => main(['run', '--dataset', w.dsPath, '--arms', 'same', '--max-usd', '5', '--confirm-spend', '--results', w.dsPath], deps), /must not be the dataset/);
  assert.equal(JSON.parse(fs.readFileSync(w.dsPath, 'utf8')).source, 'store-export', 'the dataset survived');
});

test('R2-H3(freeze): duplicate PR numbers or duplicate (pr, checkpoint) pairs are refused', async () => {
  const w = world();
  const pr = { pr: 1, label: 'bad', branch: 'bb', runIds: ['r1', 'r2', 'r3'] };
  assert.throws(() => freezeFromExport({ exp: w.exp, exportPath: 'x', spec: { prs: [pr, { ...pr }] } }), /duplicate PR number #1/);
  const { assertNoDuplicates } = await import('../scripts/lib/audit/step-back-dataset.mjs');
  assert.throws(() => assertNoDuplicates([{ pr: 2, checkpoints: [{ checkpoint: 3 }, { checkpoint: 3 }] }]), /duplicate \(pr, checkpoint\) pair #2 R3/);
  await assert.rejects(() => runReplay({ dataset: { ...w.dataset, prs: [...w.dataset.prs, ...w.dataset.prs] }, arms: ['same'], dryRun: true, deps: { readExport: () => w.exp, openRevision: w.openRevision, makeProvider: () => provider('gpt-5.5', async () => ({})) } }), /duplicate PR number/);
});

test('R2-H1: run verifies the export and spec hashes recorded at freeze before any call', async () => {
  const w = world(); let calls = 0;
  const base = { readExport: () => w.exp, openRevision: w.openRevision, makeProvider: () => provider('gpt-5.5', async () => { calls++; return { text: GOOD }; }) };
  const args = ['run', '--dataset', w.dsPath, '--arms', 'same', '--dry-run'];
  assert.equal(await main(args, { ...base, readBytes: w.readBytes }), 0, 'matching bytes verify');
  const tampered = (p) => (p === 'x.json' ? Buffer.from('EXPORT-BYTES-EDITED') : w.readBytes(p));
  await assert.rejects(() => main(args, { ...base, readBytes: tampered }), /export file \(x\.json\) changed since the dataset was frozen/);
  const specEdited = (p) => (p === 'spec.json' ? Buffer.from('SPEC-EDITED') : w.readBytes(p));
  await assert.rejects(() => main(args, { ...base, readBytes: specEdited }), /spec file/);
  const unhashed = { ...w.dataset, inputs: null };
  const p2 = path.join(w.dir, 'unhashed.json'); fs.writeFileSync(p2, JSON.stringify(unhashed));
  await assert.rejects(() => main(['run', '--dataset', p2, '--arms', 'same', '--dry-run'], { ...base, readBytes: w.readBytes }), /records no input hashes/);
  assert.equal(calls, 0);
});

test('R3-H2/H3/M2: completeness compares planned vs completed IDENTITIES; a stop with no ground truth blocks adoption', async () => {
  const { scoreReplay } = await import('../scripts/lib/audit/step-back-replay.mjs');
  const truth = { 1: { label: 'bad', acceptedHighRounds: [1] }, 2: { label: 'bad', acceptedHighRounds: [1] }, 3: { label: 'bad', acceptedHighRounds: [1] } };
  const plan = [{ arm: 'same', pr: 1, checkpoint: 3 }, { arm: 'same', pr: 2, checkpoint: 3 }, { arm: 'same', pr: 3, checkpoint: 3 }];
  const c = (pr, action = 'stop', status = 'ok') => ({ arm: 'same', pr, checkpoint: 3, action, status });
  const full = scoreReplay({ calls: [c(1), c(2), c(3)], truth, arms: ['same'], plan });
  assert.deepEqual([full.arms.same.complete, full.arms.same.verdict], [true, 'adopted']);
  // Same COUNT (3 completed of 3 planned) but PR 3 is missing and PR 1 appears twice: incomplete.
  const dup = scoreReplay({ calls: [c(1), c(1), c(2)], truth, arms: ['same'], plan });
  assert.equal(dup.arms.same.complete, false);
  assert.equal(dup.arms.same.verdict, 'incomplete (not adopted)');
  // An extra identity outside the plan is incomplete too.
  const extra = scoreReplay({ calls: [c(1), c(2), c(3), c(9)], truth, arms: ['same'], plan });
  assert.equal(extra.arms.same.complete, false);
  // A stop on a PR with no ground-truth entry blocks adoption.
  const noTruth = scoreReplay({ calls: [c(1), c(2), c(3)], truth: { 1: truth[1], 2: truth[2] }, arms: ['same'], plan });
  assert.deepEqual([noTruth.arms.same.complete, noTruth.arms.same.missingTruth, noTruth.arms.same.verdict], [false, true, 'incomplete (not adopted)']);
});

test('R3-H6: freeze refuses a run id repeated within a PR or pinned to two PRs', async () => {
  const { assertNoDuplicates } = await import('../scripts/lib/audit/step-back-dataset.mjs');
  assert.throws(() => assertNoDuplicates([{ pr: 1, runIds: ['a', 'b', 'a'] }]), /run id a is repeated within PR #1/);
  assert.throws(() => assertNoDuplicates([{ pr: 1, runIds: ['a'] }, { pr: 2, runIds: ['b', 'a'] }]), /pinned to both PR #1 and PR #2/);
  assertNoDuplicates([{ pr: 1, runIds: ['a'] }, { pr: 2, runIds: ['b'] }]);
});

test('R3-H7: score --out refuses the results file it reads and every input', async () => {
  const w = world();
  const results = path.join(w.dir, 'calls.jsonl');
  const deps = { readExport: () => w.exp, readBytes: w.readBytes, openRevision: w.openRevision, makeProvider: () => provider('gpt-5.5', async () => ({ text: GOOD, usage: { input_tokens: 1, output_tokens: 1 } })) };
  const orig = console.log; console.log = () => {};
  try {
    await main(['run', '--dataset', w.dsPath, '--arms', 'same', '--max-usd', '5', '--confirm-spend', '--results', results], deps);
    const before = fs.readFileSync(results, 'utf8');
    for (const bad of [results, w.dsPath, scoringPathFor(w.dsPath)]) {
      await assert.rejects(() => main(['score', '--dataset', w.dsPath, '--results', results, '--out', bad]), /--out must not be/);
    }
    assert.equal(fs.readFileSync(results, 'utf8'), before, 'the results file was not touched');
  } finally { console.log = orig; }
});
