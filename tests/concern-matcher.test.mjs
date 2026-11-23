/**
 * Plan: docs/plans/seeded-defect-benchmark.md §1.4, §8. Offline: judges are injected,
 * nothing reaches a provider.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  filterCandidates, prepareJudgePayload, judgePairs, assignMatches, classifyNovelty, createJudge,
  scoreRecall, stampMismatch, MATCHER_VERSION, makePairId, DEFAULT_JUDGE_SENTINELS,
} from '../scripts/lib/model-eval/concern-matcher.mjs';
import {
  wilson, scoreCalibration, ACCEPT_BAR, drawCalibrationSets, renderWorksheet, joinWorksheetLabels, makeRng,
} from '../scripts/lib/model-eval/matcher-calibration.mjs';
import { resolveModel, modelFamily } from '../scripts/lib/model-resolver.mjs';

// A fake judge that reads the concern tag `[c:N]` out of each side of the REAL payload.
function taggedJudge(fn) {
  return {
    stamp: { sentinel: 'fake', provider: 'fake', model: 'fake', backend: null, matcherVersion: MATCHER_VERSION },
    async call({ user }) {
      const f = /<concern_f>[\s\S]*?\[c:(\w+)\][\s\S]*?<\/concern_f>/.exec(user)?.[1];
      const x = /<concern_x>[\s\S]*?\[c:(\w+)\][\s\S]*?<\/concern_x>/.exec(user)?.[1];
      const quote = /<concern_f>[\s\S]*?text:\n([^\n]*)/.exec(user)?.[1] ?? '';
      return fn(f, x, quote);
    },
  };
}
const oracle = taggedJudge((f, x, quote) => ({ verdict: f === x ? 'same' : 'different', quote }));

const mkX = (n, over = {}) => ({ id: `X${n}`, file: `src/d${n}.js`, lines: 10, severity: 'HIGH', text: `[c:${n}] defect number ${n}`, ...over });
const mkF = (id, c, over = {}) => ({ id, file: `src/d${c}.js`, lines: 12, severity: 'HIGH', text: `[c:${c}] finding about ${c}`, ...over });

async function pipeline(findings, xs, judge) {
  const pairs = filterCandidates(findings, xs);
  const j = await judgePairs({ pairs, judge });
  return { j, a: assignMatches({ findings, xs, verdicts: j.results }) };
}

// ── scorer controls ────────────────────────────────────────────────────────────

test('oracle scores 1.0 and null scores 0', async () => {
  const xs = [1, 2, 3, 4, 5].map((n) => mkX(n));
  const findings = [1, 2, 3, 4, 5].map((n) => mkF(`F${n}`, n));
  const { a } = await pipeline(findings, xs, oracle);
  assert.equal(scoreRecall(a, xs), 1);
  // null: same files, unrelated concerns
  const nullF = [1, 2, 3, 4, 5].map((n) => mkF(`N${n}`, `z${n}`, { file: `src/d${n}.js` }));
  const r = await pipeline(nullF, xs, oracle);
  assert.equal(scoreRecall(r.a, xs), 0);
});

test('shuffled findings score ~0 (a derangement of concerns)', async () => {
  const xs = Array.from({ length: 20 }, (_, i) => mkX(i));
  // every finding sits in its own defect's file but describes the NEXT defect's concern
  const findings = xs.map((x, i) => mkF(`F${i}`, (i + 1) % 20, { file: x.file }));
  const { a } = await pipeline(findings, xs, oracle);
  assert.equal(scoreRecall(a, xs), 0);
});

test('a duplicate is credited once and is neither credit nor false positive', async () => {
  const xs = [mkX(1)];
  const findings = [mkF('F1', 1), mkF('F2', 1)];
  const { a } = await pipeline(findings, xs, oracle);
  assert.equal(a.matches.length, 1);
  assert.equal(scoreRecall(a, xs), 1);
  assert.equal(a.duplicates.length, 1);
  assert.deepEqual(a.unmatchedFindingIds, []);
  assert.equal(a.matches[0].fId + a.duplicates[0].fId, 'F1F2');
});

// ── filter ─────────────────────────────────────────────────────────────────────

test('filter window: ±15 inclusive when both cite lines; no-line is a candidate for every X in its file', () => {
  const x = { id: 'X', file: 'src/A.js', lines: 100, severity: 'LOW', text: 't' };
  const at = (line) => filterCandidates([{ id: 'F', file: 'src/a.js', lines: line, text: 't' }], [x]).length;
  assert.equal(at(115), 1);
  assert.equal(at(85), 1);
  assert.equal(at(116), 0);
  assert.equal(at(84), 0);
  assert.equal(filterCandidates([{ id: 'F', file: 'src/a.js', text: 't' }], [x]).length, 1, 'no-line finding');
  assert.equal(filterCandidates([{ id: 'F', file: 'src/a.js', lines: 999, text: 't' }], [{ ...x, lines: undefined }]).length, 1, 'no-line X');
  assert.equal(filterCandidates([{ id: 'F', file: 'src/b.js', lines: 100, text: 't' }], [x]).length, 0, 'other file');
});

test('filter: file normalisation, ranges, a defect over two files, and input-order independence', () => {
  const x = { id: 'X', files: ['src/a.js', 'src/b.js'], lines: 1, severity: 'HIGH', text: 't' };
  const fs = [
    { id: 'F1', file: '.\\SRC\\B.js', lines: 500, text: 't' },
    { id: 'F2', file: 'src/a.js', lines: [90, 110], text: 't' },
    { id: 'F3', file: 'src/c.js', text: 't' },
  ];
  // a two-file defect cites no single line frame => every finding in either file is a candidate
  assert.deepEqual(filterCandidates(fs, [x]).map((c) => c.fId), ['F1', 'F2']);
  const ranged = filterCandidates([{ id: 'F', file: 'a.js', lines: [90, 100], text: 't' }], [{ id: 'X', file: 'a.js', lines: [110, 120], text: 't' }]);
  assert.equal(ranged.length, 1, 'gap 10 <= 15');
  assert.deepEqual(filterCandidates([...fs].reverse(), [x]).map((c) => c.pairId), filterCandidates(fs, [x]).map((c) => c.pairId));
});

// ── assignment ────────────────────────────────────────────────────────────────

function shuffle(arr, rng) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(rng() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
  return a;
}
const same = (fId, xId) => ({ fId, xId, verdict: 'same' });

function assertStable(findings, xs, verdicts, expectMatches) {
  const rng = makeRng('perm');
  const canon = JSON.stringify(assignMatches({ findings, xs, verdicts }));
  assert.deepEqual(assignMatches({ findings, xs, verdicts }).matches, expectMatches);
  for (let i = 0; i < 300; i++) {
    const r = assignMatches({ findings: shuffle(findings, rng), xs: shuffle(xs, rng), verdicts: shuffle(verdicts, rng) });
    assert.equal(JSON.stringify(r), canon, `permutation ${i} changed the matching`);
  }
}

test('assignment is identical for every shuffle: one finding equidistant from a HIGH and a LOW defect', () => {
  const xs = [{ id: 'xh', file: 'a', lines: 20, severity: 'HIGH' }, { id: 'xl', file: 'a', lines: 40, severity: 'LOW' }];
  const findings = [{ id: 'f1', file: 'a', lines: 30, severity: 'MEDIUM' }];
  assertStable(findings, xs, [same('f1', 'xh'), same('f1', 'xl')], [{ xId: 'xh', fId: 'f1' }]);
});

test('assignment is identical for every shuffle: two findings tied for one defect', () => {
  const xs = [{ id: 'x1', file: 'a', lines: 10, severity: 'HIGH' }];
  const findings = [
    { id: 'fb', file: 'a', lines: 12, severity: 'LOW' },
    { id: 'fa', file: 'a', lines: 12, severity: 'LOW' },
    { id: 'fc', file: 'a', lines: 11, severity: 'LOW' },
    { id: 'fh', file: 'a', lines: 30, severity: 'HIGH' },
  ];
  // F severity desc beats line distance
  assertStable(findings, xs, findings.map((f) => same(f.id, 'x1')), [{ xId: 'x1', fId: 'fh' }]);
  // then line distance, then id
  const low = findings.slice(0, 3);
  assertStable(low, xs, low.map((f) => same(f.id, 'x1')), [{ xId: 'x1', fId: 'fc' }]);
  assertStable(low.slice(0, 2), xs, low.slice(0, 2).map((f) => same(f.id, 'x1')), [{ xId: 'x1', fId: 'fa' }]);
});

test('maximum cardinality beats the locally best edge', () => {
  const xs = [{ id: 'xh', file: 'a', lines: 1, severity: 'HIGH' }, { id: 'xl', file: 'a', lines: 1, severity: 'LOW' }];
  const findings = [{ id: 'f1', file: 'a', lines: 1, severity: 'HIGH' }, { id: 'f2', file: 'a', lines: 1, severity: 'LOW' }];
  // f1 would love xh (best key) but f2 only has xh: the only size-2 matching is f1-xl, f2-xh
  assertStable(findings, xs, [same('f1', 'xh'), same('f1', 'xl'), same('f2', 'xh')],
    [{ xId: 'xh', fId: 'f2' }, { xId: 'xl', fId: 'f1' }]);
});

test('ids are stable strings, never array positions', () => {
  const a = assignMatches({ findings: [{ id: 7, file: 'a' }], xs: [{ id: 7, file: 'a' }], verdicts: [{ fId: '7', xId: '7', verdict: 'same' }] });
  assert.deepEqual(a.matches, [{ xId: '7', fId: '7' }]);
  assert.equal(makePairId('a', 'b'), makePairId('a', 'b'));
});

test('partial never credits and never makes F non-novel', async () => {
  const xs = [mkX(1)];
  const findings = [mkF('F1', 1)];
  const a = assignMatches({ findings, xs, verdicts: [{ fId: 'F1', xId: 'X1', verdict: 'partial' }] });
  assert.equal(a.matches.length, 0);
  assert.deepEqual(a.partials, [{ fId: 'F1', xId: 'X1' }]);
  const partialJudge = taggedJudge((f, x, quote) => ({ verdict: 'partial', quote }));
  const n = await classifyNovelty({ findings, ledgerEntries: xs, judge: partialJudge });
  assert.equal(n.perFinding[0].novel, true);
  assert.deepEqual(n.perFinding[0].flags, ['partial-of X1']);
  assert.equal(n.incomplete, false);
});

// ── judge fail-closed ─────────────────────────────────────────────────────────

test('an unknown verdict, a throwing call and a `same` without a quote from F all fail closed', async () => {
  const xs = [mkX(1)];
  const findings = [mkF('F1', 1)];
  for (const [name, judge] of [
    ['unknown verdict', taggedJudge((f, x, q) => ({ verdict: 'maybe', quote: q }))],
    ['missing verdict', taggedJudge(() => ({ quote: 'x' }))],
    ['null', taggedJudge(() => null)],
    ['throws', { stamp: {}, async call() { throw Object.assign(new Error('boom'), { status: 500 }); } }],
    ['quote not in F', taggedJudge(() => ({ verdict: 'same', quote: 'words the finding never said' }))],
  ]) {
    const n = await classifyNovelty({ findings, ledgerEntries: xs, judge });
    assert.equal(n.incomplete, true, name);
    assert.equal(n.counts.notJudged, 1, name);
    assert.ok(n.perFinding[0].flags.includes('not-judged'), name);
  }
});

test('novelty: `same` => not novel; _priorRuling => not novel; otherwise novel', async () => {
  const xs = [mkX(1), mkX(2)];
  const findings = [mkF('F1', 1), mkF('F2', 9, { file: 'src/d2.js' }), mkF('F3', 9, { file: 'src/d2.js', _priorRuling: true })];
  const n = await classifyNovelty({ findings, ledgerEntries: xs, judge: oracle });
  assert.deepEqual(n.perFinding.map((p) => [p.id, p.novel]), [['F1', false], ['F2', true], ['F3', false]]);
  assert.deepEqual(n.perFinding[0].sameOf, ['X1']);
});

// ── judge resolution ──────────────────────────────────────────────────────────

test('default primary judge: latest-opus, pinned {backend:"sdk"}, gated on isClaudeAvailableFor("sdk")', async () => {
  assert.equal(DEFAULT_JUDGE_SENTINELS.primary, 'latest-opus');
  assert.equal(DEFAULT_JUDGE_SENTINELS.secondary, 'latest-pro');
  let opts; let gate;
  const fakeClient = { messages: { create: async () => ({ content: [] }) } };
  const judge = await createJudge({ deps: {
    isClaudeAvailableFor: (b) => { gate = b; return true; },
    createClient: async (o) => { opts = o; return fakeClient; },
  } });
  assert.deepEqual(opts, { backend: 'sdk' });
  assert.equal(gate, 'sdk');
  assert.equal(judge.stamp.provider, 'anthropic');
  assert.equal(judge.stamp.model, resolveModel('latest-opus'));
  assert.equal(judge.stamp.backend, 'sdk');
  await assert.rejects(() => createJudge({ deps: { isClaudeAvailableFor: () => false, createClient: async () => fakeClient } }), /sdk backend/);
});

test('second judge is a different provider family; a repeat whose resolution differs is a stampMismatch', async () => {
  const gem = await createJudge({ sentinel: 'latest-pro', deps: { geminiClient: { models: { generateContent: async () => ({}) } } } });
  const opus = await createJudge({ deps: { anthropicClient: { messages: { create: async () => ({}) } } } });
  assert.equal(gem.stamp.provider, 'google');
  assert.notEqual(modelFamily(gem.stamp.model), modelFamily(opus.stamp.model));
  assert.equal(stampMismatch(opus.stamp, { ...opus.stamp }), false);
  assert.equal(stampMismatch(opus.stamp, { ...opus.stamp, model: 'claude-opus-9' }), true);
  assert.equal(stampMismatch(opus.stamp, null), true);
});

test('prepareJudgePayload: ok payload carries both sides and no array-position identity', () => {
  const p = prepareJudgePayload({ f: mkF('F1', 1), x: mkX(1) });
  assert.equal(p.ok, true);
  assert.match(p.user, /<concern_f>[\s\S]*F1[\s\S]*<\/concern_f>/);
  assert.match(p.user, /<concern_x>[\s\S]*X1[\s\S]*<\/concern_x>/);
});

// ── calibration ───────────────────────────────────────────────────────────────

test('wilson interval math', () => {
  const w = wilson(36, 40);
  assert.equal(w.p, 0.9);
  assert.ok(Math.abs(w.lo - 0.7695) < 1e-3, `lo ${w.lo}`);
  assert.ok(Math.abs(w.hi - 0.9604) < 1e-3, `hi ${w.hi}`);
  assert.deepEqual(wilson(0, 0), { k: 0, n: 0, p: null, lo: null, hi: null });
  assert.equal(wilson(0, 10).lo, 0);
  assert.equal(wilson(10, 10).hi, 1);
});

let seq = 0;
function pair(arm, set, label, verdict, extra = {}) {
  seq += 1;
  return { row: { pairId: `p${seq}`, set, stratum: extra.stratum ?? (set === 'prevalence' ? 'prevalence' : 'same'), sourceArm: arm, label, f: { text: extra.f ?? 'alpha beta gamma' }, x: { text: extra.x ?? 'alpha beta gamma' } }, verdict: { pairId: `p${seq}`, verdict } };
}
function build(spec) {
  const rows = spec.flatMap(([n, ...a]) => Array.from({ length: n }, () => pair(...a)));
  return { labelled: rows.map((r) => r.row), judgeVerdicts: rows.map((r) => r.verdict) };
}
const filterOk = (kept, n) => Array.from({ length: n }, (_, i) => ({ pairId: `fr${i}`, keptByFilter: i < kept }));

const goodSpec = [
  [10, 'A', 'prevalence', 'same', 'same'], [10, 'B', 'prevalence', 'same', 'same'],
  [15, 'A', 'prevalence', 'different', 'different'], [15, 'B', 'prevalence', 'different', 'different'],
  [10, 'A', 'challenge', 'same', 'same'], [10, 'B', 'challenge', 'same', 'same'],
];

test('calibration: accept when every bar clears', () => {
  const r = scoreCalibration({ ...build(goodSpec), filterRecallPairs: filterOk(20, 20) });
  assert.equal(r.decision.status, 'accept', JSON.stringify(r.decision));
  assert.equal(r.judge.prevalence.precision.p, 1);
  assert.equal(r.judge.prevalence.recall.p, 1);
  assert.equal(r.judge.perArm.A.same, 20);
  assert.equal(r.counts.perSet.prevalence, 50);
});

test('calibration: precision below 0.90 fails', () => {
  const spec = [...goodSpec, [5, 'A', 'prevalence', 'different', 'same']];
  const r = scoreCalibration({ ...build(spec), filterRecallPairs: filterOk(20, 20) });
  assert.equal(r.decision.status, 'fail');
  assert.match(r.decision.reasons.join(), /precision 0\.800/);
});

test('calibration: recall below 0.85 and filter recall below 0.95 each fail', () => {
  const lowRecall = [...goodSpec, [5, 'A', 'prevalence', 'same', 'different']];
  const r1 = scoreCalibration({ ...build(lowRecall), filterRecallPairs: filterOk(20, 20) });
  assert.equal(r1.decision.status, 'fail');
  assert.match(r1.decision.reasons.join(), /recall 0\.8/);
  const r2 = scoreCalibration({ ...build(goodSpec), filterRecallPairs: filterOk(18, 20) });
  assert.equal(r2.decision.status, 'fail');
  assert.match(r2.decision.reasons.join(), /filter recall 0\.900/);
});

test('calibration: fewer than 15 same pairs in an arm is inconclusive, not fail and not accept', () => {
  const spec = [
    [10, 'A', 'prevalence', 'same', 'same'], [4, 'B', 'prevalence', 'same', 'same'],
    [10, 'A', 'challenge', 'same', 'same'], [4, 'B', 'challenge', 'same', 'same'],
    [10, 'A', 'prevalence', 'different', 'different'],
  ];
  const r = scoreCalibration({ ...build(spec), filterRecallPairs: filterOk(20, 20) });
  assert.equal(r.decision.status, 'inconclusive');
  assert.match(r.decision.inconclusiveReasons.join(), /arm-B-has-8-same/);
});

test('calibration: per-arm recall gap above 0.05 fails even when pooled recall clears', () => {
  const spec = [
    [10, 'A', 'prevalence', 'same', 'same'], [10, 'B', 'prevalence', 'same', 'same'],
    [15, 'A', 'prevalence', 'different', 'different'], [15, 'B', 'prevalence', 'different', 'different'],
    [10, 'A', 'challenge', 'same', 'same'],
    [6, 'B', 'challenge', 'same', 'same'], [4, 'B', 'challenge', 'same', 'different'], // arm B recall 16/20 = 0.8
  ];
  const r = scoreCalibration({ ...build(spec), filterRecallPairs: filterOk(20, 20) });
  assert.ok(r.judge.prevalence.recall.p >= 0.85);
  assert.ok(Math.abs(r.armRecallGap - 0.2) < 1e-9);
  assert.equal(r.decision.status, 'fail');
  assert.match(r.decision.reasons.join(), /per-arm recall gap/);
});

test('calibration: Jaccard-0.15 negative control misses a paraphrase the judge finds; not-judged counts as not-same', () => {
  const para = { f: 'the lock is never released on error', x: 'mutex stays held after failure path' };
  const spec = [...goodSpec, [3, 'A', 'challenge', 'same', 'same', para], [1, 'A', 'prevalence', 'same', 'not-judged']];
  const r = scoreCalibration({ ...build(spec), filterRecallPairs: filterOk(20, 20) });
  assert.equal(r.control.missedSameFoundByJudge, 3);
  assert.equal(r.judge.notJudged, 1);
  assert.equal(r.judge.prevalence.fn, 1);
});

test('calibration: refuses an unlabelled pair or a missing verdict instead of scoring a partial file', () => {
  const b = build(goodSpec);
  assert.throws(() => scoreCalibration({ ...b, judgeVerdicts: b.judgeVerdicts.slice(1) }), /no judge verdict/);
  b.labelled[0].label = 'yes';
  assert.throws(() => scoreCalibration(b), /expected one of/);
});

test('sampler + worksheet: deterministic, order-independent, disjoint, blinded', () => {
  const files = ['a.js', 'b.js', 'c.js', 'd.js'];
  const findings = Array.from({ length: 40 }, (_, i) => ({ id: `f${i}`, file: files[i % 4], lines: i, severity: 'HIGH', text: `finding text ${i} lock leak`, arm: i % 2 ? 'META' : 'CONTINUE' }));
  const ledger = Array.from({ length: 24 }, (_, i) => ({ id: `x${i}`, file: files[i % 4], lines: i * 2, severity: 'LOW', text: `ledger text ${i} lock leak`, arm: 'META' }));
  const sizes = { challenge: 12, prevalence: 8, filterRecall: 6 };
  const s1 = drawCalibrationSets({ findings, ledgerEntries: ledger, seed: 7, sizes });
  const s2 = drawCalibrationSets({ findings: [...findings].reverse(), ledgerEntries: [...ledger].reverse(), seed: 7, sizes });
  assert.deepEqual(s1.prevalence.map((p) => p.pairId), s2.prevalence.map((p) => p.pairId));
  assert.deepEqual(s1.challenge.map((p) => p.pairId), s2.challenge.map((p) => p.pairId));
  assert.equal(s1.prevalence.length, 8);
  assert.equal(s1.challenge.length, 12);
  assert.equal(s1.filterRecall.length, 6);
  const prev = new Set(s1.prevalence.map((p) => p.pairId));
  assert.ok(s1.challenge.every((p) => !prev.has(p.pairId)), 'challenge and prevalence are disjoint');
  assert.notDeepEqual(s1.prevalence.map((p) => p.pairId), drawCalibrationSets({ findings, ledgerEntries: ledger, seed: 8, sizes }).prevalence.map((p) => p.pairId));

  const w = renderWorksheet(s1, { seed: 7, ledgerEntries: ledger });
  assert.equal(JSON.stringify(w), JSON.stringify(renderWorksheet(s2, { seed: 7, ledgerEntries: ledger })));
  assert.ok(!/META|CONTINUE|intendedStratum|same-like|hard-negative|easy-negative|arm/i.test(w.worksheetMarkdown.replace(/^.*Label each pair.*$/m, '').replace(/^For Part B.*$/m, '')), 'worksheet hides arm and strata');
  assert.equal(Object.keys(w.key.pairs).length, 20);

  // round-trip a labelling
  const answers = { pairs: {}, filterRecall: {} };
  for (const id of Object.keys(w.key.pairs)) answers.pairs[id] = 'different';
  for (const id of Object.keys(w.key.filterRecall)) answers.filterRecall[id] = [];
  const joined = joinWorksheetLabels({ key: w.key, answers, findings, ledgerEntries: ledger });
  assert.equal(joined.labelled.length, 20);
  delete answers.pairs.P001;
  assert.throws(() => joinWorksheetLabels({ key: w.key, answers, findings, ledgerEntries: ledger }), /unanswered/);
});

test('ACCEPT_BAR is the §1.4 bar', () => {
  assert.deepEqual({ ...ACCEPT_BAR }, { precision: 0.9, recall: 0.85, filterRecall: 0.95, armRecallGap: 0.05, minSamePerArm: 15 });
});
