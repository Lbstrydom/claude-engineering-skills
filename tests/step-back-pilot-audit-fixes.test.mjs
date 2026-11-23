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
import { verifyRepoIdentity, scorePilot, runNovelty, calibrationMaterial } from '../scripts/lib/audit/step-back-pilot-cli.mjs';
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

test('R3 H2/H7: a complete valid record that lacks only its newline is KEPT (terminated), not deleted by the tail repair', async () => {
  const dir = tmp(); const file = path.join(dir, 'l.jsonl');
  try {
    initLedger({ file, capUsd: 50 });
    const h = await reserveCall({ seam: 't', provider: 'anthropic', model: 'claude-opus-5-5', body: 'x', outputCap: 10, file });
    // strip the final newline of the (complete) reserve record, as a crash between the payload and the newline would
    const text = fs.readFileSync(file, 'utf8'); fs.writeFileSync(file, text.replace(/\n$/, ''));
    await settleCall(h, { usage: { input_tokens: 100, output_tokens: 5 }, modelServed: 'claude-opus-5-5' });
    const calls = readLedgerSummary(file).calls;
    assert.ok(calls.some((c) => c.callId === h.callId && c.state === 'settled'), 'the reservation survived the repair and was settled');
  } finally { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }); }
});

test('R3 H5: duplicate run identities make the dataset invalid', () => {
  const r = (arm) => ({ pointId: 'p', rep: 0, arm, valid: true, novelActionable: 0, novelActionableHM: 0, costUsd: 1 });
  assert.equal(decideMetaPilot({ runs: [r('META'), r('META'), r('CONTINUE')], plannedPairs: 1 }).branch, 1);
});

test('R3 H3/M2: calibration text comes only from earlier rounds and an overlapping T2/T1 pair of one session counts each finding once', () => {
  const mkF = (id, round, detail) => ({ id, severity: 'HIGH', category: '[backend] x', section: 's', detail, _primaryFile: 'a.mjs', topicId: 'T', affectedFiles: ['a.mjs'] });
  const snap = { rounds: [{ round: 1, findings: [mkF('f1', 1, 'EARLY text')] }, { round: 2, findings: [mkF('f2', 2, 'LATE reraise text')] }], ledgerEntries: [{ topicId: 'T', findingId: 'f1', severity: 'HIGH', category: '[backend] x', affectedFiles: ['a.mjs'], firstSeenRound: 1 }] };
  const early = ledgerTargets(snap, { upToRound: 1 })[0];
  assert.match(early.text, /EARLY/); assert.doesNotMatch(early.text, /LATE/);
  const ds = { points: ['t2', 't1'].map((id) => ({ pointId: id, status: 'recoverable', set: 'calibration', sessionId: 'S', mode: 'code' })) };
  const m = calibrationMaterial({ dataset: ds, snapshots: { t2: snap, t1: snap } });
  assert.equal(m.findings.filter((f) => f.id.endsWith('|f2')).length, 1, 'the shared round-2 finding is one observation, not two');
});

test('R4 H2: the clone origin must be on github.com as well as owner/name', () => {
  const ok = (url) => verifyRepoIdentity({ name: 'Lbstrydom/wine-cellar-app', localPath: 'x' }, { git: () => url }).ok;
  assert.equal(ok('https://github.com/Lbstrydom/wine-cellar-app.git'), true);
  assert.equal(ok('git@github.com:Lbstrydom/wine-cellar-app.git'), true);
  assert.equal(ok('https://git.corp.example.com/Lbstrydom/wine-cellar-app.git'), false, 'same owner/name on another host');
  assert.equal(ok('git@gitlab.com:Lbstrydom/wine-cellar-app.git'), false);
});

test('R4 H5: a negative or non-finite line window is rejected, not silently dropping every pair', () => {
  const f = { id: 'f', file: 'a.js', lines: [3, 3], text: 't' }; const x = { id: 'x', file: 'a.js', lines: [3, 3], text: 't' };
  assert.throws(() => filterCandidates([f], [x], { window: -1 }), /window/);
  assert.throws(() => filterCandidates([f], [x], { window: NaN }), /window/);
  assert.equal(filterCandidates([f], [x], { window: 0 }).length, 1);
});

test('R4 H6: a valid run with no findings collection blocks the score instead of scoring as "no findings"', () => {
  const runs = [{ pointId: 'p', arm: 'CONTINUE', rep: 0, valid: true, costUsd: 1 }];
  const s = scoreMetaRuns({ runs, novelByFinding: new Map(), labels: new Map() });
  assert.equal(s.incomplete, true); assert.equal(s.blocked[0].reason, 'valid-run-without-findings');
});

test('R4 H4: a ruling made after the frame round never leaks into an earlier calibration frame', () => {
  const snap = { rounds: [{ round: 1, findings: [{ id: 'f1', severity: 'HIGH', category: '[backend] x', section: 's', detail: 'd', topicId: 'T' }] }], ledgerEntries: [{ topicId: 'T', findingId: 'f1', severity: 'HIGH', category: '[backend] x', affectedFiles: ['a.mjs'], firstSeenRound: 1, round: 5, ruling: 'LATE-RULING' }] };
  assert.doesNotMatch(ledgerTargets(snap, { upToRound: 2 })[0].text, /LATE-RULING/);
  assert.match(ledgerTargets(snap)[0].text, /LATE-RULING/, 'control: the full checkpoint state does carry it');
});

test('R5 H3: the 24-valid-pair floor is absolute; a small plan cannot scale it down into a keep', () => {
  const runs = Array.from({ length: 8 }, (_, i) => ['META', 'CONTINUE'].map((arm) => ({ pointId: `p${i}`, rep: 0, arm, valid: true, stopRun: arm === 'META' && i < 5, novelActionable: 0, novelActionableHM: 0, costUsd: arm === 'META' ? 1 : 3 }))).flat();
  assert.equal(decideMetaPilot({ runs, plannedPairs: 8 }).branch, 1, '8 valid pairs of 8 planned is still below the pre-registered floor of 24');
});

test('R5 H4: a newline-terminated invalid record followed by blank lines is corruption, not a torn tail', async () => {
  const dir = tmp(); const file = path.join(dir, 'l.jsonl');
  try {
    initLedger({ file, capUsd: 50 });
    fs.appendFileSync(file, '{"type":"reserve","callId":"x"\n   \n');
    assert.throws(() => readLedgerSummary(file), /not valid JSON/);
  } finally { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }); }
});

test('R5 H6/H7: negative, fractional, missing counts invalidate the dataset; a non-array findings value blocks instead of throwing', () => {
  const mk = (over) => [{ pointId: 'p', rep: 0, arm: 'META', valid: true, novelActionable: 0, novelActionableHM: 0, costUsd: 1, ...over }, { pointId: 'p', rep: 0, arm: 'CONTINUE', valid: true, novelActionable: 0, novelActionableHM: 0, costUsd: 3 }];
  for (const bad of [{ novelActionable: -1 }, { novelActionable: 1.5 }, { novelActionableHM: undefined }, { novelActionable: null }]) assert.equal(decideMetaPilot({ runs: mk(bad), plannedPairs: 1 }).branch, 1, JSON.stringify(bad));
  const s = scoreMetaRuns({ runs: [{ pointId: 'p', arm: 'CONTINUE', rep: 0, valid: true, costUsd: 1, findings: {} }], novelByFinding: new Map(), labels: new Map() });
  assert.equal(s.incomplete, true);
});

test('R6 G4: calibration with short samples is inconclusive inside scoreCalibration itself', () => {
  const labelled = []; const verdicts = {};
  for (let i = 0; i < 60; i++) { labelled.push({ pairId: `p${i}`, set: 'prevalence', stratum: 'prevalence', sourceArm: i % 2 ? 'code' : 'plan', label: i < 40 ? 'same' : 'different', f: { id: `f${i}`, file: 'a', text: 'x' }, x: { id: `x${i}`, file: 'a', text: 'x' } }); verdicts[`p${i}`] = i < 40 ? 'same' : 'different'; }
  const base = { labelled, judgeVerdicts: verdicts, filterRecallPairs: Array.from({ length: 20 }, (_, i) => ({ pairId: `r${i}`, keptByFilter: true })) };
  assert.equal(scoreCalibration({ ...base, shortfalls: { prevalence: 0, challenge: 0, filterRecall: 0 } }).decision.status, 'accept');
  const short = scoreCalibration({ ...base, shortfalls: { challenge: 70 } });
  assert.equal(short.decision.status, 'inconclusive'); assert.match(short.decision.inconclusiveReasons.join(), /challenge-sample-short-by-70/);
});

test('R8: Restates ids contain spaces (a timestamp); they split on commas only', async () => {
  const { parseCalibrationAnswers } = await import('../scripts/lib/audit/step-back-pilot-cli.mjs');
  const id1 = 'r|code|feat/x@2026-10-14 21:49:16.859255+00|r6|573f696b'; const id2 = 'r|code|feat/x@2026-10-14 21:49:16.859255+00|r6|3f42d36b';
  const a = parseCalibrationAnswers(`### R001\n\nRestates: ${id1}, ${id2}\n\n### R002\n\nRestates: none\n`);
  assert.deepEqual(a.filterRecall, { R001: [id1, id2], R002: [] });
});
