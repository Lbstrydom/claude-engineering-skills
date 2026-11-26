// Positive-control fixture for tests/run-tests-hang-controls.test.mjs: the file hangs while it is being IMPORTED, before any
// test is registered, so no test ever starts. The per-test limit must still catch it (timed from the file's `load` line), and
// name it as outside any test. Not in the default globs.
import test from 'node:test';

setInterval(() => {}, 1000);
await new Promise(() => {});

test('never registered', () => {});
