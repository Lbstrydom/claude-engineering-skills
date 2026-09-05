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
import { createHash } from 'node:crypto';
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
/**
 * WHERE A DSN ACTUALLY CONNECTS — not where its URL appears to point.
 *
 * `pg` parses connection strings with `pg-connection-string`, which lets the
 * **query string override the authority**: `?host=` replaces the URL hostname
 * and `?port=` replaces the port. Every guard and identity function here used
 * to read `URL.hostname` / `URL.port` directly, which is the host the string
 * *displays*, not the host the driver *dials*. Measured 2026-09-04 against the
 * installed parser:
 *
 *   postgresql://localhost:5432/db?host=prod.example.com  → host prod.example.com
 *   postgresql://x.pooler.supabase.com:5432/db?port=6543  → port 6543
 *
 * Both defeat a guard that exists to prevent a specific disaster:
 *
 *  - `assertDisposableDbUrl` reads the hostname to decide whether a suite may
 *    `DROP SCHEMA public CASCADE`. The first DSN above passes as `localhost`
 *    and drops the schema on `prod.example.com`. The allowlist is documented as
 *    failing CLOSED; through this door it failed OPEN.
 *  - `assertSafeDsn` refuses the Supabase **transaction** pooler on port 6543
 *    because it breaks prepared statements and the `search_path` pin. The
 *    second DSN above reads as 5432 and connects to 6543.
 *  - `dbIdentity` / `storeFingerprint` name the store in reports and in the
 *    committed disposition ledger. A fingerprint keyed on the displayed host is
 *    a confident label for a database the process never talked to — the exact
 *    defect the drift-report store line was added to prevent.
 *
 * ONE oracle, so the guards and the label cannot disagree about which database
 * is meant.
 *
 * SCOPE, STATED HONESTLY. This resolves the two overrides the shipped parser
 * applies to a URL-form DSN. It is deliberately NOT a libpq reimplementation:
 * `PGHOST`/`PGPORT` and other environment defaults, `service=` files, and
 * comma-separated multi-host DSNs are not resolved here. Those reach a real
 * connection through `pg`'s own handling; a DSN using them will still be named
 * by its URL fields. Widening this means adopting libpq's full precedence
 * order, which is a bigger contract than any current caller needs — and a
 * half-done version that looked complete would be worse than one that says
 * where it stops.
 *
 * @param {URL} parsed a parsed DSN
 * @returns {{host: string, port: string, database: string}} effective target;
 *   `host` keeps its original case (callers normalise), `port` defaults to 5432
 */
export function effectiveDbTarget(parsed) {
  // LAST occurrence, not the first — `searchParams.get()` returns the first,
  // and the driver keeps the last. Verified against the installed parser:
  //
  //   ?host=first.example&host=last.example&port=1111&port=2222
  //     driver → host last.example, port 2222
  //     get()  → host first.example, port 1111
  //
  // Getting this backwards reopens the exact fail-open this function was added
  // to close, one layer down: `?host=127.0.0.1&host=prod.example.com` would read
  // as the disposable loopback host while connecting to prod. Caught by the
  // verification round on the fix itself — the author-mimicry case, where the
  // repair reproduces the class it repairs.
  // THE LAST OCCURRENCE VERBATIM — an empty one is not "skip to the previous",
  // it is "no override", and the driver then falls back to the URL authority.
  // Measured, because two rounds of this were settled by guessing at it:
  //
  //   ?host=real.example&host=   → driver dials the URL host, NOT real.example
  //   ?host=                     → driver dials the URL host
  //   ?port=2222&port=           → driver uses the URL port, NOT 2222
  //
  // An earlier version scanned backwards for the last NON-empty value, which
  // disagreed with the driver in the fail-OPEN direction:
  // `postgresql://prod.example/db?host=127.0.0.1&host=` resolved to the
  // disposable loopback host while the connection went to prod. Its regression
  // test asserted that behaviour, so the test pinned the defect rather than the
  // contract — which is why each round of this was decided by probing the
  // parser rather than by reasoning about it.
  const lastParam = (name) => {
    const all = parsed.searchParams.getAll(name);
    if (all.length === 0) return null;
    return (all[all.length - 1] || '').trim() || null;
  };
  const qHost = lastParam('host');
  const qPort = lastParam('port');

  // CANONICAL DECIMAL PORT. The query form is not normalised by anything —
  // `new URL` normalises the AUTHORITY (`:06543` → `6543`) but leaves
  // `?port=06543` exactly as written, and the parser passes it through. The
  // socket, however, connects by NUMBER. Measured:
  //
  //   ?port=06543  → parser '06543', connects to 6543
  //   ?port=+6543  → parser ' 6543'  (the + decodes to a space), connects to 6543
  //   ?port=6543␠  → parser '6543 ',  connects to 6543
  //   :06543       → parser '6543'   (URL already normalised it)
  //
  // Two consequences, both closed here rather than at each reader. The
  // transaction-pooler refusal compares against '6543' and every padded form
  // slipped past it. And `dbIdentity` gave one store several identities, so the
  // fingerprint this change publishes would differ between two runs that
  // reached the same database — the precise failure it exists to prevent.
  //
  // A value that is not a valid port is left VERBATIM: it cannot equal 6543, so
  // the guard still refuses correctly, and inventing a number for garbage would
  // hide a malformed DSN behind a plausible-looking identity.
  // `parseInt(v, 10)` — NOT `Number(v)` — because that is literally what the
  // driver does: `pg/lib/connection-parameters.js` reads
  // `this.port = parseInt(val('port', config), 10)`. The two disagree on inputs
  // that reach this code, and the disagreement is exploitable:
  //
  //   '6543abc' → Number NaN (left verbatim, guard compares unequal → ACCEPTED)
  //               parseInt 6543 (connects to the transaction pooler)
  //   '1e4'     → Number 10000, parseInt 1 — one store, two identities
  //   '0x1993'  → Number 6547, parseInt 0
  //
  // A guard that models the driver must use the driver's own coercion; picking
  // a "reasonable" one is how the fifth round's fix left a sixth hole. An input
  // that does not yield a valid port is left VERBATIM — it cannot equal '6543',
  // so the refusal still holds, and inventing a number for garbage would hide a
  // malformed DSN behind a plausible identity.
  const canonicalPort = (value) => {
    const n = parseInt(String(value), 10);
    return Number.isInteger(n) && n >= 1 && n <= 65535 ? String(n) : value;
  };

  return {
    host: qHost || parsed.hostname,
    port: canonicalPort(qPort || parsed.port || '5432'),
    // `?dbname=` is NOT an override. The final gate challenged this, claiming
    // `pg` falls back to `config.dbname` when `database` is empty; measured
    // against the real `ConnectionParameters` rather than reasoned about:
    //
    //   postgresql://h:5432/real?dbname=other  → database 'real'  (path wins)
    //   postgresql://h:5432/?dbname=other      → database 'User'  (NOT 'other')
    //
    // The empty-path case falls back to the OS USERNAME (`this.database =
    // this.user`), so `dbname` is genuinely unused and reading it here would
    // invent a behaviour. The claim stands — but the probe found a real gap it
    // did not name, recorded rather than mirrored:
    //
    // A DSN with no database path connects to a database named after whoever is
    // running the process. We return '' there, and deliberately DO NOT copy the
    // fallback: it would make this identity depend on `process.env.USER`, so two
    // machines would fingerprint one DSN differently — destroying the
    // cross-machine equality the fingerprint exists for. A pathless DSN is
    // therefore named as "no database", which is honest about what the string
    // says, and every DSN this store actually uses names one.
    database: decodeURIComponent(parsed.pathname.replace(/^\//, '')),
  };
}

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
  // EFFECTIVE host/port, not the displayed ones — `?port=6543` on a DSN whose
  // URL says 5432 reaches the transaction pooler this check exists to refuse.
  const target = effectiveDbTarget(parsed);
  if (target.port === '6543' && /(^|\.)pooler\.supabase\.com$/i.test(target.host)) {
    throw new Error(
      'AUDIT_DB_URL points at the Supabase Transaction pooler (port 6543), which does not ' +
      'preserve prepared statements or the search_path startup pin this store requires. ' +
      'Use the Session pooler (port 5432) — Supabase dashboard → Connect → Session pooler — ' +
      'or a Direct connection (plan §2 R9).',
    );
  }
}

/**
 * Loopback hostnames — the only place a throwaway Postgres lives in this
 * repo's design. `db-test-container.mjs` builds
 * `postgresql://postgres:postgres@127.0.0.1:<port>/postgres`, and
 * postgres-parity CI's service container is reached at `127.0.0.1:5432`.
 * Anything else is assumed to be somebody's real database.
 */
const LOOPBACK_DB_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

/**
 * Is `hostname` a disposable, throwaway database host?
 *
 * **This predicate is an ALLOWLIST and it fails CLOSED**: an unrecognised host
 * is treated as production. That direction is the whole point — it was an
 * allowlist's opposite that broke.
 *
 * History (2026-08-08). This started life as `isHostedSupabaseHost()`, a
 * DENYLIST matching `/(\.supabase\.co|\.supabase\.com)$/`, used by both callers
 * as a proxy for "not disposable". The proxy held only while the sentence in
 * its own docstring was true — *"this repo has exactly one Supabase project,
 * and it is always production"*. On 2026-08-08 the audit-loop store moved to a
 * self-hosted Postgres on a LAN address, and that sentence stopped being true:
 * production became a plain self-hosted Postgres, indistinguishable by hostname
 * from a local container. Both guards silently went inert against the very
 * database they exist to protect, on the same day the store moved.
 *
 * It bit immediately. The schema fixture was regenerated straight from the new
 * production store with no warning — the third occurrence of exactly the class
 * `generate-expected-schema.mjs`'s guard was written to refuse "rather than
 * relying on commit-message discipline a third time". It encoded 9
 * `ordinal_position` values that a fresh migration replay does not produce
 * (production had been provisioned by dump/restore, which renumbers `attnum`
 * past `DROP COLUMN` tombstones), and would have turned `db:suites:gate` red.
 * It was caught by reading an unexpected diff, which is not a control.
 *
 * A denylist of production hosts can only ever be as current as the last
 * infrastructure change. An allowlist of loopback hosts is a property of what
 * "disposable" MEANS, so it does not rot when the store moves again.
 *
 * Deliberately NO env-var escape hatch: a bypass on a guard whose whole job is
 * to stop `DROP SCHEMA public CASCADE` reaching production is the bypass that
 * gets used at 2am. A genuinely non-loopback disposable DB should be reached
 * through a port-forward, or this allowlist should be edited on purpose.
 *
 * @param {string} hostname - a parsed `URL.hostname` (IPv6 may carry brackets)
 * @returns {boolean} true only for known-throwaway hosts
 */
export function isDisposableDbHost(hostname) {
  if (typeof hostname !== 'string' || hostname === '') return false;
  const h = hostname.trim().toLowerCase();
  if (LOOPBACK_DB_HOSTS.has(h)) return true;
  // 127.0.0.0/8 is entirely loopback, not just 127.0.0.1.
  return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(h);
}

/**
 * Identity of the database a DSN addresses: host, port, database name — the
 * three things that decide WHICH database gets written to. Compared instead of
 * the raw DSN string because two different strings routinely name one database
 * (`?sslmode=disable` appended, a different user, `localhost` vs `127.0.0.1`,
 * an implicit vs explicit `:5432`). The old exact-string comparison missed
 * every one of those, which mattered the moment production stopped being
 * catchable by hostname.
 *
 * Exported since 2026-08-10 for operator-facing diagnostics as well as identity
 * comparison: it is the only DSN renderer in the codebase that is
 * credential-free BY CONSTRUCTION (it reads three fields and never touches
 * userinfo), so a message built from it cannot leak a password by omission the
 * way a regex-masked DSN can.
 *
 * @param {string} dsn
 * @returns {string|null} canonical `host:port/database`, or null if unparseable
 */
export function dbIdentity(dsn) {
  let u;
  try { u = new URL(dsn); } catch { return null; }
  // Effective target — a `?host=`/`?port=` override changes which database this
  // DSN names, so an identity built from the URL authority alone would label
  // two different stores identically (and one store two different ways).
  const target = effectiveDbTarget(u);
  const host = target.host.trim().toLowerCase();
  // localhost and 127.0.0.1 are the same server for this purpose.
  const canonHost = LOOPBACK_DB_HOSTS.has(host) || /^127\./.test(host) ? 'localhost' : host;
  return `${canonHost}:${target.port}/${target.database}`;
}

/**
 * A one-way fingerprint of the database a DSN addresses — `dbIdentity` hashed.
 *
 * **Why a hash and not the identity itself.** The identity is credential-free
 * but it is not IDENTITY-free: it is a hostname. The consumer-report
 * disposition ledger that consumes this is COMMITTED to a public GitHub repo,
 * and one of the consumers filing reports is a corporate repo whose store is
 * `<something>.postgres.database.azure.com` — an internal resource name that
 * has no business being published, and which was not previously tracked here.
 * The same rule the private-consumer registry follows (gitignored so a private
 * repo's NAME never lands in this repo) applies to its infrastructure.
 *
 * The only operation the reconciler performs on this value is EQUALITY, so a
 * digest satisfies it exactly. Nothing downstream needs to recover the host.
 *
 * WHAT IT DOES AND DOES NOT PROVIDE (corrected 2026-09-04, code-audit M6 —
 * this used to end "and nothing can", which overstates it). The digest is
 * unkeyed and deterministic over a LOW-ENTROPY input: `host:port/database`.
 * It resists nothing against a guessed candidate — anyone holding a list of
 * plausible hostnames can hash them and check for a match, and confirming a
 * guess is exactly the capability a published identifier should not hand out
 * cheaply. What it does provide is that the value carries no plaintext
 * locator: a reader who does not already have a candidate learns nothing, and
 * the string cannot be pasted into a connection attempt.
 *
 * That is the right trade for its actual job. A keyed HMAC would resist the
 * guessing attack and destroy the property the value exists for — two
 * independent processes, on different machines, must derive the SAME
 * fingerprint for one store, which a per-machine key makes impossible. So the
 * rule stands on scope, not on strength: publish the fingerprint, never
 * `dbIdentity`, and do not treat a fingerprint as a secret.
 *
 * 16 hex characters (64 bits): collision-irrelevant for a set of stores that
 * numbers in the single digits, and short enough to read in a report line.
 *
 * @param {string} dsn
 * @returns {string|null} 16 lowercase hex chars, or null if the DSN is unparseable
 */
export function storeFingerprint(dsn) {
  const identity = dbIdentity(dsn);
  if (!identity) return null;
  return createHash('sha256').update(identity).digest('hex').slice(0, 16);
}

/**
 * Classify a failed connection/probe into an actionable cause.
 *
 * WHY THIS EXISTS. The store is provider-neutral by construction — any
 * Postgres 13+ behind one `AUDIT_DB_URL`, with the sole provider-specific
 * branch being the narrow Supabase transaction-pooler refusal above. But the
 * probe reported every failure with one line that named Supabase, so a
 * consumer pointing at a plain local Postgres read "Supabase connection
 * failed", concluded the runtime was Supabase-coupled, and wrote an
 * eight-section proposal to make it vendor-neutral. It already was. The defect
 * was that the message could not tell you WHICH database it meant or WHY it
 * failed (upstream, 2026-08-10).
 *
 * The three classes below are the onboarding failures for a NEW provider —
 * wrong host, wrong TLS mode, un-migrated schema — which is exactly the moment
 * "point it at any Postgres you like" either works or silently doesn't. Each
 * carries the remedy rather than a code the reader has to look up.
 *
 * Deliberately NOT plumbed into a return value or a reason-code enum: every
 * caller today gates on a boolean cloud-on/off, so a structured result would be
 * an abstraction with no consumer. This shapes the message; that is the whole job.
 *
 * @param {{code?: string, message?: string}} err
 * @returns {{cause: string, hint: string}}
 */
export function classifyDbConnectionError(err) {
  const code = String(err?.code ?? '');
  const msg = String(err?.message ?? '');

  // Node socket-level failures — nothing answered at all.
  if (['ECONNREFUSED', 'ENOTFOUND', 'ETIMEDOUT', 'EHOSTUNREACH', 'ENETUNREACH', 'EAI_AGAIN'].includes(code)) {
    return {
      cause: 'unreachable',
      hint: 'nothing is listening there — start the server (or the container), or correct AUDIT_DB_URL',
    };
  }
  // TLS. The single most common failure when moving between providers: the
  // default mode is strict `require`, which a managed pooler's internal CA and
  // a self-signed self-hosted cert both fail. Naming the knob turns a stack of
  // OpenSSL text into a one-line fix.
  if (/^(SELF_SIGNED_CERT|DEPTH_ZERO_SELF_SIGNED|UNABLE_TO_VERIFY_LEAF)/.test(code)
      || /self[- ]signed certificate|unable to verify the first certificate|certificate/i.test(msg)) {
    return {
      cause: 'tls-rejected',
      hint: 'TLS verification failed — set AUDIT_DB_SSL_MODE to `no-verify` (managed poolers with an '
        + 'internal CA) or `disable` (plain local Postgres); `require` is the strict default',
    };
  }
  if (code === '28P01' || code === '28000') {
    return { cause: 'auth-failed', hint: 'the server rejected the credentials in AUDIT_DB_URL' };
  }
  if (code === '3D000') {
    return { cause: 'database-missing', hint: 'the server is up but has no such database — create it, then run `node scripts/setup-postgres.mjs --migrate`' };
  }
  // 42P01 undefined_table: reached the right database, but the audit-loop
  // schema was never installed. Distinct from every case above — the DSN is
  // correct and only the bootstrap step is missing.
  if (code === '42P01') {
    return { cause: 'schema-missing', hint: 'connected, but the audit-loop tables are absent — run `node scripts/setup-postgres.mjs --migrate`' };
  }
  return { cause: code || 'unknown', hint: 'see docs/runbooks/postgres-parity.md' };
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
 * hooks already call before touching the pool.
 *
 * Two independent checks, both fail-closed (2026-08-08 rewrite — see
 * `isDisposableDbHost`): the host must be on the loopback ALLOWLIST, and the
 * test URL must not name the same database as the real `AUDIT_DB_URL`. The
 * first used to be a Supabase denylist, which went inert when production moved
 * to self-hosted Postgres; the second used to be exact string equality, which
 * one appended `?sslmode=disable` defeats.
 *
 * @param {string} testUrl - the candidate `AUDIT_DB_TEST_URL` value
 * @param {{productionUrl?: string|null}} [opts] - the real `AUDIT_DB_URL`
 *   (read BEFORE any swap), so an accidental copy-paste is caught even when
 *   the host itself looks disposable.
 */
export function assertDisposableDbUrl(testUrl, { productionUrl = null } = {}) {
  let parsed;
  try {
    parsed = new URL(testUrl);
  } catch {
    throw new Error('AUDIT_DB_TEST_URL is not a valid URL — expected a postgresql:// connection string.');
  }
  // The host this DSN CONNECTS to, not the one it displays. Without this,
  // `postgresql://localhost/db?host=prod.example.com` passes the loopback
  // allowlist and the suite drops the schema on prod — the allowlist failing
  // OPEN through the one door it does not look at (2026-09-04).
  if (!isDisposableDbHost(effectiveDbTarget(parsed).host)) {
    throw new Error(
      // The host the check REFUSED, not the one the string displays. Reporting
      // `parsed.hostname` here would print `points at host "localhost"` for a
      // DSN rejected because `?host=` sends it to prod — a message that
      // contradicts its own decision and sends the reader hunting the wrong
      // thing (found by the full-scope census, not by the finding).
      `AUDIT_DB_TEST_URL points at host "${effectiveDbTarget(parsed).host}", which is not a recognised disposable ` +
      'database host — refusing to run destructive integration tests (they DROP SCHEMA public CASCADE) ' +
      'against it. AUDIT_DB_TEST_URL must be a throwaway local/container Postgres on loopback ' +
      '(127.0.0.0/8, localhost or ::1); `npm run db:local up` provisions one. This check is an ' +
      'allowlist and fails closed on purpose: an unrecognised host is assumed to be a real database.',
    );
  }
  const testId = dbIdentity(testUrl);
  const prodId = productionUrl ? dbIdentity(productionUrl) : null;
  if (testId && prodId && testId === prodId) {
    throw new Error(
      `AUDIT_DB_TEST_URL names the same database as AUDIT_DB_URL (${testId}) — refusing to run ` +
      'destructive integration tests against what would be production. Host, port and database name ' +
      'are compared, so differing credentials or query parameters do not make it a different database.',
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
  // false` — the cwd `.env` is the entrypoint's job (every real CLI imports
  // `lib/load-env.mjs`); the bug was only the missing shared layer. Sync +
  // idempotent + latched → no-op after the first call.
  //
  // That parenthetical used to read "`import 'dotenv/config'`/config.mjs", as
  // if the two were interchangeable. They are not — `dotenv/config` reads only
  // `${cwd}/.env` — and treating them as equal is what let 43 cwd-blind call
  // sites read as covered until 2026-08-15. See `lib/load-env.mjs`.
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
/** Latch so the store line is emitted once per process, not per getPool() call. */
let _announcedStore = null;
// The DSN `getPool()` opened, or null before any pool exists. Read by
// `activeStoreDescriptor` so a report names the store its queries reached.
let _activeDsn = null;

/**
 * Say WHICH store this process connected to, once, on stderr.
 *
 * WHY (2026-08-31, measured in a consumer). `getPool()` announced nothing, so a
 * process had no way to know which database it had reached — and an ad-hoc
 * script that imports `db/client.mjs` WITHOUT first importing `lib/load-env.mjs`
 * silently skips the repo's own `.env` and falls back to whatever
 * `~/.audit-loop.env` names. That is a different, real, populated database, so
 * the wrong-store read does not error: it returns rows, or zero rows, and looks
 * exactly like a correct answer.
 *
 * It cost a real false finding. A consumer session verifying the Azure
 * `finding_embeddings` backfill reported "storyline has zero rows" — measured
 * against a local Docker Postgres on `:5433` instead of the tenant store. It
 * only surfaced because the number contradicted another account and someone
 * checked `inet_server_addr()` by hand. Had it agreed, the wrong figure would
 * have been believed, and the remedy under discussion was a re-embed billed
 * against a corporate Azure tenant.
 *
 * FINGERPRINT, NEVER A HOSTNAME. AGENTS.md: a store is named to operators by
 * fingerprint plus the consumers using it, because this repo is public and one
 * consumer's store is corporate. `storeFingerprint` is a one-way digest of
 * host+port+database, so two processes on the same store print the same 16 hex
 * chars and two processes on different stores cannot print the same ones — which
 * is the entire question this line exists to answer. The database NAME is
 * included because it is the discriminator that would have caught the incident
 * at a glance (`audit_loop` vs `postgres`) and is not a locator.
 *
 * stderr, not stdout: every CLI here keeps stdout clean for JSON.
 *
 * @param {string} dsn
 */
function announceStore(dsn) {
  const desc = storeDescriptor(dsn);
  if (!desc || _announcedStore === desc.fingerprint) return;
  _announcedStore = desc.fingerprint;
  process.stderr.write(`  [db/client] store ${desc.label}\n`);
}

/**
 * The publishable identity of the store a DSN addresses, as ONE oracle.
 *
 * `announceStore` above prints this into the process log; the drift report and
 * the architecture-map header print it beside their verdict. There must be only
 * one formatter, because the whole property being asserted is that two surfaces
 * naming the same store produce the same string — a second spelling of "store
 * <fp> (db=<name>)" is a second thing that can drift.
 *
 * WHY IT ALSO BELONGS IN THE REPORTS (consumer report, 2026-09-04). `arch:drift`
 * printed `GREEN`, score 0, 0 duplication pairs for a repo that had measured 14
 * pairs an hour earlier, because the run had connected to a different database.
 * Nothing in the report said which one. The only evidence was this log line,
 * thousands of lines away in a different CI step — so distinguishing the two runs
 * meant noticing that an eight-hex digest had changed, across an hour and two
 * separate log files. Having more than one store reachable is a SUPPORTED
 * configuration (a repo `.env` and `~/.audit-loop.env` may name different
 * databases), so the ambiguity that creates has to be resolved in the output.
 *
 * FINGERPRINT, NEVER A HOSTNAME — the reporter asked for `host:port/database`,
 * and that is the one form this may not take. AGENTS.md: a store is named to
 * operators by fingerprint plus the consumers using it, because this repo is
 * public and one consumer's store is corporate. `dbIdentity` IS that hostname
 * and stays internal. The database NAME is included because it is the
 * discriminator that would have caught the incident at a glance (`audit_loop`
 * vs `postgres`) and is not a locator.
 *
 * @param {string|null|undefined} dsn
 * @returns {{fingerprint: string, database: string, label: string}|null}
 *   null when there is no DSN or it is unparseable — a caller must render that
 *   as "unknown", never as an absent line, or a local-mode run looks like a
 *   cloud run whose store nobody happened to mention.
 */
export function storeDescriptor(dsn) {
  const fingerprint = storeFingerprint(dsn);
  if (!fingerprint) return null;
  let database = 'unknown';
  // Same resolver the fingerprint is built from, so the label's two halves can
  // never describe different databases.
  try { database = effectiveDbTarget(new URL(dsn)).database || 'unknown'; } catch { /* keep 'unknown' */ }
  return { fingerprint, database, label: `${fingerprint} (db=${database})` };
}

/**
 * The descriptor for the store this process is actually talking to.
 *
 * Prefers the DSN `getPool()` OPENED (`_activeDsn`) over a fresh
 * `resolveDbUrl()`. Plan-audit R1 H2 named the shape: a descriptor resolved
 * apart from the client that ran the query is, structurally, a second answer to
 * a question that must have one — and this whole change exists so that a verdict
 * names the store it came from. Today the two cannot diverge in a single process
 * (env is stable; `getPool` caches), so this is not a bug fix; it removes the
 * possibility rather than relying on an invariant nothing states.
 *
 * Falls back to configuration when no pool has been opened — a caller may ask
 * before connecting, and `null` (no DSN at all) is the honest answer there.
 *
 * @returns {{fingerprint: string, database: string, label: string}|null}
 */
export function activeStoreDescriptor() {
  return storeDescriptor(_activeDsn ?? resolveDbUrl());
}

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
    // The DSN this pool was actually OPENED with, kept so a later report names
    // the store the queries went to rather than re-deriving one from config.
    // Plan-audit R1 H2: a descriptor resolved apart from the client that ran the
    // query can, in principle, describe a different store — the same
    // "resolved apart" shape AGENTS.md names for endpoint/credential pairs. In
    // one process the two cannot diverge today (env is stable and `getPool`
    // caches), but nothing asserted that, and the whole point of this change is
    // that a verdict names the store it came from.
    _activeDsn = url;
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

    announceStore(url);

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
  // Clear the store-announcement latch too, or a test that reconnects to a
  // DIFFERENT store gets silence — which is the exact blindness the line was
  // added to remove, reproduced inside the suite.
  _announcedStore = null;
  _activeDsn = null;
}
