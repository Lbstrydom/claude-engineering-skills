/**
 * Fixture: the negative control — everything here genuinely runs and passes.
 * If the guard fails this file, the guard is always-refuse and worthless.
 * See the header of `construction-failure.fixture.mjs` for the naming rule.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

describe('fixture: a wholly healthy suite', () => {
  it('passes', () => { assert.equal(1, 1); });
  it('also passes', () => { assert.ok(true); });
});
