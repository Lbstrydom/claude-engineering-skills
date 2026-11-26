// Positive-control fixture for tests/run-tests-hang-controls.test.mjs: the test skips itself and only THEN registers an after
// hook that hangs. The guard's end must still come after that hook, so the hang stays this test's and is stopped by name.
// Not in the default globs.
import test from 'node:test';

test('skips, then its teardown hangs', (t) => {
  t.skip('looks done');
  t.after(async () => { setInterval(() => {}, 1000); await new Promise(() => {}); });
});
