/**
 * @fileoverview The one place a run / audit-session id is turned into the 40-character key the debt schema stores
 * (`deferredRun`, `lastSurfacedRun`, event `runId`/`resolvedBy`).
 *
 * Before this a consumer's id of the shape `audit-code-<slug>-<timestamp>-<suffix>` was rejected AFTER the entry was
 * built, and the tiered stage-0 route cut every id to its first 40 characters, so two ids sharing a prefix recorded the
 * same attribution. The cap itself stays (it is the schema's contract); the id is compacted instead.
 *
 * An id within the cap is returned unchanged. A longer one becomes `<27-char prefix>~<12 hex of sha256(full id)>`: the
 * same id always yields the same key (a retry of one audit is idempotent), and the digest covers the WHOLE id, so ids
 * that share a prefix stay distinct. The key is a pure function of the canonical id, so attribution is verifiable by
 * recomputing it from the audit's own files; no second identity is invented and nothing resets a round budget.
 *
 * @module scripts/lib/run-key
 */
import { createHash } from 'node:crypto';

export const RUN_KEY_MAX = 40;
const DIGEST_CHARS = 12;
const PREFIX_CHARS = RUN_KEY_MAX - DIGEST_CHARS - 1;

/**
 * @param {string} runId - the canonical run / audit-session id
 * @returns {string} a key of at most RUN_KEY_MAX characters
 * @throws {TypeError} when the id is not a non-empty string
 */
export function compactRunKey(runId) {
  if (typeof runId !== 'string' || runId.length === 0) {
    throw new TypeError('compactRunKey: a run id must be a non-empty string');
  }
  if (runId.length <= RUN_KEY_MAX) return runId;
  const digest = createHash('sha256').update(runId, 'utf8').digest('hex').slice(0, DIGEST_CHARS);
  // The cap counts UTF-16 units, so the cut must not leave half of a surrogate pair behind (an ill-formed key).
  let prefix = runId.slice(0, PREFIX_CHARS);
  const last = prefix.charCodeAt(prefix.length - 1);
  if (last >= 0xd800 && last <= 0xdbff) prefix = prefix.slice(0, -1);
  return `${prefix}~${digest}`;
}
