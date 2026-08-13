/**
 * @fileoverview Work-unit clustering — the deterministic half.
 *
 * These pin the properties that make a work-unit key usable as something you
 * filter, count and diff on. The label is deliberately NOT pinned here: it is
 * presentation, it may come from a model, and it is allowed to change.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  deriveCutoff, pairwiseSimilarities, workUnitKey, clusterWorkUnits,
  CUTOFF_FLOOR, DEFAULT_CUTOFF_SIGMA,
} from '../scripts/lib/work-units.mjs';

/** Unit vectors in the plane — cosine is exactly cos(theta). */
const at = (deg) => [Math.cos((deg * Math.PI) / 180), Math.sin((deg * Math.PI) / 180)];
const f = (id, deg, extra = {}) => ({ id, embedding: at(deg), createdAt: `2026-07-${String(10 + Number(id.slice(1))).padStart(2, '0')}`, ...extra });

describe('the cutoff is derived from the population, never a constant', () => {
  test('cutoff is mean + k*stdev over the observed similarities', () => {
    // Chosen so mean+σ clears CUTOFF_FLOOR — otherwise the floor binds and this
    // asserts the guard rather than the derivation (it did, on first run).
    const sims = [0.5, 0.6, 0.7, 0.8, 0.9];
    const d = deriveCutoff(sims, { sigma: 1 });
    assert.equal(d.samples, 5);
    assert.ok(Math.abs(d.mean - 0.7) < 1e-9);
    assert.ok(Math.abs(d.cutoff - (0.7 + d.stdev)) < 1e-9);
    assert.equal(d.source, 'derived');
  });

  test('the floor binds toward LESS merging, never more', () => {
    // A low-similarity population would derive a cutoff under the floor. The
    // floor raises it, which makes clustering stricter — the safe direction. A
    // guard that loosened the cutoff could merge an unrelated backlog into one
    // unit, which is the failure this must never have.
    const d = deriveCutoff([0.1, 0.2, 0.3, 0.4, 0.5], { sigma: 1 });
    assert.equal(d.source, 'floored');
    assert.equal(d.cutoff, CUTOFF_FLOOR);
    assert.ok(d.cutoff > d.mean + d.stdev, 'the floor must be stricter than the derived value it replaced');
  });

  test('a different population yields a different cutoff — the point of deriving it', () => {
    const tight = deriveCutoff([0.80, 0.81, 0.82, 0.83], { sigma: 2 });
    const broad = deriveCutoff([0.10, 0.40, 0.70, 0.95], { sigma: 2 });
    assert.notEqual(tight.cutoff, broad.cutoff);
  });

  test('too few pairs reports insufficient-samples rather than inventing a threshold', () => {
    const d = deriveCutoff([0.9, 0.8]);
    assert.equal(d.source, 'insufficient-samples');
    assert.equal(d.cutoff, CUTOFF_FLOOR);
  });

  test('a degenerate (zero-variance) population cannot collapse the backlog into one unit', () => {
    // sigma≈0 ⇒ mean+kσ ≈ mean, which without the floor would merge everything.
    const d = deriveCutoff([0.2, 0.2, 0.2, 0.2], { sigma: DEFAULT_CUTOFF_SIGMA });
    assert.ok(d.cutoff >= CUTOFF_FLOOR);
    assert.equal(d.source, 'floored');
  });

  test('pairwiseSimilarities returns the upper triangle only', () => {
    assert.equal(pairwiseSimilarities([f('a', 0), f('b', 10), f('c', 20)]).length, 3);
  });
});

describe('the work-unit key is stable and membership-derived', () => {
  test('order-independent — two runs over the same set agree', () => {
    assert.equal(workUnitKey(['c', 'a', 'b']), workUnitKey(['a', 'b', 'c']));
  });

  test('changes when membership changes — this is what makes a label cache correct', () => {
    assert.notEqual(workUnitKey(['a', 'b']), workUnitKey(['a', 'b', 'c']));
  });
});

describe('clustering', () => {
  test('near-identical findings in DIFFERENT files land in one unit', () => {
    // The whole reason requireSameFile is false: "store writes that swallow
    // failures" is one refactor spanning several files.
    const findings = [
      f('f1', 0, { primaryFile: 'a.mjs', category: 'Error swallowing' }),
      f('f2', 1, { primaryFile: 'b.mjs', category: 'Missing error handling' }),
      f('f3', 2, { primaryFile: 'c.mjs', category: 'Missing Error Handling' }),
      f('f4', 89, { primaryFile: 'd.mjs', category: 'Something else entirely' }),
    ];
    const { units } = clusterWorkUnits(findings, { cutoff: 0.9 });
    const big = units.find((u) => u.size > 1);
    assert.equal(big.size, 3, 'the three spellings of one theme must group');
    assert.deepEqual(big.files, ['a.mjs', 'b.mjs', 'c.mjs']);
    assert.ok(units.some((u) => u.size === 1 && u.members[0].id === 'f4'), 'the unrelated finding stays its own unit');
  });

  test('an unembedded finding is unclustered — never merged, never dropped', () => {
    const findings = [
      f('f1', 0, { primaryFile: 'a.mjs' }),
      f('f2', 1, { primaryFile: 'b.mjs' }),
      { id: 'f3', primaryFile: 'c.mjs', createdAt: '2026-07-13' },   // no embedding
    ];
    const { units, unclustered } = clusterWorkUnits(findings, { cutoff: 0.9 });
    assert.equal(unclustered.length, 1);
    assert.equal(unclustered[0].id, 'f3');
    const allMembers = units.flatMap((u) => u.members.map((m) => m.id));
    assert.ok(!allMembers.includes('f3'), 'absence of evidence must not become membership');
    assert.equal(allMembers.length + unclustered.length, findings.length, 'nothing may be silently dropped');
  });

  test('no embeddings at all reports no-embeddings rather than an empty clean result', () => {
    const { units, unclustered, cutoff } = clusterWorkUnits([{ id: 'x' }, { id: 'y' }]);
    assert.equal(units.length, 0);
    assert.equal(unclustered.length, 2);
    assert.equal(cutoff.source, 'no-embeddings');
  });

  test('clustering is reproducible for a fixed input — the key must not churn', () => {
    const mk = () => [
      f('f1', 0, { primaryFile: 'a.mjs' }), f('f2', 1, { primaryFile: 'b.mjs' }),
      f('f3', 40, { primaryFile: 'c.mjs' }), f('f4', 41, { primaryFile: 'd.mjs' }),
    ];
    const a = clusterWorkUnits(mk(), { cutoff: 0.95 });
    const b = clusterWorkUnits(mk().reverse(), { cutoff: 0.95 });
    assert.deepEqual(a.units.map((u) => u.key), b.units.map((u) => u.key),
      'input order must not change the unit keys');
  });

  test('the fallback label is deterministic and marked as such', () => {
    const { units } = clusterWorkUnits([f('f1', 0, { primaryFile: 'a.mjs', category: 'Error swallowing' })], { cutoff: 0.9 });
    assert.equal(units[0].label, 'Error swallowing');
    assert.equal(units[0].labelSource, 'category');
  });
});
