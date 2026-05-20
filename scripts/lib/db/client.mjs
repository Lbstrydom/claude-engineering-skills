/**
 * @fileoverview Single lazy `pg.Pool` singleton + the AsyncLocalStorage
 * transaction context used by `query.mjs`/`rpc.mjs` helpers.
 *
 * Plan: docs/plans/postgres-parity.md §2 Architecture · §7 Phase 1.
 *
 * v1 contract:
 *  - `AUDIT_DB_URL` is the ONLY supported runtime DSN input. If only legacy
 *    `SUPABASE_AUDIT_*` is set we fail fast with an actionable message — no
 *    silent DSN derivation (plan §2 "Connection model", R3/H1).
 *  - Target schema is `public` (plan §2 "Schema scope", R3/H2). v1 refuses
 *    any caller that asks for a non-public schema; `search_path` is also
 *    pinned to `public` on every fresh checkout as belt-and-braces.
 *  - **Pool-scoped** `pg` type parsers map `timestamptz`/`timestamp`/`date`
 *    (OIDs 1184/1114/1082) → raw `string`, NEVER `Date`. Set via the Pool
 *    `types` option, not the process-global `pg.types.setTypeParser` —
 *    mutating the global would silently change date parsing for any other
 *    `pg` consumer in the same process (Gemini round-2, R13).
 *  - `withTx` (in `query.mjs`) attaches a checked-out client to this
 *    AsyncLocalStorage; every query helper checks the context and binds to
 *    the active transaction client when one is present. A nested `withTx`
 *    joins the existing transaction via `SAVEPOINT` rather than checking
 *    out a second client — preventing pool-exhaustion deadlocks against
 *    `AUDIT_DB_POOL_MAX` (Gemini round-2, R15).
 *
 * @module scripts/lib/db/client
 */

import { AsyncLocalStorage } from 'node:async_hooks';

// ── pg type-parser OIDs (timestamps + dates → string, not Date) ────────────
// These are the canonical Postgres OIDs the `pg` driver receives for the
// three relevant column types. Centralised here so query.mjs and any future
// callers can reference the same constants instead of re-magic-numbering.
export const PG_OID_TIMESTAMPTZ = 1184;
export const PG_OID_TIMESTAMP   = 1114;
export const PG_OID_DATE        = 1082;
const STRING_OIDS = new Set([PG_OID_TIMESTAMPTZ, PG_OID_TIMESTAMP, PG_OID_DATE]);

/**
 * AsyncLocalStorage context that withTx populates with the active
 * { client, savepointDepth } so query helpers can auto-bind to the
 * transaction client. Exported for `query.mjs` only — external callers
 * should use `getActiveTxClient()`.
 *
 * @type {AsyncLocalStorage<{client: import('pg').PoolClient, depth: number}>}
 */
export const _txStore = new AsyncLocalStorage();

/**
 * Return the active transaction's PoolClient if a `withTx` frame is on the
 * stack, otherwise `null`. The `query`/`one`/`many`/insert/upsert helpers
 * call this and route through the tx client when present, the pool otherwise.
 *
 * @returns {import('pg').PoolClient | null}
 */
export function getActiveTxClient() {
  const ctx = _txStore.getStore();
  return ctx?.client ?? null;
}

// ── Singleton + lazy init ──────────────────────────────────────────────────

let _pool = null;
/** Promise guard so concurrent first-call sites share one Pool. */
let _initPromise = null;

/**
 * Resolve the connection string. v1 honours `AUDIT_DB_URL` only.
 * Legacy-only Supabase env vars → fail-fast with an actionable hint
 * (plan §2 "Connection model").
 *
 * @returns {string | null} DSN or null when cloud mode is disabled.
 */
function resolveDbUrl() {
  const url = (process.env.AUDIT_DB_URL || '').trim();
  if (url) return url;

  const hasLegacy =
    !!process.env.SUPABASE_AUDIT_URL ||
    !!process.env.SUPABASE_AUDIT_ANON_KEY ||
    !!process.env.SUPABASE_AUDIT_SERVICE_ROLE_KEY;

  if (hasLegacy) {
    throw new Error(
      'AUDIT_DB_URL is not set, but legacy SUPABASE_AUDIT_* configuration ' +
      'is present. Set AUDIT_DB_URL to your Postgres connection string — ' +
      'for a Supabase project, open the dashboard → Connect → Direct ' +
      'connection or Session pooler and copy the URI.'
    );
  }

  return null;
}

/**
 * v1 only supports `public`. Refuse any caller that opted into a non-public
 * schema via the legacy `AUDIT_POSTGRES_SCHEMA` env or a new
 * `AUDIT_DB_SCHEMA` value (the latter is explicitly NOT a documented env in
 * v1 — plan §2 "Schema scope"). Empty / `public` are accepted.
 */
function assertPublicSchema() {
  const schema = (process.env.AUDIT_DB_SCHEMA || process.env.AUDIT_POSTGRES_SCHEMA || '').trim();
  if (schema && schema !== 'public') {
    throw new Error(
      `Postgres-parity v1 supports only the \`public\` schema; received \`${schema}\`. ` +
      'Arbitrary-schema support is out of scope (docs/plans/postgres-parity.md §10). ' +
      'Unset AUDIT_DB_SCHEMA / AUDIT_POSTGRES_SCHEMA and re-run.'
    );
  }
}

/**
 * Build the pool config. Shape salvaged from
 * `scripts/lib/stores/postgres-store.mjs:31-47` (kept structurally identical
 * so the connection semantics match the legacy adapter), with two additions:
 *  - the `types` callback that pins date OIDs to `string` (Gemini G1).
 *  - `options: '-c search_path=public'` so the server sets `search_path` as
 *    part of the connection startup handshake — NOT via a fire-and-forget
 *    `pool.on('connect')` hook (audit R1 H4 / H6). The startup option is
 *    applied by the backend before the connection is handed to any client,
 *    so no query can ever run against the wrong schema; it also survives
 *    PgBouncer transaction-mode pooling because it's set on the backend
 *    once at connection time, not per-transaction.
 *
 * @param {string} url
 * @param {object} pgTypes - the live `pg.types` module (for default parsers)
 */
function buildPoolConfig(url, pgTypes) {
  const sslMode = (process.env.AUDIT_DB_SSL_MODE || 'require').trim();
  const maxConns = Number(process.env.AUDIT_DB_POOL_MAX || 4);

  const customTypes = {
    /**
     * Pool-scoped type parser. Returns raw `string` for OIDs 1184/1114/1082;
     * delegates to the global `pg.types` for every other type. NEVER mutates
     * `pg.types.setTypeParser` — that would change behaviour for unrelated
     * `pg` consumers in this process (Gemini round-2, R13).
     *
     * @param {number} oid
     * @param {'text'|'binary'} [format]
     */
    getTypeParser(oid, format) {
      if (STRING_OIDS.has(oid)) return (val) => val;
      return pgTypes.getTypeParser(oid, format);
    },
  };

  return {
    connectionString: url,
    // Set the session GUC during the Postgres startup handshake — eliminates
    // the race that a `SET search_path` issued from an async connect hook
    // could lose against the first user query on a fresh client.
    options: '-c search_path=public',
    max: Number.isFinite(maxConns) && maxConns > 0 ? maxConns : 4,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 10000,
    ssl: sslMode === 'disable' ? false : { rejectUnauthorized: sslMode !== 'no-verify' },
    types: customTypes,
  };
}

/**
 * Get (or lazily build) the shared `pg.Pool`. Returns `null` when cloud
 * mode is disabled (#16 graceful degradation — neither AUDIT_DB_URL nor
 * legacy Supabase config present).
 *
 * Throws synchronously on misconfiguration (legacy-only env, non-public
 * schema). Throws asynchronously via the pool's own `error` channel for
 * unreachable / auth failures — let those bubble; `normalizePostgresError`
 * in `errors.mjs` is the canonical translator.
 *
 * Concurrent first calls share one in-flight init via `_initPromise`.
 *
 * @returns {Promise<import('pg').Pool | null>}
 */
export async function getPool() {
  if (_pool) return _pool;
  if (_initPromise) return _initPromise;

  _initPromise = (async () => {
    assertPublicSchema();
    const url = resolveDbUrl();
    if (!url) return null;

    let pg;
    try {
      pg = await import('pg');
    } catch (err) {
      throw new Error(
        'AUDIT_DB_URL is set but the `pg` package is not installed. ' +
        'Run: npm install pg'
      );
    }
    const Pool = pg.default?.Pool || pg.Pool;
    const types = pg.default?.types || pg.types;
    if (!Pool || !types) {
      throw new Error('pg module shape unexpected — missing Pool or types export');
    }

    const cfg = buildPoolConfig(url, types);
    const pool = new Pool(cfg);

    // search_path is pinned via the connection startup `options` field in
    // buildPoolConfig — no per-checkout `SET` is needed (the connect-event
    // hook that used to do that was racy: see audit R1 H4 / H6).

    // Stop a transient socket error from crashing the process. Real query
    // errors are surfaced at the call site by query.mjs.
    pool.on('error', (err) => {
      process.stderr.write(`  [db/client] idle pool client error: ${err?.message || err}\n`);
    });

    _pool = pool;
    return _pool;
  })();

  try {
    return await _initPromise;
  } finally {
    _initPromise = null;
  }
}

/**
 * Drain + dispose the shared pool. Safe to call when no pool exists.
 * After this resolves, the next `getPool()` builds a fresh pool — so we
 * use it both for graceful shutdown and (with `_resetForTest`) test isolation.
 *
 * If an init is in-flight, we await it before draining so the pool it
 * builds can't outlive the close call (audit R2 M3). Failures inside the
 * pending init (e.g. legacy-only fail-fast) are swallowed here — that's
 * the in-flight caller's error to surface, not the closer's.
 */
export async function closePool() {
  if (_initPromise) {
    try { await _initPromise; } catch { /* init's error belongs to its caller */ }
  }
  const p = _pool;
  _pool = null;
  if (p) {
    try { await p.end(); } catch (err) {
      // pg's `Pool#end` rejects if called twice; we already nulled the ref
      // so a duplicate close is just a noisy no-op.
      process.stderr.write(`  [db/client] pool.end() error (ignored): ${err?.message || err}\n`);
    }
  }
}

/**
 * Test-only reset. Same observable behaviour as `closePool()`, but the
 * underscore signals "private — wired only into unit tests" the same way
 * `_internals` on file-io.mjs / shared.mjs already does.
 *
 * @returns {Promise<void>}
 */
export async function _resetForTest() {
  await closePool();
}
