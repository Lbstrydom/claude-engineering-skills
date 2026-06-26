/**
 * Debt fix 1 — computeContractDigest must include `exclude` (it drives source
 * extraction), with set-semantics (order-irrelevant). Tier-1 deterministic.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { computeContractDigest } from '../scripts/lib/nav/schema.mjs';

const base = {
  version: 1, navLayers: { primary: ['#nav'] },
  personas: [{ id: 'p', intents: [{ id: 'i', destination: 'x' }] }],
};

describe('computeContractDigest + exclude (debt fix 1)', () => {
  it('changes when exclude changes', () => {
    const a = computeContractDigest({ ...base, exclude: ['dist/**'] });
    const b = computeContractDigest({ ...base, exclude: ['dist/**', 'vendor/**'] });
    assert.notEqual(a, b, 'adding an exclude glob must change the digest');
  });
  it('is stable across exclude order (set-semantics)', () => {
    const a = computeContractDigest({ ...base, exclude: ['a/**', 'b/**'] });
    const b = computeContractDigest({ ...base, exclude: ['b/**', 'a/**'] });
    assert.equal(a, b, 'exclude order is semantically irrelevant → same digest');
  });
  it('no-exclude and empty-exclude are equivalent', () => {
    assert.equal(computeContractDigest(base), computeContractDigest({ ...base, exclude: [] }));
  });
  it('an unrelated field move does not depend on the new exclude key', () => {
    // navLayers change still changes the digest (sanity: exclude addition didn't break other fields).
    assert.notEqual(
      computeContractDigest({ ...base, exclude: ['x'] }),
      computeContractDigest({ ...base, exclude: ['x'], navLayers: { primary: ['#other'] } }),
    );
  });
});
