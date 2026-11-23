/**
 * Pilot 1 command bodies (scripts/lib/audit/step-back-pilot-cli.mjs): the paid `continue` loop under a REAL budget ledger with an
 * injected run function, the blind worksheet, label parsing and the INCOMPLETE rule. Nothing here spends or spawns a model.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { freezeMetaPilot } from '../scripts/lib/audit/step-back-pilot-freeze.mjs';
import { readAmendment } from '../scripts/lib/audit/pilot-novelty-audit.mjs';
import { runCalibrateDraw, runNovelty, runContinue, runFreeze, buildWorksheet, parseWorksheetLabels, parseCalibrationAnswers, scorePilot, snapshotsPathFor, readRunRows, appendDurably } from '../scripts/lib/audit/step-back-pilot-cli.mjs';
import { reserveCall, settleCall, readLedgerSummary } from '../scripts/lib/llm-budget.mjs';

const T0 = Date.parse('2026-11-01T10:00:00Z');
function exportOf(n) {
  const runs = []; const findings = []; const events = [];
  for (let s = 0; s < n; s++) for (let i = 1; i <= 7; i++) {
    const id = `r${s}-${i}`; const at = new Date(T0 + s * 5e8 + i * 3.6e6).toISOString();
    runs.push({ id, repo_id: 'R', branch: `feat/b${s}`, audited_sha: `${s}${i}`.padEnd(40, 'b'), diff_ref: null, created_at: at, mode: 'code', plan_file: 'docs/plans/p.md' });
    const fid = `f${s}-${i}`;
    findings.push({ id: fid, run_id: id, finding_fingerprint: `fp${s}`, severity: 'HIGH', category: '[backend] x', primary_file: 'src/a.mjs', detail_snapshot: 'd', round_raised: i, created_at: at });
    events.push({ id: `e${fid}`, finding_id: fid, adjudication_outcome: 'accepted', remediation_state: 'fixed', ruling: 'sustain', round: i, created_at: at, superseded_at: null, overrides_event_id: null });
  }
  return { runs, findings, events, exportedAt: 'x' };
}
const AMENDMENT = path.resolve('docs/experiments/seeded-bench/amendment-2-novelty-audit.json');
const setup = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-cli-'));
  const exp = path.join(dir, 'e.json'); fs.writeFileSync(exp, JSON.stringify(exportOf(20)));
  fs.writeFileSync(path.join(dir, 'repos.json'), JSON.stringify({ R: { name: 'Lbstrydom/wine-cellar-app', localPath: dir } }));
  runFreeze({ exports: [exp], reposFile: path.join(dir, 'repos.json'), seed: 's', out: path.join(dir, 'ds.json'), verifyRepo: () => ({ ok: true }) });
  return dir;
};

describe('continue (paid) under a real ledger', () => {
  const fakeRun = (cost, log) => async ({ point, arm, rep, deps }) => {
    log.push(`${point.pointId}/${arm}/${rep}`);
    const before = deps.spentUsd();
    const h = await reserveCall({ seam: 't', provider: 'anthropic', model: 'claude-opus-5-5', body: 'x', outputCap: 10, file: deps.ledger });
    await settleCall(h, { usage: { input_tokens: 1000, output_tokens: 10 }, modelServed: 'claude-opus-5-5' });
    return { type: 'run', pointId: point.pointId, arm, rep, valid: true, stopRun: false, findings: [], costUsd: deps.spentUsd() - before + cost, runId: `${point.pointId}-${arm}-${rep}`, mode: point.mode, trigger: point.trigger };
  };

  test('runs META then CONTINUE for every point and replicate, appending durably; refuses an existing results file; summary has metered spend', async () => {
    const dir = setup(); const log = [];
    const res = path.join(dir, 'r.jsonl');
    const out = await runContinue({ datasetPath: path.join(dir, 'ds.json'), set: 'rehearsal', replicates: 1, maxUsd: 50, confirmSpend: true, resultsPath: res, auditScript: 'x', deps: { pin: { head: 'abc' }, runContinuation: async (a) => fakeRun(0, log)({ ...a, deps: { ...a.deps, ledger: a.ledgerFile } }) } });
    assert.equal(out.exitCode, 0); assert.equal(log.length, out.rows.length);
    assert.ok(log[0].endsWith('/META/0') && log[1].endsWith('/CONTINUE/0'));
    const lines = fs.readFileSync(res, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    assert.equal(lines[0].type, 'header'); assert.equal(lines[0].revision, 'abc'); assert.equal(lines.at(-1).type, 'summary');
    assert.equal(readRunRows(res).length, log.length);
    assert.ok(lines.at(-1).spentUsd > 0, 'spend is metered from usage, not estimated');
    await assert.rejects(() => runContinue({ datasetPath: path.join(dir, 'ds.json'), set: 'rehearsal', replicates: 1, maxUsd: 50, confirmSpend: true, resultsPath: res, auditScript: 'x', deps: { pin: { head: 'a' } } }), /already exists/);
  });

  test('a cap too small stops the run (exit 5) and records why; nothing past the cap runs', async () => {
    const dir = setup(); const log = [];
    const out = await runContinue({ datasetPath: path.join(dir, 'ds.json'), set: 'rehearsal', replicates: 1, maxUsd: 0.0000001, confirmSpend: true, resultsPath: path.join(dir, 'r2.jsonl'), auditScript: 'x',
      deps: { pin: { head: 'a' }, runContinuation: async (a) => { log.push(1); const h = await reserveCall({ seam: 't', provider: 'anthropic', model: 'claude-opus-5-5', body: 'x'.repeat(100), outputCap: 10, file: a.ledgerFile }).catch((e) => e); return { type: 'run', valid: false, invalidReason: h?.code === 'budget-stop' ? 'budget-stop' : 'x', costUsd: 0, findings: [], pointId: a.point.pointId, arm: a.arm, rep: a.rep, runId: 'r' }; } } });
    assert.equal(out.exitCode, 5); assert.equal(out.stopped.reason, 'max-usd'); assert.equal(log.length, 1);
  });

  test('guards: unpaid flags, a calibration set and a paid run outside a fixture are refused', async () => {
    const dir = setup();
    const base = { datasetPath: path.join(dir, 'ds.json'), replicates: 1, auditScript: 'x' };
    await assert.rejects(() => runContinue({ ...base, set: 'calibration', dryRun: true }), /never run/);
    await assert.rejects(() => runContinue({ ...base, set: 'pilot', maxUsd: 5, resultsPath: path.join(dir, 'x.jsonl') }), /confirm-spend/);
    await assert.rejects(() => runContinue({ ...base, set: 'pilot', maxUsd: 5, confirmSpend: true, resultsPath: path.join(dir, 'x.jsonl') }), /pinned fixture/);
  });

  test('dry run validates every point with no ledger and no call', async () => {
    const dir = setup();
    const r = await runContinue({ datasetPath: path.join(dir, 'ds.json'), set: 'rehearsal', replicates: 2, dryRun: true, auditScript: 'x', deps: { withTree: async () => ({ ok: true }) } });
    assert.equal(r.dryRun, true); assert.equal(r.planned, r.points.length * 4); assert.ok(r.points.every((p) => p.ok));
    assert.equal(fs.existsSync(path.join(dir, 'r.jsonl.budget.jsonl')), false);
  });
});

describe('blind worksheet and scoring (amendment 2)', () => {
  const amendment = readAmendment(AMENDMENT);
  const mkRows = (n) => [
    { runId: 'p1/CONTINUE/0', pointId: 'p1', arm: 'CONTINUE', rep: 0, mode: 'code', valid: true, costUsd: 2, findings: Array.from({ length: n }, (_, i) => ({ key: `p1/CONTINUE/0:H${i}`, severity: 'HIGH', file: 'a.mjs', lines: [3, 3], text: `finding text ${i}`, affectedFiles: [] })) },
    { runId: 'p1/META/0', pointId: 'p1', arm: 'META', rep: 0, mode: 'code', valid: true, stopRun: true, costUsd: 1, findings: [] },
  ];
  const J = (novel, notJudged = false) => ({ novel, notJudged, flags: [] });
  const dataset = { points: [{ pointId: 'p1', repo: 'Lbstrydom/wine-cellar-app', checkpoint: 3 }] };
  const snapshots = { p1: { rounds: [{ round: 1, findings: [{ id: 'f1', topicId: 'T', severity: 'HIGH', category: '[backend] x', section: 's', detail: 'EARLIER ENTRY TEXT' }] }], ledgerEntries: [{ topicId: 'T', findingId: 'f1', severity: 'HIGH', category: '[backend] x', affectedFiles: ['a.mjs'], firstSeenRound: 1 }] } };
  // finding 0: opus novel, pro same (surfaced); 1: both same (hidden); 2: both same (hidden); 3: opus same + pro NOT JUDGED (surfaced)
  const novelty = { stamps: { opus: {}, pro: {} }, incomplete: false, byFinding: {
    'p1/CONTINUE/0:H0': { opus: J(true), pro: J(false) }, 'p1/CONTINUE/0:H1': { opus: J(false), pro: J(false) },
    'p1/CONTINUE/0:H2': { opus: J(false), pro: J(false) }, 'p1/CONTINUE/0:H3': { opus: J(false), pro: J(false, true) } } };
  const build = (opts = {}) => buildWorksheet({ rows: mkRows(4), novelty, seed: 's', dataset, snapshots, amendment, ...opts });

  test('hidden = BOTH judges said same; a failed or disagreeing judge surfaces the finding; arm, run and judge verdicts stay off the sheet', () => {
    const { markdown, key, counts } = build();
    assert.deepEqual(counts, { shown: 2, hidden: 2, audited: 2 });
    assert.equal(Object.keys(key.items).length, 4, 'the 2 surfaced findings plus the 2 hidden ones (fewer than the sample size, so all are audited)');
    for (const leak of ['CONTINUE', 'META', 'p1/', 'opus', 'audited']) assert.ok(!markdown.includes(leak), leak);
    assert.match(markdown, /EARLIER ENTRY TEXT/, 'the closest earlier ledger entry is shown for the human to compare');
    assert.match(markdown, /`KNOWN`/);
  });
  test('the hidden sample is a seeded probability sample: size is capped, and --audit all labels every hidden finding', () => {
    const many = { ...novelty, byFinding: Object.fromEntries(Array.from({ length: 200 }, (_, i) => [`p1/CONTINUE/0:H${i}`, { opus: J(false), pro: J(false) }])) };
    const a = buildWorksheet({ rows: mkRows(200), novelty: many, seed: 's', dataset, snapshots, amendment });
    assert.equal(a.counts.audited, amendment.audit.sample); assert.equal(a.counts.hidden, 200);
    assert.deepEqual(buildWorksheet({ rows: mkRows(200), novelty: many, seed: 's', dataset, snapshots, amendment }).key.items, a.key.items, 'seeded: reproducible');
    assert.equal(buildWorksheet({ rows: mkRows(200), novelty: many, seed: 's', dataset, snapshots, amendment, auditAll: true }).counts.audited, 200);
  });
  test('labels parse; an unlabelled item or an UNDETERMINED label makes the score INCOMPLETE; when every hidden finding is shown the audit is moot', () => {
    const { markdown, key } = build();
    assert.equal(parseWorksheetLabels(markdown).size, 0);
    assert.equal(key.audit.all, true, 'only 2 hidden findings: all are shown, so no sampling bound is needed');
    const all = (label) => new Map(Object.keys(key.items).map((w) => [w, label]));
    const done = scorePilot({ rows: mkRows(4), novelty, key, labelsById: all('REAL'), plannedPairs: 1 });
    assert.notEqual(done.decision.outcome, 'INCOMPLETE'); assert.notEqual(done.decision.outcome, 'audit-failed');
    assert.equal(scorePilot({ rows: mkRows(4), novelty, key, labelsById: new Map(), plannedPairs: 1 }).decision.outcome, 'INCOMPLETE');
    assert.equal(scorePilot({ rows: mkRows(4), novelty, key, labelsById: new Map([['W001', 'UNDETERMINED']]), plannedPairs: 1 }).decision.outcome, 'INCOMPLETE');
    assert.throws(() => scorePilot({ rows: mkRows(4), novelty, key, labelsById: new Map([['W001', 'MAYBE']]), plannedPairs: 1 }), /unknown label/);
  });
  test('the audit verdict: 80 audited of 200 hidden pass with <= 6 false suppressions and FAIL with 7 (the result is then withheld)', () => {
    const many = { ...novelty, byFinding: Object.fromEntries(Array.from({ length: 200 }, (_, i) => [`p1/CONTINUE/0:H${i}`, { opus: J(false), pro: J(false) }])) };
    const { key } = buildWorksheet({ rows: mkRows(200), novelty: many, seed: 's', dataset, snapshots, amendment });
    assert.equal(key.audit.all, false);
    const labelFirst = (nFalse) => new Map(Object.keys(key.items).map((w, i) => [w, i < nFalse ? 'REAL' : 'KNOWN']));
    const run = (nFalse) => scorePilot({ rows: mkRows(200), novelty: many, key, labelsById: labelFirst(nFalse), plannedPairs: 1 });
    assert.equal(run(0).audit.pass, true);
    assert.equal(run(6).audit.pass, true); assert.notEqual(run(6).decision.outcome, 'audit-failed');
    assert.equal(run(7).audit.pass, false); assert.equal(run(7).decision.outcome, 'audit-failed'); assert.match(run(7).decision.why, /--audit all/);
  });
  test('calibration answers parse: pair labels and restated-entry lists, `none` meaning []', () => {
    const a = parseCalibrationAnswers('### P001\n\nLabel: Same\n\n### P002\n\nLabel: \n\n### R001\n\nRestates: `x|1`, y\n\n### R002\n\nRestates: none\n');
    assert.deepEqual(a.pairs, { P001: 'same' }); assert.deepEqual(a.filterRecall, { R001: ['x|1', 'y'], R002: [] });
  });
});

test('appendDurably appends whole records', () => {
  const f = path.join(os.tmpdir(), `ad-${process.pid}.jsonl`); appendDurably(f, 'a\n'); appendDurably(f, 'b\n');
  assert.equal(fs.readFileSync(f, 'utf8'), 'a\nb\n'); fs.rmSync(f, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  assert.ok(snapshotsPathFor('x/ds.json').endsWith('ds.snapshots.json'));
  assert.ok(typeof freezeMetaPilot === 'function' && typeof readLedgerSummary === 'function');
});

describe('runNovelty gate and resumption (amendment 2)', () => {
  const mkResults = (dir, dataset) => {
    const res = path.join(dir, 'r.jsonl');
    const p = dataset.points.find((x) => x.status === 'recoverable');
    const rows = [{ type: 'header', plannedPairs: 1, datasetHash: dataset.datasetHash }, { type: 'run', pointId: p.pointId, arm: 'CONTINUE', rep: 0, findings: [{ key: 'k1', severity: 'HIGH', file: 'a.mjs', lines: null, text: 't', affectedFiles: [] }] }];
    fs.writeFileSync(res, rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
    return res;
  };
  const judgeDeps = (state) => ({ createJudge: async ({ sentinel }) => ({ stamp: { sentinel, model: 'm' } }), classifyNovelty: async ({ findings }) => { state.calls.push(findings.map((f) => f.id)); const notJudged = state.fail; return { perFinding: findings.map((f) => ({ id: f.id, novel: true, flags: [], notJudged })) }; } });
  const stamps = { opus: { stamp: { sentinel: 'latest-opus', model: 'm' } }, pro: { stamp: { sentinel: 'latest-pro', model: 'm' } } };

  test('refused without the signed amendment and a calibration report of THIS dataset; a failed judge is retried on rerun; a swapped results file is refused', async () => {
    const dir = setup();
    const dsPath = path.join(dir, 'ds.json'); const dataset = JSON.parse(fs.readFileSync(dsPath, 'utf8'));
    const res = mkResults(dir, dataset);
    const cal = path.join(dir, 'cal.json');
    await assert.rejects(() => runNovelty({ datasetPath: dsPath, resultsPath: res }), /--amendment/);
    await assert.rejects(() => runNovelty({ datasetPath: dsPath, resultsPath: res, amendmentPath: AMENDMENT }), /--calibration/);
    fs.writeFileSync(cal, JSON.stringify({ decision: 'inconclusive', datasetHash: 'OTHER', spentUsd: 2.2, judges: stamps }));
    await assert.rejects(() => runNovelty({ datasetPath: dsPath, resultsPath: res, amendmentPath: AMENDMENT, calibrationPath: cal }), /different dataset/);
    fs.writeFileSync(cal, JSON.stringify({ decision: 'inconclusive', datasetHash: dataset.datasetHash, spentUsd: 2.2, judges: stamps })); // the v1 verdict stays inconclusive: the amendment does not need it accepted
    const badAmend = path.join(dir, 'a.json'); fs.writeFileSync(badAmend, JSON.stringify({ ...JSON.parse(fs.readFileSync(AMENDMENT, 'utf8')), epoch: 'seeded-bench-v1' }));
    await assert.rejects(() => runNovelty({ datasetPath: dsPath, resultsPath: res, amendmentPath: badAmend, calibrationPath: cal }), /epoch/);

    await assert.rejects(() => runNovelty({ datasetPath: dsPath, resultsPath: res, amendmentPath: AMENDMENT, calibrationPath: cal, deps: { createJudge: async ({ sentinel }) => ({ stamp: { sentinel, model: 'DIFFERENT' } }), classifyNovelty: async () => ({ perFinding: [] }) } }), /recalibrate/);
    const state = { calls: [], fail: true };
    const run = () => runNovelty({ datasetPath: dsPath, resultsPath: res, amendmentPath: AMENDMENT, calibrationPath: cal, deps: judgeDeps(state) });
    const first = await run();
    assert.equal(first.incomplete, false, 'a failed judge is NOT incomplete under the amendment: the finding simply goes to the human');
    assert.equal(first.byFinding.k1.opus.notJudged, true);
    state.fail = false; state.calls.length = 0;
    await run();
    assert.equal(state.calls.length, 2, 'both judges retried the not-judged finding');
    state.calls.length = 0;
    await run();
    assert.equal(state.calls.length, 0, 'settled judgments are not re-paid');
    fs.appendFileSync(res, JSON.stringify({ type: 'run', pointId: 'x', findings: [] }) + '\n');
    await assert.rejects(run, /different dataset or results file/);
  });
});

describe('operator-input validation on a REAL frozen dataset (R3 M3/H8, R4 M1/M4)', () => {
  test('an unknown --point id is rejected after the dataset loads; a known one is accepted', async () => {
    const dir = setup(); const dsPath = path.join(dir, 'ds.json');
    const ds = JSON.parse(fs.readFileSync(dsPath, 'utf8'));
    const known = ds.points.find((p) => p.set === 'rehearsal').pointId;
    await assert.rejects(() => runContinue({ datasetPath: dsPath, set: 'rehearsal', replicates: 1, dryRun: true, only: ['no-such-point'], auditScript: 'x', deps: { withTree: async () => ({ ok: true }) } }), /no-such-point, not in the rehearsal set/);
    const r = await runContinue({ datasetPath: dsPath, set: 'rehearsal', replicates: 1, dryRun: true, only: [known], auditScript: 'x', deps: { withTree: async () => ({ ok: true }) } });
    assert.equal(r.points.length, 1);
  });
  test('calibrate-draw refuses to overwrite a worksheet that already exists (a human may have labelled it)', () => {
    const dir = setup(); const out = path.join(dir, 'cal');
    const first = runCalibrateDraw({ datasetPath: path.join(dir, 'ds.json'), seed: 's', outDir: out });
    assert.ok(first.findings > 0, 'control: the first draw found material');
    fs.appendFileSync(path.join(out, 'calibration-worksheet.md'), '\nLabel: same\n');
    assert.throws(() => runCalibrateDraw({ datasetPath: path.join(dir, 'ds.json'), seed: 's', outDir: out }), /already exists/);
    assert.match(fs.readFileSync(path.join(out, 'calibration-worksheet.md'), 'utf8'), /Label: same/, 'the labelled file is intact');
  });
});

test('R7 G2: an interrupted novelty run leaves a checkpoint that reads INCOMPLETE', async () => {
  const dir = setup(); const dsPath = path.join(dir, 'ds.json'); const dataset = JSON.parse(fs.readFileSync(dsPath, 'utf8'));
  const p = dataset.points.find((x) => x.status === 'recoverable');
  const res = path.join(dir, 'r.jsonl');
  fs.writeFileSync(res, [{ type: 'header', plannedPairs: 1, datasetHash: dataset.datasetHash }, { type: 'run', pointId: p.pointId, arm: 'CONTINUE', rep: 0, findings: Array.from({ length: 8 }, (_, i) => ({ key: `k${i}`, severity: 'HIGH', file: 'a.mjs', text: 't', affectedFiles: [] })) }].map((r) => JSON.stringify(r)).join('\n') + '\n');
  const cal = path.join(dir, 'cal.json');
  fs.writeFileSync(cal, JSON.stringify({ decision: 'inconclusive', datasetHash: dataset.datasetHash, spentUsd: 2.2, judges: { opus: { stamp: { sentinel: 'latest-opus', model: 'm' } }, pro: { stamp: { sentinel: 'latest-pro', model: 'm' } } } }));
  let n = 0;
  const deps = { createJudge: async ({ sentinel }) => ({ stamp: { sentinel, model: 'm' } }), classifyNovelty: async ({ findings }) => { if (++n === 2) { const e = new Error('cap'); e.code = 'budget-stop'; throw e; } return { perFinding: findings.map((f) => ({ id: f.id, novel: true, flags: [], notJudged: false })) }; } };
  await assert.rejects(() => runNovelty({ datasetPath: dsPath, resultsPath: res, amendmentPath: AMENDMENT, calibrationPath: cal, deps }), (e) => e.code === 'budget-stop');
  const onDisk = JSON.parse(fs.readFileSync(`${res}.novelty.json`, 'utf8'));
  assert.equal(onDisk.incomplete, true, 'the partial checkpoint is not mistaken for a finished run');
  assert.ok(Object.keys(onDisk.byFinding).length > 0, 'control: the first chunk was kept');
});

test('A2 final gate G1: the worksheet carries only findings of VALID pairs', () => {
  const amendment = readAmendment(AMENDMENT);
  const mk = (arm, valid) => ({ runId: `r${arm}`, pointId: 'p1', arm, rep: 0, mode: 'code', valid, costUsd: 1, findings: [{ key: `${arm}:1`, severity: 'HIGH', file: 'a.mjs', lines: [1, 1], text: 't', affectedFiles: [] }] });
  const nv = { stamps: {}, byFinding: { 'META:1': { opus: { novel: true }, pro: { novel: true } }, 'CONTINUE:1': { opus: { novel: true }, pro: { novel: true } } } };
  const ds = { points: [{ pointId: 'p1', repo: 'r', checkpoint: 1 }] }; const snaps = { p1: { rounds: [], ledgerEntries: [] } };
  assert.equal(buildWorksheet({ rows: [mk('META', true), mk('CONTINUE', true)], novelty: nv, seed: 's', dataset: ds, snapshots: snaps, amendment }).counts.shown, 2);
  assert.equal(buildWorksheet({ rows: [mk('META', false), mk('CONTINUE', true)], novelty: nv, seed: 's', dataset: ds, snapshots: snaps, amendment }).counts.shown, 0, 'an invalid META run excludes its valid CONTINUE partner too');
});
