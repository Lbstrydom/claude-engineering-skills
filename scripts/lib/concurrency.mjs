/**
 * @fileoverview Bounded-concurrency worker pool — one implementation, shared.
 *
 * Lived inside `symbol-index/summarise-domains.mjs` until 2026-08-11, when
 * `check-gate-poison-pills.mjs` needed the same ten lines to fan its pills out
 * across processes. Copying it would have put two pools with one name in the
 * tree; importing the LLM-summarisation CLI from a pre-push gate would have
 * dragged `dotenv`, the learning store and a model resolver into a check that
 * touches none of them. Moving it here is the only option that leaves exactly
 * one implementation with no dependency edge either module has to pay for.
 *
 * @module scripts/lib/concurrency
 */

/**
 * Run `fn` over `items` with at most `limit` in flight at once. Dependency-free
 * (no p-limit). Single-threaded JS → the shared accumulators the callback
 * mutates are race-free. If `fn` rejects, the rejection propagates (callers that
 * must not abort should catch inside `fn`).
 *
 * `fn` receives the item's ORIGINAL index alongside it, so a caller collecting
 * results can write them into a positional array and preserve input order
 * regardless of completion order — the property that keeps a parallelised
 * report byte-identical to the serial one it replaced.
 *
 * @template T
 * @param {T[]} items
 * @param {number} limit
 * @param {(item: T, index: number) => Promise<void>} fn
 */
export async function runWithConcurrency(items, limit, fn) {
  const queue = items.map((item, index) => ({ item, index }));
  const n = Math.max(1, Math.min(limit, queue.length));
  const worker = async () => {
    while (queue.length) {
      const { item, index } = queue.shift();
      await fn(item, index);
    }
  };
  await Promise.all(Array.from({ length: n }, worker));
}
