/**
 * Tier-1 tests for the shared seeded-RNG utilities (tiered-recall pipeline,
 * audit fix L1/L2 — extracted after mulberry32/seededShuffleCopy were
 * independently reimplemented in multiple Cluster D modules).
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mulberry32, seededShuffleCopy, seededDraw } from '../scripts/lib/audit/seeded-random.mjs';

describe('mulberry32', () => {
  it('is deterministic for a fixed seed', () => {
    const a = mulberry32(42)();
    const b = mulberry32(42)();
    assert.equal(a, b);
  });
  it('produces different sequences for different seeds', () => {
    assert.notEqual(mulberry32(1)(), mulberry32(2)());
  });
  it('produces values in [0, 1)', () => {
    const rng = mulberry32(7);
    for (let i = 0; i < 20; i++) {
      const v = rng();
      assert.ok(v >= 0 && v < 1);
    }
  });
});

describe('seededShuffleCopy', () => {
  it('never mutates the input array', () => {
    const input = [1, 2, 3, 4, 5];
    const copy = [...input];
    seededShuffleCopy(input, mulberry32(1));
    assert.deepEqual(input, copy);
  });
  it('is deterministic for the same rng sequence', () => {
    const a = seededShuffleCopy([1, 2, 3, 4, 5], mulberry32(99));
    const b = seededShuffleCopy([1, 2, 3, 4, 5], mulberry32(99));
    assert.deepEqual(a, b);
  });
  it('preserves all elements (a permutation, not a subset)', () => {
    const input = [1, 2, 3, 4, 5];
    const shuffled = seededShuffleCopy(input, mulberry32(5));
    assert.deepEqual([...shuffled].sort(), [...input].sort());
  });
});

describe('seededDraw', () => {
  it('is deterministic for a fixed seed', () => {
    assert.equal(seededDraw(10), seededDraw(10));
  });
  it('matches the first draw of mulberry32(seed)', () => {
    assert.equal(seededDraw(3), mulberry32(3)());
  });
});
