# Plan: Phase G.2 — SQLite + Postgres Adapters + Shared Conformance

- **Date**: 2026-04-05
- **Status**: Draft (follows Phase G.1)
- **Author**: Claude + Louis
- **Parent**: [skill-bundle-mega-plan.md](./skill-bundle-mega-plan.md) / split from phase-g-storage-adapters
- **Depends on**: Phase G.1 complete (adapter interfaces, facade, noop + supabase shipped)
- **Scope**: Build SQLite (local cross-repo) + Postgres (generic cloud) adapters against the G.1 interfaces. Ship a **shared SQL adapter base** so both backends share schema + query code. Strengthen the conformance suite to enforce cross-adapter equivalence.

---

## 1. Context

Phase G.1 established the architecture: 5 split interfaces, facade, noop + supabase, dual API (legacy + envelope), conformance suite. G.2 slots two new adapters into that framework:

- **SQLite** (`stores/sqlite-store.mjs`): local file-based DB at `~/.audit-loop/shared.db`, enables cross-repo learning without any cloud. Target audience: individual developers, offline users, low-budget teams.
- **Postgres** (`stores/postgres-store.mjs`): generic Postgres (AWS RDS, Azure DB, Neon, Railway, self-hosted) for teams that want cloud persistence without committing to Supabase's platform-specific features. No dependency on `postgrest` or Supabase client — direct `pg` driver.

**Key design move**: extract a **`SqlAdapterBase`** that implements the full interface set against any SQL driver supporting a common query dialect. SQLite and Postgres adapters become thin wrappers over this base with driver-specific SQL emission + migration handling.

### Non-Goals

- GitHub adapter (Phase G.3)
- Databricks, MySQL, MSSQL, DynamoDB — reserved/deferred
- Cross-backend data migration tools
- Online schema migrations (both ship with versioned schema files, operators apply at install time)
- Connection pooling beyond what `better-sqlite3` and `pg` provide out of the box
- Row-level security enforcement at adapter level (Postgres operators configure their own RLS)
- Adapter-level encryption at rest (delegated to the SQL backend's native capabilities)

---

## 2. Proposed Architecture

### 2.1 Shared SQL Adapter Base (split by concern, fix G2-R1-M3)

The shared SQL logic is split into **one repository module per interface** that G.1 defined, composed by a factory. This preserves G.1's interface segregation — the shared SQL code doesn't become a god module:

```
scripts/lib/stores/sql/
├── factory.mjs          # createSqlAdapter(driver, opts) → composes repositories
├── sql-driver.mjs       # Driver/Executor type contracts
├── sql-dialect.mjs      # Dialect helpers: placeholder(), quoteIdent(), upsert builder
├── sql-errors.mjs       # normalizeError() shared across drivers
├── sql-migrations.mjs   # version check (NOT apply — that's the setup CLIs)
├── debt-repo.mjs        # implements DebtStoreInterface against Executor
├── run-repo.mjs         # implements RunStoreInterface
├── learning-repo.mjs    # implements LearningStateStoreInterface
├── global-repo.mjs      # implements GlobalStateStoreInterface
└── repo-repo.mjs        # implements RepoStoreInterface
```

**Factory composition**:
```javascript
export async function createSqlAdapter(driver, opts) {
  await assertSchemaVersion(driver, REQUIRED_VERSION);  // read-only check
  return {
    debt: createDebtRepo(driver),
    run: createRunRepo(driver),
    learningState: createLearningRepo(driver),
    globalState: createGlobalRepo(driver),
    repo: createRepoRepo(driver),
  };
}
```

Each `*-repo.mjs` module implements the full interface against the `Driver` / `Executor` contract. Dialect differences live in `sql-dialect.mjs`; error normalization in `sql-errors.mjs`; nothing else is shared.

**`scripts/lib/stores/sql/factory.mjs`** is the public entry point used by both SQLite + Postgres adapters:

```javascript
// Executor contract — tx-scoped or pool-scoped, both expose same methods
const Executor = {
  async query(sql, params) -> { rows: object[] },      // SELECT
  async exec(sql, params) -> { changes: number },      // INSERT/UPDATE/DELETE
};

// Driver contract — thin wrapper the base uses
const Driver = {
  // Pool-scoped executor methods (autocommit)
  async query(sql, params) -> { rows: object[] },
  async exec(sql, params) -> { changes: number },
  // Transaction: fn receives a tx-scoped Executor with the SAME query/exec API
  async withTransaction(fn: (tx: Executor) => Promise<T>) -> T,
  async close() -> void,
  dialect: 'sqlite' | 'postgres',
  // Placeholder generator: sqlite uses ?, postgres uses $1/$2/...
  placeholder: (n) -> string,
  // Canonical error mapping (see §2.10)
  normalizeError(nativeError, context) -> NormalizedStoreError,
};
```

**Transaction contract (fix G2-R1-H1, G2-R2-H1)**: shared repository methods are **single-statement-per-method** wherever possible, using CTEs or composable upserts to combine operations. No async callback is passed into `better-sqlite3.transaction()` — that's unsafe.

For the small set of operations that genuinely need multi-statement atomicity (outbox-replay batch insert, bulk debt upsert), the **driver exposes a dialect-native helper**:
- SQLite: `driver.batchSync(fn)` wraps `better-sqlite3.transaction()` around a **sync-only** callback that uses the same sync `db.prepare().run()` API. The base layer calls this helper with pre-built statement arrays; NO `await` inside.
- Postgres: `driver.batchAsync(fn)` acquires a pool connection, issues `BEGIN`/`COMMIT`, passes an async `Executor` to the callback.

The shared repo code that needs tx is written **twice** (once sync for SQLite, once async for Postgres) for those handful of batch operations. All single-statement methods are shared. This is a pragmatic trade-off: ~90% of query code shared, the tx-heavy batch helpers duplicated. No async-over-sync bridging.

Both adapters share:
- Table schemas (CREATE TABLE statements with dialect guards)
- All query bodies (WHERE clauses, JOINs, upserts)
- Conformance behavior (repo scoping, capability flags, error shapes)

Dialect differences handled via:
- `driver.placeholder(n)` for parameterized queries
- **Upsert emission (fix G2-R1-H2)**: BOTH dialects use `INSERT ... ON CONFLICT (<target>) DO UPDATE SET ...`. SQLite 3.24+ supports this (required version documented in §7). NEVER `INSERT OR REPLACE` — that does delete-then-insert, firing triggers + losing unset columns. Conflict targets + update sets are defined per-table in `sql-schema/upsert-map.json`
- JSON columns: SQLite uses `TEXT` + `json_extract()` for indexed reads; Postgres uses native `jsonb`
- Client-generated IDs per G.1 §2.5 (no `DEFAULT uuid_generate_v4()`)

**Conflict targets** per table (centralized):
| Table | Conflict target | Update columns |
|---|---|---|
| `repos` | `(fingerprint)` | `name`, `profile_json`, `updated_at` |
| `debt_entries` | `(repo_id, topic_id)` | `severity`, `details`, `payload_json`, `updated_at` |
| `debt_events` | `(idempotency_key)` | no-op on conflict (append-only) |
| `bandit_arms` | `(repo_id, arm_key)` | `alpha`, `beta`, `updated_at` |
| `false_positive_patterns` | `(repo_id, pattern_hash)` | `weight`, `dismissals`, `updated_at` |
| `audit_runs` | `(run_id)` | no-op on conflict (idempotent create) |
| `audit_findings` | `(run_id, finding_hash)` | no-op on conflict |
| `prompt_variants` | `(pass_name, variant_id)` | `text`, `updated_at` |

### 2.2 SQLite Adapter

**`scripts/lib/stores/sqlite-store.mjs`** (~200 LoC wrapper + driver):

```javascript
import Database from 'better-sqlite3';  // sync API, native bindings
import { createSqlAdapter } from './sql-adapter-base.mjs';

export async function createSqliteAdapter(config) {
  const dbPath = config.path ?? path.join(os.homedir(), '.audit-loop', 'shared.db');
  ensureDirSync(path.dirname(dbPath));
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');          // concurrent readers
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');         // avoid SQLITE_BUSY on brief contention

  const driver = {
    dialect: 'sqlite',
    placeholder: (_n) => '?',
    async query(sql, params) { return { rows: db.prepare(sql).all(...params) }; },
    async exec(sql, params) {
      const info = db.prepare(sql).run(...params);
      return { changes: info.changes };
    },
    async tx(fn) { return db.transaction(fn)(); },
    async close() { db.close(); },
  };

  const base = await createSqlAdapter(driver, { dialect: 'sqlite' });
  return {
    name: 'sqlite',
    capabilities: { debt: true, run: true, learningState: true, globalState: true, repo: true },
    scopeIsolation: true,
    ...base,
  };
}
```

**Config**:
- `AUDIT_STORE=sqlite` to select
- `AUDIT_SQLITE_PATH=<path>` to override default `~/.audit-loop/shared.db`
- `AUDIT_SQLITE_READONLY=1` opens the DB read-only (CI audit scenarios)

**Read-only mode semantics (fix G2-R1-M1)**:
- DB opened with `{ readonly: true, fileMustExist: true }` flags
- NO directory creation, NO WAL pragma, NO migration apply, NO schema version write
- If DB file is missing → fail fast with canonical misconfiguration error: "readonly mode requires existing DB; run setup-sqlite.mjs first"
- If schema version doesn't match → fail fast (can't migrate in read-only mode)
- All write-interface methods return `{ok: false, reason: 'misconfiguration'}` envelope with hint "adapter is read-only"
- Conformance suite has dedicated read-only subset (skips write tests, runs read-path tests)

**Cross-repo scope**: every `repos` row represents a distinct repo (repoId = G.1 fingerprint-derived). One developer's DB serves all their checkouts. Conformance `scopeIsolation` test passes.

**Why `better-sqlite3`**:
- Synchronous API → simpler transaction semantics + test determinism
- Native bindings → faster than `sqlite3` for write-heavy audit loops
- Prebuilt binaries for common platforms → no build-from-source pain
- Well-maintained, low-churn API

**Optional dep packaging**: `better-sqlite3` lives in `optionalDependencies` alongside `@supabase/supabase-js`. G.1's lazy-loading boundary (§2.9) applies.

### 2.3 Postgres Adapter

**`scripts/lib/stores/postgres-store.mjs`** (~200 LoC wrapper + driver):

```javascript
import pg from 'pg';
import { createSqlAdapter } from './sql-adapter-base.mjs';

export async function createPostgresAdapter(config) {
  const pool = new pg.Pool({
    connectionString: config.url,
    max: Number(config.maxConns ?? 4),
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 10000,
    ssl: config.sslMode === 'disable' ? false : { rejectUnauthorized: config.sslMode !== 'no-verify' },
  });

  const driver = {
    dialect: 'postgres',
    placeholder: (n) => `$${n}`,
    async query(sql, params) {
      const res = await pool.query(sql, params);
      return { rows: res.rows };
    },
    async exec(sql, params) {
      const res = await pool.query(sql, params);
      return { changes: res.rowCount ?? 0 };
    },
    async tx(fn) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const result = await fn(client);
        await client.query('COMMIT');
        return result;
      } catch (e) {
        await client.query('ROLLBACK');
        throw e;
      } finally {
        client.release();
      }
    },
    async close() { await pool.end(); },
  };

  const base = await createSqlAdapter(driver, { dialect: 'postgres' });
  return {
    name: 'postgres',
    capabilities: { debt: true, run: true, learningState: true, globalState: true, repo: true },
    scopeIsolation: true,
    ...base,
  };
}
```

**Config**:
- `AUDIT_STORE=postgres` to select
- `AUDIT_POSTGRES_URL=postgres://user:pass@host:5432/dbname` (required)
- `AUDIT_POSTGRES_SSL_MODE=require|disable|no-verify` (default `require`)
- `AUDIT_POSTGRES_MAX_CONNS=4` (default)
- `AUDIT_POSTGRES_SCHEMA=audit_loop` (default — setup CLI creates the schema; adapter only validates existence)

**Schema qualification (fix G2-R1-L2)**: identifier values are validated + quoted via a **single central utility** `quoteIdent()` in `sql-dialect.mjs`. Rule: identifiers must match `^[a-zA-Z_][a-zA-Z0-9_]{0,62}$` or config load rejects with fail-fast error. `quoteIdent()` wraps in double-quotes per SQL standard. All generated SQL (queries + migrations) uses `quoteIdent()` — no direct string interpolation of operator-supplied values.

**Optional dep**: `pg` lives in `optionalDependencies`.

### 2.4 Shared Schema + Migrations

**`scripts/lib/stores/sql-schema/`** holds canonical CREATE TABLE + index DDL:

```
sql-schema/
├── 001-core.sql          # repos, audit_runs, audit_findings, audit_pass_stats
├── 002-debt.sql          # debt_entries, debt_events
├── 003-learning.sql      # bandit_arms, false_positive_patterns
├── 004-global.sql        # prompt_variants, prompt_revisions, prompt_experiments
├── 005-adjudication.sql  # finding_adjudication_events, suppression_events
└── meta.json             # schema version + list of migrations
```

**Access-pattern index matrix (fix G2-R1-M4)** — every method's index requirement:

| Method | Query | Required index |
|---|---|---|
| `readDebtEntries(repoId)` | `WHERE repo_id = ?` | `debt_entries(repo_id)` |
| `removeDebtEntry(repoId, topicId)` | `WHERE repo_id = ? AND topic_id = ?` | UNIQUE `debt_entries(repo_id, topic_id)` (doubles as upsert conflict target) |
| `readDebtEvents(repoId, sinceTs)` | `WHERE repo_id = ? AND created_at >= ? ORDER BY created_at ASC` | `debt_events(repo_id, created_at)` composite |
| `appendDebtEvents` idempotency | `INSERT ... ON CONFLICT (idempotency_key)` | UNIQUE `debt_events(idempotency_key)` |
| `loadBanditArms(repoId)` | `WHERE repo_id = ?` | `bandit_arms(repo_id)` (PK already covers via `(repo_id, arm_key)`) |
| `loadFalsePositivePatterns(repoId)` | `WHERE repo_id IN (?, GLOBAL_REPO_ID)` | PK `(repo_id, pattern_hash)` covers |
| `recordFindings(runId,...)` | `INSERT ... ON CONFLICT (run_id, finding_hash)` | UNIQUE `audit_findings(run_id, finding_hash)` |
| `getRepoByFingerprint(fp)` | `WHERE fingerprint = ?` | UNIQUE `repos(fingerprint)` |
| `listGlobalPromptVariants()` | `WHERE pass_name = ? ORDER BY created_at DESC` | `prompt_variants(pass_name, created_at)` composite |

**Bounded-query rule**: every SELECT has either an indexed WHERE clause or a hard `LIMIT`. The conformance suite includes an EXPLAIN-based smoke test for hot queries on SQLite (`EXPLAIN QUERY PLAN`) + Postgres (`EXPLAIN (FORMAT JSON)`) asserting index use.

**Idempotency matrix (fix G2-R2-H3)** — every write method's retry behavior:

| Method | Idempotent by | Retry behavior |
|---|---|---|
| `upsertRepo(profile, name)` | `(fingerprint)` UNIQUE | Second call with same fingerprint updates row; no duplicate |
| `upsertDebtEntries(repoId, entries)` | `(repo_id, topic_id)` UNIQUE per row | Full batch safe to replay; conflict target handles duplicates |
| `removeDebtEntry(repoId, topicId)` | naturally idempotent (DELETE WHERE ...) | Second call affects 0 rows; harmless |
| `appendDebtEvents(repoId, events)` | `(idempotency_key)` UNIQUE per event | Caller MUST supply `idempotency_key` on each event; second call no-ops via `ON CONFLICT DO NOTHING` |
| `recordRunStart(runId, ...)` | `(run_id)` UNIQUE | Caller supplies client-generated `runId`; conflict no-ops |
| `recordRunComplete(runId, stats)` | `(run_id)` update | Second call overwrites; last-write-wins |
| `recordFindings(runId, findings)` | `(run_id, finding_hash)` UNIQUE | Duplicates no-op |
| `recordPassStats(runId, pass, stats)` | `(run_id, pass_name)` UNIQUE | Second call overwrites |
| `syncBanditArms(repoId, arms)` | `(repo_id, arm_key)` UNIQUE | Updates alpha/beta; no duplicates |
| `syncFalsePositivePatterns(repoId, p)` | `(repo_id, pattern_hash)` UNIQUE | Updates weights |
| `syncPromptRevision(pass, id, text)` | `(pass_name, variant_id)` UNIQUE | Updates text; last-write-wins |

**Caller responsibility**: methods that need caller-supplied idempotency keys (`appendDebtEvents`, `recordRunStart`) validate via Zod at the facade boundary and reject missing/non-string keys with validation error.

**Dialect templating**: SQL files use a small set of templating tokens:
- `{{JSONB}}` → `jsonb` (postgres) / `TEXT` (sqlite)
- `{{TIMESTAMPTZ}}` → `TIMESTAMPTZ` (postgres) / `TEXT` (sqlite, ISO-8601 UTC string)
- `{{UUID_PK}}` → `UUID PRIMARY KEY` (postgres) / `TEXT PRIMARY KEY` (sqlite)
- `{{NOW}}` → **REMOVED** — timestamps are application-generated, NOT DB-generated (fix G2-R2-H4)
- `{{SCHEMA}}` → `"audit_loop".` (postgres) / `` (sqlite)

Templating is compile-time (at adapter init) via simple string replacement. No external template engine.

**Migration ownership (fix G2-R1-H3)**: setup CLIs (`setup-sqlite.mjs`, `setup-postgres.mjs`) are the **sole owners** of DDL application. At runtime, adapters **verify** the schema version and exit with a canonical misconfiguration error if it doesn't match:

```
Error: AUDIT_STORE=postgres schema version is 3 but this adapter requires 5.
Run: node scripts/setup-postgres.mjs --migrate
```

Runtime adapters NEVER apply DDL automatically. This separates the privileged
operation (DDL) from the hot path (queries). Setup CLIs apply migrations in a
single transaction, record version in `schema_version.v` table.

**Schema version pinning**: downgrades are refused with a clear error. Forward migrations are always additive — never drop columns in the phase that adds them.

**Canonical timestamp policy (fix G2-R2-H4)**: all timestamps are **application-generated UTC ISO-8601 with millisecond precision**, computed via `new Date().toISOString()` at the facade boundary before INSERT. Storage columns are typed accordingly (`TEXT` in SQLite, `TIMESTAMPTZ` in Postgres — Postgres parses ISO-8601 into its native type, SQLite stores verbatim). No DB `CURRENT_TIMESTAMP` / `NOW()` calls anywhere; this eliminates precision/timezone divergence between the two backends and makes cross-adapter equivalence trivially deterministic. Conformance tests compare timestamps as equal strings (no normalization needed).

### 2.5 Conformance Suite Hardening

The G.1 conformance suite (tests/stores/conformance.mjs) gains cross-adapter equivalence tests:

| Test | Purpose |
|---|---|
| Roundtrip equivalence | Write the same entity via sqlite + postgres, read back, assert deep-equal shape |
| Scope isolation (adapters with `scopeIsolation: true`) | Insert rows for repoId=A and repoId=B, query by A, assert B's rows absent |
| Envelope contract | Every legacy method + envelope variant returns per §2.0 shape |
| Transient-failure envelope | Disconnect the driver mid-transaction, assert `{ok:false, reason:'transient'}` and outbox file created |
| Idempotency | Call `upsertDebtEntries` with the same idempotency key twice, assert second call is no-op |
| Schema-version validation | Init against pre-migrated DB, assert version check passes. Against wrong-version DB, assert fail-fast error. NO DDL-apply at runtime (setup-CLI tests cover migration replay) |
| Ordering | `readDebtEvents(repoId, sinceTs)` returns events in createdAt ASC |
| Transaction atomicity | Fail mid-tx, assert no partial writes |

**Test matrix**: every adapter with `scopeIsolation: true` (sqlite, postgres, supabase) runs every isolation + equivalence test. noop runs the reduced suite. G.3's github adapter will declare its own capability flags when that phase ships.

**SQLite in CI (fix G2-R1-M2)**:
- **`:memory:` DB** for unit tests (repositories, migration apply, error mapping) — fast, isolated
- **Temp-file DB** for WAL + concurrency tests: `fs.mkdtemp()` + `<tmp>/test.db`, real file-backed so WAL actually engages across handles
- WAL-specific tests: open 3 separate `better-sqlite3` handles to same file, verify reader sees committed writes, verify `busy_timeout` behavior under contention

**Postgres in CI**: runs an **ephemeral service container** (GitHub Actions `services: postgres:16-alpine`) for the core adapter suite as a REQUIRED CI gate. `POSTGRES_TEST_URL` remains as an escape hatch for local devs without Docker — they skip with clear output — but CI always runs the full Postgres suite.

### 2.6 Facade Registration

G.1's `stores/index.mjs` selection logic extends to accept new values:

```javascript
const VALID_ADAPTERS = ['noop', 'supabase', 'sqlite', 'postgres'];
```

`validateExplicitAdapter()` error messages list all valid values.
Auto-detect rules stay unchanged (Supabase env vars → supabase; no env → noop). No auto-detect for sqlite or postgres — they are always explicit-opt-in via `AUDIT_STORE`.

### 2.7 SQLite Concurrent-Access Model

Individual developers may have multiple audit runs in different repo checkouts accessing the same `~/.audit-loop/shared.db`. SQLite + WAL + `busy_timeout=5000` handles this for small teams (1-2 parallel runs). Document explicitly:

- **Supported**: concurrent readers, single-writer-at-a-time (WAL + busy_timeout handles brief contention)
- **Not supported**: high-concurrency multi-writer scenarios — operators needing that should use Postgres
- **Failure mode**: SQLITE_BUSY after 5s → surfaces as transient-failure envelope, buffers to outbox, replay on next invocation

### 2.8 Postgres Connection Handling

- **Pool size**: default 4; configurable via `AUDIT_POSTGRES_MAX_CONNS`
- **Connection timeout**: 10s; surfaces as transient-failure envelope if pool can't connect
- **Query timeout**: 30s per statement, configurable via `AUDIT_POSTGRES_STATEMENT_TIMEOUT_MS`. Applied by setting `statement_timeout` on every acquired connection via pool `options.query: SET statement_timeout = <ms>` in the pool's `options` parameter (Node `pg` supports this via startup option). Validated by a conformance test that runs an artificially-slow query and asserts `57014` statement-timeout error
- **Reconnect**: `pg.Pool` handles lost connections automatically; adapter doesn't re-implement

### 2.10 Canonical Error Normalization (fix G2-R1-H4)

Every adapter exposes `driver.normalizeError(nativeError, context)` returning:

```typescript
type NormalizedStoreError = {
  reason: 'transient' | 'misconfiguration' | 'validation' | 'integrity' | 'capability' | 'unknown',
  retryable: boolean,
  bufferToOutbox: boolean,   // true = retry via outbox on next run
  operatorHint: string,      // user-facing remediation guidance
  nativeCode?: string,       // original driver error code for debugging
};
```

**Canonical mapping** per backend:

| Native | reason | retryable | bufferToOutbox | hint |
|---|---|---|---|---|
| `SQLITE_BUSY` (5s timeout) | transient | yes | yes | "DB locked by another process; retrying next run" |
| `SQLITE_READONLY` | misconfiguration | no | no | "DB opened read-only; unset AUDIT_SQLITE_READONLY to write" |
| `SQLITE_CANTOPEN` | misconfiguration | no | no | "cannot open DB; check path + permissions" |
| `SQLITE_CORRUPT` | misconfiguration | no | no | "DB file corrupted; restore from backup" |
| missing `better-sqlite3` | misconfiguration | no | no | "run: npm install better-sqlite3" |
| pg `ECONNREFUSED` / `ETIMEDOUT` | transient | yes | yes | "Postgres unreachable; buffering writes" |
| pg `28P01` (auth) | misconfiguration | no | no | "Postgres auth failed; check AUDIT_POSTGRES_URL credentials" |
| pg `3D000` (db missing) | misconfiguration | no | no | "Postgres DB does not exist; create it" |
| pg `42P01` (table missing) | misconfiguration | no | no | "run: node scripts/setup-postgres.mjs --migrate" |
| pg `23505` (unique violation) | integrity | no | no | "idempotency conflict — safe to ignore on retry" |
| pg `40001` (serialization failure) | transient | yes | yes | "serialization conflict; retrying" |
| pg `57014` (statement_timeout) | transient | yes | yes | "query exceeded statement_timeout; investigate + retry" |
| pg pool-exhausted | transient | yes | yes | "connection pool exhausted; queueing" |
| unknown | unknown | no | no | "unexpected driver error; see logs" |

**Error surface at facade**: the facade's envelope API (G.1 §2.11) uses these
fields to fill `{ok, supported, reason, operatorHint}`. Legacy API unwraps
transient/integrity to empty-data (preserving pre-G.1 behavior) and throws
on misconfiguration (fail-fast).

**Read paths never buffer**: `bufferToOutbox: true` applies only to write
operations. Read failures surface immediately as transient envelope with
empty-data fallback.

### 2.9 Backward Compatibility

G.2 is purely additive. No existing adapter, caller, or test changes behavior:
- `AUDIT_STORE` gains new valid values (`sqlite`, `postgres`); unset still means auto-detect → supabase-or-noop
- `.env.example` documents new variables
- `package.json` adds `better-sqlite3` + `pg` as optional dependencies
- G.1 facade + interfaces unchanged

---

## 3. File Impact Summary

**New files**:

| File | Purpose |
|---|---|
| `scripts/lib/stores/sql/factory.mjs` | Composes per-interface repos into an adapter |
| `scripts/lib/stores/sql/sql-driver.mjs` | Driver/Executor type contracts |
| `scripts/lib/stores/sql/sql-dialect.mjs` | `placeholder()`, `quoteIdent()`, upsert builder, templating |
| `scripts/lib/stores/sql/sql-errors.mjs` | `normalizeError()` |
| `scripts/lib/stores/sql/sql-migrations.mjs` | Runtime schema-version verification (no apply) |
| `scripts/lib/stores/sql/debt-repo.mjs` | `DebtStoreInterface` against Executor |
| `scripts/lib/stores/sql/run-repo.mjs` | `RunStoreInterface` |
| `scripts/lib/stores/sql/learning-repo.mjs` | `LearningStateStoreInterface` |
| `scripts/lib/stores/sql/global-repo.mjs` | `GlobalStateStoreInterface` |
| `scripts/lib/stores/sql/repo-repo.mjs` | `RepoStoreInterface` |
| `scripts/lib/stores/sqlite-store.mjs` | SQLite driver + adapter factory (composes sql/) |
| `scripts/lib/stores/postgres-store.mjs` | Postgres driver + adapter factory (composes sql/) |
| `scripts/lib/stores/sql-schema/*.sql` | Canonical schema DDL (applied by setup CLIs only) |
| `scripts/lib/stores/sql-schema/meta.json` | Schema version manifest |
| `scripts/lib/stores/sql-schema/upsert-map.json` | Conflict targets + update columns per table |
| `scripts/setup-sqlite.mjs` | CLI: init `~/.audit-loop/shared.db`, apply schema |
| `scripts/setup-postgres.mjs` | CLI: validate connection, create schema, apply migrations |
| `tests/stores/sqlite-store.test.mjs` | SQLite-specific + conformance |
| `tests/stores/postgres-store.test.mjs` | Postgres-specific + conformance (gated by `POSTGRES_TEST_URL`) |
| `tests/stores/sql/*-repo.test.mjs` | Per-interface repo tests with mock Executor |
| `tests/stores/sql/sql-dialect.test.mjs` | Dialect helper + templating tests |
| `tests/stores/sql/sql-errors.test.mjs` | Error normalization tests |
| `tests/stores/conformance-cross-adapter.test.mjs` | Cross-adapter equivalence suite |

**Modified files**:

| File | Change |
|---|---|
| `scripts/lib/stores/index.mjs` | Add `sqlite` + `postgres` to `VALID_ADAPTERS`, loader branches |
| `scripts/lib/stores/conformance.mjs` | Parameterize on `scopeIsolation` flag, add new tests |
| `scripts/lib/stores/supabase-store.mjs` | Possibly refactor to share templating with new base (optional, only if free) |
| `package.json` | Add `better-sqlite3`, `pg` to `optionalDependencies` |
| `.env.example` | Document `AUDIT_SQLITE_PATH`, `AUDIT_POSTGRES_URL`, etc. |
| `.github/workflows/ci.yml` | Gate Postgres tests on `POSTGRES_TEST_URL` secret |

**NOT touched**:
- G.1 facade (`scripts/learning-store.mjs`) — signatures unchanged
- G.1 interfaces (`stores/interfaces.mjs`) — unchanged
- `supabase-store.mjs` — unchanged unless shared templating is cheap (deferrable)
- Phase D callers — already on the facade after G.1

---

## 4. Testing Strategy

### Unit tests (`tests/stores/sql-adapter-base.test.mjs`)

Mock driver (in-memory arrays simulating rows) verifies:
- Every interface method emits correct SQL for each dialect
- Placeholder generation is correct per dialect
- Upsert emission differs correctly per dialect
- Scope predicates (`WHERE repo_id = $1`) appear in every scoped query

### SQLite adapter tests (`tests/stores/sqlite-store.test.mjs`)

- In-memory DB per test (`:memory:`)
- Full conformance suite runs
- WAL mode verified via `pragma journal_mode`
- Concurrent-reader test: open 3 read handles, assert each sees committed writes
- SQLITE_BUSY simulation: wrap a write in a long transaction, assert second write surfaces as transient-failure

### Postgres adapter tests (`tests/stores/postgres-store.test.mjs`)

- Gated on `POSTGRES_TEST_URL`; skipped with clear output if unset
- Schema-qualified test: all generated queries validated against a real Postgres instance
- Transaction rollback test
- Connection-pool exhaustion test (fake): assert new queries queue + succeed once pool frees

### Cross-adapter equivalence (`tests/stores/conformance-cross-adapter.test.mjs`)

Write the same data through sqlite + postgres (+ supabase if env configured) + noop, read back, assert same observable shape (modulo timestamp precision + UUID format normalization).

### Integration (end-to-end)

Run `openai-audit.mjs code <plan>` with `AUDIT_STORE=sqlite`, complete an audit round, assert debt + bandit + runs persisted correctly.

---

## 5. Rollback Strategy

- **Revert G.2**: git revert adapter files + `stores/index.mjs` additions. After revert, `AUDIT_STORE=sqlite` or `=postgres` **fail-fast with clear error** listing valid values (per G.1 §2.1 — NO silent fallback). Operators must switch env var to `noop`, `supabase`, or unset it. No schema changes to existing DBs.
- **Per-user rollback**: set `AUDIT_STORE=noop` or remove the env var; SQLite/Postgres data remains on disk for recovery.
- **Partial migration**: if the Postgres adapter ships but fails in production, operators can `AUDIT_STORE=sqlite` or `=supabase` without data loss (different backend = independent store).

---

## 6. Implementation Order

1. **`sql/sql-dialect.mjs`** + **`sql/sql-errors.mjs`** + tests — dialect helpers, templating, error normalization.
2. **`sql-schema/*.sql`** + `upsert-map.json` — author canonical DDL, run via template through both dialects, verify parseable.
3. **`sql/sql-driver.mjs`** + **`sql/sql-migrations.mjs`** + per-interface `sql/*-repo.mjs` + mock-driver tests — interface methods, upsert emission, scope filters.
4. **`sql/factory.mjs`** — composes repos into an adapter.
5. **`sqlite-store.mjs`** + tests — real SQLite driver, conformance suite passes.
6. **`postgres-store.mjs`** + tests — real Postgres driver (ephemeral CI service container), conformance suite passes.
7. **`setup-sqlite.mjs`** + **`setup-postgres.mjs`** — operator-facing CLIs (DDL owners).
8. **`conformance-cross-adapter.test.mjs`** — matrix tests across all scoped adapters.
9. **`stores/index.mjs` + `.env.example` + `package.json`** — wiring.
10. **CI** runs Postgres service container by default; `POSTGRES_TEST_URL` env var is local-dev override.
11. **Integration test** with `AUDIT_STORE=sqlite`.
12. **Commit + push G.2.**

---

## 7. Known Limitations (accepted for G.2)

1. **SQLite concurrent-writer ceiling** — WAL + busy_timeout handles 1-2 parallel runs; high-concurrency multi-writer scenarios documented as unsupported. **Mitigation**: Postgres for teams that need it.
2. **Postgres SSL verification** — default `sslmode=require`, but operators can downgrade to `no-verify`. Documented risk.
3. **Native-binding install pain** — `better-sqlite3` requires native bindings; platforms without prebuilt binaries fall back to source build. **Mitigation**: optional dependency; if install fails, adapter selection errors with clear install guidance.
3a. **SQLite minimum version**: `ON CONFLICT ... DO UPDATE` requires SQLite ≥ 3.24 (Jun 2018). `better-sqlite3` bundles its own SQLite so this is guaranteed on supported Node versions. Init asserts `sqlite_version()` ≥ 3.24 and fails fast otherwise.
4. **No online migrations** — schema changes require operator-initiated `setup-{sqlite,postgres}.mjs` run. **Mitigation**: migrations are additive-only within G.2.
5. **JSON column portability** — **JSON blobs are opaque payloads only** (fix G2-R2-M4). Every field the audit-loop needs to query or index is promoted to a first-class column with its own index (see §2.4 access-pattern matrix). Queryable columns: `severity`, `topic_id`, `repo_id`, `created_at`, `principle`, `pass_name`, `variant_id`, `finding_hash`, `idempotency_key`, `run_id`, `arm_key`, `pattern_hash`. The `payload_json`/`details` columns hold data the adapter never filters on — consumers read the whole blob, parse it in JS. This eliminates dialect divergence and maintains the bounded-query guarantee.
6. **Test matrix cost** — running conformance against 4 adapters (noop, supabase, sqlite, postgres) slows CI. **Mitigation**: Postgres gated on env var; SQLite in-memory is fast (~50ms full suite).
7. **Timestamp precision** — SQLite stores ISO-8601 strings, Postgres stores TIMESTAMPTZ; both accept the same application-generated ISO-8601 input, so comparison is trivially string-equal.
8. **Duplicated tx-helper code (G2-R2-H1 residual)** — `better-sqlite3` is sync-only; `pg` is async. The small set of multi-statement batch operations (outbox replay + bulk upsert) is written twice, once per dialect. **Mitigation**: these are ~50 lines per dialect, tested identically via conformance suite. Alternative (async-capable SQLite driver like `@databases/sqlite-sync-to-async`) rejected for the native-binding simplicity of `better-sqlite3`.
9. **Residual DDL-ownership ambiguity for conformance (G2-R2-H2)** — conformance suite needs migrated DBs to run against, which means test setup invokes the setup CLI. This keeps the runtime-vs-setup split clean but adds a test-harness step. **Mitigation**: `tests/stores/helpers.mjs` exposes `createMigratedDb(dialect)` that calls the setup CLI programmatically — same entry point, no DDL duplication in tests.

---

## 8. Resolved Design Decisions

| # | Question | Decision | Why |
|---|---|---|---|
| Q1 | One adapter per backend or shared base? | **Shared `SqlAdapterBase`** with driver abstraction | Avoid copy-paste between sqlite + postgres; supabase may adopt base later |
| Q2 | SQLite driver choice? | **`better-sqlite3`** (sync, native) | Simpler tx semantics, faster, widely-prebuilt |
| Q3 | Postgres driver choice? | **`pg`** (pool-based, well-maintained) | Standard, no Supabase-specific assumptions |
| Q4 | SQLite default location? | **`~/.audit-loop/shared.db`** | Cross-repo by default, matches original Phase G intent |
| Q5 | Schema-per-adapter or shared DDL? | **Shared DDL with dialect templating** | One source of truth, easier evolution |
| Q6 | Online migrations? | **No — operator-run CLI** | Avoids runtime migration race conditions |
| Q7 | Test matrix — real Postgres in CI? | **Gated on `POSTGRES_TEST_URL`** | Local devs without Docker still run SQLite tests |
| Q8 | Concurrent writers on SQLite? | **Single-writer via WAL + busy_timeout** | Matches individual-developer use case |
| Q9 | Templating engine? | **Inline string-replace on `{{TOKEN}}`** | No external dep; tokens are small and bounded |
| Q10 | SQLite JSON queries? | **Read whole blob, filter in JS** | Cross-dialect portability wins over query pushdown |
