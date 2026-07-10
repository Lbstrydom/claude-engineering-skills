/**
 * Tier-1 tests for the Phase 5 cheap-triager validation tooling (tiered-recall
 * pipeline, Cluster C). Plan: docs/plans/tiered-recall-audit-pipeline.md.
 * Covers: CSV parsing (embedded commas/quotes), two-judge consensus, the
 * omission retrofit heuristic, contrarian stratified worksheet assembly,
 * Wilson-CI, the validation manifest, and the injectable-adapter candidate
 * triage orchestration (stub adapter only — never a live model call).
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseBlindCsv, computeTwoJudgeConsensus, retrofitEvidenceType,
  buildContrarianStratifiedWorksheet, wilsonScoreInterval, computeValidationManifest,
  renderValidationMarkdown, computeDatasetHash, runCandidateTriage,
} from '../scripts/lib/solo-control/cheap-triager-validate.mjs';

describe('parseBlindCsv', () => {
  it('parses a simple header + row', () => {
    const csv = 'blind_id,commit,severity,category,file,detail,label,proof,cluster,matches,pattern\nF001,abc123,HIGH,cat,file.js,some detail,proven,proof text,c1,,\n';
    const rows = parseBlindCsv(csv);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].blind_id, 'F001');
    assert.equal(rows[0].label, 'proven');
  });
  it('handles embedded commas inside a quoted field', () => {
    const csv = 'blind_id,commit,severity,category,file,detail,label,proof,cluster,matches,pattern\nF002,abc,HIGH,cat,file.js,"detail, with, commas",false,proof,,,\n';
    const rows = parseBlindCsv(csv);
    assert.equal(rows[0].detail, 'detail, with, commas');
  });
  it('handles escaped double-quotes inside a quoted field', () => {
    const csv = 'blind_id,commit,severity,category,file,detail,label,proof,cluster,matches,pattern\nF003,abc,LOW,cat,file.js,"he said ""hi""",plausible,proof,,,\n';
    const rows = parseBlindCsv(csv);
    assert.equal(rows[0].detail, 'he said "hi"');
  });
  it('handles a quoted field containing an embedded newline', () => {
    const csv = 'blind_id,commit,severity,category,file,detail,label,proof,cluster,matches,pattern\nF004,abc,MEDIUM,cat,file.js,"line one\nline two",actionable,proof,,,\n';
    const rows = parseBlindCsv(csv);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].detail, 'line one\nline two');
  });
  it('returns an empty array for empty input', () => {
    assert.deepEqual(parseBlindCsv(''), []);
  });
  it('skips a trailing blank line', () => {
    const csv = 'blind_id,commit,severity,category,file,detail,label,proof,cluster,matches,pattern\nF005,abc,LOW,cat,file.js,d,false,p,,,\n\n';
    assert.equal(parseBlindCsv(csv).length, 1);
  });
  it('throws on a header mismatch (reordered or renamed column) rather than silently mis-mapping fields (audit fix H4/M7)', () => {
    const csv = 'blind_id,commit,category,severity,file,detail,label,proof,cluster,matches,pattern\nF006,abc,cat,LOW,file.js,d,false,p,,,\n';
    assert.throws(() => parseBlindCsv(csv), /header mismatch/);
  });
  it('throws on a header with a missing column rather than silently mis-mapping fields', () => {
    const csv = 'blind_id,commit,severity,category,file,detail,label,proof,cluster,matches\nF007,abc,LOW,cat,file.js,d,false,p,,\n';
    assert.throws(() => parseBlindCsv(csv), /header mismatch/);
  });
  it('throws on an unterminated quoted field at EOF rather than absorbing the rest of the file (audit fix H5/M8)', () => {
    const csv = 'blind_id,commit,severity,category,file,detail,label,proof,cluster,matches,pattern\nF008,abc,LOW,cat,file.js,"unterminated,false,p,,,\n';
    assert.throws(() => parseBlindCsv(csv), /unterminated quoted field/);
  });
  it('throws on a stray mid-field quote rather than silently deleting it (audit fix M5, round 2)', () => {
    const csv = 'blind_id,commit,severity,category,file,detail,label,proof,cluster,matches,pattern\nF009,abc,LOW,cat,file.js,abc"def,false,p,,,\n';
    assert.throws(() => parseBlindCsv(csv), /stray quote mid-field/);
  });
  it('throws on a data row with too few fields rather than padding with empty strings (audit fix H2, round 2)', () => {
    const csv = 'blind_id,commit,severity,category,file,detail,label,proof,cluster,matches,pattern\nF010,abc,LOW,cat,file.js,d,false,p,\n';
    assert.throws(() => parseBlindCsv(csv), /expected 11/);
  });
  it('throws on a data row with too many fields rather than silently dropping extras (audit fix H2, round 2)', () => {
    const csv = 'blind_id,commit,severity,category,file,detail,label,proof,cluster,matches,pattern\nF011,abc,LOW,cat,file.js,d,false,p,,,,extra\n';
    assert.throws(() => parseBlindCsv(csv), /expected 11/);
  });
});

describe('computeTwoJudgeConsensus', () => {
  const mkRow = (id, label) => ({ blind_id: id, label });
  it('agrees when both judges land in the same tier (valid)', () => {
    const c = computeTwoJudgeConsensus([mkRow('F1', 'proven')], [mkRow('F1', 'actionable')]);
    assert.equal(c.get('F1').consensusTier, 'valid');
  });
  it('agrees when both judges land in the same tier (dismissed)', () => {
    const c = computeTwoJudgeConsensus([mkRow('F1', 'plausible')], [mkRow('F1', 'false')]);
    assert.equal(c.get('F1').consensusTier, 'dismissed');
  });
  it('reports no-consensus when judges disagree on tier', () => {
    const c = computeTwoJudgeConsensus([mkRow('F1', 'proven')], [mkRow('F1', 'false')]);
    assert.equal(c.get('F1').consensusTier, 'no-consensus');
  });
  it('excludes a row with no matching GPT grading rather than defaulting', () => {
    const c = computeTwoJudgeConsensus([mkRow('F1', 'proven')], []);
    assert.equal(c.has('F1'), false);
  });
  it('excludes a row with an unrecognized label rather than misclassifying it as dismissed (audit fix H3)', () => {
    const c = computeTwoJudgeConsensus([mkRow('F1', 'not-a-real-label')], [mkRow('F1', 'proven')]);
    assert.equal(c.has('F1'), false);
  });
  it('throws on a duplicate blind_id in the GPT sheet rather than silently keeping the last one (audit fix M3)', () => {
    assert.throws(
      () => computeTwoJudgeConsensus([mkRow('F1', 'proven')], [mkRow('F1', 'proven'), mkRow('F1', 'false')]),
      /duplicate blind_id/
    );
  });
  it('throws on a duplicate blind_id in the Claude sheet too, not just GPT (audit fix H3, round 2)', () => {
    assert.throws(
      () => computeTwoJudgeConsensus([mkRow('F1', 'proven'), mkRow('F1', 'false')], [mkRow('F1', 'proven')]),
      /duplicate blind_id/
    );
  });
});

describe('retrofitEvidenceType — best-effort heuristic', () => {
  it('detects an omission signal ("does not")', () => {
    assert.equal(retrofitEvidenceType({ category: 'cache', detail: 'the schema change does not invalidate the cache' }), 'omission');
  });
  it('detects an omission signal ("missing")', () => {
    assert.equal(retrofitEvidenceType({ category: 'locking', detail: 'missing transaction lock around the update' }), 'omission');
  });
  it('defaults to commission when no omission signal is present', () => {
    assert.equal(retrofitEvidenceType({ category: 'sql', detail: 'user input is concatenated directly into the query string' }), 'commission');
  });
});

describe('buildContrarianStratifiedWorksheet', () => {
  const rows = [
    { blind_id: 'F1', severity: 'HIGH', category: 'x', detail: 'y', matches: '' },     // contrarian candidate
    { blind_id: 'F2', severity: 'MEDIUM', category: 'x', detail: 'y', matches: 'KD-001' }, // known-defect
    { blind_id: 'F3', severity: 'HIGH', category: 'x', detail: 'y', matches: '' },     // high-dismissal
    { blind_id: 'F4', severity: 'LOW', category: 'cache', detail: 'does not invalidate cache', matches: '' }, // omission-dismissal
    { blind_id: 'F5', severity: 'LOW', category: 'x', detail: 'y', matches: '' },      // remainder -> random tail
    { blind_id: 'F6', severity: 'LOW', category: 'x', detail: 'y', matches: '' },      // remainder -> random tail
  ];
  const consensus = new Map([
    ['F1', { consensusTier: 'valid' }],
    ['F3', { consensusTier: 'dismissed' }],
    ['F4', { consensusTier: 'dismissed' }],
  ]);
  const candidateTier = new Map([
    ['F1', 'dismissed'], // disagrees with consensus 'valid' -> contrarian
  ]);

  it('places a candidate/consensus disagreement in the contrarian stratum', () => {
    const { worksheetRows } = buildContrarianStratifiedWorksheet(rows, consensus, candidateTier, { tailSize: 10, seed: 1 });
    const f1 = worksheetRows.find((r) => r.blind_id === 'F1');
    assert.equal(f1.stratum, 'contrarian');
  });
  it('places a KD-matched row in the known-defect stratum even without a candidate verdict', () => {
    const { worksheetRows } = buildContrarianStratifiedWorksheet(rows, consensus, candidateTier, { tailSize: 10, seed: 1 });
    const f2 = worksheetRows.find((r) => r.blind_id === 'F2');
    assert.equal(f2.stratum, 'known-defect');
  });
  it('places a HIGH+dismissed row in the high-dismissal stratum', () => {
    const { worksheetRows } = buildContrarianStratifiedWorksheet(rows, consensus, candidateTier, { tailSize: 10, seed: 1 });
    const f3 = worksheetRows.find((r) => r.blind_id === 'F3');
    assert.equal(f3.stratum, 'high-dismissal');
  });
  it('places an omission-retrofit+dismissed row in the omission-dismissal stratum', () => {
    const { worksheetRows } = buildContrarianStratifiedWorksheet(rows, consensus, candidateTier, { tailSize: 10, seed: 1 });
    const f4 = worksheetRows.find((r) => r.blind_id === 'F4');
    assert.equal(f4.stratum, 'omission-dismissal');
  });
  it('includes remainder rows in the random tail, capped at tailSize', () => {
    const { worksheetRows, strata } = buildContrarianStratifiedWorksheet(rows, consensus, candidateTier, { tailSize: 1, seed: 1 });
    const tailRows = worksheetRows.filter((r) => r.stratum === 'random-tail');
    assert.equal(tailRows.length, 1);
    assert.equal(strata.find((s) => s.name === 'random-tail').count, 1);
  });
  it('never places the same row in two strata (dedup, first-match-wins)', () => {
    // F3 is both HIGH+dismissed AND (if consensus said no) could double-count; verify total worksheet rows == unique blind_ids
    const { worksheetRows } = buildContrarianStratifiedWorksheet(rows, consensus, candidateTier, { tailSize: 10, seed: 1 });
    const ids = worksheetRows.map((r) => r.blind_id);
    assert.equal(ids.length, new Set(ids).size);
  });
  it('is deterministic for a fixed seed', () => {
    const a = buildContrarianStratifiedWorksheet(rows, consensus, candidateTier, { tailSize: 1, seed: 42 });
    const b = buildContrarianStratifiedWorksheet(rows, consensus, candidateTier, { tailSize: 1, seed: 42 });
    assert.deepEqual(a.worksheetRows.map((r) => r.blind_id), b.worksheetRows.map((r) => r.blind_id));
  });
});

describe('wilsonScoreInterval', () => {
  it('returns [null, null] for zero total', () => {
    assert.deepEqual(wilsonScoreInterval(0, 0), [null, null]);
  });
  it('returns a widening interval around 0 successes / small N', () => {
    const [lo, hi] = wilsonScoreInterval(0, 5);
    assert.equal(lo, 0);
    assert.ok(hi > 0 && hi < 1);
  });
  it('returns a narrow interval for a large N with a stable rate', () => {
    const [lo, hi] = wilsonScoreInterval(50, 1000);
    assert.ok(hi - lo < 0.05);
  });
});

describe('computeValidationManifest', () => {
  const gradedStrata = [
    { name: 'high-dismissal', gradedRows: [{ humanFalseDismissal: false }, { humanFalseDismissal: false }, { humanFalseDismissal: true }] },
    { name: 'omission-dismissal', gradedRows: [{ humanFalseDismissal: false }] },
    { name: 'random-tail', gradedRows: [{ humanFalseDismissal: false }, { humanFalseDismissal: false }] },
  ];
  it('computes per-stratum falseDismissalRate + ci95', () => {
    const m = computeValidationManifest(gradedStrata, { candidateModel: 'glm-5.2', datasetHash: 'abc', generatedAt: '2026-01-01T00:00:00Z' });
    const hd = m.strata.find((s) => s.name === 'high-dismissal');
    assert.equal(hd.count, 3);
    assert.ok(Math.abs(hd.falseDismissalRate - (1 / 3)) < 0.001);
  });
  it('passes when load-bearing + overall rates are within default thresholds', () => {
    const allGood = [
      { name: 'high-dismissal', gradedRows: Array.from({ length: 20 }, () => ({ humanFalseDismissal: false })) },
      { name: 'omission-dismissal', gradedRows: Array.from({ length: 20 }, () => ({ humanFalseDismissal: false })) },
    ];
    const m = computeValidationManifest(allGood, { candidateModel: 'x', datasetHash: 'h', generatedAt: 'now' });
    assert.equal(m.passed, true);
  });
  it('fails when a load-bearing stratum exceeds its threshold', () => {
    const m = computeValidationManifest(gradedStrata, { candidateModel: 'x', datasetHash: 'h', generatedAt: 'now' });
    assert.equal(m.passed, false); // high-dismissal rate 1/3 >> 0.05 default
  });
  it('honors explicit threshold overrides', () => {
    const m = computeValidationManifest(gradedStrata, {
      candidateModel: 'x', datasetHash: 'h', generatedAt: 'now',
      thresholds: { highOrOmissionMaxFalseDismissalRate: 0.5, overallMaxFalseDismissalRate: 0.5 },
    });
    assert.equal(m.passed, true);
  });
  it('handles an empty stratum without throwing (null rate, not NaN)', () => {
    const m = computeValidationManifest([{ name: 'x', gradedRows: [] }], { candidateModel: 'x', datasetHash: 'h', generatedAt: 'now' });
    assert.equal(m.strata[0].falseDismissalRate, null);
  });
});

describe('renderValidationMarkdown', () => {
  it('renders a table row per stratum and the pass/fail verdict', () => {
    const manifest = computeValidationManifest(
      [{ name: 'high-dismissal', gradedRows: [{ humanFalseDismissal: false }] }],
      { candidateModel: 'glm-5.2', datasetHash: 'abc123', generatedAt: '2026-01-01T00:00:00Z' }
    );
    const md = renderValidationMarkdown(manifest);
    assert.match(md, /glm-5\.2/);
    assert.match(md, /high-dismissal/);
    assert.match(md, /PASSED|FAILED/);
  });
});

describe('computeDatasetHash', () => {
  it('is deterministic for the same content', () => {
    assert.equal(computeDatasetHash('a', 'b'), computeDatasetHash('a', 'b'));
  });
  it('differs when either input changes', () => {
    assert.notEqual(computeDatasetHash('a', 'b'), computeDatasetHash('a', 'c'));
    assert.notEqual(computeDatasetHash('a', 'b'), computeDatasetHash('x', 'b'));
  });
});

describe('runCandidateTriage — injectable adapter, never a live call', () => {
  it('collects verdicts from the stub adapter keyed by blind_id', async () => {
    const rows = [{ blind_id: 'F1' }, { blind_id: 'F2' }];
    const result = await runCandidateTriage(rows, { callAdapter: async (r) => (r.blind_id === 'F1' ? 'valid' : 'dismissed') });
    assert.equal(result.get('F1'), 'valid');
    assert.equal(result.get('F2'), 'dismissed');
  });
  it('omits a row whose adapter call throws, rather than crashing the batch', async () => {
    const rows = [{ blind_id: 'F1' }, { blind_id: 'F2' }];
    const result = await runCandidateTriage(rows, {
      callAdapter: async (r) => { if (r.blind_id === 'F1') throw new Error('boom'); return 'valid'; },
    });
    assert.equal(result.has('F1'), false);
    assert.equal(result.get('F2'), 'valid');
  });
  it('omits a row whose adapter returns an unrecognized verdict', async () => {
    const rows = [{ blind_id: 'F1' }];
    const result = await runCandidateTriage(rows, { callAdapter: async () => 'maybe' });
    assert.equal(result.has('F1'), false);
  });
});
