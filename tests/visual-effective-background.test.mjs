/**
 * @fileoverview Tier-1 tests for effective-background resolution (Gemini-G1/G2-M1).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveEffectiveBackground, UNRESOLVABLE } from '../scripts/lib/visual/effective-background.mjs';

test('an unresolvable layer (gradient/image) → unverified, never a fabricated backdrop', () => {
  const r = resolveEffectiveBackground(['255,255,255,0.5', UNRESOLVABLE], { theme: 'light' });
  assert.equal(r.status, 'unverified');
});

test('transparent stack bottoms out on the UA canvas default (G2-M1), not unverified', () => {
  const light = resolveEffectiveBackground(['0,0,0,0'], { theme: 'light' });
  assert.equal(light.status, 'resolved');
  assert.equal(light.color, '255,255,255');
  const dark = resolveEffectiveBackground([], { theme: 'dark' });
  assert.equal(dark.status, 'resolved');
  assert.equal(dark.color, '18,18,18');
});

test('opaque layer in the stack is the backdrop', () => {
  const r = resolveEffectiveBackground(['0,0,0,0', '20,30,40'], { theme: 'light' });
  assert.equal(r.status, 'resolved');
  assert.equal(r.color, '20,30,40');
});

test('translucent layer composites over the lower opaque layer', () => {
  // 50% white over black → ~128 grey
  const r = resolveEffectiveBackground(['255,255,255,0.5', '0,0,0'], { theme: 'light' });
  assert.equal(r.color, '128,128,128');
});
