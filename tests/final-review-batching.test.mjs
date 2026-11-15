/**
 * @fileoverview `gemini-review.mjs review --batch` (final-review/batching.mjs).
 *
 * ai-organiser, 2026-11-15: a large diff got PARTIAL coverage from one envelope
 * and was batched by hand into 8 groups. These tests pin the mechanical
 * replacement: packing under the renderer's own budget, the forward/backward/
 * disjoint completeness check that round-cap-and-structural-card.md describes,
 * and a fold whose disposition is computed exactly as a single review's.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  planDisjointBatches, checkBatchCompleteness, planTranscriptBatches, foldBatchResults, reviewBatches, mergeBatchCoverage,
} from '../scripts/lib/final-review/batching.mjs';
import { FULL_CODE_MAX_CHARS, CHANGED_FILE_MAX_PER_FILE } from '../scripts/lib/final-review/code-render.mjs';
import { stampGateDisposition } from '../scripts/lib/final-review/round-gate.mjs';
import { parseReviewArgs, REVIEW_FLAGS } from '../scripts/lib/final-review/review-args.mjs';

const sizes = (map) => (p) => map[p] ?? 0;

const okResult = (over = {}) => ({
  verdict: 'APPROVE',
  deliberation_quality: { claude_bias_detected: false, gpt_false_positive_count: 0, deliberation_was_fair: true, quality_summary: 'ok' },
  new_findings: [], wrongly_dismissed: [], over_engineering_flags: [], architectural_coherence: 'Strong', overall_reasoning: 'fine',
  _envelope: { codeCoverage: { state: 'full', changedRequested: 1, changedLinesUnread: 0, changedLinesUnmeasuredFiles: 0 } },
  ...over,
});

describe('planDisjointBatches packs to the renderer budget', () => {
  test('files that fit one envelope stay one batch', () => {
    assert.deepEqual(planDisjointBatches(['a', 'b'], { sizeOf: sizes({ a: 10, b: 10 }) }), [['a', 'b']]);
  });

  test('a diff over FULL_CODE_MAX_CHARS splits, and every file costs at most the per-file cap', () => {
    const files = Array.from({ length: 6 }, (_, i) => `f${i}.mjs`);
    // 6 huge files: each is capped at CHANGED_FILE_MAX_PER_FILE, so floor(budget / cap) per batch.
    const batches = planDisjointBatches(files, { sizeOf: () => 10_000_000 });
    const perBatch = Math.floor(FULL_CODE_MAX_CHARS / CHANGED_FILE_MAX_PER_FILE);
    assert.equal(batches.length, Math.ceil(6 / perBatch));
    assert.ok(batches.every((b) => b.length <= perBatch));
    assert.ok(checkBatchCompleteness(batches, files).ok);
  });

  test('an exact duplicate is planned once, but paths differing only in CASE are two files', () => {
    assert.equal(planDisjointBatches(['a.mjs', 'a.mjs'], { sizeOf: () => 1 }).flat().length, 1);
    // On a case-sensitive checkout these are two changed files; folding them dropped one from every batch.
    const b = planDisjointBatches(['A.mjs', 'a.mjs'], { sizeOf: () => 1 });
    assert.deepEqual(b.flat(), ['A.mjs', 'a.mjs']);
    assert.ok(checkBatchCompleteness(b, ['A.mjs', 'a.mjs']).ok);
    assert.deepEqual(checkBatchCompleteness([['A.mjs']], ['A.mjs', 'a.mjs']).missing, ['a.mjs'], 'the check must not fold them either');
  });
});

describe('planDisjointBatches — sizes and identities that used to collapse', () => {
  test('a file over 2 GiB is charged the per-file cap, not wrapped negative to zero', () => {
    const files = Array.from({ length: 4 }, (_, i) => `big${i}`);
    const batches = planDisjointBatches(files, { sizeOf: () => 3 * 1024 ** 3 });
    assert.equal(batches.flat().length, 4);
    assert.ok(batches.length > 1, 'four capped files cannot share one 100K envelope');
  });
  test('a backslash is part of a POSIX filename, not a separator', () => {
    const b = planDisjointBatches(['src/a\\b.mjs', 'src/a/b.mjs'], { sizeOf: () => 1 });
    assert.deepEqual(b.flat(), ['src/a\\b.mjs', 'src/a/b.mjs']);
  });
});

describe('checkBatchCompleteness — forward, backward, disjoint', () => {
  test('a changed file in NO batch is caught (the #361 miss)', () => {
    const r = checkBatchCompleteness([['a'], ['b']], ['a', 'b', 'c']);
    assert.equal(r.ok, false);
    assert.deepEqual(r.missing, ['c']);
  });
  test('a batch member that is not a changed file is caught', () => {
    assert.deepEqual(checkBatchCompleteness([['a', 'z']], ['a']).extra, ['z']);
  });
  test('a file in two batches is caught', () => {
    assert.deepEqual(checkBatchCompleteness([['a'], ['a', 'b']], ['a', 'b']).duplicated, ['a']);
  });
  test('an exact partition passes', () => {
    assert.equal(checkBatchCompleteness([['a'], ['b']], ['a', 'b']).ok, true);
  });
});

describe('planTranscriptBatches', () => {
  test('null (single ordinary review) when everything fits, or nothing is declared', () => {
    assert.equal(planTranscriptBatches(JSON.stringify({ changed_files: ['a'] }), { sizeOf: () => 1 }), null);
    assert.equal(planTranscriptBatches(JSON.stringify({ rounds: [] })), null);
    assert.equal(planTranscriptBatches('not json'), null);
  });
  test('each batch transcript is the ORIGINAL transcript with changed_files narrowed', () => {
    const t = { rounds: [{ findings: [{ id: 'H1' }] }], changed_files: ['a', 'b', 'c'], _diffBase: 'abc' };
    const plan = planTranscriptBatches(JSON.stringify(t), { sizeOf: () => 60_000 });
    assert.ok(plan.batches.length > 1);
    const parsed = plan.transcripts.map((s) => JSON.parse(s));
    assert.deepEqual(parsed.flatMap((p) => p.changed_files).sort(), ['a', 'b', 'c']);
    for (const p of parsed) { assert.deepEqual(p.rounds, t.rounds); assert.equal(p._diffBase, 'abc'); }
  });
});

describe('the fold — one verdict, derived the same way as a single review', () => {
  const fold = (results) => {
    const combined = foldBatchResults(results.map((result, i) => ({ files: [`f${i}`], result })), 'gemini');
    stampGateDisposition(combined, 1);
    return combined;
  };

  test('all batches approve → approve, coverage FULL', () => {
    const c = fold([okResult(), okResult()]);
    assert.equal(c.gateDisposition, 'approve');
    assert.equal(c._envelope.codeCoverage.state, 'full');
    assert.equal(c._batches.length, 2);
  });

  test('ONE blocked batch blocks the whole review, whatever the others say', () => {
    const blocking = { id: 'G1', severity: 'HIGH', category: 'x', section: 's', detail: 'd', risk: 'r', recommendation: 'fix', release_blocking: true, blocking_basis: 'correctness' };
    const c = fold([okResult(), okResult({ verdict: 'CONCERNS', new_findings: [blocking] })]);
    assert.notEqual(c.gateDisposition, 'approve');
    assert.equal(c.verdict, 'CONCERNS');
    assert.equal(c.new_findings[0]._batch, 2);
  });

  test('a batch that received none of its code still downgrades the folded gate', () => {
    const c = fold([okResult(), okResult({ _coverageGate: { downgraded: true } })]);
    assert.equal(c.gateDisposition, 'blocked');
  });

  test('coverage takes the WEAKEST batch state, and unread lines sum', () => {
    const m = mergeBatchCoverage([
      { state: 'full', changedRequested: 2, changedLinesUnread: 0 },
      { state: 'partial', changedRequested: 3, changedLinesUnread: 7 },
    ]);
    assert.equal(m.state, 'partial');
    assert.equal(m.changedLinesUnread, 7);
    assert.equal(m.changedRequested, 5);
    assert.equal(mergeBatchCoverage([{ state: 'full' }, null]).state, 'unknown');
  });

  test('a malformed batch stays malformed after the fold (fails closed)', () => {
    assert.equal(fold([okResult(), okResult({ new_findings: null })]).gateDisposition, 'blocked');
    assert.equal(fold([okResult(), okResult({ verdict: 'MAYBE' })]).gateDisposition, 'blocked');
  });

  test('finding ids are renumbered across batches so none collide', () => {
    const f = (id) => ({ id, severity: 'LOW', category: 'x', section: 's', detail: 'd', risk: 'r', recommendation: 'n', release_blocking: false, blocking_basis: null });
    const c = foldBatchResults([{ files: ['a'], result: okResult({ new_findings: [f('G1')] }) }, { files: ['b'], result: okResult({ new_findings: [f('G1')] }) }], 'gemini');
    assert.deepEqual(c.new_findings.map((x) => x.id), ['G1', 'G2']);
  });

  test('the same dismissal raised by two batches is kept once, at its highest severity', () => {
    const c = foldBatchResults([
      { files: ['a'], result: okResult({ wrongly_dismissed: [{ original_finding_id: 'H3', recommended_severity: 'LOW' }] }) },
      { files: ['b'], result: okResult({ wrongly_dismissed: [{ original_finding_id: 'H3', recommended_severity: 'HIGH' }] }) },
    ], 'gemini');
    assert.equal(c.wrongly_dismissed.length, 1);
    assert.equal(c.wrongly_dismissed[0].recommended_severity, 'HIGH');
  });
});

describe('reviewBatches runs every batch through the caller\'s own review', () => {
  test('sequential, one call per batch, usage summed, each batch stamped', async () => {
    const plan = { batches: [['a'], ['b'], ['c']], transcripts: ['ta', 'tb', 'tc'] };
    const seen = [];
    const out = await reviewBatches(plan, async (t) => { seen.push(t); return { result: okResult(), usage: { input_tokens: 10 }, latencyMs: 5 }; },
      { provider: 'gemini', stamp: (r) => stampGateDisposition(r, 1), log: () => {} });
    assert.deepEqual(seen, ['ta', 'tb', 'tc']);
    assert.equal(out.usage.input_tokens, 30);
    assert.equal(out.latencyMs, 15);
    assert.deepEqual(out.result._batches.map((b) => b.gateDisposition), ['approve', 'approve', 'approve']);
  });
});

describe('reviewBatches refuses a tree that moved between batches', () => {
  const plan = { batches: [['a'], ['b'], ['c']], transcripts: ['ta', 'tb', 'tc'] };
  const reviewOne = async () => ({ result: okResult(), usage: {}, latencyMs: 1 });
  const opts = (fingerprint) => ({ provider: 'gemini', stamp: (r) => stampGateDisposition(r, 1), log: () => {}, fingerprint });

  test('a file edited after batch 1 stops the run with no verdict', async () => {
    let calls = 0;
    const fp = (p) => (p === 'c' && ++calls > 1 ? 'edited' : `orig:${p}`);
    await assert.rejects(reviewBatches(plan, reviewOne, opts(fp)), /working tree changed during the batched review \(after batch 1\/3\): c/);
  });

  test('an edit that is RESTORED before the end is still caught at the batch boundary it spanned', async () => {
    let n = 0;
    const fp = (p) => { if (p === 'b') n += 1; return p === 'b' && n === 3 ? 'transient' : `orig:${p}`; };
    await assert.rejects(reviewBatches(plan, reviewOne, opts(fp)), /after batch 2\/3\): b/);
  });

  test('a file that cannot be READ (not merely absent) stops the run rather than reading as unchanged', async () => {
    // The default fingerprint over a real directory: EISDIR, not ENOENT.
    const dirPlan = { batches: [['tests']], transcripts: ['t'] };
    await assert.rejects(reviewBatches({ ...dirPlan, batches: [['tests'], ['scripts']], transcripts: ['t1', 't2'] }, reviewOne,
      { provider: 'gemini', stamp: () => {}, log: () => {} }), /cannot fingerprint tests/);
  });

  test('a stable tree folds normally', async () => {
    const out = await reviewBatches(plan, reviewOne, opts((p) => `orig:${p}`));
    assert.equal(out.result._batches.length, 3);
  });
});

describe('--batch is a known review flag', () => {
  test('accepted and parsed', () => {
    assert.ok(REVIEW_FLAGS.includes('--batch'));
    assert.equal(parseReviewArgs(['review', 'p.md', 't.json', '--batch']).batch, true);
    assert.equal(parseReviewArgs(['review', 'p.md', 't.json']).batch, false);
  });
  test('a value flag followed by another flag refuses instead of swallowing it', () => {
    assert.throws(() => parseReviewArgs(['review', 'p.md', 't.json', '--out', '--batch']), /--out needs a value, got the flag "--batch"/);
    assert.equal(parseReviewArgs(['review', 'p.md', 't.json', '--out', 'r.json', '--batch']).outFile, 'r.json');
  });
});
