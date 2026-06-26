/**
 * @fileoverview Tier-1 tests for token reconciliation (Tier 1 engine).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildTokenIndex } from '../scripts/lib/visual/tokens.mjs';
import { runReconcileTokens } from '../scripts/lib/visual/reconcile-tokens.mjs';

const allowedSet = { inferredMode: false, families: { colors: [{ value: '51,102,255', varName: '--brand' }], radius: [{ value: '6px', varName: '--radius' }] } };
const tokenIndex = buildTokenIndex(allowedSet.families);
const contract = { propertyPolicy: { tokenAudited: ['colors', 'radius'] } };

const node = (overrides) => ({ surfaceId: 's1', nodeKey: 'k1', device: 'desktop', theme: 'light', computed: {}, ...overrides });

test('on-scale value passes (no finding)', () => {
  const out = runReconcileTokens([node({ computed: { color: 'rgb(51,102,255)', 'border-top-left-radius': '6px' } })], tokenIndex, allowedSet, contract);
  assert.equal(out.length, 0);
});

test('off-scale literal → token_violation', () => {
  const out = runReconcileTokens([node({ computed: { color: '#010203' } })], tokenIndex, allowedSet, contract);
  assert.equal(out.length, 1);
  assert.equal(out[0].class, 'token_violation');
  assert.equal(out[0].property, 'color');
});

test('off-scale value set by a token var is absolved via provenance', () => {
  const out = runReconcileTokens([node({
    computed: { color: '#010203' },
    matched: { color: { winningValue: 'var(--brand-alt)', usesToken: true, varName: '--brand-alt' } },
  })], tokenIndex, allowedSet, contract);
  assert.equal(out.length, 0, 'tokened value must not be flagged even if not enumerated');
});

test('neutral defaults (0px radius, transparent) are skipped', () => {
  const out = runReconcileTokens([node({ computed: { 'border-top-left-radius': '0px', 'background-color': 'transparent' } })], tokenIndex, allowedSet, contract);
  assert.equal(out.length, 0);
});

test('inferredMode → engine is a no-op', () => {
  const out = runReconcileTokens([node({ computed: { color: '#010203' } })], tokenIndex, { inferredMode: true, families: {} }, contract);
  assert.equal(out.length, 0);
});

test('display:none nodes are skipped', () => {
  const out = runReconcileTokens([node({ displayed: false, computed: { color: '#010203' } })], tokenIndex, allowedSet, contract);
  assert.equal(out.length, 0);
});

test('empty-scale guard: a family with no declared tokens is NOT flagged (shakedown noise #1)', () => {
  // fontSize is audited but the allowed-set has no fontSize family → skip (don't
  // emit a gate-eligible violation for a dimension the app keeps as raw px).
  const c2 = { propertyPolicy: { tokenAudited: ['colors', 'radius', 'fontSize'] } };
  const out = runReconcileTokens([node({ computed: { 'font-size': '13px' } })], tokenIndex, allowedSet, c2);
  assert.equal(out.length, 0);
});

test('unpainted border (border-style:none / width 0) is not reconciled', () => {
  const colorsOnly = { inferredMode: false, families: { colors: [{ value: '51,102,255' }] } };
  const idx = buildTokenIndex(colorsOnly.families);
  const c2 = { propertyPolicy: { tokenAudited: ['colors'] } };
  const out = runReconcileTokens([node({ computed: { 'border-top-color': 'rgb(1,2,3)', 'border-top-style': 'none', 'border-top-width': '0px' } })], idx, colorsOnly, c2);
  assert.equal(out.length, 0);
  const painted = runReconcileTokens([node({ computed: { 'border-top-color': 'rgb(1,2,3)', 'border-top-style': 'solid', 'border-top-width': '1px' } })], idx, colorsOnly, c2);
  assert.equal(painted.length, 1, 'a painted off-scale border IS flagged');
});

test('SVG-internal decorative nodes (use/path) are skipped', () => {
  const out = runReconcileTokens([node({ tag: 'use', computed: { color: '#010203', 'font-size': '13px' } })], tokenIndex, allowedSet, contract);
  assert.equal(out.length, 0);
});

test('tokenAudited: [] is a real off-switch (audits NONE); absent audits all (gate #2a)', () => {
  const offByEmpty = runReconcileTokens([node({ computed: { color: '#010203' } })], tokenIndex, allowedSet, { propertyPolicy: { tokenAudited: [] } });
  assert.equal(offByEmpty.length, 0, 'explicit [] audits no families');
  const onByAbsent = runReconcileTokens([node({ computed: { color: '#010203' } })], tokenIndex, allowedSet, {});
  assert.equal(onByAbsent.length, 1, 'absent tokenAudited audits all families');
});

test('rgba(var(--token-rgb), α) is absolved by its opaque base on-scale (gate #2b)', () => {
  // colors scale has 51,102,255; a reduced-alpha use of it composites to 51,102,255,0.15
  const out = runReconcileTokens([node({ computed: { 'background-color': 'rgba(51,102,255,0.15)' } })], tokenIndex, allowedSet, contract);
  assert.equal(out.length, 0, 'a token color at reduced alpha is tokened, not a violation');
  // but an alpha color whose opaque base is NOT on scale still flags
  const bad = runReconcileTokens([node({ computed: { 'background-color': 'rgba(1,2,3,0.15)' } })], tokenIndex, allowedSet, contract);
  assert.equal(bad.length, 1);
});
