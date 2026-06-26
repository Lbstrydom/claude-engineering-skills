/**
 * @fileoverview Tier-1 tests for the static source-coherence lint (report-only).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildTokenIndex } from '../scripts/lib/visual/tokens.mjs';
import { runSourceCoherence } from '../scripts/lib/visual/source-coherence.mjs';

const tokenIndex = buildTokenIndex({
  colors: [{ value: '0,0,0', varName: '--ink' }, { value: '255,255,255', varName: '--paper' }],
});

test('declared-but-unreferenced token → token_unreferenced (info, report-only)', () => {
  const out = runSourceCoherence({ tokenIndex, usageCorpus: '.x{color:var(--ink)}' });
  const unref = out.filter((f) => f.class === 'token_unreferenced');
  assert.ok(unref.some((f) => f.detail.includes('--paper')));
  assert.ok(out.every((f) => f.severity === 'info'));
});

test('source references an undefined token → token_undefined_reference', () => {
  const out = runSourceCoherence({ tokenIndex, usageCorpus: '.x{color:var(--ghost)}' });
  assert.ok(out.some((f) => f.class === 'token_undefined_reference' && f.detail.includes('--ghost')));
});

test('no corpus → no defined/undefined diagnostics (only pass-through dups)', () => {
  const out = runSourceCoherence({ tokenIndex, duplicateWarnings: ['token_duplicate_definition: colors 0,0,0 defined twice'] });
  assert.equal(out.filter((f) => f.class === 'token_unreferenced').length, 0);
  assert.ok(out.some((f) => f.class === 'token_duplicate_definition'));
});
