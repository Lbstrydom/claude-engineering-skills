/**
 * @fileoverview Tier-1 tests for the winning-declaration cascade resolver (GPT-R2-H2).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveProvenance, declarationUsesToken } from '../scripts/lib/visual/provenance-resolver.mjs';

test('!important wins over a higher-specificity non-important rule', () => {
  const decls = [
    { property: 'color', value: 'var(--brand)', important: true, specificity: [0, 1, 0], sourceOrder: 1 },
    { property: 'color', value: '#ff0000', specificity: [1, 0, 0], sourceOrder: 2 },
  ];
  const r = resolveProvenance(decls, 'color');
  assert.equal(r.winningValue, 'var(--brand)');
  assert.equal(r.usesToken, true);
  assert.equal(r.varName, '--brand');
});

test('a literal that overrides a var() rule by source order is NOT absolved as tokened', () => {
  const decls = [
    { property: 'color', value: 'var(--brand)', specificity: [0, 1, 0], sourceOrder: 1 },
    { property: 'color', value: '#123456', specificity: [0, 1, 0], sourceOrder: 2 },
  ];
  assert.equal(declarationUsesToken(decls, 'color'), false, 'winning literal must not count as token usage');
});

test('higher specificity wins when importance + layer are equal', () => {
  const decls = [
    { property: 'background-color', value: '#aaa', specificity: [0, 1, 0], sourceOrder: 5 },
    { property: 'background-color', value: 'var(--bg)', specificity: [0, 2, 0], sourceOrder: 1 },
  ];
  assert.equal(resolveProvenance(decls, 'background-color').usesToken, true);
});

test('shorthand `margin` expands to the audited longhand', () => {
  const decls = [{ property: 'margin', value: 'var(--space-2)', specificity: [0, 1, 0], sourceOrder: 1 }];
  const r = resolveProvenance(decls, 'margin-top');
  assert.ok(r && r.usesToken);
});

test('no declaration for the property → null', () => {
  assert.equal(resolveProvenance([{ property: 'color', value: 'red' }], 'font-size'), null);
});
