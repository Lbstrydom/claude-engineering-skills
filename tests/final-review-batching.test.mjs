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

  test('duplicates (case-folded) are planned once', () => {
    const b = planDisjointBatches(['A.mjs', 'a.mjs'], { sizeOf: () => 1 });
    assert.equal(b.flat().length, 1);
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

describe('--batch is a known review flag', () => {
  test('accepted and parsed', () => {
    assert.ok(REVIEW_FLAGS.includes('--batch'));
    assert.equal(parseReviewArgs(['review', 'p.md', 't.json', '--batch']).batch, true);
    assert.equal(parseReviewArgs(['review', 'p.md', 't.json']).batch, false);
  });
});
