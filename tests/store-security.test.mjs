// Regression test for the "reuse prior embedding" bug found 2026-07-14:
// getSecurityIncidentsByRepo's SELECT omitted the `embedding` column, so
// `prior.embedding` was always undefined and refresh-incidents.mjs's
// unchanged-content fast path always reported a failure instead of reusing
// the existing vector. Pure — no DB connection needed for these two helpers.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { _internals } from '../scripts/lib/store/security.mjs';

const { parseVectorLiteral, formatVectorOrNull } = _internals;

describe('parseVectorLiteral — reads back what pg returns for a vector column', () => {
  it('parses a pgvector text literal into a number[]', () => {
    assert.deepEqual(parseVectorLiteral('[0.1,0.2,-0.3]'), [0.1, 0.2, -0.3]);
  });

  it('returns null for a null embedding (never a string)', () => {
    assert.equal(parseVectorLiteral(null), null);
    assert.equal(parseVectorLiteral(undefined), null);
  });

  it('passes an already-parsed array through unchanged', () => {
    const arr = [1, 2, 3];
    assert.equal(parseVectorLiteral(arr), arr);
  });

  it('handles an empty vector literal', () => {
    assert.deepEqual(parseVectorLiteral('[]'), []);
  });

  it('round-trips through formatVectorOrNull (write) then parseVectorLiteral (read)', () => {
    const original = [0.123456, -0.987654, 0];
    const written = formatVectorOrNull(original);
    const readBack = parseVectorLiteral(written);
    assert.deepEqual(readBack, original);
  });

  it('a reused embedding is accepted by formatVectorOrNull without throwing', () => {
    // This is the actual bug: before the fix, `prior.embedding` was always
    // `undefined` (never a real array), so a caller trying to write it back
    // unchanged would never even reach formatVectorOrNull with a string —
    // it would just silently count as a failure instead. This test pins the
    // fixed contract: parseVectorLiteral's output is always something
    // formatVectorOrNull accepts, so a reused embedding round-trips cleanly.
    const reused = parseVectorLiteral('[0.5,0.5]');
    assert.doesNotThrow(() => formatVectorOrNull(reused));
  });
});
