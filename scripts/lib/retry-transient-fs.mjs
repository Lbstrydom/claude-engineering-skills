/**
 * @fileoverview Generic synchronous retry wrapper for transient Windows
 * filesystem errors (EPERM/EBUSY from AV/indexer lock contention on
 * rename/rmdir). Not platform-gated — a harmless no-op on Linux/Mac,
 * where these codes cannot occur from a rename race.
 *
 * @module scripts/lib/retry-transient-fs
 */

const DEFAULT_RETRYABLE_CODES = ['EPERM', 'EBUSY'];
const DEFAULT_MAX_RETRIES = 3;
const DEFAULT_RETRY_DELAY_MS = 50;

/**
 * Synchronous blocking sleep (Atomics.wait on a throwaway SharedArrayBuffer).
 * Exported (not just via _internals) because scripts/prepush-check.mjs reuses
 * it for git-lock-contention backoff — a second legitimate production
 * consumer, not just test access. Keep this the single sleep primitive
 * rather than a second SharedArrayBuffer trick living elsewhere.
 */
export function blockingSleep(delayMs) {
  const sab = new SharedArrayBuffer(4);
  const arr = new Int32Array(sab);
  Atomics.wait(arr, 0, 0, delayMs);
}

/**
 * Run a synchronous, zero-argument operation, retrying when the thrown
 * error's `.code` is in `retryableCodes`. Rethrows immediately on a
 * non-retryable code, or after `maxRetries` attempts are exhausted.
 *
 * @param {() => any} fn
 * @param {object} [opts]
 * @param {number} [opts.maxRetries] - total attempts (not extra retries)
 * @param {number} [opts.retryDelayMs] - fixed delay between attempts
 * @param {string[]} [opts.retryableCodes]
 * @returns {any} fn()'s return value
 */
function isFiniteNonNegative(n) {
  return typeof n === 'number' && Number.isFinite(n) && n >= 0;
}

function isNonNegativeInteger(n) {
  return typeof n === 'number' && Number.isInteger(n) && n >= 0;
}

function isStringArray(arr) {
  return Array.isArray(arr) && arr.every((c) => typeof c === 'string');
}

export function retrySync(fn, {
  maxRetries = DEFAULT_MAX_RETRIES,
  retryDelayMs = DEFAULT_RETRY_DELAY_MS,
  retryableCodes = DEFAULT_RETRYABLE_CODES,
} = {}) {
  // audit-code R1-M5: a caller-supplied NaN/Infinity maxRetries makes
  // `attempt >= maxRetries` never become true, turning a persistently
  // failing operation into an infinite retry loop — the exact hang this
  // function exists to prevent. No current call site passes a dynamic
  // value, but this is a shared library boundary; validate here rather
  // than trust every future caller.
  // audit-code R2-M5: maxRetries is an attempt COUNT, not a duration — a
  // fractional value (e.g. 2.5) makes `attempt >= maxRetries` true on a
  // non-obvious attempt number, an ambiguous API contract even though it
  // can't hang. Tightened to require an integer.
  if (!isNonNegativeInteger(maxRetries)) {
    throw new TypeError(`retrySync: maxRetries must be a non-negative integer, got ${maxRetries}`);
  }
  if (!isFiniteNonNegative(retryDelayMs)) {
    throw new TypeError(`retrySync: retryDelayMs must be a finite non-negative number, got ${retryDelayMs}`);
  }
  // audit-code R3-L1: an invalid retryableCodes (null, non-array, non-string
  // entries) would throw INSIDE the catch block's `.includes()` check,
  // masking the real filesystem error with an unrelated TypeError. Validate
  // up front so a bad config fails loudly at the call, not by swallowing
  // the operation's actual failure.
  if (!isStringArray(retryableCodes)) {
    throw new TypeError('retrySync: retryableCodes must be an array of strings');
  }
  let attempt = 0;
  for (;;) {
    attempt++;
    try {
      return fn();
    } catch (err) {
      const retryable = retryableCodes.includes(err?.code);
      if (!retryable || attempt >= maxRetries) {
        throw err;
      }
      blockingSleep(retryDelayMs);
    }
  }
}

export const _internals = {
  blockingSleep,
  DEFAULT_RETRYABLE_CODES,
  DEFAULT_MAX_RETRIES,
  DEFAULT_RETRY_DELAY_MS,
};
