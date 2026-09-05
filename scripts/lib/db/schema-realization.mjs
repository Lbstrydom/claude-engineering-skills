/**
 * @fileoverview Is this database MISSING a migration that this bundle ships?
 *
 * The runtime half of the green-but-unrealized fix. On 2026-07-31 a commit shipped a
 * migration plus the code depending on it, tests passed, it pushed — and the migration
 * was never applied, so the fix was byte-for-byte inert until a human ran `--migrate`.
 * Nothing anywhere connected "the code expects this schema" to "the database has it".
 *
 * **This answers ONE question, by filename identity.** A sibling question — do applied
 * migrations differ in CONTENT from source? — belongs to `setup-postgres --check-drift`
 * (sha256 per file) and runs at ship time. Deliberately not duplicated here: a count or a
 * second checksum implementation would be a weaker rival definition of "realized" sitting
 * beside the real one.
 *
 * | Question | Mechanism | Where |
 * |---|---|---|
 * | DB **missing** a bundled migration? | filename set difference (this module) | write path |
 * | Applied migrations **differ in content**? | `runCheckDrift` sha256 | ship time |
 *
 * Plan: docs/plans/green-but-unrealized.md (Cluster A, Phase 1).
 *
 * @module scripts/lib/db/schema-realization
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { effectiveDbTarget } from './client.mjs';

/** Thrown when the DB is provably missing migrations this bundle ships. */
export const ERR_SCHEMA_BEHIND = 'ERR_SCHEMA_BEHIND';

/**
 * The migrations directory, **per layout — not a candidate list**.
 *
 * `supabase/migrations/` in this source repo; `.audit-loop/migrations/` in a consumer
 * (`LAYOUT_CONSTANTS.MIGRATIONS_DEST_PREFIX`). Duplicated as literals rather than importing
 * sync-path-map, which is `install`-domain — this module is `shared-lib` and is imported by
 * the DB write path, so it must not drag the installer's dependency graph into every query.
 * The literals are pinned by a test that reads them FROM `sync-path-map`, so a rename there
 * fails here loudly rather than silently resolving to nothing.
 *
 * **These are two different databases' schemas, so first-existing-wins is not a fallback —
 * it is a coin flip.** An ordered candidate list was correct in exactly one place: this
 * repo, the only one where just one of them exists. Every consumer has BOTH —
 * `.audit-loop/migrations/` is the synced audit-loop schema that matches the ledger this
 * module reads, and `supabase/migrations/` is the consumer's OWN app schema, unrelated by
 * design. Picking by existence there compared a consumer's app migrations against the
 * audit-loop ledger, reported all of them permanently missing, and printed a remediation
 * (`setup-postgres --migrate`) that would apply the app's DDL — including its `DROP`s —
 * to the shared audit-loop store holding every repo's findings. Found in a consumer
 * before this shipped; see `docs/plans/green-but-unrealized.md`.
 */
export const MIGRATION_DIR_BY_LAYOUT = Object.freeze({
  source: 'supabase/migrations',
  consumer: '.audit-loop/migrations',
});

/** Consumer tooling lives here (`LAYOUT_CONSTANTS.CONSUMER_TOOLING_DIR`) — pinned by test. */
const CONSUMER_TOOLING_SEGMENT = 'scripts/.claude-skills/';

/**
 * Which layout is THIS file installed under?
 *
 * Read off the module's own path, which is the fact that *determines* the answer rather
 * than a proxy for it: the sync maps `scripts/<rest>` → `scripts/.claude-skills/<rest>`, so
 * a copy under that segment is by construction the synced audit-loop bundle and its
 * migrations are `.audit-loop/migrations/`. Probing the filesystem instead asks a question
 * whose two answers are both "yes" in a consumer.
 *
 * @param {string} [moduleFilePath] injectable so a test can assert both layouts without
 *   relocating the file — the failure is invisible in this repo, which is the only place
 *   the old ordering happened to be right, and that is exactly why it shipped.
 * @returns {'source'|'consumer'}
 */
export function detectLayout(moduleFilePath = fileURLToPath(import.meta.url)) {
  return String(moduleFilePath).replace(/\\/g, '/').includes(CONSUMER_TOOLING_SEGMENT)
    ? 'consumer'
    : 'source';
}

/**
 * Repo root, resolved from THIS file rather than `process.cwd()`.
 *
 * A cwd-relative answer would report "no migrations directory" — i.e. indeterminate, i.e.
 * ALLOW — from any subdirectory, and a guard that silently stops guarding when you `cd` is
 * the false green this module exists to remove.
 *
 * **Depth is layout-dependent**: `scripts/lib/db/` here, `scripts/.claude-skills/lib/db/`
 * in a consumer. A fixed three-up landed on `<consumer>/scripts`, where neither layout
 * exists — so the runtime write guard resolved `null` and allowed every write unchecked in
 * every consumer. Fail-open, therefore invisible: the second half of the same bug.
 */
export function defaultRepoRoot(layout = detectLayout()) {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const ups = layout === 'consumer' ? 4 : 3;
  return path.resolve(here, ...Array(ups).fill('..'));
}

/**
 * Resolve the migrations directory for a repo root, or null when this layout's does not exist.
 *
 * Null is **indeterminate**, not "zero missing" — a repo without its layout's migrations
 * directory has nothing to compare against, and claiming realized there would be exactly
 * the false green this module exists to prevent. It deliberately does NOT fall back to the
 * other layout's directory: that directory belongs to a different database.
 *
 * @param {string} [cwd]
 * @param {'source'|'consumer'} [layout]
 * @returns {string|null} absolute path, or null
 */
export function resolveMigrationsDir(cwd = defaultRepoRoot(), layout = detectLayout()) {
  const abs = path.resolve(cwd, MIGRATION_DIR_BY_LAYOUT[layout]);
  try {
    if (fs.statSync(abs).isDirectory()) return abs;
  } catch { /* absent ⇒ indeterminate */ }
  return null;
}

/**
 * The layout-correct remediation command.
 *
 * A consumer's runner is at `scripts/.claude-skills/setup-postgres.mjs`; printing this
 * repo's path there names a file that does not exist, which reads as "the tool is broken"
 * rather than "apply your migrations".
 */
export function setupPostgresCommand(layout = detectLayout()) {
  const script = layout === 'consumer'
    ? `${CONSUMER_TOOLING_SEGMENT}setup-postgres.mjs`
    : 'scripts/setup-postgres.mjs';
  return `node ${script} --migrate`;
}

/**
 * `host/database` for the pool, or null — **never** user or password.
 *
 * "The database" is ambiguous wherever an operator has two, and that ambiguity is what
 * makes a printed `--migrate` dangerous: it is only safe if the reader knows which DSN it
 * targets. Derived from the pool already in hand (no new import), URL-parsed so credentials
 * in the DSN cannot reach a log line, and null on anything unexpected.
 */
export function describeDatabase(pool) {
  try {
    const dsn = pool?.options?.connectionString;
    if (!dsn) return null;
    // Effective target, not the URL authority. This label exists so a reader
    // knows which DSN a printed `--migrate` would target — and `?host=`
    // overrides the hostname in the parser `pg` uses, so the displayed host is
    // exactly the wrong thing to answer that question with. Found by the
    // full-scope census behind code-audit R1 H1, in a file the finding never
    // cited.
    const { host, database } = effectiveDbTarget(new URL(dsn));
    return database ? `${host}/${database}` : host || null;
  } catch {
    return null;
  }
}

/**
 * Sorted `*.sql` filenames bundled on disk.
 *
 * Returns `null` — NOT `[]` — when the directory exists but cannot be read (permission
 * denied, transient mount failure, removed mid-run). Collapsing an I/O failure into an
 * empty list would make "we could not look" indistinguishable from "there is nothing to
 * apply", and the caller would then report a realized schema having compared against
 * nothing. `[]` means genuinely no `.sql` files; `null` means unknown.
 */
export function listBundledMigrations(dir) {
  if (!dir) return null;
  try {
    return fs.readdirSync(dir).filter((f) => f.endsWith('.sql')).sort();
  } catch {
    return null;
  }
}

/**
 * Stable digest of the bundled set — part of the cache key.
 *
 * Without it, `migrationsDir` is a static path string, so a long-running process that
 * gains a migration (a `git pull` mid-session) would keep serving a cached "realized".
 */
export function bundledDigest(filenames) {
  return crypto.createHash('sha256').update(JSON.stringify(filenames)).digest('hex').slice(0, 16);
}

/**
 * PURE set difference: which bundled migrations are absent from the ledger?
 *
 * Filenames, not a count (a count cannot establish identity — two databases can both have
 * "94 applied" and disagree about which 94). A ledger row with no bundled file is NOT
 * reported: that is a database ahead of this checkout, which is a legitimate state for a
 * consumer on an older bundle and is not this check's business.
 *
 * @param {string[]} bundled
 * @param {Set<string>|string[]} applied
 * @returns {string[]} bundled filenames absent from `applied`, sorted
 */
export function findUnappliedMigrations(bundled, applied) {
  const have = applied instanceof Set ? applied : new Set(applied || []);
  return (bundled || []).filter((f) => !have.has(f)).sort();
}

/** Applied migration filenames, or null when the ledger table does not exist. */
export async function readAppliedMigrations(pool) {
  const exists = await pool.query(`SELECT to_regclass('public.audit_loop_migrations') AS t`);
  if (!exists.rows[0]?.t) return null;           // pre-ledger DB — `--adopt` territory
  // Schema-QUALIFIED, matching the `to_regclass('public.…')` probe above. An unqualified
  // read can resolve a different relation than the one just proven to exist whenever
  // `search_path` is non-default — the existence check would pass on `public` while the
  // read silently returned another schema's table.
  const res = await pool.query(`SELECT filename FROM public.audit_loop_migrations`);
  return new Set(res.rows.map((r) => r.filename));
}

// ── Realization assertion ───────────────────────────────────────────────────

/**
 * Positive results only, keyed on `(pool, migrationsDir, bundledDigest)`.
 *
 * A `WeakMap` on the pool so a discarded pool's entry is collectable and a *different*
 * pool never inherits another's verdict — reachable in tests (`_resetForTest`) and in a
 * consumer sharing this repo's database.
 *
 * `indeterminate` and `behind` are deliberately NOT cached: caching indeterminate would let
 * one transient ledger failure permit every subsequent write, and caching behind would keep
 * refusing after the operator ran `--migrate`. Both are the cache asserting state that has
 * since changed.
 */
let _realizedCache = new WeakMap();

/** How long a verified result stays trusted. Bounds DB-side drift a key cannot see. */
export const REALIZATION_TTL_MS = 60_000;

/**
 * @internal test seam — genuinely clears the cache.
 *
 * The first version returned `true` and cleared nothing, on the reasoning that WeakMap has
 * no `clear()`. A reset helper that reports success while the next lookup on the SAME pool
 * still returns the stale verdict is the false-green shape this whole module exists to
 * remove, sitting inside the module itself. WeakMap has no `clear()`, so replace the map.
 */
export function _resetRealizationCache() {
  _realizedCache = new WeakMap();
  return true;
}

/**
 * Refuse an application write when the database provably lacks migrations we ship.
 *
 * **Failure direction is deliberate and asymmetric.** Only a *definitely behind* schema
 * throws. Every indeterminate state — no migrations directory, no ledger table, a
 * permission-denied or timed-out ledger query — ALLOWS the write with a one-time warning.
 * Refusing on unknown would let a single transient blip block every write in every
 * consumer, converting a degraded read into a total outage. That cuts against this repo's
 * usual freshness rule, and the asymmetry is the point: an unknown *schema* blocks nothing
 * and warns; an unknown *coverage verdict* claims nothing. Both refuse to lie; they differ
 * in which direction silence is dangerous.
 *
 * **`pool` is the cache identity; `executor` is what actually runs the query.** They differ
 * inside a transaction. The first version ran the ledger SELECT on a fresh pool connection,
 * which on a `max: 1` pool DEADLOCKS against the transaction already holding the only one —
 * and because the timeout is caught as "indeterminate", the guard then allowed the write
 * unchecked. So the guard silently stopped guarding, for every write inside a transaction,
 * while every unit test stayed green: this plan's own defect class, in this plan's own
 * mechanism, found by the integration tier. The cache still keys on the pool so a result
 * verified inside one transaction is reused outside it.
 *
 * @param {{pool: object, executor?: object, migrationsDir?: string|null, warn?: (msg: string) => void}} args
 * **`realized` is not the same claim as `verified`.** `realized:true, verified:false` means
 * "allowed, but nothing was actually compared" — the indeterminate states below. A caller
 * that needs to know whether the schema was really checked reads `verified`; conflating the
 * two would make an unchecked write indistinguishable from a checked one, which is this
 * plan's own failure mode.
 *
 * @returns {Promise<{realized: boolean, verified: boolean, reason: string}>}
 * @throws {Error} with `.code === ERR_SCHEMA_BEHIND` when migrations are missing
 */
export async function assertSchemaRealized({
  pool, executor, migrationsDir, warn = defaultWarn, now = Date.now,
}) {
  const allow = (reason) => ({ realized: true, verified: false, reason });

  if (!pool) return allow('no-pool');

  const dir = migrationsDir === undefined ? resolveMigrationsDir() : migrationsDir;
  if (!dir) return allow('no-migrations-dir');

  const bundled = listBundledMigrations(dir);
  // null = could not read the directory (see listBundledMigrations). Unknown, not empty.
  if (bundled === null) {
    warn(`[schema] migrations directory unreadable (${dir}) — allowing the write unchecked`);
    return allow('bundle-unreadable');
  }
  if (bundled.length === 0) return allow('no-migrations-dir');

  const key = `${dir}::${bundledDigest(bundled)}`;
  const hit = _realizedCache.get(pool);
  // TTL as well as key. The key catches a bundle that GAINED a migration; only elapsed
  // time catches a change on the DATABASE side (a rolled-back ledger, a restore, a second
  // operator). A verified-once-forever cache in a long-running agent loop would keep
  // asserting a state it last observed hours ago.
  if (hit && hit.key === key && (now() - hit.at) < REALIZATION_TTL_MS) {
    return { realized: true, verified: true, reason: 'cached' };
  }

  let applied;
  try {
    applied = await readAppliedMigrations(executor ?? pool);
  } catch (err) {
    // Genuinely unknown (permission denied, timeout, malformed). Allow + warn + do NOT
    // cache, so the next write re-checks once the condition clears.
    warn(`[schema] could not read the migration ledger (${err.message}) — allowing the write unchecked`);
    return allow('ledger-unreadable');
  }

  if (applied === null) {
    warn(`[schema] audit_loop_migrations is absent — pre-ledger database; run \`${setupPostgresCommand().replace('--migrate', '--adopt')}\``);
    return allow('no-ledger');
  }

  const missing = findUnappliedMigrations(bundled, applied);
  if (missing.length > 0) {
    // Name BOTH sides. The remediation applies DDL, so it is only safe to follow if the
    // reader can see which directory was compared against which database — an operator
    // with two of each reads an unqualified "the database" as whichever one they had in
    // mind. Naming them is what makes the printed command checkable.
    const db = describeDatabase(pool);
    const err = new Error(
      `${db ? `database ${db}` : 'database'} is behind this revision: ${missing.length} migration(s) `
      + `bundled in ${dir} but absent from public.audit_loop_migrations `
      + `(${missing.slice(0, 3).join(', ')}${missing.length > 3 ? `, +${missing.length - 3} more` : ''}). `
      + `Run: ${setupPostgresCommand()}`,
    );
    err.code = ERR_SCHEMA_BEHIND;
    err.missing = missing;
    throw err;
  }

  _realizedCache.set(pool, { key, at: now() });
  return { realized: true, verified: true, reason: 'verified' };
}

function defaultWarn(msg) {
  process.stderr.write(`  ${msg}\n`);
}

// ── Migration context ───────────────────────────────────────────────────────

import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * Async-scoped "we are applying migrations" flag.
 *
 * The migrator MUST be exempt from the realization guard, and not by verb classification.
 * An earlier design excluded DDL by verb and called that sufficient — it is not:
 * migrations routinely carry seed/backfill DML, and the migrator has to INSERT its own
 * `audit_loop_migrations` ledger row. Both are writes, both happen precisely while the
 * schema is behind, and both would be refused — deadlocking the only command that can
 * realize the database.
 *
 * Mirrors the `_txStore` / `getActiveTxClient()` pattern `_exec` already consults, so the
 * seam has one shape rather than two. Scoped to the apply path, not a global mutable flag:
 * a flag left set by a crashed run would silently disable the guard for the rest of the
 * process.
 */
const _migrationStore = new AsyncLocalStorage();

/** Run `fn` with the realization guard bypassed. Used ONLY by the migration apply path. */
export function withMigrationContext(fn) {
  return _migrationStore.run({ migrating: true }, fn);
}

/** True when executing inside `withMigrationContext`. */
export function isMigrationContext() {
  return _migrationStore.getStore()?.migrating === true;
}
