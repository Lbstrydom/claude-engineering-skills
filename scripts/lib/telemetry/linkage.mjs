/**
 * @fileoverview Telemetry linkage as a STRUCTURAL contract, not a column each writer remembers to fill.
 *
 * Incident: `audit_runs.audit_session_id` sat at 0% on code runs for weeks because one field was dropped in
 * `buildAuditRunContext`; the row was written with NULL and nothing said so. The fix here is at the write
 * boundary: a run row always carries an explicit {@link LinkageState}, so "no session" is either a DECLARED
 * standalone reason or the loud `unlinked` state - never a bare NULL.
 *
 * The run row is the linkage ROOT. Passes, findings and LLM calls link to a session through `run_id`, and to a
 * round through their own round column where one exists (see {@link LINKAGE_REGISTRY}).
 *
 * Pure: no I/O, so it is importable from the store, the query CLI and the tests alike.
 *
 * Domain: shared-lib.
 *
 * @module scripts/lib/telemetry/linkage
 */

/** @typedef {'linked'|'unlinked'|'standalone'} LinkageState */

export const LINKAGE_STATES = Object.freeze(['linked', 'unlinked', 'standalone']);

/**
 * Why a run is legitimately outside any audit session. A closed set: a typo must fail, or it would pass for a
 * declaration. Add a reason here with its justification, never a free-text value at a call site.
 */
export const STANDALONE_REASONS = Object.freeze({
  'manual-single-shot': 'an ad-hoc single audit invoked without --session-id or a <sid>-r<N> --out path',
  'canary': 'a synthetic capture canary run, not an audit of anything',
  'model-eval': 'a model-evaluation arm with no primary audit to be a round of',
});

/** The `reason` recorded on an `unlinked` row: the writer had no session and declared nothing. */
export const UNDECLARED_REASON = 'undeclared';

/**
 * Per-writer linkage inventory (task step 1). `keys` are what the row must be reachable by; `via` says how the key
 * reaches the writer; `onMissing` is the chosen behaviour and `outcome` its durable-write justification.
 *
 * Choice rule: the RUN ROW is never refused (refusing it loses the audit's whole record - `lost`), so it records an
 * explicit `unlinked`. A CHILD row without a run id cannot be attributed to anything, so it is refused as a
 * `skipped`/declined (`no-run-id`) - nothing wrong with the store, and a retry could not succeed. A child whose RUN is
 * unlinked is still written (its own data is sound) and is surfaced by the linkage query, never hidden.
 */
export const LINKAGE_REGISTRY = Object.freeze({
  'audit.runStart': {
    table: 'audit_runs', keys: ['audit_session_id', 'audit_round'], via: 'ctx.auditIdentity -> runStartIdentity -> recordRunStart -> captureIdentityColumns',
    onMissing: 'record linkage_state=unlinked (or standalone with a declared reason)',
    outcome: 'written - refusing would be `lost` for the whole audit; the state makes the gap queryable',
  },
  'audit.passStats': {
    table: 'audit_pass_stats', keys: ['run_id', 'round'], via: 'payload.runId + payload.round (run-telemetry.mjs)',
    onMissing: 'no run id: not written', outcome: 'lost-only writer (no rowKey, append-only INSERT); a missing run id is a caller bug surfaced as `lost`',
  },
  'audit.findings': {
    table: 'audit_findings', keys: ['run_id', 'round_raised'], via: 'payload.runId + payload.round -> buildFindingRow',
    onMissing: 'no run id: not written', outcome: 'keyed (run, fingerprint, pass); missing run id is `skipped` (no-run-id), never a NULL-run row',
  },
  'audit.llmCalls': {
    table: 'llm_call_provenance', keys: ['audit_run_id'], via: 'bindAuditCallLog -> log.run_id',
    onMissing: 'no run id: declined (`no-run-id`)', outcome: 'skipped - a call with no run cannot be attributed; dropped counts ride the summary row',
    note: 'no round column: a call reaches a ROUND only through its run (a unified run spans rounds, so the round is unresolved)',
  },
  'audit.reviewerEvents': {
    table: 'finding_adjudication_events', keys: ['finding_id', 'evidence.reviewing_run_id'], via: 'payload.runId + payload.fingerprint',
    onMissing: 'no run id: not written', outcome: 'keyed; session/round are derived through the finding -> run join',
  },
  'audit.runComplete': {
    table: 'audit_runs', keys: ['run_id'], via: 'payload.runId', onMissing: 'no run id: declined', outcome: 'keyed UPDATE; carries no new linkage',
  },
});

/**
 * Resolve the linkage state of a run about to be written.
 *
 * Illegal pairs THROW (a standalone reason alongside a session id contradicts itself; an unknown reason is a typo
 * posing as a declaration). The caller is the store boundary, where a throw is caught and logged by `recordRunStart`.
 *
 * @param {{auditSessionId?: string|null, auditRound?: number|null, unifiedRun?: boolean, standaloneReason?: string|null}} input
 * @returns {{state: LinkageState, reason: string|null, auditSessionId: string|null, auditRound: number|null}}
 */
export function resolveLinkage({ auditSessionId = null, auditRound = null, unifiedRun = false, standaloneReason = null } = {}) {
  const sid = typeof auditSessionId === 'string' && auditSessionId.trim() ? auditSessionId.trim() : null;
  if (standaloneReason != null) {
    if (!Object.hasOwn(STANDALONE_REASONS, standaloneReason)) {
      throw new Error(`linkage: unknown standalone reason "${standaloneReason}" (declared: ${Object.keys(STANDALONE_REASONS).join(', ')})`);
    }
    if (sid) throw new Error(`linkage: a run cannot be standalone ("${standaloneReason}") and carry session "${sid}"`);
    return { state: 'standalone', reason: standaloneReason, auditSessionId: null, auditRound: null };
  }
  if (!sid) return { state: 'unlinked', reason: UNDECLARED_REASON, auditSessionId: null, auditRound: null };
  // A unified run (explicit runId) spans every round, so no single round describes it.
  const round = !unifiedRun && Number.isInteger(auditRound) ? auditRound : null;
  return { state: 'linked', reason: null, auditSessionId: sid, auditRound: round };
}

/**
 * Classify a stored run row for the linkage query: the stored state, but a row that predates the state column (or
 * carries a state its own session columns contradict) is reported as what it is, never as `linked`.
 * @param {{linkage_state?: string|null, audit_session_id?: string|null}} row
 * @returns {LinkageState|'legacy-unstated'}
 */
export function classifyStoredRun(row) {
  const state = row?.linkage_state ?? null;
  if (state === 'linked') return row.audit_session_id ? 'linked' : 'unlinked';
  if (state === 'standalone' || state === 'unlinked') return state;
  return row?.audit_session_id ? 'linked' : 'legacy-unstated';
}
