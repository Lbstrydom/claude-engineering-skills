/**
 * @fileoverview Advisory cloud-state classification for the cross-skill
 * dispatcher (docs/plans/cross-skill-command-registry.md D4).
 *
 * `isCloudEnabled()` collapses three different facts into one boolean:
 * cloud deliberately unconfigured (no AUDIT_DB_URL), and a configured store
 * whose pool init FAILED, both read `false`. The CLI then told operators
 * "AUDIT_DB_URL unset" while their database was merely down. This module
 * keeps the two distinguishable — as an ADVISORY classification used only
 * for envelope honesty (the `degraded: 'store-unreachable'` hint), never as
 * a routing gate: routing stays on the same pool-presence check legacy used
 * (byte-compatibility), and writes always attempt and report their own
 * discriminated outcome.
 *
 * Evidence is deliberately narrow (audit R3-H3): `dbConfig.url` presence +
 * the pool-init failure `initLearningStore` captures via
 * `_recordInitFailure()`. There is NO per-query error classification — no
 * shared boundary exists to classify those without instrumenting
 * `db/query.mjs`, and a mid-invocation drop surfaces through the write's own
 * discriminated failure anyway. Single-shot CLI: each invocation re-derives
 * the evidence at init.
 */
import { dbConfig } from '../config.mjs';

let _initFailure = null;

/** Called by initLearningStore when pool construction or the probe fails. */
export function _recordInitFailure(err) {
  _initFailure = err?.message ?? String(err);
}

/** Called by initLearningStore when the connectivity probe succeeds. */
export function _clearInitFailure() {
  _initFailure = null;
}

/**
 * @returns {'off'|'ready'|'unreachable'} `'off'` = no DSN configured (static
 *   truth); `'unreachable'` = DSN configured but init evidence says the store
 *   could not be reached; `'ready'` = configured with no failure evidence.
 *   `'ready'` is NOT a promise a later query succeeds — it is the absence of
 *   contrary evidence, which is why nothing routes on it.
 */
export function getCloudState() {
  if (!dbConfig.url) return 'off';
  return _initFailure ? 'unreachable' : 'ready';
}

/** The captured failure message, for envelope hints. Null when none. */
export function getCloudInitFailure() {
  return _initFailure;
}
