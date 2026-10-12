/**
 * @fileoverview The stderr capture helper keeps `process.stderr.write`'s calling contract.
 *
 * Code under test may call `write(chunk, callback)` or `write(chunk, encoding, callback)` and wait
 * on the callback; a stand-in that records the chunk but drops the callback would hang it.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { captureStderr } from './helpers/capture-stderr.mjs';

const nextTick = () => new Promise((resolve) => process.nextTick(resolve));

describe('captureStderr — write() signatures', () => {
  test('write(chunk) records the chunk and returns true', async () => {
    const { result, lines } = await captureStderr(() => process.stderr.write('a'));
    assert.equal(result, true);
    assert.deepEqual(lines, ['a']);
  });

  test('write(chunk, callback) invokes the callback', async () => {
    let called = 0;
    const { lines } = await captureStderr(async () => {
      process.stderr.write('b', () => { called++; });
      await nextTick();
      await nextTick();
    });
    assert.deepEqual(lines, ['b']);
    assert.equal(called, 1, 'the completion callback ran exactly once');
  });

  test('write(chunk, encoding, callback) invokes the callback', async () => {
    let called = 0;
    const { lines } = await captureStderr(async () => {
      process.stderr.write('c', 'utf8', () => { called++; });
      await nextTick();
      await nextTick();
    });
    assert.deepEqual(lines, ['c']);
    assert.equal(called, 1);
  });

  test('the original writer is restored afterwards', async () => {
    const before = process.stderr.write;
    await captureStderr(() => process.stderr.write('d'));
    assert.equal(process.stderr.write, before);
  });
});
