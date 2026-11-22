/**
 * @fileoverview The capture schema version and the closed `attempt_outcome` vocabulary
 * (docs/plans/own-model-full-capture.md section 2.9 and 2.10, phase P0).
 *
 * `CAPTURE_SCHEMA_VERSION` is stamped on every capture row. It is independent of migration
 * timestamps and of the store's `schema_version`. A meaning-changing change BUMPS it, and readers
 * report per version, never pooled (the contract-epoch rule).
 *
 * `ATTEMPT_OUTCOMES` is the closed list of what a PROVIDER ATTEMPT did. It is deliberately a
 * separate list from `capture_state` (what capture did with it, P1): two meanings, two fields.
 * The migration CHECK, the writer, the report and the tests all read this one list.
 *
 * @module scripts/lib/capture/schema-version
 */

/** Integer, one constant. Bump on a meaning-changing change to any capture row. */
export const CAPTURE_SCHEMA_VERSION = 1;

/** The synthetic canary's `purpose`: excluded from every figure so it can never pollute a population. */
export const CANARY_PURPOSE = 'capture-canary';

/** What the provider attempt did. Closed. */
export const ATTEMPT_OUTCOMES = Object.freeze([
  'success',
  'schema-reject',
  'partial',
  'timeout',
  'cancel',
  'refusal',
  'error',
  'missing-payload',
]);

/**
 * Map a thrown LLM error to its typed outcome. PURE; never throws; an unrecognised failure is
 * `error`, never a guess at something more specific.
 * @param {any} err
 * @returns {string} a member of ATTEMPT_OUTCOMES
 */
export function attemptOutcomeForError(err) {
  try {
    const cat = String(err?.llmCategory ?? '').toLowerCase();
    if (cat === 'truncated' || cat === 'incomplete') return 'partial';
    if (cat === 'schema') return 'schema-reject';
    if (cat === 'empty') return 'missing-payload';
    if (cat === 'timeout') return 'timeout';
    if (cat === 'cancel' || cat === 'aborted') return 'cancel';
    if (cat === 'refusal' || cat === 'content-filter') return 'refusal';
    // Our own timer abort arrives as an LlmError with category `timeout`; a bare abort is somebody else's cancel.
    if (!cat && (err?.name === 'AbortError' || err?.code === 'ABORT_ERR')) return 'cancel';
    return 'error';
  } catch { return 'error'; }
}
