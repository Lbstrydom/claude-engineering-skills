import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadRecipientPolicy } from '../scripts/lib/solo-control/policy.mjs';
import { gateCellState } from '../scripts/lib/solo-control/completion.mjs';
import { _internals as soloCtl } from '../scripts/solo-control-audit.mjs';
import * as guards from '../scripts/lib/solo-control/run-guards.mjs';

const nullParse = { responses: { parse: async () => ({ output_parsed: null, usage: {} }) } };
const zodTextFormat = () => ({});

// H5
test('H5: an unparsed GPT gate review is not an ok cell (no clean-round clothes)', async () => {
  const r = await soloCtl.runGptGateReview(nullParse, zodTextFormat, 'gpt-x', [], 'diff --git a/x b/x\n+1\n');
  assert.notEqual(gateCellState(r), 'ok');
  assert.equal(r.state, 'conformance-miss');
});
test('H5: an unparsed 5-pass reply carries a conformance-miss state for the ledger row', async () => {
  const r = await soloCtl.runGptPass(nullParse, zodTextFormat, 'gpt-x', 'structure', 'diff --git a/x b/x\n+1\n', null);
  assert.equal(r.state, 'conformance-miss');
});

// H1
test('H1: authorizeAll refuses when ANY model recipient is not cleared for the repo', () => {
  const p = path.join(os.tmpdir(), `rg-policy-${process.pid}.json`);
  fs.writeFileSync(p, JSON.stringify({ repos: { 'github.com/x/r': ['openai'] } }));
  try {
    const policy = loadRecipientPolicy(p);
    assert.doesNotThrow(() => guards.authorizeAll(['gpt-6-astra'], 'github.com/x/r', policy));
    assert.throws(() => guards.authorizeAll(['gpt-6-astra', 'gemini-pro-latest'], 'github.com/x/r', policy), /REFUSED/);
  } finally { fs.rmSync(p, { force: true }); }
});

// H8
test('H8: a resumed run drops the partial findings of a commit it is about to re-run', () => {
  const prior = { findings: [{ commit: 'a' }, { commit: 'a' }, { commit: 'b' }], perCommit: [{ sha: 'a', state: 'budget-exceeded' }, { sha: 'b', state: 'ran' }] };
  const out = guards.resumedOut(prior, { force: false, fresh: null, rerunShas: ['a'], patch: { model: 'm' } });
  assert.deepEqual(out.findings.map((f) => f.commit), ['b']);
  assert.equal(out.model, 'm');
  assert.equal(guards.resumedOut(null, { force: false, fresh: 'F', rerunShas: [], patch: {} }), 'F');
});

// H7
const row = (id, detail, label = '') => ({ blindId: id, commit: 'c1', severity: 'HIGH', category: 'k', file: 'f', detail, label, proof: '', cluster: `x${id}`, matches: '', pattern: '' });
test('H7: a resumed grade is discarded when its blind_id now names a different finding', () => {
  const prior = [row('F001', 'finding X', 'proven'), row('F002', 'finding Y', 'false')];
  const current = [row('F001', 'finding Y'), row('F002', 'finding Y')];
  const { grades, discarded } = guards.seedResumedGrades(prior, current);
  assert.equal(grades.has('F001'), false);
  assert.equal(grades.get('F002').label, 'false');
  assert.equal(discarded, 1);
});

// H9
test('H9: the judge tag is namespaced by batch so c1 in batch 0 and batch 1 are distinct clusters', () => {
  const a = guards.qualifyBatchCluster({ blind_id: 'F001', cluster: 'c1' }, 'abc12345', 0);
  const b = guards.qualifyBatchCluster({ blind_id: 'F041', cluster: 'c1' }, 'abc12345', 1);
  assert.notEqual(a.cluster, b.cluster);
  assert.equal(guards.qualifyBatchCluster({ blind_id: 'F002', cluster: '' }, 'abc12345', 0).cluster, '');
});

// H10
test('H10: an all-invalid sheet has zero label coverage and is directional-only', () => {
  const coverage = guards.labelCoverage({ dataRows: 5, unlabeled: 0, invalid: 5 });
  assert.equal(coverage, 0);
  assert.equal(guards.decisionStatusFor({ coverage, invalid: 5, highNeedingProof: [] }), 'directional-only');
  assert.equal(guards.decisionStatusFor({ coverage: 1, invalid: 0, highNeedingProof: [] }), 'final');
  assert.equal(guards.decisionStatusFor({ coverage: 0.95, invalid: 1, highNeedingProof: [] }), 'directional-only');
});

// Wiring: the subcommands (not exported, need live clients) must call the guards.
test('wiring: solo-control-audit.mjs routes each decision through its guard', () => {
  const src = fs.readFileSync(new URL('../scripts/solo-control-audit.mjs', import.meta.url), 'utf8');
  assert.ok((src.match(/authorizeAll\(/g) || []).length >= 2, 'H1: both apparatus branches authorize');
  for (const fn of ['resumedOut(', 'seedResumedGrades(', 'qualifyBatchCluster(', 'labelCoverage(', 'decisionStatusFor(', 'splitApparatusGaps(']) assert.ok(src.includes(fn), fn);
  assert.match(src, /state: r\.state \?\? 'ok'/, 'H5: 5-pass cell state reflects the pass result');
});

// H11
test('H11: with gaps allowed, gap commits are not in the covered set that feeds the sheet', () => {
  const { gaps, covered } = guards.splitApparatusGaps(['a', 'b', 'c'], new Set(['a']), new Set(['c']));
  assert.deepEqual(gaps, ['b']);
  assert.deepEqual(covered, ['a', 'c']);
});
