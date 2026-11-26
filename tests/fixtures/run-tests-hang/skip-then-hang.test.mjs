// Positive-control fixture for tests/run-tests-hang-controls.test.mjs: `t.skip()` does not stop a test's body, so a test that
// skips itself and THEN hangs must still be timed and stopped by the per-test limit. Not in the default globs.
import test from 'node:test';

test('skips, then hangs', async (t) => {
  t.skip('looks done');
  setInterval(() => {}, 1000);
  await new Promise(() => {});
});
