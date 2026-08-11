/**
 * Fixture: a FAILING todo test — the one case where node reports `test:fail`
 * and still exits 0 legitimately. The guard must let this through, or every
 * repo using todo markers gets a spurious red.
 * See the header of `construction-failure.fixture.mjs` for the naming rule.
 */
import { it } from 'node:test';
import assert from 'node:assert/strict';

it('a todo test that fails is not a broken run', { todo: true }, () => {
  assert.equal(1, 2);
});
