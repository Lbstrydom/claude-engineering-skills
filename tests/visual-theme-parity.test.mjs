/**
 * @fileoverview Tier-1 tests for theme parity + contrast byproduct (Gemini-G2-3).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { runThemeParity, runContrast } from '../scripts/lib/visual/theme-parity.mjs';

const contract = { propertyPolicy: { mustMatchGeometry: ['width', 'height', 'padding'] }, tolerances: { geometryPx: 1, contrastRatio: 4.5 } };

const n = (theme, key, computed, extra = {}) => ({ surfaceId: 's', nodeKey: key, device: 'desktop', theme, computed, ...extra });

test('geometry equal across themes → no drift', () => {
  const out = runThemeParity({
    light: [n('light', 'a', { width: '100px', height: '40px', 'padding-top': '8px' })],
    dark: [n('dark', 'a', { width: '100px', height: '40px', 'padding-top': '8px' })],
  }, contract);
  assert.equal(out.filter((f) => f.class === 'theme_geometry_drift').length, 0);
});

test('geometry differs beyond tolerance → theme_geometry_drift', () => {
  const out = runThemeParity({
    light: [n('light', 'a', { width: '100px' })],
    dark: [n('dark', 'a', { width: '108px' })],
  }, contract);
  assert.equal(out.filter((f) => f.class === 'theme_geometry_drift').length, 1);
});

test('theme-conditional node (display:none in light) is NOT geometry drift (G2-3)', () => {
  const out = runThemeParity({
    light: [n('light', 'logo', { width: '0px', height: '0px' }, { displayed: false })],
    dark: [n('dark', 'logo', { width: '120px', height: '40px' }, { displayed: true })],
  }, contract);
  assert.equal(out.filter((f) => f.class === 'theme_geometry_drift').length, 0);
});

test('hardcoded literal color identical across themes → theme_unmapped_token', () => {
  const out = runThemeParity({
    light: [n('light', 't', { color: '#222222' })],
    dark: [n('dark', 't', { color: '#222222' })],
  }, contract);
  assert.equal(out.filter((f) => f.class === 'theme_unmapped_token').length, 1);
});

test('tokened color identical across themes is a deliberate theme-agnostic token (no finding)', () => {
  const out = runThemeParity({
    light: [n('light', 't', { color: '#222222' }, { matched: { color: { usesToken: true, varName: '--ink' } } })],
    dark: [n('dark', 't', { color: '#222222' }, { matched: { color: { usesToken: true, varName: '--ink' } } })],
  }, contract);
  assert.equal(out.filter((f) => f.class === 'theme_unmapped_token').length, 0);
});

test('runContrast fires below the ratio over a resolved backdrop, silent on unverified', () => {
  const failing = runContrast([n('light', 'tx', { color: '#777777' }, { hasText: true, backgroundStack: ['255,255,255'] })], contract);
  assert.equal(failing.filter((f) => f.class === 'contrast_failure').length, 1);
  const unverified = runContrast([n('light', 'tx', { color: '#777777' }, { hasText: true, backgroundStack: ['unresolvable'] })], contract);
  assert.equal(unverified.length, 0, 'unverified backdrop never fires');
});
