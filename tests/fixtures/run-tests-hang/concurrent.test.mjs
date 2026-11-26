// Positive-control fixture for tests/run-tests-hang-controls.test.mjs: two CONCURRENT tests with the same name. The one that
// started first hangs; the one that started second finishes first, so a tracker pairing ends by name would close the hung
// instance and hide it. Not in the default globs.
import { describe, it } from 'node:test';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

describe('pair', { concurrency: true }, () => {
  it('same', async () => { setInterval(() => {}, 1000); await new Promise(() => {}); });
  it('same', async () => { await sleep(50); });
  it('other', async () => { await sleep(100); });
});
