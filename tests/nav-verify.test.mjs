/**
 * Cluster B/debt-2 — --verify pure logic (reconcile + live-target normalization).
 * The browser drive (runVerify) is exercised live; these lock the deterministic
 * reconciliation that decides confirmed / static-only / runtime-only.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { reconcile, normalizeLiveTarget } from '../scripts/lib/nav/verify.mjs';

describe('normalizeLiveTarget', () => {
  it('maps query-param view routing to the view slug (vanilla SPA)', () => {
    assert.equal(normalizeLiveTarget('?view=today', 'https://app.test/'), 'today');
    assert.equal(normalizeLiveTarget('https://app.test/?view=drink-soon', 'https://app.test/'), 'drink-soon');
  });
  it('normalizes path routing', () => {
    assert.equal(normalizeLiveTarget('/wines/123', 'https://app.test/'), '/wines/:param');
  });
  it('drops external + non-nav targets', () => {
    assert.equal(normalizeLiveTarget('mailto:x@y.z'), null);
    assert.equal(normalizeLiveTarget('#section', 'https://app.test/'), null);
  });
});

describe('reconcile', () => {
  it('partitions confirmed / static-only / runtime-only', () => {
    const r = reconcile(['today', 'wines', 'drink-soon'], ['today', 'wines', 'admin-secret']);
    assert.deepEqual(r.confirmed, ['today', 'wines']);
    assert.deepEqual(r.staticOnly, ['drink-soon']);
    assert.deepEqual(r.runtimeOnly, ['admin-secret']);
  });
  it('excludes <dynamic> and modal: pseudo-destinations from the static set', () => {
    const r = reconcile(['<dynamic>', 'modal:settings', 'wines'], ['wines']);
    assert.deepEqual(r.confirmed, ['wines']);
    assert.deepEqual(r.staticOnly, []);
  });
});
