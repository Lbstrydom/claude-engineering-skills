/**
 * @fileoverview Canonical error normalization for the `pg`-backed audit-loop store.
 *
 * Originally salvaged from `scripts/lib/stores/sql/sql-errors.mjs` (deleted in
 * M4 — postgres-parity plan §7 Phase 4). Hardened in M1 audit R1 (H5 / M12)
 * to prefer first-class structured fields (`err.code` syscall names + the
 * Postgres SQLSTATE class-08 family) over brittle message-substring matching.
 * Message matching is retained only as a last-resort fallback for legacy
 * pg builds that wrap socket errors without preserving `err.code`.
 *
 * @module scripts/lib/db/errors
 */

// Node syscall codes that `pg` propagates on `err.code` when the underlying
// socket / DNS lookup fails. All are retryable from this layer's perspective
// — they describe transient connectivity, not a doomed misconfiguration.
const RETRYABLE_NETWORK_CODES = new Set([
  'ECONNREFUSED',
  'ECONNRESET',
  'ETIMEDOUT',
  'EPIPE',
  'EAI_AGAIN',
  'ENOTFOUND',
  'EHOSTUNREACH',
  'ENETUNREACH',
]);

// SQLSTATE class 08 — Connection Exception. Treat the whole class as
// retryable: every member is "the connection died, retrying may succeed".
// Postgres docs: https://www.postgresql.org/docs/current/errcodes-appendix.html
function isConnectionExceptionSqlstate(code) {
  return typeof code === 'string' && code.length === 5 && code.startsWith('08');
}

// Additional retryable SQLSTATEs outside class 08.
const RETRYABLE_SQLSTATES = new Set([
  '40001', // serialization_failure
  '40P01', // deadlock_detected
  '57014', // query_canceled (statement_timeout)
  '57P01', // admin_shutdown
  '57P02', // crash_shutdown
  '57P03', // cannot_connect_now (server in restart / startup)
  '53300', // too_many_connections
  '53400', // configuration_limit_exceeded
]);

// Message-substring fallback. Only consulted when `err.code` is missing —
// some pg builds wrap the syscall error and lose `code` on the rewrap.
const TRANSIENT_MESSAGE_SUBSTRINGS = [
  'ECONNREFUSED',
  'ECONNRESET',
  'ETIMEDOUT',
  'connection terminated',
  'Connection terminated',
  'Client has encountered a connection error',
];

/**
 * @typedef {Object} NormalizedStoreError
 * @property {'transient'|'misconfiguration'|'validation'|'integrity'|'capability'|'unknown'} reason
 * @property {boolean} retryable
 * @property {boolean} bufferToOutbox
 * @property {string} operatorHint
 * @property {string} [nativeCode]
 */

/**
 * Normalize a native Postgres error into a canonical error shape.
 *
 * Classification priority (high → low):
 *  1. `err.code` matches a known syscall name → transient/network.
 *  2. `err.code` matches SQLSTATE 08* → transient/connection.
 *  3. `err.code` matches an explicit SQLSTATE allowlist → transient/misc.
 *  4. `err.code` is a known fixed-meaning SQLSTATE → misconfig / integrity.
 *  5. Message-substring fallback for legacy wrappers without `err.code`.
 *  6. `unknown` (not retryable).
 *
 * @param {Error & {code?: string}} err
 * @param {string} [_context]
 * @returns {NormalizedStoreError}
 */
export function normalizePostgresError(err, _context) {
  const code = err?.code || '';
  const msg = err?.message || '';

  // (1) Node syscall codes
  if (RETRYABLE_NETWORK_CODES.has(code)) {
    return {
      reason: 'transient',
      retryable: true,
      bufferToOutbox: true,
      operatorHint: `Postgres connection failed (${code}); buffering writes`,
      nativeCode: code,
    };
  }

  // (2) SQLSTATE class 08 — Connection Exception
  if (isConnectionExceptionSqlstate(code)) {
    return {
      reason: 'transient',
      retryable: true,
      bufferToOutbox: true,
      operatorHint: `Postgres connection exception (SQLSTATE ${code}); retrying`,
      nativeCode: code,
    };
  }

  // (3) Allowlisted retryable SQLSTATEs
  if (RETRYABLE_SQLSTATES.has(code)) {
    const hint = ({
      '40001': 'Serialization conflict; retrying',
      '40P01': 'Deadlock detected; retrying',
      '57014': 'Query exceeded statement_timeout',
      '57P01': 'Postgres admin shutdown; retrying after restart',
      '57P02': 'Postgres crash shutdown; retrying after restart',
      '57P03': 'Postgres cannot connect (starting up?); retrying',
      '53300': 'Too many connections; reduce AUDIT_DB_POOL_MAX or retry',
      '53400': 'Configuration limit exceeded; retrying',
    })[code];
    return {
      reason: 'transient',
      retryable: true,
      bufferToOutbox: true,
      operatorHint: hint,
      nativeCode: code,
    };
  }

  // (4) Fixed-meaning SQLSTATEs
  if (code === '28P01' || code === '28000') {
    return {
      reason: 'misconfiguration',
      retryable: false,
      bufferToOutbox: false,
      operatorHint: 'Postgres auth failed; check AUDIT_DB_URL credentials',
      nativeCode: code,
    };
  }
  if (code === '3D000') {
    return {
      reason: 'misconfiguration',
      retryable: false,
      bufferToOutbox: false,
      operatorHint: 'Postgres DB does not exist; create it',
      nativeCode: code,
    };
  }
  if (code === '42P01') {
    return {
      reason: 'misconfiguration',
      retryable: false,
      bufferToOutbox: false,
      operatorHint: 'Run: node scripts/setup-postgres.mjs --migrate',
      nativeCode: code,
    };
  }
  if (code === '23505') {
    return {
      reason: 'integrity',
      retryable: false,
      bufferToOutbox: false,
      // Be precise: this is *a* unique-violation, not necessarily an idempotency
      // collision. Audit M4 flagged the broad "safe to ignore" wording — the
      // caller has to decide whether their write was idempotent. We just say
      // what happened and let context drive the response.
      operatorHint: 'Unique constraint violation (SQLSTATE 23505) — caller-specific: safe if the write was idempotent, otherwise a real conflict',
      nativeCode: code,
    };
  }

  // (5) Message-substring fallback (only when no err.code)
  if (!code) {
    for (const needle of TRANSIENT_MESSAGE_SUBSTRINGS) {
      if (msg.includes(needle)) {
        return {
          reason: 'transient',
          retryable: true,
          bufferToOutbox: true,
          operatorHint: 'Postgres unreachable (legacy wrapper, no err.code); buffering writes',
          nativeCode: code,
        };
      }
    }
  }

  // (6) Unknown
  return {
    reason: 'unknown',
    retryable: false,
    bufferToOutbox: false,
    operatorHint: code ? `Postgres error (SQLSTATE ${code}): ${msg}` : `Postgres error: ${msg}`,
    nativeCode: code,
  };
}

/**
 * Is this SQLSTATE a SCHEMA/QUERY fault — i.e. "the query is broken", as
 * opposed to "the query ran and the data is absent"?
 *
 * SQLSTATE class 42 is "Syntax Error or Access Rule Violation": `42703`
 * undefined_column, `42P01` undefined_table, `42P10` invalid_column_reference,
 * `42601` syntax_error, `42501` insufficient_privilege. Every one of them
 * means the statement can NEVER succeed as written against this database —
 * no amount of data would change the answer.
 *
 * Why this exists as ONE exported predicate rather than an inline `startsWith`
 * at each catch: this repo has now been bitten three times by the same shape,
 * a bare `catch { return null }` (or `return false`) that renders a schema
 * error as an empty result. `getActiveSnapshot` selected a `commit_sha` column
 * `refresh_runs` does not have and reported "no snapshot" for every healthy
 * repo; `getFreshImportersOrNull` selected the same phantom column and its
 * freshness cache therefore never hit once in its entire history. Both were
 * invisible precisely because "no row" and "this query is broken" arrived at
 * the caller as the same value. A caller may still DEGRADE on a schema fault
 * — that is usually the right behaviour for best-effort context — but it must
 * not do so SILENTLY.
 *
 * Deliberately NOT folded into `normalizePostgresError`: that function's
 * `reason` drives `durableWrite`'s spill/outbox routing, and re-classifying a
 * whole SQLSTATE class there would change write-path behaviour for every
 * registered writer. This predicate answers one narrow question for read-path
 * catches and changes nothing else.
 *
 * @param {string} [code] - a SQLSTATE, e.g. `err.code` from node-postgres.
 * @returns {boolean}
 */
export function isSchemaFaultSqlstate(code) {
  return typeof code === 'string' && /^42/.test(code);
}

/**
 * Describe a caught error for a read-path catch that is about to degrade.
 * Returns `null` when the error is NOT a schema fault (the caller should stay
 * silent — an ordinary miss or a transient blip is not news); otherwise a
 * one-line operator string naming the SQLSTATE and the remedy.
 *
 * Named by PATH, not an `npm run` alias: this module syncs into consumer repos
 * under `scripts/.claude-skills/`, where the alias does not exist (AGENTS.md
 * "Five shapes" #5).
 *
 * @param {Error & {code?: string}} err
 * @param {string} where - the function name, for the operator's benefit.
 * @returns {string|null}
 */
export function describeSchemaFault(err, where) {
  // Walks `cause`: several store functions rethrow as
  // `new Error('<fn> failed: ' + err.message, { cause: err })`, which puts the
  // SQLSTATE one level down. Reading only the top-level `code` would leave this
  // predicate blind at exactly the seams that wrap — the same "checked the
  // wrong layer" mistake in miniature. Bounded depth, so a self-referential
  // cause chain cannot spin.
  let cur = err;
  for (let depth = 0; cur && depth < 5; depth += 1) {
    const code = cur.code || cur._normalized?.nativeCode || '';
    if (isSchemaFaultSqlstate(code)) {
      return `  [store] ${where}: query rejected by Postgres (SQLSTATE ${code}: ${cur.message || 'no message'}). `
        + 'This is a SCHEMA fault, not an empty result — the value returned is a degraded default, not a measurement. '
        + 'Run: node scripts/setup-postgres.mjs --check-drift\n';
    }
    cur = cur.cause;
  }
  return null;
}

/**
 * Enrich a 42P10 (`no unique or exclusion constraint matching the ON
 * CONFLICT specification`) error with the table and columns the caller
 * expected a constraint on. Postgres's own message names neither — the
 * caller (`upsert()`) already knows both, and by the time the failure
 * reaches an operator (`durableWrite`'s outcome tally stringifies it) that
 * context is gone.
 *
 * Write-path counterpart to `describeSchemaFault` above: same shape (name the
 * fault Postgres left anonymous), different seam (a thrown write error here,
 * a caught read error there) — kept separate rather than folded into one
 * function because the write path has the table/columns as call-site
 * arguments, not something to walk a `cause` chain for.
 *
 * Consumer report, 2026-09-04: the bare message sent the operator to
 * `--check-drift`, which compares the applied-migrations ledger to source
 * files, not the live schema — it read clean while the real `bandit_arms`
 * constraint had four columns against the three the migrations declare.
 * Naming the table/columns here points at `pg_constraint` instead.
 *
 * No-op (returns `err` unchanged) for any other SQLSTATE or when no
 * `onConflict` target was supplied — safe to call unconditionally from a
 * generic catch.
 *
 * @param {Error & {code?: string}} err
 * @param {string} table
 * @param {string|string[]|undefined} onConflict
 * @returns {Error} the same error object, mutated in place
 */
export function annotateConflictTargetFault(err, table, onConflict) {
  if (err && err.code === '42P10' && onConflict) {
    const cols = (Array.isArray(onConflict) ? onConflict : [onConflict]).join(', ');
    err.message = `${table} has no unique constraint on (${cols}) — ${err.message}`;
  }
  return err;
}

// ── Test seam ──────────────────────────────────────────────────────────────

export const _internals = Object.freeze({
  RETRYABLE_NETWORK_CODES,
  RETRYABLE_SQLSTATES,
  isConnectionExceptionSqlstate,
  isSchemaFaultSqlstate,
  describeSchemaFault,
  annotateConflictTargetFault,
});
