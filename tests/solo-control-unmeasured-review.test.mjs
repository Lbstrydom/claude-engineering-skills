/**
 * A Gemini review that never ran must not reach the blind sheet as a review
 * that found nothing. `apparatus-bc` (arms B and C) and `sonnet-gemini-retro`
 * swallowed every Gemini failure — a thrown error, the no-key skip, an
 * unparseable reply — into an empty net-new list and wrote the commit as
 * `ran`; `merge` then put the arm's findings on the sheet with the Gemini
 * stage silently missing, and `--resume` never retried the commit because it
 * read `ran`. These tests failed before the fix (the helpers did not exist).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  gateCellState, runMeasuredReview, reviewCommitState, unmeasuredCommits, UNMEASURED_REVIEW_STATE,
} from '../scripts/lib/solo-control/completion.mjs';

const F = { severity: 'HIGH', category: 'bug', detail: 'd' };

test('runMeasuredReview: a returned review is measured and keeps its findings (an empty list included)', async () => {
  assert.deepEqual(await runMeasuredReview(async () => ({ findings: [F] })), { findings: [F], measured: true, error: null });
  assert.deepEqual(await runMeasuredReview(async () => ({ findings: [] })), { findings: [], measured: true, error: null });
});

test('runMeasuredReview: the no-key skip, a thrown error and an unparseable reply are all UNMEASURED, never an empty measured review', async () => {
  const skip = await runMeasuredReview(async () => ({ findings: [], skipped: 'no-key' }));
  assert.equal(skip.measured, false);
  assert.equal(skip.error, 'no-key');

  const threw = await runMeasuredReview(async () => { throw new Error('429 high demand'); });
  assert.equal(threw.measured, false);
  assert.match(threw.error, /429/);

  const unparseable = await runMeasuredReview(async () => ({ findings: [], state: 'conformance-miss' }));
  assert.equal(unparseable.measured, false);
});

test('reviewCommitState: an unmeasured review is a non-`ran` commit state carrying its reason, so resume retries it', () => {
  assert.deepEqual(reviewCommitState({ measured: true, error: null }), { state: 'ran' });
  assert.deepEqual(reviewCommitState({ measured: false, error: 'no-key' }), { state: UNMEASURED_REVIEW_STATE, error: 'no-key' });
});

test('unmeasuredCommits: finds an arm\'s unmeasured commit, and a later successful re-run of the same commit clears it (last entry wins)', () => {
  const runs = [
    { armLabel: 'B', perCommit: [{ sha: 'c1', state: UNMEASURED_REVIEW_STATE, error: 'no-key' }, { sha: 'c2', state: 'ran' }] },
    { armLabel: 'C', perCommit: [{ sha: 'c1', state: UNMEASURED_REVIEW_STATE, error: 'x' }, { sha: 'c1', state: 'ran' }] },
    { armLabel: 'S-sonnet', perCommit: [{ sha: 'c1', state: 'ran' }] },
  ];
  assert.deepEqual(unmeasuredCommits(runs, ['c1', 'c2']), [{ arm: 'B', commit: 'c1', error: 'no-key' }]);
  assert.deepEqual(unmeasuredCommits(runs, ['c2']), [], 'only commits being merged are considered');
});

test('unmeasuredCommits: legitimate exclusions (no-clean-files, diff-too-large, not-found) are not unmeasured reviews', () => {
  const runs = [{ armLabel: 'B', perCommit: [{ sha: 'c1', state: 'no-clean-files' }, { sha: 'c2', state: 'diff-too-large' }] }];
  assert.deepEqual(unmeasuredCommits(runs, ['c1', 'c2']), []);
});

test('gateCellState moved to completion.mjs unchanged: a skip is provider-error, an explicit state wins, otherwise ok', () => {
  assert.equal(gateCellState({ findings: [], skipped: 'no-key' }), 'provider-error');
  assert.equal(gateCellState({ findings: [], state: 'conformance-miss' }), 'conformance-miss');
  assert.equal(gateCellState({ findings: [] }), 'ok');
});

// ── resume: an unmeasured commit is retried for EVERY arm, without duplicating findings ──

test('coveredCommits: covered only when EVERY arm\'s latest entry is `ran` — B measured but C unmeasured is NOT covered', async () => {
  const { coveredCommits } = await import('../scripts/lib/solo-control/completion.mjs');
  const priorB = { armLabel: 'B', perCommit: [{ sha: 'c1', state: 'ran' }, { sha: 'c2', state: 'ran' }] };
  const priorC = { armLabel: 'C', perCommit: [{ sha: 'c1', state: UNMEASURED_REVIEW_STATE }, { sha: 'c2', state: 'ran' }] };
  // Pre-fix, apparatus-bc read B alone: c1 counted as covered and C's review was never retried.
  assert.deepEqual([...coveredCommits([priorB, priorC])].sort(), ['c2']);
  assert.deepEqual([...coveredCommits([priorB, null])].sort(), ['c1', 'c2'], 'a missing prior file constrains nothing');
});

test('resumeArmFile: a re-run commit\'s earlier findings are dropped so the re-run does not append duplicates; others are kept', async () => {
  const { resumeArmFile } = await import('../scripts/lib/solo-control/completion.mjs');
  const prior = { armLabel: 'B', findings: [{ commit: 'c1', detail: 'old' }, { commit: 'c2', detail: 'keep' }], perCommit: [{ sha: 'c1', state: UNMEASURED_REVIEW_STATE }] };
  const fresh = { armLabel: 'B', findings: [], perCommit: [] };
  const out = resumeArmFile(prior, { force: false, rerun: ['c1'], fresh });
  assert.deepEqual(out.findings, [{ commit: 'c2', detail: 'keep' }]);
  assert.deepEqual(out.perCommit, prior.perCommit, 'history is kept: the new entry is appended and wins as the latest');
  assert.notEqual(out.findings, prior.findings, 'a copy, never the prior object mutated');
  assert.equal(resumeArmFile(prior, { force: true, rerun: ['c1'], fresh }), fresh);
  assert.equal(resumeArmFile(null, { force: false, rerun: [], fresh }), fresh);
});

test('runGptPass: a reply the SDK could not parse is a conformance-miss, so solo-pass-retro counts the pass as unmeasured', async () => {
  const { _internals: soloCtl } = await import('../scripts/solo-control-audit.mjs');
  const fakeFormat = () => ({ type: 'json_schema' });
  const unparsed = { responses: { parse: async () => ({ output_parsed: null, status: 'incomplete', usage: { input_tokens: 9 } }) } };
  const r = await soloCtl.runGptPass(unparsed, fakeFormat, 'gpt-5.6', 'structure', 'DIFF', null);
  assert.deepEqual(r.findings, []);
  assert.equal(r.state, 'conformance-miss');
  assert.equal((await runMeasuredReview(async () => r)).measured, false);

  const parsed = { responses: { parse: async () => ({ output_parsed: { findings: [] }, usage: {} }) } };
  const ok = await soloCtl.runGptPass(parsed, fakeFormat, 'gpt-5.6', 'structure', 'DIFF', null);
  assert.equal(ok.state, undefined, 'an empty but PARSED reply is a real, measured "found nothing"');
});
