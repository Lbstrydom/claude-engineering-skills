// Positive-control fixture for tests/run-tests-hang-controls.test.mjs: one test's own after hook hangs while a CONCURRENT
// sibling keeps finishing short subtests, so the file never looks quiet. The hung teardown must still be named and stopped
// at the per-test limit: the guard's end line is written after the test's own after hooks. Not in the default globs.
import { describe, it } from 'node:test';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

describe('pair', { concurrency: true }, () => {
  it('teardown hangs', (t) => {
    t.after(async () => { setInterval(() => {}, 1000); await new Promise(() => {}); });
  });
  it('keeps busy', async (t) => {
    // ~4 s: busy for half the 8-s limit, but never over it itself.
    // ~6 s: busy for most of the 8-s limit, but never over it itself.
    for (let i = 0; i < 80; i += 1) await t.test(`step ${i}`, () => sleep(50));
  });
});
