/**
 * @fileoverview Tier-1 tests for drift partition / scoping / aging.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { partitionFindings, scopeToChanged, ageDivergences, divergenceKey, firstSeenFromHistory, assessCaptureIntegrity } from '../scripts/lib/visual/drift.mjs';
import { readBaseline, writeBaseline } from '../scripts/lib/visual/store.mjs';

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

test('baseline ratchet: absent → null; round-trips; novelty filter blocks only new keys', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'visual-baseline-'));
  assert.equal(readBaseline(dir), null, 'no baseline file → null (gate hints to create one)');

  const preexisting = { class: 'token_violation', surfaceId: 's', nodeKey: 'k1', property: 'color' };
  const fresh = { class: 'token_violation', surfaceId: 's', nodeKey: 'k2', property: 'color' };
  writeBaseline(dir, [divergenceKey(preexisting)], '2026-06-26T00:00:00+00:00');

  const baseline = readBaseline(dir);
  assert.ok(baseline.has(divergenceKey(preexisting)), 'accepted key present');

  const blockers = [preexisting, fresh].filter((b) => !baseline.has(divergenceKey(b)));
  assert.deepEqual(blockers, [fresh], 'only the NEW finding survives the baseline filter');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('assessCaptureIntegrity flags degraded (all stalled) vs partial vs clean (silent-green guard)', () => {
  // all three surfaces stalled → degraded (gate must not pass green)
  const all = assessCaptureIntegrity(['a', 'b', 'c'], ['a', 'b', 'c']);
  assert.ok(all.degraded && !all.partial, 'every surface unverifiable → degraded');
  assert.equal(all.verifiedCount, 0);
  // one stalled → partial (warn, gate covers the rest)
  const some = assessCaptureIntegrity(['a', 'b', 'c'], ['b']);
  assert.ok(some.partial && !some.degraded, 'some unverifiable → partial');
  assert.equal(some.verifiedCount, 2);
  // none stalled → clean
  const clean = assessCaptureIntegrity(['a', 'b'], []);
  assert.ok(!clean.degraded && !clean.partial);
  // no surfaces declared → noSurfaces (gate checks nothing)
  assert.ok(assessCaptureIntegrity([], []).noSurfaces);
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
