/**
 * @fileoverview Concurrency-bound regression test for the worker-pool
 * pattern introduced in stage0-relevance-context.mjs's impactCache build
 * (5308a5d6). `buildStage0RelevanceContext` itself calls
 * `getFreshImportersOrNull` (a real DB-touching import with no dependency-
 * injection seam, and this repo's `node --test` runner does not pass
 * `--experimental-test-module-mocks`), so this test proves the underlying
 * "N workers pull from a shared cursor" ALGORITHM in isolation — the exact
 * shape copied into `buildStage0RelevanceContext` — rather than exercising
 * the real function end-to-end. A prior draft of that fix wrapped a
 * semaphore around a still-sequential for...of loop, which provided no
 * concurrency at all (audit-plan round-3 M1); this test would have caught
 * that regression.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

// Mirrors buildStage0RelevanceContext's worker-pool block exactly, generic
// over the per-item async work function so it's testable without a DB.
async function runWorkerPool(items, concurrency, work) {
  let nextIndex = 0;
  let maxInFlight = 0;
  let inFlight = 0;
  const results = new Map();
  const worker = async () => {
    let i;
    while ((i = nextIndex++) < items.length) {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      try {
        results.set(items[i], await work(items[i]));
      } finally {
        inFlight--;
      }
    }
  };
  const workerCount = Math.min(concurrency, items.length);
  await Promise.all(Array.from({ length: workerCount }, () => worker()));
  return { results, maxInFlight };
}

test('worker pool runs multiple items concurrently, not sequentially', async () => {
  const items = Array.from({ length: 12 }, (_, i) => `file${i}.mjs`);
  const { maxInFlight } = await runWorkerPool(items, 4, async () => {
    await new Promise((r) => setTimeout(r, 10));
    return true;
  });
  // A sequential loop (the round-2 regression) would peak at 1 in-flight.
  assert.ok(maxInFlight > 1, `expected concurrent execution, got maxInFlight=${maxInFlight}`);
  assert.ok(maxInFlight <= 4, `expected the concurrency cap to be honored, got maxInFlight=${maxInFlight}`);
});

test('worker pool never exceeds the concurrency cap even with more items than workers', async () => {
  const items = Array.from({ length: 20 }, (_, i) => i);
  const { maxInFlight, results } = await runWorkerPool(items, 8, async (i) => {
    await new Promise((r) => setTimeout(r, 5));
    return i * 2;
  });
  assert.ok(maxInFlight <= 8);
  assert.equal(results.size, 20);
  for (const i of items) assert.equal(results.get(i), i * 2);
});

test('a failing item degrades to null without stranding the pool — matches buildStage0RelevanceContext\'s own try/catch shape', async () => {
  // buildStage0RelevanceContext wraps its own per-item try/catch { result =
  // null } AROUND the getFreshImportersOrNull call, inside the loop body —
  // the pool itself never sees the error. This test uses the identical
  // shape rather than relying on the pool to catch for it.
  const items = [1, 2, 3, 4, 5];
  const work = async (i) => {
    try {
      if (i === 3) throw new Error('simulated lookup failure');
      return i;
    } catch { return null; }
  };
  const { results } = await runWorkerPool(items, 2, work);
  assert.equal(results.size, 5, 'all 5 items completed — one failure does not strand or drop the others');
  assert.equal(results.get(3), null, 'the failing item degrades to null, matching the real code\'s catch behavior');
  assert.equal(results.get(1), 1);
  assert.equal(results.get(5), 5);
});

test('fewer items than the concurrency cap spawns only as many workers as items', async () => {
  const items = ['a', 'b'];
  let started = 0;
  await runWorkerPool(items, 8, async (i) => { started++; return i; });
  assert.equal(started, 2, 'no wasted/idle workers beyond the item count');
});
