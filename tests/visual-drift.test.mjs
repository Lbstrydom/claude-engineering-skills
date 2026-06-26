/**
 * @fileoverview Tier-1 tests for drift partition / scoping / aging.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { partitionFindings, scopeToChanged, ageDivergences, divergenceKey, firstSeenFromHistory } from '../scripts/lib/visual/drift.mjs';

test('partitionFindings splits by gateEligible', () => {
  const { gateEligible, advisory } = partitionFindings([
    { class: 'token_violation', gateEligible: true },
    { class: 'component_inconsistency', gateEligible: false },
  ]);
  assert.equal(gateEligible.length, 1);
  assert.equal(advisory.length, 1);
});

test('scopeToChanged delegates to the canonical resolver (never false-blocks on null)', () => {
  const findings = [{ class: 'token_violation', surfaceId: 'pricing', property: 'color', gateEligible: true }];
  const surfaces = [{ id: 'pricing', sourceGlobs: ['src/pricing/**'] }];
  assert.deepEqual(scopeToChanged(findings, { changedPaths: null, surfaces }), []);
  assert.equal(scopeToChanged(findings, { changedPaths: ['src/pricing/x.tsx'], surfaces }).length, 1);
});

test('divergenceKey is stable per (class, surface, node, property)', () => {
  const f = { class: 'token_violation', surfaceId: 's', nodeKey: 'k', property: 'color' };
  assert.equal(divergenceKey(f), 'token_violation:s:k:color');
});

test('ageDivergences computes ageDays from cloud firstSeen', () => {
  const lookup = (k) => (k.startsWith('token_violation') ? '2026-06-01T00:00:00+00:00' : null);
  const aged = ageDivergences([{ class: 'token_violation', surfaceId: 's', nodeKey: 'k', property: 'color' }], { firstSeenLookup: lookup, headCommitDate: '2026-06-11T00:00:00+00:00' });
  assert.equal(aged[0].ageDays, 10);
});

test('firstSeenFromHistory ignores invalid timestamps and keeps the earliest', () => {
  const lookup = firstSeenFromHistory([
    { driftKeys: ['k1'], capturedAt: 'not-a-date' },
    { driftKeys: ['k1'], capturedAt: '2026-06-05T00:00:00+00:00' },
    { driftKeys: ['k1'], capturedAt: '2026-06-01T00:00:00+00:00' },
  ]);
  assert.equal(lookup('k1'), '2026-06-01T00:00:00+00:00');
  assert.equal(lookup('missing'), null);
});
