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
 *  - `isCallerTx: true` — a DB error, or a count mismatch against
 *    `expectAffected`, RETHROWS. The caller's own `withTx` then rolls back
 *    the whole transaction. Only a thrown exception triggers a Postgres
 *    abort; an unexpected row count is not itself an error and does not
 *    abort anything on its own.
 *  - `isCallerTx: false` (default) — `client` is not inside any transaction
 *    (a bare pool connection, autocommit per statement). A DB error or count
 *    mismatch is caught and returned as a typed outcome — never thrown,
 *    since there is genuinely no transaction to protect.
 *
 * **`isCallerTx: false` + an over-matching predicate is unsafe by construction
 * (round-3 audit H3) — the statement has ALREADY autocommitted by the time
 * `mismatched-count` is reported, so an unintended EXTRA row it touched
 * cannot be rolled back; only `isCallerTx: true` (a real open transaction)
 * can undo an over-match.** Every current call site avoids this by scoping
 * its `WHERE` to a UUID primary key (`WHERE id = $1`), under which `affected`
 * can only ever be 0 or 1 — `mismatched-count` is therefore unreachable
 * today, not merely untested. This is a REQUIREMENT for any future
 * `isCallerTx: false` call, not an accident of the current callers: the
 * predicate must be scoped so it cannot match more than one row, or the
 * caller must supply `isCallerTx: true` inside its own `withTx` instead.
 *
 * `expectAffected` (default `1`) is checked as an EXACT match, not a
 * minimum — audit round-1 M3: a statement matching MORE rows than intended
 * (e.g. an under-scoped predicate) is exactly as wrong as matching fewer, and
 * a minimum-only check silently accepted it as `written`. `affected === 0`
 * reports `'not-found'`; any other mismatch reports `'mismatched-count'` —
 * distinct outcomes because "nothing matched" and "the wrong number matched"
 * are different facts a caller may want to react to differently (round-1
 * H3/H12: a bare `'not-found'` for every non-exact count previously implied
 * "no write occurred" even when some rows genuinely were affected).
 * Pass `expectAffected: null` to skip the count check entirely and rely on
 * thrown-error detection alone — for a caller that genuinely does not know
 * or care how many rows a statement should affect (e.g. an
 * `INSERT ... WHERE EXISTS (...)` guard that legitimately matches 0 or 1).
 *
 * Validates `expectAffected` itself: a non-integer (e.g. `NaN` from an
 * upstream bug) must never silently make the comparison vacuously pass
 * (round-1 H7) — this throws synchronously, before any query runs, on a
 * malformed `expectAffected` regardless of `isCallerTx`, since that is a
 * caller bug, not a DB outcome.
 *
 * @param {import('pg').PoolClient | import('pg').Pool} client
 * @param {{text: string, values?: unknown[]}} statement
 * @param {{expectAffected?: number|null, isCallerTx?: boolean}} [opts]
 * @returns {Promise<{outcome: 'written', affected: number}
 *                  | {outcome: 'not-found'|'mismatched-count'|'failed', affected: number, error?: Error}>}
 */
export async function applyFindingWrite(client, statement, { expectAffected = 1, isCallerTx = false } = {}) {
  if (expectAffected !== null && (!Number.isInteger(expectAffected) || expectAffected < 0)) {
    throw new TypeError(`applyFindingWrite: expectAffected must be a non-negative integer or null, got ${expectAffected}`);
  }
  let res;
  try {
    res = await client.query(statement.text, statement.values ?? []);
  } catch (err) {
    if (isCallerTx) throw err;
    return { outcome: 'failed', affected: 0, error: err };
  }
  const affected = res.rowCount ?? 0;
  if (expectAffected !== null && affected !== expectAffected) {
    if (isCallerTx) {
      throw new Error(`applyFindingWrite: expected ${expectAffected} affected row(s), got ${affected}`);
    }
    return { outcome: affected === 0 ? 'not-found' : 'mismatched-count', affected };
  }
  return { outcome: 'written', affected };
}
