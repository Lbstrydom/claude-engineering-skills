/**
 * @fileoverview Unit tests for the shadow-vs-pipeline overlap summary.
 *
 * The load-bearing case is the LAST one: a run set where no run carries both
 * shadow and audit-pass findings must read INCONCLUSIVE, never a clean zero.
 * That is the "can this return green without having checked anything?" guard —
 * the failure mode the 2026-07 shadow A/B actually hit, where an unmeasured
 * tail was read as an absence of overlap.
 *
 * @module tests/shadow-overlap
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { summariseOverlap } from '../scripts/lib/model-eval/shadow-overlap.mjs';

const row = (run_id, pass_name, primary_file) => ({ run_id, pass_name, primary_file });

describe('summariseOverlap', () => {
  it('reports CLEAN when shadow and audit passes share a run but no file', () => {
    const r = summariseOverlap([
      row('run1', 'final-review-shadow', 'a.mjs'),
      row('run1', 'merged', 'b.mjs'),
      row('run1', 'merged', 'c.mjs'),
    ]);
    assert.equal(r.runsWithBoth, 1);
    assert.equal(r.sameFileCount, 0);
    assert.match(r.interpretation, /^CLEAN within-run/);
  });

  it('reports OVERLAP and names the file when both flagged it in one run', () => {
    const r = summariseOverlap([
      row('run1', 'final-review-shadow', 'shared.mjs'),
      row('run1', 'merged', 'shared.mjs'),
    ]);
    assert.equal(r.sameFileCount, 1);
    assert.deepEqual(r.overlaps, [{ runId: 'run1', files: ['shared.mjs'] }]);
    assert.match(r.interpretation, /^OVERLAP/);
  });

  it('excludes the PRIMARY final reviewer from the audit-pass side', () => {
    // final-review is the primary gate, not a pipeline audit pass. Counting it
    // would make every shadow-only finding look "already covered" by the very
    // reviewer it was defined as being disjoint from.
    const r = summariseOverlap([
      row('run1', 'final-review-shadow', 'a.mjs'),
      row('run1', 'final-review', 'a.mjs'),
    ]);
    assert.equal(r.runsWithBoth, 0, 'a primary-only run must not count as a both-run');
    assert.match(r.interpretation, /^INCONCLUSIVE/);
  });

  it('ignores rows with no primary_file rather than counting them as matches', () => {
    const r = summariseOverlap([
      row('run1', 'final-review-shadow', null),
      row('run1', 'merged', null),
    ]);
    assert.equal(r.runsWithBoth, 0);
    assert.match(r.interpretation, /^INCONCLUSIVE/);
  });

  it('VACUOUS-GREEN GUARD: no both-run reads INCONCLUSIVE, never a clean zero', () => {
    const r = summariseOverlap([
      row('run1', 'final-review-shadow', 'a.mjs'),   // shadow, no audit pass
      row('run2', 'merged', 'b.mjs'),                 // audit pass, no shadow
    ]);
    assert.equal(r.runsWithBoth, 0);
    assert.equal(r.sameFileCount, 0);
    assert.match(r.interpretation, /^INCONCLUSIVE/,
      'zero overlap with zero both-runs means UNMEASURED, not clean');
  });

  it('always states that cross-run overlap was not measured', () => {
    for (const rows of [[], [row('r', 'final-review-shadow', 'a.mjs'), row('r', 'merged', 'a.mjs')]]) {
      assert.equal(summariseOverlap(rows).crossRunOverlapMeasured, false);
    }
  });
});
