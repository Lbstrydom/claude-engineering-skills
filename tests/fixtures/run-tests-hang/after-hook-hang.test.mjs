// Positive-control fixture for tests/run-tests-hang-controls.test.mjs: the test's body passes but its own after hook hangs.
// The guard writes a test's end after its own after hooks, so the hang is still that test's: named and stopped at the limit. Not in the default globs.
import test from 'node:test';

test('teardown hangs', (t) => {
  t.after(async () => { setInterval(() => {}, 1000); await new Promise(() => {}); });
});
