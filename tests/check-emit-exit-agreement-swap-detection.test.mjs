/**
 * @fileoverview Regression test for the identity-based ratchet fix
 * (scripts/check-emit-exit-agreement.mjs `compareToBaseline` + `hitId`).
 *
 * The original ratchet compared only the TOTAL COUNT of declared
 * `emit(..., {softFail:true})` opt-outs against the baseline. That means one
 * exemption could be silently swapped for a different, never-reviewed one —
 * dismiss the opt-out in file A, add a brand-new one in file B — without
 * ever changing `hits.length`, so neither growth nor shrinkage fired.
 * Verified empirically before the fix: `{grew:false, shrank:false}` for such
 * a swap. Fixed by recording each hit's own `file:line:col` identity in the
 * baseline (`ids`) and comparing identity SETS instead of a bare count.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { compareToBaseline } from '../scripts/check-emit-exit-agreement.mjs';

describe('compareToBaseline (identity-based ratchet)', () => {
  it('detects a same-count SWAP: opt-out removed from file A, a different one added in file B', () => {
    const baselineHits = [{ file: 'scripts/a.mjs', line: 10, col: 0 }];
    const base = {
      count: 1,
      files: { 'scripts/a.mjs': 1 },
      ids: baselineHits.map((h) => `${h.file}:${h.line}:${h.col}`),
    };

    // A is gone; B is a brand-new, never-reviewed opt-out. Total count is
    // still 1 — the exact shape the original bug missed.
    const afterSwap = [{ file: 'scripts/b.mjs', line: 5, col: 0 }];

    const result = compareToBaseline(afterSwap, base);
    assert.equal(result.grew, true, 'a swap must read as growth — a new, unreviewed opt-out exists');
    assert.equal(result.shrank, false);
    assert.equal(result.swapped, true, 'same total, different identity => flagged as swapped');
    assert.deepEqual(result.addedHits, afterSwap, 'the new opt-out must be named, not just counted');
  });

  it('does NOT flag growth when nothing changed', () => {
    const hits = [{ file: 'scripts/a.mjs', line: 10, col: 0 }];
    const base = { count: 1, files: { 'scripts/a.mjs': 1 }, ids: ['scripts/a.mjs:10:0'] };
    const result = compareToBaseline(hits, base);
    assert.equal(result.grew, false);
    assert.equal(result.shrank, false);
    assert.equal(result.swapped, false);
  });

  it('flags a genuine ADDITION (net growth, not a swap) without claiming swapped', () => {
    const base = { count: 1, files: { 'scripts/a.mjs': 1 }, ids: ['scripts/a.mjs:10:0'] };
    const hits = [
      { file: 'scripts/a.mjs', line: 10, col: 0 },
      { file: 'scripts/b.mjs', line: 5, col: 0 },
    ];
    const result = compareToBaseline(hits, base);
    assert.equal(result.grew, true);
    assert.equal(result.swapped, false, 'the count actually changed — this is a plain addition, not a swap');
    assert.deepEqual(result.addedHits, [{ file: 'scripts/b.mjs', line: 5, col: 0 }]);
  });

  it('flags a genuine ratchet-down (removal, no addition) as shrank', () => {
    const base = { count: 2, files: {}, ids: ['scripts/a.mjs:10:0', 'scripts/b.mjs:5:0'] };
    const hits = [{ file: 'scripts/a.mjs', line: 10, col: 0 }];
    const result = compareToBaseline(hits, base);
    assert.equal(result.grew, false);
    assert.equal(result.shrank, true);
  });

  it('falls back to count-only comparison for a legacy baseline with no `ids` — a same-count swap is NOT detectable there (documented, pre-existing limitation)', () => {
    const base = { count: 1, files: { 'scripts/a.mjs': 1 }, ids: null };
    const afterSwap = [{ file: 'scripts/b.mjs', line: 5, col: 0 }];
    const result = compareToBaseline(afterSwap, base);
    assert.equal(result.grew, false, 'legacy (no-ids) baselines keep the original, weaker count-only behaviour');
    assert.equal(result.shrank, false);
  });
});
