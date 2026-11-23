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
import { runContinue, runFreeze, buildWorksheet, parseWorksheetLabels, parseCalibrationAnswers, scorePilot, snapshotsPathFor, readRunRows, appendDurably } from '../scripts/lib/audit/step-back-pilot-cli.mjs';
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
const setup = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-cli-'));
  const exp = path.join(dir, 'e.json'); fs.writeFileSync(exp, JSON.stringify(exportOf(20)));
  fs.writeFileSync(path.join(dir, 'repos.json'), JSON.stringify({ R: { name: 'Lbstrydom/wine-cellar-app', localPath: dir } }));
  runFreeze({ exports: [exp], reposFile: path.join(dir, 'repos.json'), seed: 's', out: path.join(dir, 'ds.json') });
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

describe('blind worksheet and scoring', () => {
  const rows = [
    { runId: 'p1/CONTINUE/0', pointId: 'p1', arm: 'CONTINUE', rep: 0, mode: 'code', valid: true, costUsd: 2, findings: [{ key: 'p1/CONTINUE/0:H1', severity: 'HIGH', file: 'a.mjs', lines: [3, 3], text: 'secret-arm-free text' }] },
    { runId: 'p1/META/0', pointId: 'p1', arm: 'META', rep: 0, mode: 'code', valid: true, stopRun: true, costUsd: 1, findings: [] },
  ];
  const novelty = { stamps: { opus: {}, pro: {} }, incomplete: false, byFinding: { 'p1/CONTINUE/0:H1': { opus: { novel: true }, pro: { novel: false } } } };
  const dataset = { points: [{ pointId: 'p1', repo: 'Lbstrydom/wine-cellar-app' }] };

  test('the sheet hides arm, run and judge verdicts; every finding novel under EITHER judge is on it', () => {
    const { markdown, key } = buildWorksheet({ rows, novelty, seed: 's', dataset });
    assert.equal(Object.keys(key.items).length, 1);
    for (const hidden of ['CONTINUE', 'META', 'p1/', 'opus']) assert.ok(!markdown.includes(hidden), hidden);
    assert.match(markdown, /### W001/);
  });
  test('labels parse; an unlabelled item or an UNDETERMINED label makes the score INCOMPLETE, never a guess', () => {
    const { markdown, key } = buildWorksheet({ rows, novelty, seed: 's', dataset });
    assert.equal(parseWorksheetLabels(markdown).size, 0);
    const filled = markdown.replace('Label: ', 'Label: real');
    assert.equal(parseWorksheetLabels(filled).get('W001'), 'REAL');
    const done = scorePilot({ rows, novelty, key, labelsById: parseWorksheetLabels(filled), plannedPairs: 1 });
    assert.notEqual(done.decision.outcome, 'INCOMPLETE');
    assert.equal(done.byJudge.opus.find((r) => r.arm === 'CONTINUE').novelActionableHM, 1);
    assert.equal(done.byJudge.pro.find((r) => r.arm === 'CONTINUE').novelActionableHM, 0, 'novelty is per judge');
    assert.equal(scorePilot({ rows, novelty, key, labelsById: new Map(), plannedPairs: 1 }).decision.outcome, 'INCOMPLETE');
    assert.equal(scorePilot({ rows, novelty, key, labelsById: new Map([['W001', 'UNDETERMINED']]), plannedPairs: 1 }).decision.outcome, 'INCOMPLETE');
    assert.throws(() => scorePilot({ rows, novelty, key, labelsById: new Map([['W001', 'MAYBE']]), plannedPairs: 1 }), /unknown label/);
  });
  test('calibration answers parse: pair labels and restated-entry lists, `none` meaning []', () => {
    const a = parseCalibrationAnswers('### P001\n\nLabel: Same\n\n### P002\n\nLabel: \n\n### R001\n\nRestates: `x|1`, y\n\n### R002\n\nRestates: none\n');
    assert.deepEqual(a.pairs, { P001: 'same' }); assert.deepEqual(a.filterRecall, { R001: ['x|1', 'y'], R002: [] });
  });
});

test('appendDurably appends whole records', () => {
  const f = path.join(os.tmpdir(), `ad-${process.pid}.jsonl`); appendDurably(f, 'a\n'); appendDurably(f, 'b\n');
  assert.equal(fs.readFileSync(f, 'utf8'), 'a\nb\n'); fs.rmSync(f);
  assert.ok(snapshotsPathFor('x/ds.json').endsWith('ds.snapshots.json'));
  assert.ok(typeof freezeMetaPilot === 'function' && typeof readLedgerSummary === 'function');
});
