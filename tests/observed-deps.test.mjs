/**
 * @fileoverview Tests for the observed-deps two-layer model.
 * Plan: docs/plans/observed-domain-deps.md §8 Groups A-F.
 *
 * Group A — computeObservedDomainDeps (pure compute)
 * Group B — mergeDomainDeps (merge semantics, R1-H2)
 * Group C — computeDomainMapDigest (envelope freshness signal, R1-H1)
 * Group D — ObservedDepsSchema boundary validation (R1-M1)
 * Group E — readDomainDeps fallback behaviour (filesystem fixtures, R1-M2 + R2-H1)
 * Group F — flattenMergedDeps adapter for archTiers
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  OBSERVED_FILE,
  OBSERVED_VERSION,
  ObservedDepsSchema,
  computeDomainMapDigest,
  computeObservedDomainDeps,
  mergeDomainDeps,
  flattenMergedDeps,
} from '../scripts/lib/observed-deps.mjs';
import { readDomainDeps } from '../scripts/lib/dashboard/collect-reference.mjs';

// Shared rule set — keep order-significant for first-match-wins
const RULES = [
  { pattern: 'scripts/lib/store/**', domain: 'arch-memory' },
  { pattern: 'scripts/lib/dashboard/**', domain: 'dashboard' },
  { pattern: 'scripts/lib/**', domain: 'shared-lib' },
  { pattern: 'scripts/**', domain: 'scripts' },
];

// ── Group A — computeObservedDomainDeps ────────────────────────────────────

test('A1: empty edges → {}', () => {
  assert.deepEqual(computeObservedDomainDeps([], RULES), {});
});

test('A2: single cross-domain edge → tagged map', () => {
  const edges = [{ importer: 'scripts/lib/store/foo.mjs', imported: 'scripts/lib/util.mjs' }];
  assert.deepEqual(computeObservedDomainDeps(edges, RULES), {
    'arch-memory': ['shared-lib'],
  });
});

test('A3: self-loop (same domain) excluded', () => {
  const edges = [{ importer: 'scripts/lib/util-a.mjs', imported: 'scripts/lib/util-b.mjs' }];
  assert.deepEqual(computeObservedDomainDeps(edges, RULES), {});
});

test('A4: untagged endpoint (no rule matches) excluded', () => {
  const edges = [
    { importer: 'scripts/lib/store/x.mjs', imported: 'node_modules/zod/index.mjs' },
    { importer: 'node_modules/pg/lib.mjs', imported: 'scripts/lib/store/y.mjs' },
  ];
  assert.deepEqual(computeObservedDomainDeps(edges, RULES), {});
});

test('A5: multiple edges into same target dedup', () => {
  const edges = [
    { importer: 'scripts/lib/store/a.mjs', imported: 'scripts/lib/util.mjs' },
    { importer: 'scripts/lib/store/b.mjs', imported: 'scripts/lib/util.mjs' },
    { importer: 'scripts/lib/store/c.mjs', imported: 'scripts/lib/other.mjs' },
  ];
  assert.deepEqual(computeObservedDomainDeps(edges, RULES), {
    'arch-memory': ['shared-lib'],
  });
});

test('A6: to-domains sorted alphabetically', () => {
  const edges = [
    { importer: 'scripts/lib/store/a.mjs', imported: 'scripts/lib/dashboard/x.mjs' },
    { importer: 'scripts/lib/store/b.mjs', imported: 'scripts/lib/util.mjs' },
    { importer: 'scripts/lib/store/c.mjs', imported: 'scripts/foo.mjs' },
  ];
  const result = computeObservedDomainDeps(edges, RULES);
  assert.deepEqual(result['arch-memory'], ['dashboard', 'scripts', 'shared-lib']);
});

test('A7: outer from-keys deterministically sorted (R2-L4)', () => {
  // Run twice with identical edges in different orders — keys must be identical
  const edgesA = [
    { importer: 'scripts/lib/store/x.mjs', imported: 'scripts/lib/util.mjs' },
    { importer: 'scripts/lib/dashboard/y.mjs', imported: 'scripts/lib/util.mjs' },
  ];
  const edgesB = [...edgesA].reverse();
  const a = computeObservedDomainDeps(edgesA, RULES);
  const b = computeObservedDomainDeps(edgesB, RULES);
  assert.deepEqual(Object.keys(a), Object.keys(b));
  assert.deepEqual(Object.keys(a), ['arch-memory', 'dashboard']);  // alpha-sorted
});

test('A8: malformed edge entries skipped without throwing', () => {
  const edges = [
    null,
    { importer: 'scripts/lib/store/a.mjs', imported: 'scripts/lib/util.mjs' },
    { importer: 123, imported: 'x' },
    { importer: 'scripts/lib/store/b.mjs' }, // missing imported
  ];
  const result = computeObservedDomainDeps(edges, RULES);
  assert.deepEqual(result, { 'arch-memory': ['shared-lib'] });
});

// ── Group B — mergeDomainDeps ──────────────────────────────────────────────

test('B1: both empty → {}', () => {
  assert.deepEqual(mergeDomainDeps({}, {}), {});
});

test('B2: observed-only edge → source: observed', () => {
  const result = mergeDomainDeps({ 'arch-memory': ['shared-lib'] }, {});
  assert.deepEqual(result, { 'arch-memory': [{ to: 'shared-lib', source: 'observed' }] });
});

test('B3: manual-only edge → source: manual', () => {
  const result = mergeDomainDeps({}, { 'arch-memory': ['shared-lib'] });
  assert.deepEqual(result, { 'arch-memory': [{ to: 'shared-lib', source: 'manual' }] });
});

test('B4: edge in both → source: both', () => {
  const result = mergeDomainDeps(
    { 'arch-memory': ['shared-lib'] },
    { 'arch-memory': ['shared-lib'] },
  );
  assert.deepEqual(result, { 'arch-memory': [{ to: 'shared-lib', source: 'both' }] });
});

test('B5: distinct edges from same from → both retained, sorted alpha by to', () => {
  const result = mergeDomainDeps(
    { 'arch-memory': ['shared-lib'] },
    { 'arch-memory': ['dashboard'] },
  );
  assert.deepEqual(result['arch-memory'], [
    { to: 'dashboard', source: 'manual' },
    { to: 'shared-lib', source: 'observed' },
  ]);
});

test('B6: manual entry with empty [] preserved (self-contained intent)', () => {
  const result = mergeDomainDeps({}, { 'claudemd-management': [] });
  assert.deepEqual(result, { 'claudemd-management': [] });
});

test('B7: null inputs treated as empty', () => {
  assert.deepEqual(mergeDomainDeps(null, null), {});
});

test('B8: dangerous keys (__proto__/constructor/prototype) skipped (Gemini-G2)', () => {
  // Hand-edited domain-map.json with __proto__ key (JSON.parse makes this an own key on modern Node)
  const malicious = { '__proto__': ['shared-lib'], 'constructor': ['x'], 'prototype': ['y'] };
  const result = mergeDomainDeps({}, malicious);
  assert.deepEqual(result, {});  // all three dangerous keys dropped
  // Confirm prototype not polluted
  assert.equal({}.shared, undefined);
});

test('B9: non-string array values filtered (Gemini-M7)', () => {
  const manual = { 'arch-memory': ['shared-lib', 42, null, '', 'plan'] };
  const result = mergeDomainDeps({}, manual);
  // Only the two valid string entries survive
  assert.deepEqual(result['arch-memory'], [
    { to: 'plan', source: 'manual' },
    { to: 'shared-lib', source: 'manual' },
  ]);
});

// ── Group C — computeDomainMapDigest ────────────────────────────────────────

test('C1: empty rules → stable 64-char lowercase hex', () => {
  const digest = computeDomainMapDigest([]);
  assert.match(digest, /^[0-9a-f]{64}$/);
  assert.equal(digest, computeDomainMapDigest([]));
});

test('C2: adding a rule changes the digest', () => {
  const before = computeDomainMapDigest(RULES);
  const after = computeDomainMapDigest([...RULES, { pattern: 'new/**', domain: 'new' }]);
  assert.notEqual(before, after);
});

test('C3: reordering rules changes the digest (first-match-wins is semantic)', () => {
  const before = computeDomainMapDigest(RULES);
  const reordered = [...RULES].reverse();
  const after = computeDomainMapDigest(reordered);
  assert.notEqual(before, after);
});

test('C4: identical-rule-array calls produce identical digests', () => {
  const a = computeDomainMapDigest(RULES);
  const b = computeDomainMapDigest([...RULES]);  // structurally equal
  assert.equal(a, b);
});

test('C5: null or non-array input returns the empty-rules digest', () => {
  const empty = computeDomainMapDigest([]);
  assert.equal(computeDomainMapDigest(null), empty);
  assert.equal(computeDomainMapDigest('not-an-array'), empty);
});

// ── Group D — ObservedDepsSchema validation ────────────────────────────────

const VALID_ENVELOPE = {
  version: OBSERVED_VERSION,
  refreshId: 'abc-123',
  domainMapDigest: 'a'.repeat(64),
  generatedAt: '2026-05-22T10:00:00.000Z',
  deps: { 'arch-memory': ['shared-lib'] },
};

test('D1: valid envelope parses', () => {
  const r = ObservedDepsSchema.safeParse(VALID_ENVELOPE);
  assert.equal(r.success, true);
});

test('D2: missing field → safeParse fails', () => {
  const { refreshId, ...rest } = VALID_ENVELOPE;
  const r = ObservedDepsSchema.safeParse(rest);
  assert.equal(r.success, false);
});

test('D3: wrong version literal → fails', () => {
  const r = ObservedDepsSchema.safeParse({ ...VALID_ENVELOPE, version: 2 });
  assert.equal(r.success, false);
});

test('D4: non-hex domainMapDigest → fails', () => {
  const r = ObservedDepsSchema.safeParse({ ...VALID_ENVELOPE, domainMapDigest: 'NOT-HEX!' });
  assert.equal(r.success, false);
});

test('D5: deps with non-array value → fails', () => {
  const r = ObservedDepsSchema.safeParse({ ...VALID_ENVELOPE, deps: { x: 'not-an-array' } });
  assert.equal(r.success, false);
});

// ── Group E — readDomainDeps fallback (filesystem fixtures) ────────────────

function makeFixtureRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'observed-deps-test-'));
  fs.mkdirSync(path.join(root, '.audit-loop'), { recursive: true });
  return root;
}

function writeDomainMap(root, allowedDeps, rules = RULES) {
  fs.writeFileSync(
    path.join(root, '.audit-loop', 'domain-map.json'),
    JSON.stringify({ rules, allowedDeps }, null, 2),
  );
}

function writeObserved(root, envelope) {
  fs.writeFileSync(
    path.join(root, OBSERVED_FILE),
    JSON.stringify(envelope, null, 2),
  );
}

test('E1: observed absent → returns manual-only, observedRejectedReason=absent', () => {
  const root = makeFixtureRoot();
  writeDomainMap(root, { 'arch-memory': ['shared-lib'] });
  const r = readDomainDeps(root);
  assert.equal(r.depsSource.observedAvailable, false);
  assert.equal(r.depsSource.observedRejectedReason, 'absent');
  assert.deepEqual(r.deps, { 'arch-memory': ['shared-lib'] });
  assert.equal(r.depsSource.edgeCounts.manual, 1);
  assert.equal(r.depsSource.edgeCounts.observed, 0);
});

test('E2: observed valid + digest matches → merged, observedAvailable=true', () => {
  const root = makeFixtureRoot();
  writeDomainMap(root, { 'arch-memory': ['shared-lib'] });
  writeObserved(root, {
    version: OBSERVED_VERSION,
    refreshId: 'snap-xyz',
    domainMapDigest: computeDomainMapDigest(RULES),
    generatedAt: '2026-05-22T10:00:00.000Z',
    deps: { 'arch-memory': ['dashboard', 'shared-lib'] },
  });
  const r = readDomainDeps(root);
  assert.equal(r.depsSource.observedAvailable, true);
  assert.equal(r.depsSource.observedRejectedReason, null);
  assert.equal(r.depsSource.observedRefreshId, 'snap-xyz');
  assert.deepEqual(r.deps['arch-memory'], ['dashboard', 'shared-lib']);
  // shared-lib edge is in both, dashboard is observed-only
  assert.equal(r.depsSource.edgeCounts.both, 1);
  assert.equal(r.depsSource.edgeCounts.observed, 1);
});

test('E3: observed digest mismatches → rejected as stale-rules', () => {
  const root = makeFixtureRoot();
  writeDomainMap(root, { 'arch-memory': ['shared-lib'] });
  writeObserved(root, {
    version: OBSERVED_VERSION,
    refreshId: 'snap-xyz',
    domainMapDigest: 'b'.repeat(64),  // bogus digest
    generatedAt: '2026-05-22T10:00:00.000Z',
    deps: { 'arch-memory': ['dashboard'] },
  });
  const r = readDomainDeps(root);
  assert.equal(r.depsSource.observedAvailable, false);
  assert.equal(r.depsSource.observedRejectedReason, 'stale-rules');
  // falls back to manual
  assert.deepEqual(r.deps, { 'arch-memory': ['shared-lib'] });
});

test('E4: observed JSON malformed → rejected as unreadable', () => {
  const root = makeFixtureRoot();
  writeDomainMap(root, {});
  fs.writeFileSync(path.join(root, OBSERVED_FILE), '{not valid json');
  const r = readDomainDeps(root);
  assert.equal(r.depsSource.observedRejectedReason, 'unreadable');
});

test('E5: observed schema mismatch → rejected as schema-invalid', () => {
  const root = makeFixtureRoot();
  writeDomainMap(root, {});
  writeObserved(root, { ...VALID_ENVELOPE, version: 99 });
  const r = readDomainDeps(root);
  assert.equal(r.depsSource.observedRejectedReason, 'schema-invalid');
});

test('E6: both files absent → empty merge, no crash', () => {
  const root = makeFixtureRoot();
  const r = readDomainDeps(root);
  assert.deepEqual(r.deps, {});
  assert.equal(r.depsSource.edgeCounts.observed, 0);
  assert.equal(r.depsSource.edgeCounts.manual, 0);
  assert.equal(r.depsSource.edgeCounts.both, 0);
});

test('E7: edgeCounts matches actual provenance distribution', () => {
  const root = makeFixtureRoot();
  writeDomainMap(root, {
    'arch-memory': ['shared-lib'],   // both with observed
    'plan': ['shared-lib'],          // manual-only
  });
  writeObserved(root, {
    version: OBSERVED_VERSION,
    refreshId: 'snap',
    domainMapDigest: computeDomainMapDigest(RULES),
    generatedAt: '2026-05-22T10:00:00.000Z',
    deps: {
      'arch-memory': ['shared-lib', 'dashboard'],  // shared-lib=both, dashboard=observed-only
    },
  });
  const r = readDomainDeps(root);
  assert.equal(r.depsSource.edgeCounts.both, 1);     // arch-memory→shared-lib
  assert.equal(r.depsSource.edgeCounts.observed, 1); // arch-memory→dashboard
  assert.equal(r.depsSource.edgeCounts.manual, 1);   // plan→shared-lib
});

// ── Group F — flattenMergedDeps ────────────────────────────────────────────

test('F1: flatten preserves all targets regardless of source', () => {
  const merged = {
    'arch-memory': [
      { to: 'dashboard', source: 'observed' },
      { to: 'shared-lib', source: 'both' },
      { to: 'plan', source: 'manual' },
    ],
  };
  assert.deepEqual(flattenMergedDeps(merged), {
    'arch-memory': ['dashboard', 'plan', 'shared-lib'],
  });
});

test('F2: sort order preserved (alphabetical)', () => {
  const merged = { x: [{ to: 'c' }, { to: 'a' }, { to: 'b' }].map(e => ({ ...e, source: 'observed' })) };
  assert.deepEqual(flattenMergedDeps(merged), { x: ['a', 'b', 'c'] });
});

test('F3: empty or non-object input safe', () => {
  assert.deepEqual(flattenMergedDeps({}), {});
  assert.deepEqual(flattenMergedDeps(null), {});
  assert.deepEqual(flattenMergedDeps(undefined), {});
});
