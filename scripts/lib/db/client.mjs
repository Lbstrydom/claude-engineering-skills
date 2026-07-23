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
import { loadSharedEnv } from '../load-shared-env.mjs';

// ── pg type-parser OIDs (timestamps + dates → string, not Date) ────────────
// These are the canonical Postgres OIDs the `pg` driver receives for the
// three relevant column types. Centralised here so query.mjs and any future
// callers can reference the same constants instead of re-magic-numbering.
export const PG_OID_TIMESTAMPTZ = 1184;
export const PG_OID_TIMESTAMP   = 1114;
export const PG_OID_DATE        = 1082;
const STRING_OIDS = new Set([PG_OID_TIMESTAMPTZ, PG_OID_TIMESTAMP, PG_OID_DATE]);

// Accepted SSL modes (plan §2). `require` = strict verify; `no-verify` = TLS
// without cert verification (Supabase poolers' internal CA); `disable` = no TLS.
const VALID_SSL_MODES = new Set(['require', 'no-verify', 'disable']);
// Upper bound on AUDIT_DB_POOL_MAX — the audit-loop's chunked upserts never need
// more; a huge value usually signals a typo, not intent.
const MAX_POOL_SIZE = 50;

/**
 * Reject DSNs that are structurally invalid or use a forbidden connection mode.
 * Called once at pool init (getPool). Throws with an actionable message.
 *
 * The Supabase **Transaction pooler (port 6543)** is forbidden: it doesn't
 * preserve server-side prepared statements or the `options=-c search_path=public`
 * startup pin the db/ seam relies on (plan §2 R9 / postgres-parity). The check
 * is scoped to Supabase pooler hosts so a self-hosted Postgres on 6543 is
 * unaffected.
 *
 * @param {string} url
 */
export function assertSafeDsn(url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error('AUDIT_DB_URL is not a valid URL — expected a postgresql:// connection string.');
  }
  if (!/^postgres(ql)?:$/.test(parsed.protocol)) {
    throw new Error(
      `AUDIT_DB_URL must be a postgresql:// connection string; got protocol "${parsed.protocol}".`,
    );
  }
  if (parsed.port === '6543' && /(^|\.)pooler\.supabase\.com$/i.test(parsed.hostname)) {
    throw new Error(
      'AUDIT_DB_URL points at the Supabase Transaction pooler (port 6543), which does not ' +
      'preserve prepared statements or the search_path startup pin this store requires. ' +
      'Use the Session pooler (port 5432) — Supabase dashboard → Connect → Session pooler — ' +
      'or a Direct connection (plan §2 R9).',
    );
  }
}

/** Hostname suffixes that indicate a Supabase-hosted (never disposable) database. */
const HOSTED_SUPABASE_SUFFIXES = /(\.supabase\.co|\.supabase\.com)$/i;

/**
 * Is `hostname` the shared Supabase-hosted project (this repo's one and only
 * production database)? Shared predicate — reused by `assertDisposableDbUrl`
 * below (destructive-test-DB safety) and
 * `scripts/postgres-parity/generate-expected-schema.mjs` (fixture-ground-truth
 * safety: the committed schema fixture must reflect a vanilla self-hosted
 * Postgres — what postgres-parity CI actually verifies against — never the
 * Supabase platform layer's extra extensions/grants). Two independent
 * incidents needed the exact same "is this the shared prod host" check; this
 * is the single place it's defined.
 * @param {string} hostname
 * @returns {boolean}
 */
export function isHostedSupabaseHost(hostname) {
  return HOSTED_SUPABASE_SUFFIXES.test(hostname);
}

/**
 * Fail-closed guard for `AUDIT_DB_TEST_URL` before ANY destructive
 * integration-test operation (schema drop/recreate) runs against it.
 *
 * Root-caused incident (2026-07-14): `tests/db-setup.test.mjs` /
 * `tests/db-withtx.test.mjs`'s integration suites swap `AUDIT_DB_URL =
 * AUDIT_DB_TEST_URL` for their duration and then run `DROP SCHEMA public
 * CASCADE` in `beforeEach`. The only prior gate was "is AUDIT_DB_TEST_URL
 * SET" — never "is it actually disposable" — so when `AUDIT_DB_TEST_URL`
 * was set to (or resolved to the same database as) the real production
 * `AUDIT_DB_URL`, the suite wiped the shared Supabase learning store with
 * no warning. This closes that gap at the one place both suites' `before()`
 * hooks already call before touching the pool: reject a hosted Supabase URL
 * outright (a genuine disposable test DB is never Supabase-hosted in this
 * repo's design — it's a local/container Postgres), and reject a test URL
 * that's identical to the real `AUDIT_DB_URL` even if it isn't Supabase
 * (e.g. a self-hosted production instance).
 *
 * @param {string} testUrl - the candidate `AUDIT_DB_TEST_URL` value
 * @param {{productionUrl?: string|null}} [opts] - the real `AUDIT_DB_URL`
 *   (read BEFORE any swap), so an accidental copy-paste is caught even when
 *   it isn't Supabase-hosted.
 */
export function assertDisposableDbUrl(testUrl, { productionUrl = null } = {}) {
  let parsed;
  try {
    parsed = new URL(testUrl);
  } catch {
    throw new Error('AUDIT_DB_TEST_URL is not a valid URL — expected a postgresql:// connection string.');
  }
  if (isHostedSupabaseHost(parsed.hostname)) {
    throw new Error(
      `AUDIT_DB_TEST_URL points at a Supabase-hosted database (host "${parsed.hostname}") — ` +
      'refusing to run destructive integration tests against it. AUDIT_DB_TEST_URL must be a ' +
      'disposable local/container Postgres instance (e.g. 127.0.0.1), never a hosted Supabase ' +
      'project (this repo has exactly one Supabase project, and it is always production).',
    );
  }
  if (productionUrl && testUrl === productionUrl) {
    throw new Error(
      'AUDIT_DB_TEST_URL is identical to AUDIT_DB_URL — refusing to run destructive integration ' +
      'tests against what would be the same database as production.',
    );
  }
}

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
// Back-compat alias warnings — emitted at most once per (alias) per process.
const _aliasWarned = new Set();
function warnAliasOnce(alias, canonical) {
  if (_aliasWarned.has(alias)) return;
  _aliasWarned.add(alias);
  process.stderr.write(
    `  [db] ${alias} is a deprecated alias for ${canonical} — using it. ` +
    `Rename to ${canonical} to silence this notice.\n`,
  );
}

/** For tests — reset the alias-warning latch. */
export function _resetAliasWarnings() {
  _aliasWarned.clear();
}

export function resolveDbUrl() {
  // Guarantee the shared-env precondition at the single DSN reader: load the
  // shared `~/.audit-loop.env` layer here, so cloud connectivity no longer
  // depends on some entrypoint having imported config.mjs first. `includeCwd:
  // false` — the cwd `.env` is the entrypoint's job (every real CLI does
  // `import 'dotenv/config'`/config.mjs first); the bug was only the missing
  // shared layer. Sync + idempotent + latched → no-op after the first call.
  loadSharedEnv({ includeCwd: false });
  const canonical = (process.env.AUDIT_DB_URL || '').trim();
  const alias = (process.env.AUDIT_POSTGRES_URL || '').trim();
  // Canonical wins when both set; warn whenever the alias contributes.
  if (alias && !canonical) warnAliasOnce('AUDIT_POSTGRES_URL', 'AUDIT_DB_URL');
  const url = canonical || alias;
  if (url) return url;

  // §1.5 M4: AUDIT_STORE=postgres is a validation signal, not a silent no-op.
  // Asking for postgres without a DSN must fail fast, not degrade to local-only.
  if ((process.env.AUDIT_STORE || '').trim().toLowerCase() === 'postgres') {
    throw new Error(
      'AUDIT_STORE=postgres is set but no Postgres DSN is configured. ' +
      'Set AUDIT_DB_URL (or the legacy AUDIT_POSTGRES_URL alias) to your ' +
      'connection string, or unset AUDIT_STORE to use local-only mode.',
    );
  }

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
export function buildPoolConfig(url, pgTypes) {
  if (!process.env.AUDIT_DB_SSL_MODE && process.env.AUDIT_POSTGRES_SSL_MODE) {
    warnAliasOnce('AUDIT_POSTGRES_SSL_MODE', 'AUDIT_DB_SSL_MODE');
  }
  const sslMode = (process.env.AUDIT_DB_SSL_MODE || process.env.AUDIT_POSTGRES_SSL_MODE || 'require').trim();
  // Validate the SSL mode explicitly — an unknown value silently fell through to
  // strict `require`, masking a typo as a confusing TLS failure at connect time.
  if (!VALID_SSL_MODES.has(sslMode)) {
    throw new Error(
      `AUDIT_DB_SSL_MODE="${sslMode}" is invalid. Use one of: ` +
      `${[...VALID_SSL_MODES].join(' | ')}.`,
    );
  }
  // Validate pool size: a positive integer within a sane bound. The prior
  // `Number(... ) > 0` accepted fractional/huge values that `pg` mishandles.
  const rawMax = process.env.AUDIT_DB_POOL_MAX;
  let maxConns = 4;
  if (rawMax != null && String(rawMax).trim() !== '') {
    const n = Number(rawMax);
    if (!Number.isInteger(n) || n < 1 || n > MAX_POOL_SIZE) {
      throw new Error(
        `AUDIT_DB_POOL_MAX="${rawMax}" is invalid. Use a positive integer 1–${MAX_POOL_SIZE}.`,
      );
    }
    maxConns = n;
  }

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
    max: maxConns, // validated above (positive integer 1–MAX_POOL_SIZE)
    idleTimeoutMillis: 30000,
    // Let the process exit once all pooled connections are idle, instead of the
    // pool keeping the event loop alive for the full idleTimeoutMillis. We run
    // CLI-per-invocation (AGENTS.md "Accepted Technical Debt" — no long-lived
    // server), so a one-shot command (`recommend-skills`, `get-reachability-evidence`,
    // …) exits as soon as its queries finish instead of lingering ~30s. The test
    // runner keeps its own loop alive, so this never ends a suite early.
    allowExitOnIdle: true,
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
    // Load the shared-env layer BEFORE any env read in this init path
    // (assertPublicSchema reads AUDIT_DB_SCHEMA), so every getPool() env read
    // sees the same resolved layers. Idempotent + latched → resolveDbUrl()'s
    // own call below is a no-op.
    loadSharedEnv({ includeCwd: false });
    assertPublicSchema();
    const url = resolveDbUrl();
    if (!url) return null;
    assertSafeDsn(url); // reject forbidden/invalid DSNs (txn pooler 6543, non-postgres) before connecting

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
