/**
 * Fixture: suites that die while being CONSTRUCTED.
 *
 * Deliberately broken. Named `.fixture.mjs`, NOT `.test.mjs`, so no glob in
 * `run-tests.mjs` DEFAULT_ARGS can pick it up — it is only ever run by being
 * named explicitly from `tests/test-guard-false-green.test.mjs`.
 *
 * Two shapes, because the guard claims to catch the CLASS, not one cause:
 *   1. an undefined identifier — the shape that actually shipped in dd83e1f8
 *   2. a plain throw in the suite body — any other construction-time failure
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

// A healthy suite, so the fixture also proves the guard is not just reacting
// to the file as a whole.
describe('fixture: a suite that really runs', () => {
  it('passes', () => { assert.equal(1, 1); });
});

describe('fixture: undefined identifier at construction', () => {
  // DELIBERATE: `test` is never imported above. This is the exact bug under
  // test — do not "fix" it by adding the import.
  test('never runs', () => { assert.equal(1, 1); });
});

describe('fixture: a plain throw at construction', () => {
  throw new Error('deliberate construction failure');
});
