/**
 * @fileoverview Tier-1 unit test for the deploy-topology seam (GREEN ≠ REALIZED Cluster C,
 * plan: docs/completed/green-not-realized.md Phase 7). Pure — no /cycle run needed. Pins the
 * mode→action→message mapping the cycle SKILL Step 5 depends on, incl. the safe degrade for
 * unknown / missing config (opt-in default).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { resolvePreviewGate, PREVIEW_GATE_MODES } from '../scripts/lib/cycle/topology.mjs';

test('pre_merge_required → halt (must gate before merge)', () => {
  const g = resolvePreviewGate({ previewGateMode: 'pre_merge_required' });
  assert.equal(g.action, 'halt');
  assert.equal(g.mode, 'pre_merge_required');
  assert.match(g.message, /before merge/i);
});

test('post_merge_warning → warn (post-hoc, cannot prevent prod exposure)', () => {
  const g = resolvePreviewGate({ previewGateMode: 'post_merge_warning' });
  assert.equal(g.action, 'warn');
  assert.match(g.message, /POST-HOC|cannot prevent/i);
});

test('not_applicable → none, silent (empty message)', () => {
  const g = resolvePreviewGate({ previewGateMode: 'not_applicable' });
  assert.equal(g.action, 'none');
  assert.equal(g.message, '');
});

test('missing / undefined config → not_applicable+none (opt-in default)', () => {
  assert.deepEqual(resolvePreviewGate(), { mode: 'not_applicable', action: 'none', message: '' });
  assert.deepEqual(resolvePreviewGate({}), { mode: 'not_applicable', action: 'none', message: '' });
});

test('unknown mode → degrades to not_applicable (never invents a gate)', () => {
  const g = resolvePreviewGate({ previewGateMode: 'deploy-from-main-lol' });
  assert.equal(g.mode, 'not_applicable');
  assert.equal(g.action, 'none');
});

test('non-object config does not throw', () => {
  assert.equal(resolvePreviewGate(null).action, 'none');
  assert.equal(resolvePreviewGate('nonsense').action, 'none');
});

test('PREVIEW_GATE_MODES is the canonical 3-state set', () => {
  assert.deepEqual([...PREVIEW_GATE_MODES].sort(), ['not_applicable', 'post_merge_warning', 'pre_merge_required']);
});
