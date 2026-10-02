/**
 * @fileoverview Final-review debt re-suppression must SEE the debt context a
 * real /audit-code transcript carries.
 *
 * `run-finalization.mjs` writes `_debtMemory` onto each ROUND result, and
 * `buildAuditTranscript` nests those results under `rounds[]`. Both final-review
 * readers looked only at the transcript's top level, so for every
 * script-built transcript the reviewer got no "pre-filtered debt" block and
 * `applyDebtSuppression` suppressed nothing (found 2026-10-02). The fixture is
 * built by the real transcript builder, not hand-shaped, so the test follows
 * the producer if it moves.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { buildAuditTranscript } from '../scripts/lib/audit/transcript.mjs';
import { applyDebtSuppression, debtSuppressionContextOf } from '../scripts/lib/final-review/post-review.mjs';

const debt = (topicId, detailSnapshot) => ({
  topicId, category: 'Error swallowing', section: 'scripts/lib/x.mjs',
  deferredReason: 'out of scope', detailSnapshot,
});
const CLAIM = 'loadThing catches every database error and returns an empty array, indistinguishable from no rows';

function realTranscript(...roundDebt) {
  return buildAuditTranscript({
    auditMode: 'code',
    rounds: roundDebt.map((ctx, i) => ({ round: i + 1, findings: [], code_files: ['scripts/lib/x.mjs'],
      ...(ctx ? { _debtMemory: { suppressionContext: ctx } } : {}) })),
  });
}

describe('debtSuppressionContextOf', () => {
  test('reads the per-round _debtMemory a built transcript nests under rounds[]', () => {
    const ctx = debtSuppressionContextOf(realTranscript([debt('t1', CLAIM)]));
    assert.deepEqual(ctx.map((d) => d.topicId), ['t1']);
  });

  test('unions rounds, one entry per topic (the latest round wins)', () => {
    const ctx = debtSuppressionContextOf(realTranscript([debt('t1', 'old')], null, [debt('t1', CLAIM), debt('t2', 'x')]));
    assert.deepEqual(ctx.map((d) => [d.topicId, d.detailSnapshot]), [['t1', CLAIM], ['t2', 'x']]);
  });

  test('still reads a top-level _debtMemory (hand-built transcripts)', () => {
    assert.equal(debtSuppressionContextOf({ _debtMemory: { suppressionContext: [debt('t9', CLAIM)] } }).length, 1);
  });

  test('no debt anywhere → empty', () => {
    assert.deepEqual(debtSuppressionContextOf(realTranscript(null)), []);
  });
});

describe('applyDebtSuppression on a real built transcript', () => {
  test('a finding restating a deferred claim is suppressed', async () => {
    const result = { new_findings: [{ category: 'Error swallowing', section: 'scripts/lib/x.mjs', detail: CLAIM }] };
    await applyDebtSuppression(result, JSON.stringify(realTranscript([debt('t1', CLAIM)])));
    assert.equal(result.new_findings.length, 0, 'the per-round debt context must reach the suppressor');
  });
});
