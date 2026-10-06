/**
 * @fileoverview `worker_threads` entry for the Home cards that do SYNCHRONOUS work
 * (`spawnSync` git): in-flight, the git half of Recently shipped, and consumer
 * history inspection.
 *
 * `Promise.race` against a timer is not a deadline for synchronous work — a
 * `spawnSync` blocks the event loop, so the timer cannot even fire, and a race
 * never cancels the loser. Running the work here keeps the main thread's loop free;
 * `collect-home.mjs` enforces the deadline and calls `worker.terminate()`, the only
 * way to actually stop synchronous work in-process. (A `spawnSync` child already
 * running when the worker dies is bounded by `runGit`'s own timeout.)
 *
 * Protocol: `workerData = {card, root, now, opts}`; one message back,
 * `{ok: true, result}` or `{ok: false, error}`. Importing this module on the main
 * thread does nothing.
 *
 * Plan: docs/plans/dashboard-home-summary.md §2 (Deadline and cancellation contract).
 *
 * @module scripts/lib/dashboard/home-worker
 */
import { isMainThread, parentPort, workerData } from 'node:worker_threads';

/** Card name → runner. Dynamic imports keep the worker's startup to what the card needs. */
const RUNNERS = {
  vitals: async (root, now, opts) => (await import('./collect-home-vitals.mjs')).collectVitals(root, { now, plans: opts?.plans, skills: opts?.skills, sourceStatus: opts?.sourceStatus }),
  inflight: async (root, now) => (await import('./collect-home-inflight.mjs')).collectInflight(root, { now }),
  'shipped-merges': async (root, now) => (await import('./collect-home-shipped.mjs')).collectShippedMerges(root, { now }),
  consumers: async (root, now, opts) => (await import('./collect-home-consumers.mjs')).collectConsumers(root, { now, consumers: opts?.consumers, isSource: opts?.isSource }),
};

/** The cards this worker can run; `collect-home.mjs` imports it, which also keeps this file in the sync import closure. */
export const WORKER_CARDS = Object.freeze(Object.keys(RUNNERS));

if (!isMainThread && parentPort) {
  const { card, root, now, opts } = workerData;
  try {
    const run = RUNNERS[card];
    if (!run) throw new Error(`unknown Home worker card: ${String(card).slice(0, 40)}`);
    const result = await run(root, new Date(now), opts);
    parentPort.postMessage({ ok: true, result });
  } catch (err) {
    parentPort.postMessage({ ok: false, error: String(err?.message ?? err).split('\n')[0].slice(0, 400) });
  }
}
