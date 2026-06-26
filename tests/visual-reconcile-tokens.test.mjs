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
