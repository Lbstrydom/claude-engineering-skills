/**
 * @fileoverview Calibration of the concern matcher against a human-labelled pair
 * file: the gate that must pass before any aggregate figure of the seeded-defect
 * benchmark is read (plan docs/plans/seeded-defect-benchmark.md §1.4).
 *
 * Two halves, both pure and seeded (no I/O, no clock, no network):
 *
 *   - `drawCalibrationSets` + `renderWorksheet`: draw the three samples and emit a
 *     BLINDED worksheet (markdown) plus a JSON key (seeded shuffle; arm, judge
 *     verdict and the sampler's intended stratum never appear in the worksheet).
 *   - `scoreCalibration`: judge (and a Jaccard-0.15 negative control, reusing the
 *     repo's FUZZY_CONFIG_V2) against the labels: per-stratum / per-arm counts,
 *     Wilson 95% precision and recall of `same`, prevalence-weighted precision,
 *     filter recall, and the accept bar.
 *
 * Sampling honesty: whether a candidate pair is `same` cannot be known before a
 * human labels it, so the challenge set's thirds are INTENDED strata. "same-like"
 * pairs are drawn from the filter's output by high lexical overlap, "hard
 * negatives" by low overlap in the same file, "easy negatives" across files. The
 * human label is the truth; `scoreCalibration` stratifies on the label, and a
 * shortfall of real positives is reported, never padded. The enrichment biases
 * only the challenge set, which is why the accept bar reads the prevalence set.
 *
 * @module scripts/lib/model-eval/matcher-calibration
 */

import { jaccardSimilarity } from '../text-similarity.mjs';
import { FUZZY_CONFIG_V2 } from './deterministic-scorer.mjs';
import { filterCandidates, makePairId, fileKey, DEFAULT_LINE_WINDOW, NOT_JUDGED } from './concern-matcher.mjs';

/** Accept bar (§1.4). Fewer than `minSamePerArm` positives in any arm => `inconclusive`. */
export const ACCEPT_BAR = Object.freeze({
  precision: 0.90,
  recall: 0.85,
  filterRecall: 0.95,
  armRecallGap: 0.05,
  minSamePerArm: 15,
});

export const DEFAULT_SIZES = Object.freeze({ challenge: 120, prevalence: 80, filterRecall: 60 });

const LABELS = Object.freeze(['same', 'partial', 'different']);

// ── Wilson ──────────────────────────────────────────────────────────────────

/**
 * Wilson score interval for k successes in n trials.
 * @returns {{k:number,n:number,p:number|null,lo:number|null,hi:number|null}}
 */
export function wilson(k, n, z = 1.96) {
  if (!(n > 0)) return { k, n, p: null, lo: null, hi: null };
  const p = k / n;
  const z2 = z * z;
  const denom = 1 + z2 / n;
  const centre = (p + z2 / (2 * n)) / denom;
  const half = (z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n))) / denom;
  return { k, n, p, lo: Math.max(0, centre - half), hi: Math.min(1, centre + half) };
}

// ── Seeded PRNG ─────────────────────────────────────────────────────────────

function fnv1a(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/** mulberry32 seeded from any string/number; returns a () => [0,1) generator. */
export function makeRng(seed) {
  let a = fnv1a(String(seed));
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffled(items, rng) {
  const a = [...items];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const byPairId = (a, b) => cmp(a.pairId, b.pairId);

// ── Scoring ─────────────────────────────────────────────────────────────────

function confusion(rows, predictedSame) {
  let tp = 0; let fp = 0; let fn = 0; let tn = 0; let wtp = 0; let wpp = 0;
  for (const r of rows) {
    const actual = r.label === 'same';
    const pred = predictedSame(r);
    const w = Number.isFinite(r.weight) ? r.weight : 1;
    if (pred) wpp += w;
    if (pred && actual) { tp += 1; wtp += w; } else if (pred) fp += 1; else if (actual) fn += 1; else tn += 1;
  }
  return {
    tp, fp, fn, tn,
    precision: wilson(tp, tp + fp),
    recall: wilson(tp, tp + fn),
    weightedPrecision: wpp > 0 ? wtp / wpp : null,
  };
}

function toVerdictMap(v) {
  if (v instanceof Map) return v;
  if (Array.isArray(v)) return new Map(v.map((r) => [r.pairId, r.verdict]));
  return new Map(Object.entries(v ?? {}));
}

/** Jaccard-0.15 negative control's verdict for one pair (the repo's FUZZY_CONFIG_V2). */
export function jaccardControlVerdict(f, x) {
  return jaccardSimilarity(f?.text, x?.text) >= FUZZY_CONFIG_V2.similarityThreshold ? 'same' : 'different';
}

/**
 * Score a judge against human labels.
 *
 * @param {{
 *   labelled: Array<{pairId:string,set:'challenge'|'prevalence',stratum?:string,sourceArm:string,
 *     label:'same'|'partial'|'different',f?:{text:string},x?:{text:string},weight?:number}>,
 *   judgeVerdicts: Array<{pairId:string,verdict:string}>|Map<string,string>|object,
 *   filterRecallPairs?: Array<{pairId:string,keptByFilter:boolean}>,
 *   bar?: Partial<typeof ACCEPT_BAR>
 * }} args
 */
export function scoreCalibration({ labelled, judgeVerdicts, filterRecallPairs = [], bar = {} }) {
  const B = { ...ACCEPT_BAR, ...bar };
  const verdicts = toVerdictMap(judgeVerdicts);
  const reasons = [];
  const inconclusive = [];

  for (const r of labelled) {
    if (!LABELS.includes(r.label)) throw new Error(`scoreCalibration: pair ${r.pairId} has label "${r.label}", expected one of ${LABELS.join('|')}`);
    if (!verdicts.has(r.pairId)) throw new Error(`scoreCalibration: no judge verdict for labelled pair ${r.pairId}`);
  }
  const judgeSame = (r) => verdicts.get(r.pairId) === 'same';
  const controlSame = (r) => jaccardControlVerdict(r.f, r.x) === 'same';

  const prevalence = labelled.filter((r) => r.set === 'prevalence');
  const challenge = labelled.filter((r) => r.set === 'challenge');

  const counts = { perSet: {}, perStratum: {}, perArm: {} };
  for (const r of labelled) {
    counts.perSet[r.set] = (counts.perSet[r.set] ?? 0) + 1;
    const st = r.stratum ?? 'unstratified';
    counts.perStratum[st] = (counts.perStratum[st] ?? 0) + 1;
    const a = (counts.perArm[r.sourceArm] ??= { pairs: 0, same: 0 });
    a.pairs += 1;
    if (r.label === 'same') a.same += 1;
  }
  const notJudged = labelled.filter((r) => verdicts.get(r.pairId) === NOT_JUDGED).length;

  const judge = {
    prevalence: confusion(prevalence, judgeSame),
    challenge: confusion(challenge, judgeSame),
    perStratum: {},
    perArm: {},
    notJudged,
  };
  for (const st of Object.keys(counts.perStratum)) {
    judge.perStratum[st] = confusion(labelled.filter((r) => (r.stratum ?? 'unstratified') === st), judgeSame);
  }
  // Per-arm recall pools both sets: the >= 15 positives per arm the bar demands
  // only exist pooled, and recall (unlike precision) is not distorted by the
  // challenge set's enrichment of negatives.
  for (const arm of Object.keys(counts.perArm)) {
    const c = confusion(labelled.filter((r) => r.sourceArm === arm), judgeSame);
    judge.perArm[arm] = { same: counts.perArm[arm].same, recall: c.recall, precision: c.precision };
  }

  const control = {
    prevalence: confusion(prevalence, controlSame),
    challenge: confusion(challenge, controlSame),
    // The plan expects Jaccard to miss `same` pairs the judge finds.
    missedSameFoundByJudge: labelled.filter((r) => r.label === 'same' && judgeSame(r) && !controlSame(r)).length,
  };

  const kept = filterRecallPairs.filter((p) => p.keptByFilter).length;
  const filterRecall = wilson(kept, filterRecallPairs.length);

  // ── decision ──
  // An unjudged, missing or unrecognised verdict is NOT a negative prediction: it leaves the calibration incomplete.
  const invalid = labelled.filter((r) => { const v = verdicts.get(r.pairId); return v !== NOT_JUDGED && !['same', 'partial', 'different'].includes(v); }).length;
  if (notJudged > 0) inconclusive.push(`${notJudged}-labelled-pairs-not-judged`);
  if (invalid > 0) inconclusive.push(`${invalid}-labelled-pairs-with-missing-or-invalid-verdict`);
  const prec = judge.prevalence.precision;
  const rec = judge.prevalence.recall;
  if (rec.n === 0) inconclusive.push('no-same-pairs-in-prevalence-set');
  if (prec.n === 0) inconclusive.push('judge-predicted-no-same-in-prevalence-set');
  if (filterRecall.n === 0) inconclusive.push('no-human-found-same-pairs-for-filter-recall');
  const arms = Object.keys(judge.perArm).sort();
  if (arms.length < 2) inconclusive.push('fewer-than-two-source-arms');
  for (const a of arms) if (judge.perArm[a].same < B.minSamePerArm) inconclusive.push(`arm-${a}-has-${judge.perArm[a].same}-same-pairs(<${B.minSamePerArm})`);

  let armGap = null;
  const armRecalls = arms.map((a) => judge.perArm[a].recall.p).filter((p) => p !== null);
  if (armRecalls.length >= 2) armGap = Math.max(...armRecalls) - Math.min(...armRecalls);

  // Acceptance precision is the prevalence-WEIGHTED one when the draw carries weights (equal to plain precision otherwise).
  const precP = judge.prevalence.weightedPrecision ?? prec.p;
  if (precP !== null && precP < B.precision) reasons.push(`precision ${precP.toFixed(3)} < ${B.precision}`);
  if (rec.p !== null && rec.p < B.recall) reasons.push(`recall ${rec.p.toFixed(3)} < ${B.recall}`);
  if (filterRecall.p !== null && filterRecall.p < B.filterRecall) reasons.push(`filter recall ${filterRecall.p.toFixed(3)} < ${B.filterRecall}`);
  if (armGap !== null && armGap > B.armRecallGap) reasons.push(`per-arm recall gap ${armGap.toFixed(3)} > ${B.armRecallGap}`);

  // Insufficient evidence outranks a point-estimate miss: below the sample floor the
  // honest answer is "label more", not "the matcher failed" (§1.4).
  const status = inconclusive.length > 0 ? 'inconclusive' : reasons.length > 0 ? 'fail' : 'accept';
  return {
    bar: B,
    counts,
    judge,
    control,
    filterRecall,
    armRecallGap: armGap,
    decision: { status, reasons, inconclusiveReasons: inconclusive },
  };
}

// ── Sampler ─────────────────────────────────────────────────────────────────

function sampleN(items, n, rng) {
  return shuffled(items, rng).slice(0, Math.max(0, n));
}

function ledgerFor(finding, ledgerEntries) {
  if (finding.sessionId == null) return ledgerEntries;
  return ledgerEntries.filter((x) => x.sessionId != null && String(x.sessionId) === String(finding.sessionId));
}

/**
 * Draw the three calibration samples from CALIBRATION-split sessions only (the
 * caller partitions first, C2). Deterministic under `seed`, independent of input
 * order. Findings carry `{id, file, lines?, severity, text, arm, sessionId?}`;
 * ledger entries `{id, file, lines?, severity, text, arm?, sessionId?}`.
 *
 *  - prevalence (80): random from the filter's real output;
 *  - challenge (120): thirds `same-like` (highest lexical overlap among filter
 *    candidates), `hard-negative` (lowest overlap, same file), `easy-negative`
 *    (different file), drawn from what prevalence left;
 *  - filterRecall (60): random findings; the human searches the WHOLE ledger
 *    (of the finding's session, when sessions are carried), not the filter window.
 *
 * @returns {{prevalence: object[], challenge: object[], filterRecall: object[], shortfalls: object}}
 */
export function drawCalibrationSets({ findings, ledgerEntries, seed, sizes = {}, window = DEFAULT_LINE_WINDOW }) {
  const n = { ...DEFAULT_SIZES, ...sizes };
  const rng = makeRng(`${seed}:calibration`);
  const fs = [...findings].sort((a, b) => cmp(String(a.id), String(b.id)));
  const xs = [...ledgerEntries].sort((a, b) => cmp(String(a.id), String(b.id)));

  const candidates = filterCandidates(fs, xs, { window }).map((c) => ({
    ...c, sim: jaccardSimilarity(c.f.text, c.x.text),
  }));
  const pick = (rows, stratum, set) => rows.map((c) => ({
    pairId: c.pairId, fId: c.fId, xId: c.xId, f: c.f, x: c.x, set, intendedStratum: stratum, sourceArm: c.f.arm ?? null,
  }));

  const prevalence = pick(sampleN(candidates, n.prevalence, rng), 'prevalence', 'prevalence').sort(byPairId);
  const taken = new Set(prevalence.map((p) => p.pairId));
  const rest = candidates.filter((c) => !taken.has(c.pairId));

  const third = Math.floor(n.challenge / 3);
  const counts = { 'same-like': third, 'hard-negative': third, 'easy-negative': n.challenge - 2 * third };
  const bySim = [...rest].sort((a, b) => b.sim - a.sim || cmp(a.pairId, b.pairId));
  const sameLikePool = bySim.slice(0, counts['same-like'] * 3);
  const sameLike = sampleN(sameLikePool, counts['same-like'], rng);
  const used = new Set(sameLike.map((c) => c.pairId));
  const hardPool = bySim.filter((c) => !used.has(c.pairId)).reverse().slice(0, counts['hard-negative'] * 3);
  const hard = sampleN(hardPool, counts['hard-negative'], rng);
  hard.forEach((c) => used.add(c.pairId));

  // Easy negatives: different file entirely (so the filter would have dropped them).
  const easy = [];
  const allPairs = [];
  for (const f of fs) for (const x of xs) {
    if (fileKey(f.file) !== fileKey(x.file) && !taken.has(makePairId(f.id, x.id))) allPairs.push({ f, x });
  }
  for (const { f, x } of sampleN(allPairs, counts['easy-negative'], rng)) {
    easy.push({ pairId: makePairId(f.id, x.id), fId: String(f.id), xId: String(x.id), f, x });
  }

  const challenge = [
    ...pick(sameLike, 'same-like', 'challenge'),
    ...pick(hard, 'hard-negative', 'challenge'),
    ...pick(easy, 'easy-negative', 'challenge'),
  ].sort(byPairId);

  const filterRecall = sampleN(fs, n.filterRecall, rng).map((f) => ({
    fId: String(f.id), f, sourceArm: f.arm ?? null,
    candidateXIds: ledgerFor(f, xs).map((x) => String(x.id)),
  })).sort((a, b) => cmp(a.fId, b.fId));

  return {
    prevalence, challenge, filterRecall,
    shortfalls: {
      prevalence: n.prevalence - prevalence.length,
      challenge: n.challenge - challenge.length,
      filterRecall: n.filterRecall - filterRecall.length,
    },
  };
}

function block(side) {
  const lr = side.lines ?? side.line;
  return [
    `- file: ${(Array.isArray(side.files) ? side.files : [side.file]).join(', ')}`,
    `- lines: ${lr == null ? 'not cited' : JSON.stringify(lr)}`,
    `- severity: ${side.severity ?? 'unstated'}`,
    '',
    String(side.text ?? '').trim().split('\n').map((l) => `> ${l}`).join('\n'),
  ].join('\n');
}

/**
 * Blind the drawn sets: one seeded shuffle across ALL pairs so set and stratum
 * leave no ordering trace; worksheet ids (`P001`, `R001`) carry no pair identity.
 * The worksheet shows file/lines/severity/text only. The key maps worksheet ids
 * back to pairs, sets, sampler strata and source arms; never share it with the labeller.
 *
 * @param {ReturnType<typeof drawCalibrationSets>} sets
 * @param {{seed: string|number, ledgerEntries?: object[]}} opts
 * @returns {{worksheetMarkdown: string, key: object}}
 */
export function renderWorksheet(sets, { seed, ledgerEntries = [] }) {
  const rng = makeRng(`${seed}:worksheet`);
  const pairs = shuffled([...sets.prevalence, ...sets.challenge].sort(byPairId), rng);
  const recalls = shuffled(sets.filterRecall, rng);
  const xById = new Map(ledgerEntries.map((x) => [String(x.id), x]));

  const key = { version: 1, seed: String(seed), pairs: {}, filterRecall: {} };
  const md = [
    '# Matcher calibration worksheet',
    '',
    'Label each pair blind. For Part A answer `same` (fixing one would fix the other), `partial` (overlap, neither restates the other) or `different`.',
    'For Part B, list the id(s) of every ledger entry the finding restates (searching the WHOLE list), or `none`.',
    '',
    '## Part A: pairs',
    '',
  ];
  pairs.forEach((p, i) => {
    const id = `P${String(i + 1).padStart(3, '0')}`;
    key.pairs[id] = { pairId: p.pairId, fId: p.fId, xId: p.xId, set: p.set, intendedStratum: p.intendedStratum, sourceArm: p.sourceArm };
    md.push(`### ${id}`, '', '**Finding F**', block(p.f), '', '**Entry X**', block(p.x), '', 'Label: ', '');
  });
  md.push('## Part B: filter-recall sample', '');
  recalls.forEach((r, i) => {
    const id = `R${String(i + 1).padStart(3, '0')}`;
    key.filterRecall[id] = { fId: r.fId, sourceArm: r.sourceArm, candidateXIds: r.candidateXIds };
    md.push(`### ${id}`, '', '**Finding F**', block(r.f), '', '**Ledger entries**', '');
    for (const xid of r.candidateXIds) {
      const x = xById.get(xid);
      md.push(`- \`${xid}\`${x ? ` (${(x.file ?? '')}${x.lines != null ? `:${JSON.stringify(x.lines)}` : ''}): ${String(x.text ?? '').replace(/\s+/g, ' ').slice(0, 300)}` : ''}`);
    }
    md.push('', 'Restates: ', '');
  });
  return { worksheetMarkdown: md.join('\n'), key };
}

/**
 * Join a human's answers back to the key.
 * `answers.pairs` = `{P001: 'same'|'partial'|'different'}`; `answers.filterRecall` =
 * `{R001: ['x-id', ...]}` (empty = restates nothing). Anything unanswered, or any
 * unknown label, throws: a half-labelled set must not be scored.
 *
 * @returns {{labelled: object[], filterRecallPairs: Array<{pairId:string,keptByFilter:boolean}>}}
 */
export function joinWorksheetLabels({ key, answers, findings, ledgerEntries, window = DEFAULT_LINE_WINDOW }) {
  const fById = new Map(findings.map((f) => [String(f.id), f]));
  const xById = new Map(ledgerEntries.map((x) => [String(x.id), x]));
  const labelled = [];
  for (const [wid, meta] of Object.entries(key.pairs)) {
    const label = answers.pairs?.[wid];
    if (!LABELS.includes(label)) throw new Error(`joinWorksheetLabels: ${wid} unanswered or invalid ("${label}")`);
    labelled.push({
      pairId: meta.pairId, set: meta.set, stratum: meta.set === 'challenge' ? (label === 'same' ? 'same' : meta.intendedStratum) : 'prevalence',
      sourceArm: meta.sourceArm, label, f: fById.get(meta.fId), x: xById.get(meta.xId),
    });
  }
  const filterRecallPairs = [];
  for (const [wid, meta] of Object.entries(key.filterRecall)) {
    const ids = answers.filterRecall?.[wid];
    if (!Array.isArray(ids)) throw new Error(`joinWorksheetLabels: ${wid} unanswered (use [] for "none")`);
    const f = fById.get(meta.fId);
    for (const xid of ids) {
      const x = xById.get(String(xid));
      if (!x) throw new Error(`joinWorksheetLabels: ${wid} names unknown ledger entry "${xid}"`);
      filterRecallPairs.push({ pairId: makePairId(f.id, x.id), keptByFilter: filterCandidates([f], [x], { window }).length > 0 });
    }
  }
  return { labelled, filterRecallPairs };
}
