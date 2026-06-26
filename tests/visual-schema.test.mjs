/**
 * @fileoverview Tier-1 tests for the visual-audit schema contracts — digest
 * determinism, strict-contract typo rejection, discriminated theme-apply union.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  VisualContractSchema,
  computeContractDigest,
  computeConfigDigest,
  GATE_ELIGIBLE_CLASSES,
} from '../scripts/lib/visual/schema.mjs';

const baseContract = {
  version: 1,
  surfaces: [{ id: 's1', selector: '.grid', sourceGlobs: ['src/a/**'] }],
  tokenSources: [{ type: 'css-vars', path: 'src/tokens.css' }],
  themes: [{ name: 'light', apply: { mode: 'class', target: 'html', value: 'light' } }],
};

test('VisualContractSchema accepts a minimal valid contract + applies defaults', () => {
  const r = VisualContractSchema.safeParse(baseContract);
  assert.ok(r.success, r.success ? '' : JSON.stringify(r.error.issues));
  assert.equal(r.data.surfaces[0].nodeBudget, 400);
  assert.equal(r.data.tolerances.contrastRatio, 4.5);
});

test('VisualContractSchema is STRICT — a typo on a meaningful key fails loudly', () => {
  const bad = { ...baseContract, surfaces: [{ id: 's1', selector: '.g', sourceGlob: ['x'] }] };
  const r = VisualContractSchema.safeParse(bad);
  assert.ok(!r.success, 'expected strict rejection of `sourceGlob` typo');
});

test('theme apply is a discriminated union — class mode requires value', () => {
  const bad = { ...baseContract, themes: [{ name: 'dark', apply: { mode: 'class', target: 'html' } }] };
  assert.ok(!VisualContractSchema.safeParse(bad).success, 'class mode without value should fail');
  const good = { ...baseContract, themes: [{ name: 'dark', apply: { mode: 'media', colorScheme: 'dark' } }] };
  assert.ok(VisualContractSchema.safeParse(good).success, 'media mode with colorScheme should pass');
});

test('computeContractDigest is stable across key ordering + array ordering', () => {
  const a = computeContractDigest(baseContract);
  const reordered = {
    themes: baseContract.themes,
    tokenSources: baseContract.tokenSources,
    surfaces: [{ sourceGlobs: ['src/a/**'], selector: '.grid', id: 's1' }],
    version: 1,
  };
  assert.equal(computeContractDigest(reordered), a, 'digest must ignore cosmetic ordering');
});

test('computeContractDigest changes when a surface sourceGlob changes', () => {
  const a = computeContractDigest(baseContract);
  const b = computeContractDigest({ ...baseContract, surfaces: [{ id: 's1', selector: '.grid', sourceGlobs: ['src/b/**'] }] });
  assert.notEqual(a, b);
});

test('computeConfigDigest is a function of adapterVersion + contractDigest', () => {
  const cd = computeContractDigest(baseContract);
  assert.equal(computeConfigDigest({ contractDigest: cd }), computeConfigDigest({ contractDigest: cd }));
  assert.notEqual(
    computeConfigDigest({ adapterVersion: 1, contractDigest: cd }),
    computeConfigDigest({ adapterVersion: 2, contractDigest: cd }),
  );
});

test('inferred + source-coherence classes are NOT gate-eligible', () => {
  for (const c of ['component_inconsistency', 'token_unreferenced', 'token_undefined_reference', 'token_duplicate_definition']) {
    assert.ok(!GATE_ELIGIBLE_CLASSES.has(c), `${c} must not gate`);
  }
  assert.ok(GATE_ELIGIBLE_CLASSES.has('token_violation'));
  assert.ok(GATE_ELIGIBLE_CLASSES.has('theme_geometry_drift'));
});
