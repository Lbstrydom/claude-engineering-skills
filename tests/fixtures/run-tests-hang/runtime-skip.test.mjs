// Fixture for tests/run-tests-hang-controls.test.mjs: a HEALTHY file whose tests skip themselves at run time. Node ends a
// `t.skip()` test without running afterEach, so the guard must still see each one end, or it would fail a passing run (and,
// past the per-test limit, stop it). Not in the default globs.
import { describe, it, test } from 'node:test';

test('skips itself', (t) => { t.skip('not here'); });
test('skips itself, returning', (t) => t.skip());
describe('suite', () => {
  it('skips itself too', (t) => { t.skip('nested'); });
  it('runs', () => {});
});
test('runs after', () => {});
