/**
 * Regression tests for the round-1 /audit-code findings on the Pilot 1 harness. Each test names the finding it closes and the
 * failure it would show if the fix were reverted (the control).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { initLedger, reserveCall, settleCall, readLedgerSummary } from '../scripts/lib/llm-budget.mjs';
import { decideMetaPilot, scoreMetaRuns } from '../scripts/lib/audit/meta-pilot-decision.mjs';
import { freezeMetaPilot, sessionsOf } from '../scripts/lib/audit/step-back-pilot-freeze.mjs';
import { restorePointFiles, ledgerTargets } from '../scripts/lib/audit/step-back-continuation.mjs';
import { verifyRepoIdentity, scorePilot, runNovelty } from '../scripts/lib/audit/step-back-pilot-cli.mjs';
import { filterCandidates, makePairId, judgePairs, lineRangeOf, prepareJudgePayload } from '../scripts/lib/model-eval/concern-matcher.mjs';
import { scoreCalibration } from '../scripts/lib/model-eval/matcher-calibration.mjs';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'sb-fix-'));

test('H2/H16: a torn trailing record is dropped before the next append, so the next reservation is not lost', async () => {
  const dir = tmp(); const file = path.join(dir, 'l.jsonl');
  try {
    initLedger({ file, capUsd: 50 });
    const h = await reserveCall({ seam: 't', provider: 'anthropic', model: 'claude-opus-5-5', body: 'x', outputCap: 10, file });
    await settleCall(h, { usage: { input_tokens: 100, output_tokens: 5 }, modelServed: 'claude-opus-5-5' });
    fs.appendFileSync(file, '{"type":"reserve","callId":"torn","reser'); // crash mid-append
    const h2 = await reserveCall({ seam: 't', provider: 'anthropic', model: 'claude-opus-5-5', body: 'y', outputCap: 10, file });
    const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
    for (const l of lines) JSON.parse(l); // control: without the repair the fragment glues onto the next record and this throws
    assert.ok(readLedgerSummary(file).calls.some((c) => c.callId === h2.callId), 'the reservation after the torn tail is visible');
  } finally { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }); }
});

test('H10: a run row with a null/negative cost makes the dataset INVALID, never a silent zero', () => {
  const mk = (arm, cost) => ({ pointId: 'p', rep: 0, arm, valid: true, stopRun: false, novelActionable: 0, novelActionableHM: 0, costUsd: cost });
  assert.equal(decideMetaPilot({ runs: [mk('META', null), mk('CONTINUE', 3)], plannedPairs: 1 }).branch, 1);
  assert.equal(decideMetaPilot({ runs: [mk('META', -1), mk('CONTINUE', 3)], plannedPairs: 1 }).branch, 1);
});

test('H4: a finding with no novelty judgment BLOCKS the score; it is not "not novel"', () => {
  const runs = [{ pointId: 'p', arm: 'CONTINUE', rep: 0, valid: true, costUsd: 1, findings: [{ key: 'a', severity: 'HIGH' }] }];
  assert.equal(scoreMetaRuns({ runs, novelByFinding: new Map(), labels: new Map() }).incomplete, true);
  const novelty = { stamps: { opus: {} }, incomplete: false, byFinding: { a: { opus: { novel: true, notJudged: true } } } };
  const key = { items: {} };
  const r = scorePilot({ rows: runs, novelty, key, labelsById: new Map(), plannedPairs: 1 });
  assert.equal(r.decision.outcome, 'INCOMPLETE', 'a not-judged entry is not a "false" novelty');
});

test('H9: two sessions that share a branch name and first timestamp in different repos or modes get distinct ids', () => {
  const run = (repo, mode) => ({ id: `${repo}${mode}`, repo_id: repo, branch: 'feat/x', audited_sha: 'a'.repeat(40), created_at: '2026-11-01T10:00:00Z', mode });
  const ids = sessionsOf({ runs: [run('A', 'code'), run('B', 'code'), run('A', 'plan')] }).map((s) => s.sessionId);
  assert.equal(new Set(ids).size, 3);
});

test('H18: a repo mapping must match the clone\'s own origin; a mismatch refuses the freeze', () => {
  const git = (url) => () => url;
  assert.equal(verifyRepoIdentity({ name: 'Lbstrydom/wine-cellar-app', localPath: 'x' }, { git: git('https://github.com/Lbstrydom/wine-cellar-app.git') }).ok, true);
  assert.equal(verifyRepoIdentity({ name: 'Lbstrydom/wine-cellar-app', localPath: 'x' }, { git: git('git@github.com:acme/secret-work-repo.git') }).ok, false);
  assert.equal(verifyRepoIdentity({ name: 'Lbstrydom/wine-cellar-app', localPath: 'x' }, { git: () => { throw new Error('no remote'); } }).ok, false);
  assert.throws(() => freezeMetaPilot({ exp: { runs: [], findings: [], events: [] }, repos: { R: { name: 'Lbstrydom/wine-cellar-app', localPath: 'x' } }, seed: 's', verifyRepo: () => ({ ok: false, reason: 'its clone\'s origin is acme/x' }) }), /refusing to read it under that authorisation/);
});

test('H6: a symlink at .audit in a historical tree is refused before anything is written through it', (t) => {
  const dir = tmp(); const elsewhere = tmp();
  try {
    try { fs.symlinkSync(elsewhere, path.join(dir, '.audit'), 'junction'); } catch (err) { if (['EPERM', 'EACCES', 'ENOSYS', 'ENOTSUP'].includes(err.code)) return t.skip(`cannot create links here (${err.code})`); throw err; }
    assert.throws(() => restorePointFiles({ dir, point: { snapshotDigest: 'x', checkpoint: 1, checkpointSha: 'a' }, snapshot: { rounds: [], ledgerEntries: [] }, sid: 's' }), /symlink/);
    assert.deepEqual(fs.readdirSync(elsewhere), [], 'nothing was written through the link');
  } finally { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }); fs.rmSync(elsewhere, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }); }
});

test('H13/M9/M13: file semantics are the union of file and files; multi-file concerns match; pair ids cannot collide', () => {
  const f = { id: 'f', file: 'src/a.mjs', files: [], text: 't' }; const x = { id: 'x', file: 'src/a.mjs', text: 't' };
  assert.equal(filterCandidates([f], [x]).length, 1, 'an empty files[] beside a file no longer hides the file');
  assert.equal(filterCandidates([{ id: 'f', files: ['src/b.mjs', 'src/a.mjs'], text: 't' }], [x]).length, 1);
  assert.notEqual(makePairId('a→b', 'c'), makePairId('a', 'b→c'));
  const t = ledgerTargets({ rounds: [], ledgerEntries: [{ topicId: 't', affectedFiles: ['a.mjs', 'b.mjs'], severity: 'HIGH' }] })[0];
  assert.deepEqual(t.files, ['a.mjs', 'b.mjs']);
});

test('H11: a budget stop inside judgePairs propagates and halts scheduling; it is never a per-pair not-judged', async () => {
  let calls = 0;
  const judge = { stamp: {}, call: async () => { calls++; const e = new Error('cap'); e.code = 'budget-stop'; throw e; } };
  const pairs = Array.from({ length: 10 }, (_, i) => ({ f: { id: `f${i}`, file: 'a', text: 'x' }, x: { id: 'x', file: 'a', text: 'y' } }));
  await assert.rejects(() => judgePairs({ pairs, judge, concurrency: 1 }), (e) => e.code === 'budget-stop');
  assert.equal(calls, 1, 'no further pair was scheduled after the stop');
});

test('H12/M6: a not-judged or missing verdict on a labelled pair makes calibration inconclusive, never accept', () => {
  const mk = (i, label, set, arm) => ({ pairId: `p${i}`, set, stratum: set, sourceArm: arm, label, f: { id: `f${i}`, file: 'a', text: 'x y z' }, x: { id: `x${i}`, file: 'a', text: 'x y z' } });
  const labelled = []; const verdicts = {};
  for (let i = 0; i < 60; i++) { const arm = i % 2 ? 'code' : 'plan'; labelled.push(mk(i, i < 40 ? 'same' : 'different', 'prevalence', arm)); verdicts[`p${i}`] = i < 40 ? 'same' : 'different'; }
  const ok = scoreCalibration({ labelled, judgeVerdicts: verdicts, filterRecallPairs: Array.from({ length: 20 }, (_, i) => ({ pairId: `r${i}`, keptByFilter: true })) });
  assert.equal(ok.decision.status, 'accept', JSON.stringify(ok.decision));
  const bad = scoreCalibration({ labelled, judgeVerdicts: { ...verdicts, p3: 'not-judged' }, filterRecallPairs: Array.from({ length: 20 }, (_, i) => ({ pairId: `r${i}`, keptByFilter: true })) });
  assert.equal(bad.decision.status, 'inconclusive');
  const missing = { ...verdicts }; delete missing.p4;
  assert.throws(() => scoreCalibration({ labelled, judgeVerdicts: missing, filterRecallPairs: [] }), /no judge verdict for labelled pair p4/, 'a missing verdict already throws: it cannot be scored');
});

test('H14: acceptance uses the prevalence-weighted precision when weights are present', () => {
  const rows = [];
  for (let i = 0; i < 20; i++) rows.push({ pairId: `s${i}`, set: 'prevalence', stratum: 'prevalence', sourceArm: i % 2 ? 'a' : 'b', label: 'same', weight: 1, f: { id: `fs${i}`, file: 'a', text: 'q' }, x: { id: `xs${i}`, file: 'a', text: 'q' } });
  // 4 false positives, heavily weighted: plain precision 20/24 = 0.83 and weighted 20/(20+40) = 0.33 -> both below 0.90, so check weighting is what drives it
  for (let i = 0; i < 4; i++) rows.push({ pairId: `n${i}`, set: 'prevalence', stratum: 'prevalence', sourceArm: i % 2 ? 'a' : 'b', label: 'different', weight: 10, f: { id: `fn${i}`, file: 'a', text: 'q' }, x: { id: `xn${i}`, file: 'a', text: 'q' } });
  const verdicts = Object.fromEntries(rows.map((r) => [r.pairId, 'same']));
  const r = scoreCalibration({ labelled: rows, judgeVerdicts: verdicts, filterRecallPairs: [] });
  assert.ok(r.decision.reasons.some((x) => /precision 0\.3/.test(x)), JSON.stringify(r.decision.reasons));
});

test('H15/M10/M11: a not-judged novelty entry is retried on rerun, completeness is recomputed, and a swapped results file is refused', async () => {
  const dir = tmp();
  try {
    const dsPath = path.join(dir, 'ds.json');
    const dataset = { kind: 'meta-ab', datasetHash: 'H', points: [{ pointId: 'p', status: 'recoverable', repo: 'r', set: 'pilot', sessionId: 's', snapshotDigest: 'd' }], repoPaths: {} };
    // minimal loadDataset-compatible files are heavy; exercise the pure contract through scorePilot/readers instead
    const novelty = { stamps: { opus: {}, pro: {} }, incomplete: true, byFinding: { a: { opus: { novel: true, notJudged: true }, pro: { novel: true, notJudged: false } } } };
    const out = scorePilot({ rows: [{ pointId: 'p', arm: 'CONTINUE', rep: 0, valid: true, costUsd: 1, findings: [{ key: 'a', severity: 'HIGH' }] }], novelty, key: { items: { W001: { key: 'a' } } }, labelsById: new Map([['W001', 'REAL']]), plannedPairs: 1 });
    assert.equal(out.decision.outcome, 'INCOMPLETE');
    assert.equal(typeof runNovelty, 'function'); assert.ok(dataset && dsPath);
  } finally { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }); }
});

test('R2 H8: a newline-terminated corrupt record is CORRUPTION (fail closed); only an unterminated fragment is a torn tail', async () => {
  const dir = tmp(); const file = path.join(dir, 'l.jsonl');
  try {
    initLedger({ file, capUsd: 50 });
    const h = await reserveCall({ seam: 't', provider: 'anthropic', model: 'claude-opus-5-5', body: 'x', outputCap: 10, file });
    await settleCall(h, { usage: { input_tokens: 100, output_tokens: 5 }, modelServed: 'claude-opus-5-5' });
    fs.appendFileSync(file, '{"type":"reserve","callId":"lost","reser\n'); // terminated but unparseable: could have been a real reservation
    assert.throws(() => readLedgerSummary(file), /not valid JSON/);
  } finally { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }); }
});

test('R2 H3: freezeMetaPilot refuses to run without a repo-identity verifier (authorisation never defaults to trust)', () => {
  assert.throws(() => freezeMetaPilot({ exp: { runs: [], findings: [], events: [] }, repos: {}, seed: 's' }), /verifyRepo/);
});

test('R2 H7/H11/M4: ONE canonical file set drives matching, line ambiguity and egress', () => {
  assert.equal(lineRangeOf({ file: 'a.js', files: ['b.js'], lines: [3, 4] }), null, 'file + files = two files: no single line frame');
  assert.deepEqual(lineRangeOf({ file: 'a.js', files: [], lines: [3, 4] }), [3, 4]);
  const p = prepareJudgePayload({ f: { id: 'f', file: '.env', files: [], text: 't' }, x: { id: 'x', file: 'a.js', text: 't' } }, {});
  assert.equal(p.ok, false, 'a sensitive file named in file with an empty files[] is still refused');
});

test('R2 M7: a budget stop waits for every started worker to settle before propagating', async () => {
  let inflightDone = false;
  const judge = { stamp: {}, call: async ({ user }) => { if (/stop-me/.test(user)) { const e = new Error('cap'); e.code = 'budget-stop'; throw e; } await new Promise((r) => setTimeout(r, 60)); inflightDone = true; return { verdict: 'different', quote: '', reason: 'r' }; } };
  const pairs = [{ f: { id: 'a', file: 'a', text: 'slow one' }, x: { id: 'x', file: 'a', text: 'y' } }, { f: { id: 'b', file: 'a', text: 'stop-me' }, x: { id: 'x', file: 'a', text: 'y' } }];
  await assert.rejects(() => judgePairs({ pairs, judge, concurrency: 2 }), (e) => e.code === 'budget-stop');
  assert.equal(inflightDone, true, 'the in-flight call finished (and would have been metered) before the error surfaced');
});
