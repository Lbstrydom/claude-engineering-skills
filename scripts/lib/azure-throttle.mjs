/**
 * @fileoverview Global concurrency throttle for Azure LLM calls.
 *
 * Azure deployments often ship with tiny default quotas (e.g. 10 RPM / 10K TPM).
 * The audit's parallel passes + map-reduce, and the embedder's per-batch
 * `Promise.all` fan-out (up to 25 calls), blow past the requests-per-minute
 * limit in a burst → 429s. This caps the number of IN-FLIGHT Azure calls
 * process-wide so bursts are paced; the SDK's own `Retry-After`-aware retry
 * (see `AZURE_MAX_RETRIES`) then absorbs whatever still 429s.
 *
 * **No-op on the public path** — `azureThrottle(fn)` runs `fn` directly when the
 * Azure work profile is inactive, so non-Azure users see zero behaviour change.
 *
 * This is the right-sized layer: a concurrency gate + the SDK's native
 * Retry-After backoff. A full per-deployment token-bucket (TPM pacing) is
 * deliberately NOT built here — raise the deployment quota for throughput;
 * revisit a token-bucket only if concurrency=1 still can't keep up.
 *
 * @module scripts/lib/azure-throttle
 */

import { azureConfig } from './config.mjs';

// Max simultaneous Azure LLM calls process-wide. Default 4 — the workhorse
// deployments now sit at 100K TPM / 100 RPM (GPT auditor, Opus reviewer) and
// 200/600 RPM (Sonnet summaries, embeddings), so the binding constraint is TPM
// on the large GPT passes (~2–4 big calls/min), not the old ~10 RPM quota. Raise
// further if RPM-bound batch work (embeddings/arch summaries) dominates.
function maxConcurrency() {
  const n = Number(process.env.AZURE_MAX_CONCURRENCY);
  return Number.isFinite(n) && n >= 1 ? Math.floor(n) : 4;
}

let _active = 0;
/** @type {Array<() => void>} */
const _queue = [];

function acquire() {
  if (_active < maxConcurrency()) {
    _active++;
    return Promise.resolve();
  }
  return new Promise((resolve) => _queue.push(resolve));
}

function release() {
  _active = Math.max(0, _active - 1);
  const next = _queue.shift();
  if (next) {
    _active++;
    next();
  }
}

/**
 * Run `fn` under the global Azure concurrency cap. No-op (direct call) when the
 * Azure profile is inactive, so the public path is unchanged.
 * @template T
 * @param {() => Promise<T>} fn
 * @returns {Promise<T>}
 */
export async function azureThrottle(fn) {
  if (!azureConfig.active) return fn();
  await acquire();
  try {
    return await fn();
  } finally {
    release();
  }
}

/** Resolve the SDK `maxRetries` for Azure clients (honours Retry-After). */
export function azureMaxRetries() {
  const n = Number(process.env.AZURE_MAX_RETRIES);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : 6;
}

/** Inspect throttle state (tests / diagnostics). */
export function _throttleState() {
  return { active: _active, queued: _queue.length, max: maxConcurrency() };
}
