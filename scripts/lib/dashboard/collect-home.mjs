/**
 * @fileoverview Home composer: runs every card unit concurrently under ONE deadline
 * contract, isolates each unit's failure, then builds the pure model.
 *
 * **Deadline and cancellation (plan §2).** `Promise.race` against a timer is not a
 * deadline when the work is synchronous (`spawnSync` blocks the loop, and a race
 * never cancels the loser). So `withDeadline` gives every unit the same behaviour
 * through two release paths: ASYNC units get an `AbortSignal` (the queue reads
 * `execFile` with it, so the child is killed and reaped); SYNCHRONOUS units run in a
 * `worker_threads` Worker (`home-worker.mjs`) and register `worker.terminate()`. On
 * expiry the unit yields `missing-optional` "timed out after N" — an expected
 * absence, not a defect — and its resources are released.
 *
 * **Aggregate `sources.home`**: `ok` if every card is `ok`; `missing-optional` if
 * every non-ok card is `missing-optional`; otherwise `unexpected-error` naming the
 * failing cards. The build keeps its rule (`invalid | unexpected-error` ⇒ non-zero).
 *
 * **Content hash.** `homeContentProjection(home)` strips ONLY provenance (`asOf`,
 * `observedAt`, `builtAt`, `durationMs`, `durations`) and keeps every measurement,
 * state and decision, so two builds of identical content hash identically while a
 * changed queue count does not.
 *
 * Plan: docs/plans/dashboard-home-summary.md §2 (Execution bounds, Content hash).
 *
 * @module scripts/lib/dashboard/collect-home
 */
import { Worker } from 'node:worker_threads';
import { buildHomeModel, makeMeasurement, LIMITS, clip } from './home-model.mjs';
import { collectQueues, QUEUE_MEASUREMENTS } from './collect-home-queues.mjs';
import { reduceVitalsInput, VITAL_MEASUREMENTS } from './collect-home-vitals.mjs';
import { readStatusHead, shippedLog } from './collect-home-shipped.mjs';
import { WORKER_CARDS } from './home-worker.mjs';

export const DEFAULT_DEADLINE_MS = 45_000;
/** After a deadline fires: how long the cancelled work gets to wind down before it is reported unreleased. */
const DEFAULT_SETTLE_MS = 8_000;
const DEFAULT_WORKER_URL = new URL('./home-worker.mjs', import.meta.url);

/** Provenance keys: change without the content changing. */
const PROVENANCE_KEYS = new Set(['asOf', 'observedAt', 'builtAt', 'durationMs', 'durations']);

/**
 * Run `work` under a deadline. Never rejects: resolves `{value}`, `{error}` or
 * `{timedOut: true, ...}`. On expiry the shared signal is aborted, every registered cancel hook
 * runs AND IS AWAITED (a hook that throws or rejects is reported in `cancelErrors`, never
 * swallowed), and the work is given `settleMs` to wind down. `released` says whether it did:
 * a deadline result never claims a release that was not observed.
 *
 * @param {string} name
 * @param {number} ms
 * @param {(ctx: {signal: AbortSignal, onCancel: (fn: () => (void|Promise<unknown>)) => void}) => Promise<any>} work
 * @param {{settleMs?: number}} [opts]
 * @returns {Promise<{value: any} | {error: Error} | {timedOut: true, ms: number, released: boolean, cancelErrors: string[], settled: ({value: any}|{error: Error}|null)}>}
 */
export function withDeadline(name, ms, work, { settleMs = DEFAULT_SETTLE_MS } = {}) {
  const ac = new AbortController();
  const cancels = [];
  let timer;
  let expired = false;
  const done = Promise.resolve()
    .then(() => work({ signal: ac.signal, onCancel: (fn) => cancels.push(fn) }))
    .then((value) => ({ value }), (error) => ({ error }));
  const deadline = new Promise((resolve) => {
    timer = setTimeout(async () => {
      expired = true; // from here a late result of the cancelled work is NOT the answer
      ac.abort();
      const cancelErrors = [];
      const pending = cancels.map((c) => {
        try { return Promise.resolve(c()); } catch (err) { cancelErrors.push(String(err?.message ?? err).split('\n')[0]); return Promise.resolve(); }
      });
      // ONE settle timer bounds BOTH waits (the cancel hooks and the work winding down). A hook that
      // never settles must not stop the timer from ever starting — that was an unbounded wait.
      let waitTimer;
      const waitP = new Promise((r) => { waitTimer = setTimeout(() => r('timeout'), settleMs); });
      const hooks = await Promise.race([Promise.allSettled(pending), waitP]);
      if (hooks === 'timeout') {
        cancelErrors.push('cancellation hook did not settle');
      } else {
        for (const r of hooks) {
          if (r.status === 'rejected') cancelErrors.push(String(r.reason?.message ?? r.reason).split('\n')[0]);
        }
      }
      const wound = await Promise.race([done, waitP.then(() => null)]);
      clearTimeout(waitTimer);
      resolve({ timedOut: true, ms, released: wound !== null, cancelErrors, settled: wound });
    }, ms);
  });
  return Promise.race([done.then((r) => (expired ? new Promise(() => {}) : r)), deadline]).finally(() => clearTimeout(timer));
}

/**
 * Run a synchronous card in a worker thread. Registers `terminate` with the deadline.
 * @param {{signal: AbortSignal, onCancel: Function}} ctx
 */
function runInWorker(ctx, workerUrl, card, root, now, opts) {
  return new Promise((resolve, reject) => {
    if (!WORKER_CARDS.includes(card)) { reject(new Error(`no worker runner for card ${card}`)); return; }
    const worker = new Worker(workerUrl, { workerData: { card, root, now: now.toISOString(), opts } });
    ctx.onCancel(() => worker.terminate()); // awaited by withDeadline; a failure is reported, not swallowed
    let settled = false;
    const end = (fn, v) => { if (settled) return; settled = true; fn(v); };
    worker.once('message', (m) => {
      if (m?.ok) end(resolve, m.result); else end(reject, new Error(m?.error ?? 'worker reported failure'));
      worker.terminate().catch(() => {}); // normal completion: the result already stands
    });
    worker.once('error', (e) => end(reject, e));
    worker.once('exit', (code) => end(reject, new Error(`worker exited (code ${code}) without reporting`)));
  });
}

const fmtMs = (ms) => (ms >= 1000 ? `${Math.round(ms / 100) / 10}s` : `${ms}ms`);

/** Measurements standing in for a unit that timed out or failed (every id it would have produced). */
function placeholders(items, status, detail, asOf) {
  return items.map((i) => makeMeasurement({ id: i.id, label: i.label, card: i.card, status, detail, asOf, source: i.source ?? 'unavailable' }));
}

const WORKER_ITEMS = {
  vitals: VITAL_MEASUREMENTS,
  consumers: [{ id: 'consumers', label: 'Consumers', card: 'consumers', source: '.sync-receipt.json' }],
  'shipped-merges': [{ id: 'shipped-merges', label: 'Shipped (merges)', card: 'shipped', source: 'git log --first-parent' }],
  inflight: [{ id: 'inflight', label: 'In flight', card: 'inflight', source: 'git worktree/branch facts' }],
};

/** A unit's result, validated: a malformed return must not reach the model. */
function validate(result) {
  const ms = Array.isArray(result) ? result : result?.measurements ?? (result?.id ? [result] : null);
  if (!Array.isArray(ms) || ms.length === 0 || !ms.every((m) => m && typeof m.id === 'string' && typeof m.status === 'string')) {
    throw new Error('collector returned a malformed result');
  }
  return ms;
}

/**
 * The aggregate `sources.home` entry.
 * @param {Record<string, {status: string, label: string}>} cards - built model cards
 * @returns {{status: 'ok'|'missing-optional'|'unexpected-error', detail: string}}
 */
export function aggregateSources(cards) {
  const nonOk = Object.values(cards).filter((c) => c.status !== 'ok');
  if (nonOk.length === 0) return { status: 'ok', detail: '' };
  const names = (cs) => cs.map((c) => `${c.id} (${c.status})`).join(', ');
  if (nonOk.every((c) => c.status === 'missing-optional')) {
    return { status: 'missing-optional', detail: clip(`unmeasured: ${names(nonOk)}`, LIMITS.detail) };
  }
  const failing = nonOk.filter((c) => c.status !== 'missing-optional');
  return { status: 'unexpected-error', detail: clip(`failing: ${names(failing)}`, LIMITS.detail) };
}

/**
 * Strip provenance, keep content. Recursive; the input is not mutated.
 * @param {unknown} home
 * @returns {unknown}
 */
export function homeContentProjection(home) {
  if (Array.isArray(home)) return home.map(homeContentProjection);
  if (home && typeof home === 'object') {
    return Object.fromEntries(Object.entries(home).filter(([k]) => !PROVENANCE_KEYS.has(k)).map(([k, v]) => [k, homeContentProjection(v)]));
  }
  return home;
}

/**
 * Collect Home. Every unit is isolated: a thrown, timed-out or malformed unit
 * degrades ITS measurements and nothing else.
 *
 * @param {string} root
 * @param {object} [opts]
 * @param {{active: object[], completed?: object[]}} [opts.plans] - `reference.plans`
 * @param {object[]} [opts.skills] - `reference.skills`
 * @param {object} [opts.sourceStatus] - `{plans, skills}` source statuses from the reference build
 * @param {Function} [opts.run] - queue-reader runner (injectable; tests never touch the real store)
 * @param {string} [opts.repo] - `owner/repo` slug for Q3
 * @param {Date} [opts.now]
 * @param {number} [opts.deadlineMs=45000] - per-unit deadline, enforced by abort / terminate
 * @param {number} [opts.settleMs=8000] - grace for cancelled work to wind down before it is reported unreleased
 * @param {URL|string} [opts.workerUrl] - worker entry (tests substitute a blocking one)
 * @param {Array<{name: string, path: string}>} [opts.consumers] - registry override
 * @param {boolean} [opts.isSource]
 * @param {Record<string, Function>} [opts.collectors] - per-unit overrides: `(ctx) => result` (tests)
 * @returns {Promise<{home: object, sources: {home: {status: string, detail: string}}}>}
 */
export async function collectHome(root, {
  plans, skills, sourceStatus, run, repo, now = new Date(), deadlineMs = DEFAULT_DEADLINE_MS,
  workerUrl = DEFAULT_WORKER_URL, consumers, isSource, collectors = {}, settleMs,
} = {}) {
  const asOf = now.toISOString();
  const statusRead = (() => { try { return readStatusHead(root); } catch (err) { return { text: null, absent: false, capped: false, error: `cannot read status.md (${err.code ?? 'error'})` }; } })();
  const inWorker = (card, opts) => (ctx) => runInWorker(ctx, workerUrl, card, root, now, opts);

  const units = {
    queues: { items: QUEUE_MEASUREMENTS, work: (ctx) => collectQueues(root, { statusText: statusRead.text, statusCapped: statusRead.capped, run, repo, signal: ctx.signal, now }) },
    // Synchronous fs work, so it shares the worker contract; only the reduced plan/skill facts cross the thread boundary.
    vitals: { items: VITAL_MEASUREMENTS, work: inWorker('vitals', (() => { const r = reduceVitalsInput({ plans, skills }); return { plans: r.plans, skills: r.skillsCount, sourceStatus }; })()) },
    consumers: { items: WORKER_ITEMS.consumers, work: inWorker('consumers', { consumers, isSource }) },
    'shipped-merges': { items: WORKER_ITEMS['shipped-merges'], work: inWorker('shipped-merges') },
    inflight: { items: WORKER_ITEMS.inflight, work: inWorker('inflight') },
  };

  const t0 = Date.now();
  const durations = {};
  const results = await Promise.all(Object.entries(units).map(async ([name, u]) => {
    const work = collectors[name] ?? u.work;
    const out = await withDeadline(name, deadlineMs, work, settleMs === undefined ? {} : { settleMs });
    durations[name] = Date.now() - t0;
    let ms;
    if (out.timedOut) {
      // Work that wound down after the abort may still have produced honest per-measurement outcomes.
      let settled = null;
      if (out.settled?.value) { try { settled = validate(out.settled.value); } catch { settled = null; } }
      const notes = [
        out.released ? '' : '; stop not confirmed (work still winding down)',
        ...out.cancelErrors.map((e) => `; cancellation failed: ${e}`),
      ].join('');
      ms = settled && !notes ? settled : placeholders(u.items, 'missing-optional', `timed out after ${fmtMs(out.ms)}${notes}`, asOf);
    }
    else if (out.error) ms = placeholders(u.items, 'unexpected-error', `collector failed: ${String(out.error.message ?? out.error).split('\n')[0]}`, asOf);
    else {
      try { ms = validate(out.value); } catch (err) { ms = placeholders(u.items, 'unexpected-error', err.message, asOf); }
    }
    return [name, ms];
  }));
  const byUnit = Object.fromEntries(results);

  const cards = {
    queues: { measurements: byUnit.queues },
    vitals: { measurements: byUnit.vitals },
    consumers: { measurements: byUnit.consumers },
    shipped: { measurements: [shippedLog(statusRead, now), ...byUnit['shipped-merges']] },
    inflight: { measurements: byUnit.inflight },
  };
  const model = buildHomeModel(cards, { now });
  const home = { ...model, durations };
  return { home, sources: { home: aggregateSources(home.cards) } };
}
