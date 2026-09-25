/**
 * @fileoverview `audit_findings` write-boundary primitive — intra-call
 * atomicity + a verified, typed outcome for a single statement.
 *
 * Plan: docs/plans/runs-findings-write-boundary-hardening.md, Phase 2.
 *
 * Companion to `finding-identity.mjs` (Root Cause 1). This is Root Cause 2:
 * several write sites caught and swallowed a DB error even when running
 * inside a caller-supplied transaction, silently masking a poisoned
 * transaction whose eventual COMMIT would degrade to a ROLLBACK with no
 * signal. `recordFindings` already has the right idiom for its own
 * statement (rethrow when `opts.client` was supplied); this generalises it.
 *
 * Deliberately NOT `durable-write.mjs`: no disk envelope, no spill queue, no
 * cross-process replay. This is intra-call atomicity only — did this one
 * statement apply to the expected rows, inside this one call, right now.
 *
 * @module scripts/lib/store/finding-write
 */

/**
 * Run one statement and verify its affected-row count.
 *
 * `isCallerTx` means exactly one thing: is `client` currently inside an open
 * Postgres transaction (`BEGIN`…`COMMIT`) — never a proxy for caller intent.
 * This function never opens or owns a transaction itself in either mode.
 *
 *  - `isCallerTx: true` — a DB error, or an under-count against
 *    `expectAffected`, RETHROWS. The caller's own `withTx` then rolls back
 *    the whole transaction. Only a thrown exception triggers a Postgres
 *    abort; a 0-row UPDATE/INSERT is not itself an error and does not abort
 *    anything on its own.
 *  - `isCallerTx: false` (default) — `client` is not inside any transaction
 *    (a bare pool connection, autocommit per statement). A DB error or
 *    under-count is caught and returned as a typed outcome — never thrown,
 *    since there is genuinely no transaction to protect.
 *
 * @param {import('pg').PoolClient | import('pg').Pool} client
 * @param {{text: string, values?: unknown[]}} statement
 * @param {{expectAffected?: number, isCallerTx?: boolean}} [opts]
 * @returns {Promise<{outcome: 'written', affected: number}
 *                  | {outcome: 'not-found'|'failed', affected: number, error?: Error}>}
 */
export async function applyFindingWrite(client, statement, { expectAffected = 1, isCallerTx = false } = {}) {
  let res;
  try {
    res = await client.query(statement.text, statement.values ?? []);
  } catch (err) {
    if (isCallerTx) throw err;
    return { outcome: 'failed', affected: 0, error: err };
  }
  const affected = res.rowCount ?? 0;
  if (affected < expectAffected) {
    if (isCallerTx) {
      throw new Error(`applyFindingWrite: expected ${expectAffected} affected row(s), got ${affected}`);
    }
    return { outcome: 'not-found', affected };
  }
  return { outcome: 'written', affected };
}
