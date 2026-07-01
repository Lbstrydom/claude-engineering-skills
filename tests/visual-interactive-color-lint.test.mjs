/**
 * @fileoverview Theme-safety PIECE 1a — the static "styled the box, forgot the
 * text" lint. Pure (no browser). Advisory / report-only.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { lintInteractiveColor } from '../scripts/lib/visual/interactive-color-lint.mjs';

const src = (content, p = 'a.css') => [{ path: p, content }];

describe('lintInteractiveColor', () => {
  it('flags a control that sets background but not color', () => {
    const f = lintInteractiveColor(src('button { background: #fff; }'));
    assert.equal(f.length, 1);
    assert.equal(f[0].class, 'interactive_color_unset');
    assert.equal(f[0].gateEligible, false); // advisory v1
    assert.match(f[0].evidence[0], /a\.css/);
  });

  it('flags a .btn that sets a visible border but not color', () => {
    assert.equal(lintInteractiveColor(src('.btn { border: 1px solid; }')).length, 1);
  });

  it('does NOT flag when color is set in the same rule', () => {
    assert.equal(lintInteractiveColor(src('button { background:#fff; color:#333; }')).length, 0);
  });

  it('does NOT flag when a COMPANION rule sets color', () => {
    assert.equal(lintInteractiveColor(src('button{background:#fff} button{color:#333}')).length, 0);
  });

  it('does NOT flag a non-control selector, or a control with no box', () => {
    assert.equal(lintInteractiveColor(src('div { background:#fff; }')).length, 0, 'not a control');
    assert.equal(lintInteractiveColor(src('button { color:#333; }')).length, 0, 'no box');
    assert.equal(lintInteractiveColor(src('button { border-radius: 4px; }')).length, 0, 'border-radius is not a box border');
  });

  it('handles grouped selectors', () => {
    const f = lintInteractiveColor(src('button, .btn { background:#fff; }'));
    assert.equal(f.length, 2); // both sub-selectors flagged
  });

  it('a border shorthand with a transparent/none/0 token is NOT a visible box (M1/L1)', () => {
    assert.equal(lintInteractiveColor(src('.btn { border: 1px solid transparent; }')).length, 0);
    assert.equal(lintInteractiveColor(src('button { border: 0 solid red; }')).length, 0);
    assert.equal(lintInteractiveColor(src('button { border: 1px none red; }')).length, 0);
    assert.equal(lintInteractiveColor(src('.btn { border: 1px solid #333; }')).length, 1, 'a real border IS a box');
  });

  it('empty / unreadable sources → no findings, no throw', () => {
    assert.deepEqual(lintInteractiveColor([]), []);
    assert.deepEqual(lintInteractiveColor(null), []);
  });
});
