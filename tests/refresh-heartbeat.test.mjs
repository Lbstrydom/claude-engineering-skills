/**
 * @fileoverview Regression guard for `runWithHeartbeat` in
 * `scripts/symbol-index/refresh.mjs` (tech-debt entries 41bf7af6/812d9d83):
 * a failed heartbeat write must remain visible to the run, not swallowed
 * after a single stderr line.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { _internals } from '../scripts/symbol-index/refresh.mjs';

const { runWithHeartbeat } = _internals;

describe('runWithHeartbeat', () => {
  it('a beat function that always rejects is visible via heartbeatStatus.failureCount, and the work still completes', async () => {
    const failingBeat = () => Promise.reject(new Error('ECONNREFUSED: simulated'));
    let observedFailureCount;
    const result = await runWithHeartbeat('refresh-1', 5, async (heartbeatStatus) => {
      // Give the interval a couple of ticks to fire.
      await new Promise((resolve) => setTimeout(resolve, 30));
      observedFailureCount = heartbeatStatus.failureCount;
      return 'work-done';
    }, failingBeat);

    assert.equal(result, 'work-done', 'the real work must complete despite heartbeat failures');
    assert.ok(observedFailureCount > 0, `expected at least one recorded heartbeat failure, got ${observedFailureCount}`);
  });

  it('a beat function that always succeeds reports zero failures', async () => {
    const okBeat = () => Promise.resolve();
    let observedFailureCount;
    await runWithHeartbeat('refresh-2', 5, async (heartbeatStatus) => {
      await new Promise((resolve) => setTimeout(resolve, 30));
      observedFailureCount = heartbeatStatus.failureCount;
    }, okBeat);

    assert.equal(observedFailureCount, 0);
  });

  it('lastError carries the most recent failure message', async () => {
    let call = 0;
    const beat = () => {
      call++;
      return Promise.reject(new Error(`fail-${call}`));
    };
    let status;
    await runWithHeartbeat('refresh-3', 5, async (heartbeatStatus) => {
      await new Promise((resolve) => setTimeout(resolve, 40));
      status = heartbeatStatus;
    }, beat);

    assert.ok(status.failureCount >= 2, `expected multiple beats to fire, got ${status.failureCount}`);
    assert.equal(status.lastError, `fail-${status.failureCount}`);
  });

  it('the interval is cleared once fn resolves — no heartbeat fires after completion', async () => {
    let beatCount = 0;
    const beat = () => { beatCount++; return Promise.resolve(); };
    await runWithHeartbeat('refresh-4', 5, async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }, beat);
    const countAtCompletion = beatCount;
    await new Promise((resolve) => setTimeout(resolve, 40));
    assert.equal(beatCount, countAtCompletion, 'no further heartbeat may fire after runWithHeartbeat resolves');
  });

  it('propagates a thrown error from fn, still clearing the interval', async () => {
    let beatCount = 0;
    const beat = () => { beatCount++; return Promise.resolve(); };
    await assert.rejects(
      () => runWithHeartbeat('refresh-5', 5, async () => {
        throw new Error('real work failed');
      }, beat),
      /real work failed/,
    );
    const countAtRejection = beatCount;
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(beatCount, countAtRejection, 'no further heartbeat may fire after runWithHeartbeat rejects');
  });
});
