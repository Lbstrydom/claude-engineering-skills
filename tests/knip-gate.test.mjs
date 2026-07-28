import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { collectKeys, diffAgainstBaseline } from '../scripts/knip-gate.mjs';

describe('knip-gate / collectKeys', () => {
  it('produces a stable file-scoped key for a file-level issue', () => {
    const parsed = { issues: [{ file: 'scripts/lib/foo.mjs', files: [{ name: 'scripts/lib/foo.mjs' }], dependencies: [], devDependencies: [], unlisted: [], unresolved: [], duplicates: [] }] };
    assert.deepEqual(collectKeys(parsed), ['files:scripts/lib/foo.mjs']);
  });

  it('produces a file→name key for a dependency-shaped issue', () => {
    const parsed = { issues: [{ file: 'package.json', dependencies: [{ name: 'left-pad' }], files: [], devDependencies: [], unlisted: [], unresolved: [], duplicates: [] }] };
    assert.deepEqual(collectKeys(parsed), ['dependencies:package.json→left-pad']);
  });

  it('normalises backslashes so Windows and POSIX runs produce identical keys', () => {
    const parsed = { issues: [{ file: 'scripts\\lib\\foo.mjs', files: [{ name: 'scripts\\lib\\foo.mjs' }], dependencies: [], devDependencies: [], unlisted: [], unresolved: [], duplicates: [] }] };
    assert.deepEqual(collectKeys(parsed), ['files:scripts/lib/foo.mjs']);
  });

  it('only reports gated types, ignoring exports/types even if present in the raw payload', () => {
    const parsed = { issues: [{ file: 'a.mjs', exports: [{ name: 'unusedExport' }], files: [], dependencies: [], devDependencies: [], unlisted: [], unresolved: [], duplicates: [] }] };
    assert.deepEqual(collectKeys(parsed), []);
  });

  it('handles an empty issues array', () => {
    assert.deepEqual(collectKeys({ issues: [] }), []);
  });

  it('handles a missing issues field without throwing', () => {
    assert.deepEqual(collectKeys({}), []);
  });

  it('deduplicates identical keys across entries', () => {
    const parsed = { issues: [
      { file: 'a.mjs', files: [{ name: 'a.mjs' }], dependencies: [], devDependencies: [], unlisted: [], unresolved: [], duplicates: [] },
      { file: 'a.mjs', files: [{ name: 'a.mjs' }], dependencies: [], devDependencies: [], unlisted: [], unresolved: [], duplicates: [] },
    ] };
    assert.deepEqual(collectKeys(parsed), ['files:a.mjs']);
  });
});

describe('knip-gate / diffAgainstBaseline', () => {
  it('reports no drift when current equals baseline', () => {
    const r = diffAgainstBaseline(['files:a.mjs', 'files:b.mjs'], ['files:a.mjs', 'files:b.mjs']);
    assert.deepEqual(r, { netNew: [], stale: [] });
  });

  it('flags a key present in current but not baseline as net-new', () => {
    const r = diffAgainstBaseline(['files:a.mjs', 'files:new.mjs'], ['files:a.mjs']);
    assert.deepEqual(r.netNew, ['files:new.mjs']);
    assert.deepEqual(r.stale, []);
  });

  it('flags a key present in baseline but not current as stale (self-cleaning)', () => {
    const r = diffAgainstBaseline(['files:a.mjs'], ['files:a.mjs', 'files:fixed.mjs']);
    assert.deepEqual(r.netNew, []);
    assert.deepEqual(r.stale, ['files:fixed.mjs']);
  });

  it('reports both net-new and stale in the same diff, independently', () => {
    const r = diffAgainstBaseline(['files:kept.mjs', 'files:new.mjs'], ['files:kept.mjs', 'files:gone.mjs']);
    assert.deepEqual(r.netNew, ['files:new.mjs']);
    assert.deepEqual(r.stale, ['files:gone.mjs']);
  });

  it('handles an empty baseline (first-ever run) — everything current is net-new, nothing stale', () => {
    const r = diffAgainstBaseline(['files:a.mjs', 'files:b.mjs'], []);
    assert.deepEqual(r.netNew.sort(), ['files:a.mjs', 'files:b.mjs']);
    assert.deepEqual(r.stale, []);
  });

  it('handles an empty current (repo now perfectly clean) — everything baselined is stale', () => {
    const r = diffAgainstBaseline([], ['files:a.mjs']);
    assert.deepEqual(r.netNew, []);
    assert.deepEqual(r.stale, ['files:a.mjs']);
  });
});
