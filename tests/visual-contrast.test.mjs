/**
 * @fileoverview Tier-1 tests for WCAG contrast math.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { contrastRatio, relativeLuminance, textContrast, composite, parseRgba } from '../scripts/lib/visual/contrast.mjs';

test('black on white is 21:1; identical colors are 1:1', () => {
  assert.equal(contrastRatio({ r: 0, g: 0, b: 0 }, { r: 255, g: 255, b: 255 }), 21);
  assert.equal(contrastRatio({ r: 80, g: 80, b: 80 }, { r: 80, g: 80, b: 80 }), 1);
});

test('relativeLuminance bounds', () => {
  assert.equal(relativeLuminance({ r: 0, g: 0, b: 0 }), 0);
  assert.ok(Math.abs(relativeLuminance({ r: 255, g: 255, b: 255 }) - 1) < 1e-9);
});

test('parseRgba handles 3 and 4 component normalized strings', () => {
  assert.deepEqual(parseRgba('0,0,0'), { r: 0, g: 0, b: 0, a: 1 });
  assert.deepEqual(parseRgba('255,255,255,0.5'), { r: 255, g: 255, b: 255, a: 0.5 });
});

test('composite blends a translucent fg over an opaque bg', () => {
  // 50% black over white → mid grey ~128
  const c = composite({ r: 0, g: 0, b: 0, a: 0.5 }, { r: 255, g: 255, b: 255 });
  assert.equal(c.r, 128); assert.equal(c.g, 128); assert.equal(c.b, 128);
});

test('textContrast composes translucent text then computes the ratio', () => {
  // opaque dark grey text on white
  const ratio = textContrast('64,64,64', '255,255,255');
  assert.ok(ratio > 10 && ratio < 11, `unexpected ratio ${ratio}`);
  // unparseable → null (never fabricated)
  assert.equal(textContrast('nope', '255,255,255'), null);
});
