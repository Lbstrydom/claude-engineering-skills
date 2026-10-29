/**
 * @fileoverview Closed vocabularies + pure chronology helpers for the own-model
 * telemetry columns (docs/plans/own-model-telemetry-slice-1.md). One module so
 * the JS validators and the migration's CHECK constraints
 * (20261026120000_own_model_telemetry_slice1.sql) have a single place to agree;
 * `tests/own-model-telemetry.test.mjs` compares both sides against the CHECKs.
 *
 * @module scripts/lib/adjudication-vocab
 */

/**
 * Who decided. `agent` is the campaign-verdict kind and stays campaign-only. `reviewer` is the final reviewer's
 * per-finding reversal (audit-telemetry-capture Decision 4); it is only writable on a store whose
 * `fae_adjudicator_kind_chk` was widened by migration 20261029120000.
 */
export const ADJUDICATOR_KINDS = Object.freeze(['agent', 'human', 'pipeline', 'rule', 'reviewer']);

/** Which workflow owns a finding_adjudication_events row. */
export const EVENT_ORIGINS = Object.freeze(['audit', 'campaign']);

/**
 * Why a finding was dismissed. `unclassified` is the explicit "the producer
 * supplied no class" value: NULL must keep meaning "not captured", and `other`
 * must keep meaning "a considered reason outside the vocabulary".
 */
export const DISMISS_REASON_CLASSES = Object.freeze([
  'false-positive', 'not-actionable', 'duplicate', 'out-of-scope', 'accepted-risk',
  'already-fixed', 'control-marker', 'other', 'unclassified',
]);

export const DIFF_CAPTURE_STATUSES = Object.freeze([
  'captured', 'refused-secret', 'empty-after-filter', 'oversize-section', 'not-applicable',
  // The repo's training_eligible is explicitly false: its diff content is never stored.
  'repo-excluded',
]);

export const isAdjudicatorKind = (v) => ADJUDICATOR_KINDS.includes(v);
export const isDismissReasonClass = (v) => DISMISS_REASON_CLASSES.includes(v);

const TERMINAL_FIX = new Set(['fixed', 'verified']);

/**
 * Was the fix recorded no later than the first decision?
 *
 * `true` iff fixRecordedAt <= firstDecidedAt, `false` iff the fix came strictly
 * after, `null` while either timestamp is unknown. Unknown is never coerced:
 * a legacy finding already decided (or already fixed) when the columns were
 * added keeps a NULL stamp, so its flag stays NULL rather than inventing
 * chronology (plan decision 5).
 *
 * @param {{fixRecordedAt?: Date|string|null, firstDecidedAt?: Date|string|null}} t
 * @returns {boolean|null}
 */
export function fixOrderFlag({ fixRecordedAt, firstDecidedAt } = {}) {
  if (fixRecordedAt == null || firstDecidedAt == null) return null;
  const fix = new Date(fixRecordedAt).getTime();
  const decided = new Date(firstDecidedAt).getTime();
  if (Number.isNaN(fix) || Number.isNaN(decided)) return null;
  return fix <= decided;
}

/** A `remediation_state` that counts as "the fix landed" for chronology. */
export const isTerminalFixState = (state) => TERMINAL_FIX.has(state);
