import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { freezeDataset, acceptedHighRounds, scoringPathFor } from '../scripts/lib/audit/step-back-dataset.mjs';
import { runReplay, scoreReplay, renderDryRun, ADOPTION_RULE } from '../scripts/lib/audit/step-back-replay.mjs';
import { main, EXIT_BUDGET_STOP } from '../scripts/step-back-replay.mjs';

const sha = (n) => String(n).repeat(40).slice(0, 40);

/** A synthetic PR on disk: rounds 1..lastRound, per-round ledger snapshots at 3 and 6, a final ledger. */
function synthPr(dir, { pr, sid, label, lastRound, finalEntries, noShaAt = null, skipLedgerSnapshotAt = [] }) {
  for (let n = 1; n <= lastRound; n++) {
    fs.writeFileSync(path.join(dir, `${sid}-r${n}-result.json`), JSON.stringify({
      round: n, _auditedSha: noShaAt === n ? null : sha(n), verdict: 'SIGNIFICANT_ISSUES',
      findings: [{ id: `H${n}`, severity: 'HIGH', _hash: `h${pr}-${n}`, _primaryFile: 'src/a.mjs', affectedFiles: ['src/a.mjs'] }],
    }));
    if ((n === 3 || n === 6) && !skipLedgerSnapshotAt.includes(n)) {
      fs.writeFileSync(path.join(dir, `${sid}-r${n}-ledger.json`), JSON.stringify({ entries: [{ topicId: `t${pr}-${n}`, firstSeenRound: n, round: n }] }));
    }
  }
  fs.writeFileSync(path.join(dir, `${sid}-ledger.json`), JSON.stringify({ entries: finalEntries }));
  return { pr, label, sid, auditDir: dir, planFile: 'plan.md' };
}
const acc = (round, severity = 'HIGH') => ({ firstSeenRound: round, adjudicationOutcome: 'accepted', severity });

function synthDataset() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-replay-'));
  const prs = [
    synthPr(dir, { pr: 1, sid: 'A', label: 'bad', lastRound: 6, finalEntries: [acc(1), acc(2)] }),          // nothing accepted after R3 -> a stop at R3 is an early stop
    synthPr(dir, { pr: 2, sid: 'B', label: 'bad', lastRound: 6, finalEntries: [acc(2), acc(5)] }),          // accepted HIGH at R5 -> a stop at R3 is FALSE, at R6 is early
    synthPr(dir, { pr: 3, sid: 'C', label: 'converged', lastRound: 3, finalEntries: [acc(1)] }),            // converged, ends at 3
    synthPr(dir, { pr: 4, sid: 'D', label: 'bad', lastRound: 6, finalEntries: [acc(1)], noShaAt: 3 }),      // no audited_sha at R3 -> unrecoverable at freeze
  ];
  const { dataset, scoring } = freezeDataset({ spec: { prs } });
  const dsPath = path.join(dir, 'dataset.json');
  fs.writeFileSync(dsPath, JSON.stringify(dataset));
  fs.mkdirSync(path.join(dir, 'scoring'));
  fs.writeFileSync(scoringPathFor(dsPath), JSON.stringify(scoring));
  return { dir, dataset, scoring, dsPath };
}

function fakeRepo() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-rev-'));
  fs.writeFileSync(path.join(root, 'plan.md'), '# plan\n');
  fs.mkdirSync(path.join(root, 'src'));
  fs.writeFileSync(path.join(root, 'src', 'a.mjs'), 'export const a = 1;\n');
  const checkouts = [];
  return { checkouts, checkout: async (s) => { checkouts.push(s); return { root, repoFiles: ['plan.md', 'src/a.mjs'], cleanup: () => {} }; } };
}

const topicOf = (f) => f._hash;

function fakeProviders(script = () => ({ action: 'structural', files: ['src/a.mjs'] }), usage = { input_tokens: 1000, output_tokens: 100 }) {
  const calls = [];
  const models = { same: 'gpt-5.5', different: 'gemini-3.1-pro-preview' };
  return {
    calls,
    makeProvider: (arm) => ({ model: models[arm], call: async ({ user }) => { calls.push({ arm, chars: user.length }); const idx = calls.length; return { text: JSON.stringify(script({ arm, idx, user })), usage }; } }),
  };
}

test('freezeDataset: lists sid/ledger/result paths/audited shas; missing sha and store disagreement are unrecoverable; truth is separate', () => {
  const { dataset, scoring } = synthDataset();
  const a = dataset.prs.find((p) => p.pr === 1);
  assert.equal(a.status, 'recoverable');
  assert.deepEqual(a.auditedShas[3], sha(3)); assert.ok(a.ledgerPath.endsWith('A-ledger.json')); assert.ok(a.resultPaths[6].endsWith('A-r6-result.json'));
  assert.deepEqual(a.checkpoints, [{ checkpoint: 3, hasRoundLedger: true }, { checkpoint: 6, hasRoundLedger: true }]);
  assert.equal(dataset.prs.find((p) => p.pr === 4).status, 'unrecoverable');
  assert.match(dataset.prs.find((p) => p.pr === 4).reason, /no audited_sha/);
  assert.equal(JSON.stringify(dataset).includes('acceptedHighRounds'), false, 'dataset carries no ground truth');
  assert.deepEqual(scoring.truth[2].acceptedHighRounds, [2, 5]);
  assert.equal(scoring.truth[4], undefined, 'unrecoverable PRs are not imputed');
  assert.deepEqual(acceptedHighRounds([acc(2, 'MEDIUM'), { firstSeenRound: 3, adjudicationOutcome: 'dismissed', severity: 'HIGH' }, acc(4)]), [4]);
  // store cross-check
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-x-'));
  const spec = synthPr(dir, { pr: 9, sid: 'X', label: 'bad', lastRound: 3, finalEntries: [] });
  const f = freezeDataset({ spec: { prs: [{ ...spec, storeRows: [{ round: 2, audited_sha: 'f'.repeat(40) }] }] } });
  assert.match(f.dataset.prs[0].reason, /disagrees/);
});

test('dry-run: prints the planned calls and estimated cost, makes NO provider call', async () => {
  const { dsPath, dataset } = synthDataset();
  const repo = fakeRepo(); const fp = fakeProviders();
  const res = await runReplay({ dataset, arms: ['none', 'same', 'different'], dryRun: true, deps: { checkout: repo.checkout, makeProvider: fp.makeProvider, topicOf } });
  assert.equal(fp.calls.length, 0);
  // PRs 1,2 -> checkpoints 3 and 6; PR 3 -> checkpoint 3 only; PR 4 unrecoverable: 5 checkpoints x 2 paid arms.
  assert.equal(res.plan.length, 10);
  const text = renderDryRun({ ...res, maxUsd: 20 });
  assert.match(text, /DRY RUN - no provider call was made/);
  assert.match(text, /planned calls: 10 \(5 PR-checkpoints\), UPPER-BOUND total \$\d+\.\d\d against a hard stop of \$20\.00/);
  assert.match(text, /unrecoverable.*#4/);
  assert.match(text, /call 1: PR #1 R3 arm=same model=gpt-5\.5 pack=\d+ chars upper bound \$/);
  // And through the CLI entry, with the same seams.
  const lines = []; const orig = console.log; console.log = (s) => lines.push(s);
  try { assert.equal(await main(['run', '--dataset', dsPath, '--dry-run', '--max-usd', '20'], { checkout: repo.checkout, makeProvider: fp.makeProvider, topicOf }), 0); } finally { console.log = orig; }
  assert.match(lines.join('\n'), /planned calls: 10/);
  assert.equal(fp.calls.length, 0);
});

test('a paid run needs --max-usd and --confirm-spend', async () => {
  const { dsPath } = synthDataset();
  await assert.rejects(() => main(['run', '--dataset', dsPath]), /--max-usd <n>, --confirm-spend and --results/);
  await assert.rejects(() => main(['run', '--dataset', dsPath, '--max-usd', '5', '--results', 'x.jsonl']), /--confirm-spend/);
});

test('budget hard stop is checked BEFORE each call: no call is made that would cross the cap', async () => {
  const { dataset } = synthDataset();
  const repo = fakeRepo();
  // Each call reports 10k in / 4k out: gpt-5.5 = $0.17. Cap 0.2: call 1 fits; call 2's estimate would cross it.
  const fp = fakeProviders(undefined, { input_tokens: 10000, output_tokens: 4000 });
  const res = await runReplay({ dataset, arms: ['same', 'different'], maxUsd: 0.2, deps: { checkout: repo.checkout, makeProvider: fp.makeProvider, topicOf } });
  assert.equal(fp.calls.length, 1, 'exactly one provider call was made');
  assert.equal(res.calls[0].status, 'ok'); assert.equal(res.calls[0].spendSource, 'usage');
  assert.ok(Math.abs(res.spentUsd - 0.17) < 1e-9, `spent ${res.spentUsd}`);
  assert.equal(res.stopped.reason, 'max-usd');
  assert.ok(res.calls.slice(1).every((c) => c.status === 'skipped-budget' && c.costUsd === 0));
  assert.equal(res.calls.length, res.plan.length, 'every planned call is accounted for');
  // A cap below the very first estimate makes zero calls.
  const fp2 = fakeProviders();
  const none = await runReplay({ dataset, arms: ['same'], maxUsd: 0.001, deps: { checkout: repo.checkout, makeProvider: fp2.makeProvider, topicOf } });
  assert.equal(fp2.calls.length, 0); assert.equal(none.spentUsd, 0);
});

test('CLI exits 5 on a budget stop and writes results with the score', async () => {
  const { dsPath, dir } = synthDataset();
  const repo = fakeRepo(); const fp = fakeProviders(undefined, { input_tokens: 10000, output_tokens: 4000 });
  const out = path.join(dir, 'results.json');
  const orig = console.log; console.log = () => {};
  let code;
  try { code = await main(['run', '--dataset', dsPath, '--arms', 'none,same,different', '--max-usd', '0.2', '--confirm-spend', '--results', path.join(dir, 'calls.jsonl'), '--out', out], { checkout: repo.checkout, makeProvider: fp.makeProvider, topicOf }); } finally { console.log = orig; }
  assert.equal(code, EXIT_BUDGET_STOP);
  const r = JSON.parse(fs.readFileSync(out, 'utf8'));
  assert.equal(r.score.arms.same.verdict, 'incomplete (not adopted)');
  assert.equal(r.score.arms.none.earlyStops, 0);
});

test('scoring: adopted only with falseStops = 0 and earlyStops >= 2; first stop per PR; harmless and incomplete handled', () => {
  const truth = {
    1: { label: 'bad', acceptedHighRounds: [1, 2] }, 2: { label: 'bad', acceptedHighRounds: [2, 5] },
    3: { label: 'converged', acceptedHighRounds: [1] }, 5: { label: 'bad', acceptedHighRounds: [1] },
  };
  const plan = [];
  for (const arm of ['same', 'different']) for (const [pr, cp] of [[1, 3], [2, 3], [2, 6], [3, 3], [5, 3]]) plan.push({ arm, pr, checkpoint: cp });
  const call = (arm, pr, checkpoint, action, status = 'ok') => ({ arm, pr, checkpoint, action, status });
  const calls = [
    // same: stops PR1@3 (early), PR5@3 (early), PR2@6 (early; R3 said defect), PR3@3 (harmless) -> adopted
    call('same', 1, 3, 'stop'), call('same', 2, 3, 'defect'), call('same', 2, 6, 'structural'), call('same', 3, 3, 'stop'), call('same', 5, 3, 'structural'),
    // different: stops PR2@3 while HIGH accepted at R5 -> FALSE stop; also 2 early stops -> not adopted
    call('different', 1, 3, 'stop'), call('different', 2, 3, 'stop'), call('different', 2, 6, 'defect'), call('different', 3, 3, 'defect'), call('different', 5, 3, 'stop'),
  ];
  const s = scoreReplay({ calls, truth, arms: ['none', 'same', 'different'], plan });
  assert.deepEqual([s.arms.same.earlyStops, s.arms.same.falseStops, s.arms.same.verdict], [3, 0, 'adopted']);
  assert.deepEqual([s.arms.different.earlyStops, s.arms.different.falseStops, s.arms.different.verdict], [2, 1, 'not adopted']);
  assert.equal(s.arms.none.verdict.startsWith('recorded-baseline'), true);
  assert.deepEqual([s.rule.maxFalseStops, s.rule.minEarlyStops, s.rule.ofBadPrs], [ADOPTION_RULE.maxFalseStops, ADOPTION_RULE.minEarlyStops, 3]);
  // Only one early stop -> not adopted; an invalid output counts and never stops; a missing call makes the arm incomplete.
  const one = scoreReplay({ calls: [call('same', 1, 3, 'stop'), call('same', 2, 3, null, 'invalid'), call('same', 2, 6, 'defect'), call('same', 3, 3, 'defect'), call('same', 5, 3, 'defect')], truth, arms: ['same'], plan: plan.filter((p) => p.arm === 'same') });
  assert.deepEqual([one.arms.same.earlyStops, one.arms.same.invalidOutputs, one.arms.same.verdict], [1, 1, 'incomplete (not adopted)']);  // an invalid checkpoint leaves the arm incomplete (R1 H4)
  const partial = scoreReplay({ calls: calls.slice(0, 3), truth, arms: ['same'], plan: plan.filter((p) => p.arm === 'same') });
  assert.equal(partial.arms.same.verdict, 'incomplete (not adopted)');
});

test('replay: no pack contains a topic first raised after its checkpoint, and the scoring file is never opened before the end', async () => {
  const { dataset, dir } = synthDataset();
  const repo = fakeRepo();
  const seen = [];
  const fp = fakeProviders((a) => { seen.push(a.user); return { action: 'defect', topicId: 't', evidenceNeeded: 'e' }; });
  const opened = [];
  const readJson = (p) => { opened.push(p); return JSON.parse(fs.readFileSync(p, 'utf8')); };
  await runReplay({ dataset, arms: ['same'], maxUsd: 50, deps: { checkout: repo.checkout, makeProvider: fp.makeProvider, topicOf, readJson } });
  assert.ok(seen.length > 0);
  for (const user of seen) {
    // R3 packs (the first of each PR) carry rounds 1-3 only: never rounds 4-6 findings or the later topics.
    if (!user.includes('h1-6')) assert.equal(user.includes('h1-4'), false);
  }
  const r3 = seen.find((u) => u.includes('h1-3') && !u.includes('h1-6'));
  assert.ok(r3, 'an R3 pack exists');
  for (const later of ['h1-4', 'h1-5', 'h1-6', 't1-6']) assert.equal(r3.includes(later), false, later);
  assert.equal(opened.some((p) => /scoring|[A-D]-ledger\.json$/.test(p) && !/-r\d+-ledger\.json$/.test(p)), false, 'final ledger / scoring never opened by the pack path');
  assert.ok(repo.checkouts.every((s) => /^[0-9a-f]{40}$/.test(s)));
  assert.ok(repo.checkouts.includes(sha(3)) && repo.checkouts.includes(sha(6)), 'each checkpoint is built at its own audited sha');
  void dir;
});
