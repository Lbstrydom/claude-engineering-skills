// Positive-control fixture for tests/run-tests-hang-controls.test.mjs: the test's body passes but its own after hook hangs.
// The guard's end line lands first (its t.after was registered first), so the hang is outside any test: it must still be
// stopped at the per-test limit, timed from the last event. Not in the default globs.
import test from 'node:test';

test('teardown hangs', (t) => {
  t.after(async () => { setInterval(() => {}, 1000); await new Promise(() => {}); });
});
