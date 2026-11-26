// Positive-control fixture for tests/run-tests-hang-controls.test.mjs: one test never yields the event loop, so no timer or
// async write in this process can run again. Not in the default globs.
import test from 'node:test';

test('before busy', () => {});

test('busy loop', () => {
  for (;;) { /* spin */ }
});

test('after busy', () => {});
