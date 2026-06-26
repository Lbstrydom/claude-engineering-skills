/**
 * @fileoverview Tier-1 tests for the signifier matrix (Gemini-G2-M2).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { runSignifiers } from '../scripts/lib/visual/signifiers.mjs';

const base = { surfaceId: 's', device: 'desktop', theme: 'light' };

test('focusable node with no focus rule → missing_visible_focus', () => {
  const out = runSignifiers([{ ...base, nodeKey: 'b', focusable: true, computed: { 'outline-style': 'none' }, pseudo: {} }]);
  assert.ok(out.some((f) => f.class === 'missing_visible_focus'));
});

test('focus via box-shadow ring (not outline) passes (G2-M2)', () => {
  const out = runSignifiers([{
    ...base, nodeKey: 'b', focusable: true,
    computed: { 'outline-style': 'none', 'box-shadow': 'none' },
    pseudo: { focusVisible: { 'outline-style': 'none', 'box-shadow': '0 0 0 3px #3366ff' } },
  }]);
  assert.equal(out.filter((f) => f.class === 'missing_visible_focus').length, 0);
});

test('focus via outline passes', () => {
  const out = runSignifiers([{
    ...base, nodeKey: 'b', focusable: true,
    computed: { 'outline-style': 'none', 'outline-width': '0px' },
    pseudo: { focus: { 'outline-style': 'solid', 'outline-width': '2px' } },
  }]);
  assert.equal(out.filter((f) => f.class === 'missing_visible_focus').length, 0);
});

test('interactive node with no hover delta → state_has_no_visual_delta', () => {
  const out = runSignifiers([{
    ...base, nodeKey: 'b', interactive: true,
    computed: { 'background-color': 'rgb(0,0,255)', color: 'rgb(255,255,255)' },
    pseudo: { hover: { 'background-color': 'rgb(0,0,255)', color: 'rgb(255,255,255)' } },
  }]);
  assert.ok(out.some((f) => f.class === 'state_has_no_visual_delta'));
});

test('hover with a background change passes', () => {
  const out = runSignifiers([{
    ...base, nodeKey: 'b', interactive: true,
    computed: { 'background-color': 'rgb(0,0,255)' },
    pseudo: { hover: { 'background-color': 'rgb(0,0,200)' } },
  }]);
  assert.equal(out.filter((f) => f.class === 'state_has_no_visual_delta').length, 0);
});

test('SVG-internal decorative node is not probed for signifiers (pass-4 #2)', () => {
  // a <use> with a role/onclick marked interactive must NOT emit state_has_no_visual_delta
  const out = runSignifiers([{
    ...base, nodeKey: 'u', tag: 'use', interactive: true, focusable: true,
    computed: { 'background-color': 'rgb(0,0,0)' }, pseudo: { hover: { 'background-color': 'rgb(0,0,0)' } },
  }]);
  assert.equal(out.length, 0);
});

test('disabled control with no visual signifier → disabled_not_signified; opacity<1 passes', () => {
  const bad = runSignifiers([{ ...base, nodeKey: 'b', disabled: true, computed: { opacity: '1', cursor: 'pointer', filter: 'none' } }]);
  assert.ok(bad.some((f) => f.class === 'disabled_not_signified'));
  const ok = runSignifiers([{ ...base, nodeKey: 'b', disabled: true, computed: { opacity: '0.5', cursor: 'pointer', filter: 'none' } }]);
  assert.equal(ok.filter((f) => f.class === 'disabled_not_signified').length, 0);
});
