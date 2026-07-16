/**
 * @fileoverview Tier-1 tests for token normalization + allowed-set extraction.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { normalizeColor, normalizeLength, normalizeByFamily, extractAllowedSet, buildTokenIndex, inferClusters } from '../scripts/lib/visual/tokens.mjs';

test('normalizeColor canonicalizes hex/rgb/shorthand to r,g,b[,a]', () => {
  assert.equal(normalizeColor('#FFF'), '255,255,255');
  assert.equal(normalizeColor('#ff0000'), '255,0,0');
  assert.equal(normalizeColor('rgb(0, 128, 255)'), '0,128,255');
  assert.equal(normalizeColor('rgba(0,0,0,0.5)'), '0,0,0,0.5');
  assert.equal(normalizeColor('transparent'), '0,0,0,0');
  assert.equal(normalizeColor('not-a-color'), null);
});

test('normalizeLength converts rem→px at 16 base and rounds', () => {
  assert.equal(normalizeLength('1rem'), '16px');
  assert.equal(normalizeLength('8px'), '8px');
  assert.equal(normalizeLength('0.5rem'), '8px');
  assert.equal(normalizeLength('auto'), null);
});

test('normalizeByFamily maps fontWeight keywords + unitless lineHeight', () => {
  assert.equal(normalizeByFamily('fontWeight', 'bold'), '700');
  assert.equal(normalizeByFamily('lineHeight', '1.5'), '1.5');
  assert.equal(normalizeByFamily('colors', '#000'), '0,0,0');
});

test('extractAllowedSet reads css-vars + json and builds a usable index', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'visual-tokens-'));
  fs.writeFileSync(path.join(dir, 'tokens.css'), ':root{--color-brand:#3366ff;--space-2:8px;--radius-md:6px;}');
  fs.writeFileSync(path.join(dir, 'extra.json'), JSON.stringify({ colors: { accent: '#ff8800' }, spacing: { lg: '16px' } }));
  const contract = {
    tokenSources: [
      { type: 'css-vars', path: 'tokens.css' },
      { type: 'json', path: 'extra.json' },
    ],
  };
  const { allowedSet, tokenIndex } = await extractAllowedSet(dir, contract);
  assert.equal(allowedSet.inferredMode, false);
  assert.ok(tokenIndex.has('colors', '51,102,255'), 'css var color in scale');
  assert.ok(tokenIndex.has('spacing', '8px'), 'css var spacing in scale');
  assert.ok(tokenIndex.has('colors', '255,136,0'), 'json color in scale');
  assert.equal(tokenIndex.has('colors', '1,2,3'), false, 'unknown color not in scale');
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
});

test('`--font-*` named length tokens classify as fontSize, not spacing (shakedown #1)', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'visual-font-'));
  fs.writeFileSync(path.join(dir, 'vars.css'), ':root{--font-sm:0.85rem;--btn-font-lg:1.2rem;--space-2:8px;--font-weight-bold:700;}');
  const { allowedSet, tokenIndex } = await extractAllowedSet(dir, { tokenSources: [{ type: 'css-vars', path: 'vars.css' }] });
  assert.ok(tokenIndex.has('fontSize', '13.6px'), '0.85rem → 13.6px in fontSize (rem→px)');
  assert.ok(tokenIndex.has('fontSize', '19.2px'), '--btn-font-lg 1.2rem → 19.2px in fontSize');
  assert.ok(tokenIndex.has('spacing', '8px'), '--space-2 stays spacing');
  assert.ok(!(allowedSet.families.spacing || []).some((t) => t.value === '13.6px'), 'font sizes no longer pollute spacing');
  assert.ok(tokenIndex.has('fontWeight', '700'), '--font-weight-bold stays fontWeight (unitless)');
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
});

test('extractAllowedSet with no sources → inferredMode', async () => {
  const { allowedSet } = await extractAllowedSet('/nonexistent', { tokenSources: [] });
  assert.equal(allowedSet.inferredMode, true);
});

test('inferClusters flags a minority outlier only when a dominant cluster exists', () => {
  const vals = [];
  for (let i = 0; i < 9; i++) vals.push({ family: 'spacing', value: '8px' });
  vals.push({ family: 'spacing', value: '11px' });
  const out = inferClusters(vals);
  assert.ok(out.some((o) => o.value === '11px'), 'outlier flagged');
  assert.ok(!out.some((o) => o.value === '8px'), 'dominant value not flagged');
});

test('buildTokenIndex respects theme scoping', () => {
  const idx = buildTokenIndex({ colors: [{ value: '0,0,0', varName: '--fg', theme: 'dark' }] });
  assert.equal(idx.has('colors', '0,0,0', 'dark'), true);
  assert.equal(idx.has('colors', '0,0,0', 'light'), false, 'dark-scoped token not valid in light');
});
