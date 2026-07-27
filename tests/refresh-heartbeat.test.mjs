/**
 * @fileoverview Regression guard for `runWithHeartbeat` in
 * `scripts/symbol-index/refresh.mjs`.
 *
 * Two eras of fix, same function:
 *  - 41bf7af6/812d9d83 (2026-07-27, earlier): a failed heartbeat write must
 *    remain visible to the run, not swallowed after a single stderr line.
 *  - symbol-index-pipeline-reliability-hardening.md Theme 1 (this file):
 *    the heartbeat must actually ENFORCE cancellation (not just log), the
 *    tick loop must never overlap or fire a stale abort after `fn()`
 *    settles, and sustained heartbeat failure must itself trigger a
 *    precautionary abort.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { _internals } from '../scripts/symbol-index/refresh.mjs';

const { runWithHeartbeat } = _internals;

describe('runWithHeartbeat — failure visibility (legacy 41bf7af6/812d9d83)', () => {
  it('a beat function that always rejects is visible via heartbeatStatus.failureCount, and the work still completes', async () => {
    const failingBeat = () => Promise.reject(new Error('ECONNREFUSED: simulated'));
    let observedFailureCount;
    const result = await runWithHeartbeat('refresh-1', 'repo-1', 5, async (heartbeatStatus) => {
      // Give a couple of ticks a chance to fire, but resolve well before
      // MAX_CONSECUTIVE_HEARTBEAT_FAILURES (3) would trigger a self-abort.
      await new Promise((resolve) => setTimeout(resolve, 12));
      observedFailureCount = heartbeatStatus.failureCount;
      return 'work-done';
    }, failingBeat);

    assert.equal(result, 'work-done', 'the real work must complete despite heartbeat failures');
    assert.ok(observedFailureCount > 0, `expected at least one recorded heartbeat failure, got ${observedFailureCount}`);
  });

  it('a beat function that always succeeds (still running) reports zero failures', async () => {
    const okBeat = () => Promise.resolve(true);
    let observedFailureCount;
    await runWithHeartbeat('refresh-2', 'repo-1', 5, async (heartbeatStatus) => {
      await new Promise((resolve) => setTimeout(resolve, 20));
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
    await runWithHeartbeat('refresh-3', 'repo-1', 5, async (heartbeatStatus) => {
      await new Promise((resolve) => setTimeout(resolve, 12));
      status = heartbeatStatus;
    }, beat);

    assert.ok(status.failureCount >= 1, `expected at least one beat to fire, got ${status.failureCount}`);
    assert.equal(status.lastError, `fail-${status.failureCount}`);
  });
});

describe('runWithHeartbeat — enforcement (Theme 1: cancellation actually stops the run)', () => {
  it('a beatFn reporting stillRunning=false aborts the signal', async () => {
    const beat = () => Promise.resolve(false);
    let observedAborted = false;
    let observedReason;
    await assert.rejects(
      () => runWithHeartbeat('refresh-4', 'repo-1', 5, async (heartbeatStatus, signal) => {
        await new Promise((resolve) => {
          const check = () => {
            if (signal.aborted) { observedAborted = true; observedReason = signal.reason; resolve(); return; }
            setTimeout(check, 3);
          };
          check();
        });
        if (signal.aborted) throw signal.reason;
      }, beat),
    );
    assert.equal(observedAborted, true, 'signal.aborted must flip once beatFn reports not-running');
    assert.ok(observedReason instanceof Error);
  });

  it('a beatFn that always succeeds never aborts the signal', async () => {
    const beat = () => Promise.resolve(true);
    let sawAborted = false;
    await runWithHeartbeat('refresh-5', 'repo-1', 5, async (heartbeatStatus, signal) => {
      await new Promise((resolve) => setTimeout(resolve, 20));
      sawAborted = signal.aborted;
    }, beat);
    assert.equal(sawAborted, false);
  });

  it('MAX_CONSECUTIVE_HEARTBEAT_FAILURES consecutive rejections trigger a precautionary self-abort (sustained DB outage)', async () => {
    const beat = () => Promise.reject(new Error('ECONNREFUSED'));
    let observedAborted = false;
    await runWithHeartbeat('refresh-6', 'repo-1', 5, async (heartbeatStatus, signal) => {
      await new Promise((resolve) => {
        const check = () => {
          if (signal.aborted) { observedAborted = true; resolve(); return; }
          setTimeout(check, 3);
        };
        check();
      });
    }, beat);
    assert.equal(observedAborted, true, 'sustained heartbeat failure must itself be treated as abort-worthy');
  });

  it('a single transient failure followed by recovery does NOT trigger the self-abort (resets the consecutive counter)', async () => {
    let call = 0;
    const beat = () => {
      call++;
      if (call === 1) return Promise.reject(new Error('one blip'));
      return Promise.resolve(true);
    };
    let sawAborted = false;
    await runWithHeartbeat('refresh-7', 'repo-1', 5, async (heartbeatStatus, signal) => {
      await new Promise((resolve) => setTimeout(resolve, 40));
      sawAborted = signal.aborted;
    }, beat);
    assert.equal(sawAborted, false, 'a recovered heartbeat must reset the consecutive-failure counter, not accumulate toward the threshold');
  });

  it('no stale abort fires after fn() has already resolved (the settled-flag race)', async () => {
    let resolveBeat;
    const stalledBeat = () => new Promise((resolve) => { resolveBeat = resolve; });
    const result = await runWithHeartbeat('refresh-8', 'repo-1', 5, async () => {
      // Resolve fn() quickly, WHILE a beatFn call is still in flight.
      await new Promise((resolve) => setTimeout(resolve, 8));
      return 'done-before-beat-settles';
    }, stalledBeat);
    assert.equal(result, 'done-before-beat-settles');
    // Now let the stalled beat resolve to `false` (not running) — this must
    // NOT retroactively do anything, since runWithHeartbeat already returned.
    resolveBeat(false);
    await new Promise((resolve) => setTimeout(resolve, 20));
    // No assertion possible on a signal that's already out of scope — the
    // real guard here is that this doesn't throw an unhandled rejection or
    // crash the process (node:test fails the run on an unhandled rejection).
  });

  it('ticks never overlap — the next beatFn call waits for the previous one to fully settle', async () => {
    let concurrentCalls = 0;
    let maxConcurrent = 0;
    const slowBeat = async () => {
      concurrentCalls++;
      maxConcurrent = Math.max(maxConcurrent, concurrentCalls);
      await new Promise((resolve) => setTimeout(resolve, 15));
      concurrentCalls--;
      return true;
    };
    await runWithHeartbeat('refresh-9', 'repo-1', 5, async () => {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }, slowBeat);
    assert.equal(maxConcurrent, 1, 'a slow beatFn call must never overlap with the next scheduled tick');
  });

  it('the timer is cleared once fn resolves — no heartbeat fires after completion', async () => {
    let beatCount = 0;
    const beat = () => { beatCount++; return Promise.resolve(true); };
    await runWithHeartbeat('refresh-10', 'repo-1', 5, async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }, beat);
    const countAtCompletion = beatCount;
    await new Promise((resolve) => setTimeout(resolve, 40));
    assert.equal(beatCount, countAtCompletion, 'no further heartbeat may fire after runWithHeartbeat resolves');
  });

  it('propagates a thrown error from fn, still clearing the timer', async () => {
    let beatCount = 0;
    const beat = () => { beatCount++; return Promise.resolve(true); };
    await assert.rejects(
      () => runWithHeartbeat('refresh-11', 'repo-1', 5, async () => {
        throw new Error('real work failed');
      }, beat),
      /real work failed/,
    );
    const countAtRejection = beatCount;
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(beatCount, countAtRejection, 'no further heartbeat may fire after runWithHeartbeat rejects');
  });

  it('fn receives repoId-aware beatFn calls (repo is threaded through, not just refreshId)', async () => {
    const seenArgs = [];
    const beat = (args) => { seenArgs.push(args); return Promise.resolve(true); };
    await runWithHeartbeat('refresh-12', 'repo-42', 5, async () => {
      await new Promise((resolve) => setTimeout(resolve, 12));
    }, beat);
    assert.ok(seenArgs.length > 0);
    assert.equal(seenArgs[0].refreshId, 'refresh-12');
    assert.equal(seenArgs[0].repoId, 'repo-42');
  });
});
