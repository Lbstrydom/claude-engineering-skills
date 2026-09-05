/**
 * @fileoverview Repo-identity domain — audit_repos lookups + upserts.
 *
 * Part of the postgres-parity M3 domain-module split (plan §2
 * "Domain-module split", §7 P3). Translates the 6 repo-related
 * PostgREST calls in `scripts/learning-store.mjs` to raw SQL over the
 * new `db/` seam.
 *
 * The barrel in `scripts/learning-store.mjs` will re-export these
 * functions verbatim; signatures + return shapes match the legacy
 * supabase-js path byte-for-byte (audit-loop migration #18 — public
 * contract frozen).
 *
 * Graceful degradation (#16): every public function returns `null` (or
 * an equivalent neutral value) when `getPool()` returns null, mirroring
 * the legacy `if (!_supabase) return null` guard. NO_DB errors thrown
 * by the query helpers are caught and translated to the same neutral
 * return.
 *
 * @module scripts/lib/store/repo
 */

import { getPool, dbIdentity, classifyDbConnectionError, activeStoreDescriptor } from '../db/client.mjs';
import { one, insertReturning, updateWhere, many, pgArray } from '../db/query.mjs';
import { resolveRepoIdentity } from '../repo-identity.mjs';
import { _recordInitFailure, _clearInitFailure } from './client-state.mjs';

// ── Lifecycle helpers ──────────────────────────────────────────────────────

/**
 * Initialise the learning store. Under the old supabase-js path this
 * eagerly created the Supabase client; under the pg path this is just
 * a connectivity probe — the pool is lazy and getPool() builds it on
 * first use.
 *
 * Returns `true` if cloud mode is active (a pool was built + a SELECT 1
 * succeeded), `false` if cloud is disabled (no AUDIT_DB_URL) or the
 * probe failed.
 *
 * @returns {Promise<boolean>}
 */
export async function initLearningStore() {
  let pool;
  try {
    pool = await getPool();
  } catch (err) {
    // Feed the advisory cloud-state classifier (client-state.mjs) so a
    // configured-but-unreachable store stops reading identically to an
    // unconfigured one at the envelope layer. Advisory only — this function's
    // boolean contract and every caller of it are unchanged.
    _recordInitFailure(err);
    process.stderr.write(`  [learning] Cloud store init failed: ${err.message}\n`);
    return false;
  }
  if (!pool) {
    // Clear any failure recorded by an EARLIER in-process init call (finding
    // d5d1ccd9): "not configured" is a clean, deliberate state, not a
    // connectivity failure, and leaving a stale `_initFailure` standing here
    // would make `getCloudState()` answer 'unreachable' for a store nobody
    // is even trying to reach. A single real CLI invocation only ever calls
    // this once (so `_initFailure` starts null and this is a no-op there),
    // but the module-level singleton persists across multiple in-process
    // calls — e.g. a batch script that iterates repos/env states — where it
    // is not a no-op.
    _clearInitFailure();
    process.stderr.write(
      '  [learning] Cloud store not configured — using local mode.\n' +
      '             Run `npm run setup:cloud` from your claude-engineering-skills install to inherit shared config,\n' +
      '             OR set AUDIT_DB_URL in this repo\'s .env directly.\n'
    );
    return false;
  }
  // Connectivity probe — single SELECT against audit_repos so we surface
  // table-missing / auth errors at init time rather than at first real query.
  try {
    await pool.query('SELECT 1 FROM audit_repos LIMIT 1');
  } catch (err) {
    // Names the DATABASE and the CAUSE, not a vendor. This line used to read
    // "Supabase connection failed" for every failure — including a plain local
    // Postgres that was simply not running — which is how a consumer concluded
    // the store was Supabase-coupled when it has been provider-neutral since
    // the M4 postgres-parity migration. `dbIdentity` is credential-free by
    // construction, so the DSN's password cannot ride along.
    const where = dbIdentity(process.env.AUDIT_DB_URL || '') ?? 'the configured database';
    const { cause, hint } = classifyDbConnectionError(err);
    // `err.message` is EMPTY for pg's aggregate ECONNREFUSED — verified against
    // a dead endpoint, not assumed. That is why the old line rendered as
    // "Supabase connection failed: " with nothing after the colon: a vendor
    // name and no reason whatsoever. Appending it unconditionally would put a
    // whitespace-only line back in its place, so it is emitted only when it
    // actually says something.
    const raw = String(err?.message ?? '').trim();
    _recordInitFailure(err);
    process.stderr.write(
      `  [learning] Postgres store unavailable at ${where} (${cause})\n` +
      `             ${hint}\n` +
      (raw ? `             ${raw}\n` : '')
    );
    return false;
  }
  _clearInitFailure();
  process.stderr.write('  [learning] Cloud store connected\n');
  return true;
}

/**
 * Synchronous-feeling cloud-enabled check. Inside the legacy code this
 * was `_supabase !== null` — a sync read of module state. Under the pg
 * path it's an async pool-presence check.
 *
 * @returns {Promise<boolean>}
 */
export async function isCloudEnabled() {
  try {
    const pool = await getPool();
    return pool !== null;
  } catch {
    return false;
  }
}

/**
 * The publishable identity of the store this process would talk to — the
 * `storeDescriptor` shape (`{fingerprint, database, label}`), or `null` when no
 * DSN resolves (local mode) or it is unparseable.
 *
 * Exposed HERE, and re-exported through `learning-store.mjs`, so the reporting
 * CLIs can name their store without importing `db/client.mjs` directly.
 * `arch-memory` may depend on `learning-store` and `shared-lib`, not on
 * `stores` (`.audit-loop/domain-map.json`), and three CLIs reaching straight for
 * the client produced three `arch-memory -> stores` layering violations —
 * `tests/arm-vocabulary-layering.test.mjs` caught them at once. Routing through
 * the barrel they already import is the refactor half of AGENTS.md's
 * *refactor > retag > declare* preference order.
 *
 * Not async and never opens a pool: it answers "which store is this process
 * talking to", which a cloud-off run must also be able to answer (as `null`).
 * `activeStoreDescriptor` prefers the DSN the pool was OPENED with, so on the
 * reporting path — where `initLearningStore()` has already run — the answer is
 * bound to the client that ran the queries rather than re-derived from config
 * (plan-audit R1 H2).
 *
 * @returns {{fingerprint: string, database: string, label: string}|null}
 */
export function getActiveStoreDescriptor() {
  return activeStoreDescriptor();
}

// ── audit_repos CRUD ───────────────────────────────────────────────────────

/**
 * The `last_audited_at` write, in ONE place.
 *
 * Only a profile-bearing call is a real audit. A profile-less call is a pure id
 * lookup (cross-skill reads, /ship, persona-test) and must not touch the
 * column, or "last audited" degrades into "last touched" on every read
 * (Gemini-r2 finding). Spreading `{}` omits the column entirely.
 *
 * It is a helper rather than an inline ternary because the guard was applied to
 * `resolveRepoForStore`'s UPDATE branch and MISSED on its INSERT sibling — the
 * miss was invisible for as long as the column was `NOT NULL DEFAULT NOW()`,
 * since omitting it stamped the identical value. Migration
 * 20260731130000_audit_repos_last_audited_at_nullable.sql dropped both, so
 * omission now means NULL = "never audited"; routing every write through here
 * is what stops the two branches drifting apart again.
 *
 * @param {object|null|undefined} profile - generateRepoProfile() output, if any
 * @returns {{last_audited_at?: string}} column patch to spread into a write
 */
function auditStampCols(profile) {
  return profile ? { last_audited_at: new Date().toISOString() } : {};
}

/**
 * @deprecated Cluster A (§2.1): keys `audit_repos` on the VOLATILE content
 * `fingerprint`, which is what fragmented B1 (a new row per evolving-repo
 * audit). All live callers were migrated to `resolveRepoForStore()` (stable
 * `repo_uuid` identity). Retained only for the frozen public-export contract;
 * do NOT call from new code — it will re-introduce fragmentation, and the
 * `audit_repos`-fragmentation guardrail test will fail. Removal tracked as a
 * follow-up once the export contract can drop it.
 *
 * Upsert a repo profile keyed on `fingerprint`. Returns the row id, or
 * null when the store is disabled / the upsert fails.
 *
 * Legacy contract:
 *   - input: profile = { repoFingerprint, stack, fileBreakdown, focusAreas }, repoName
 *   - return: string (uuid) | null
 *   - on-conflict: 'fingerprint' DO UPDATE
 *
 * @param {object} profile - From generateRepoProfile()
 * @param {string} repoName - Human-readable repo name
 * @returns {Promise<string|null>} row id
 */
export async function upsertRepo(profile, _repoName) {
  // Deprecated path: DELEGATE to the stable repo_uuid resolver. This (a) stops
  // legacy callers re-fragmenting, and (b) survives the unify migration — the
  // old `onConflict: 'fingerprint'` upsert would now throw (the fingerprint
  // UNIQUE constraint was dropped). `repoName` is ignored: identity derives the
  // name. Return shape (id | null) is preserved for the frozen contract — but
  // the null is no longer SILENT for failures: collapsing a thrown lookup into
  // the same null as "cloud off" is the F7 class, and this shim was the last
  // caller-visible spot doing it. The contract stays null (its callers are
  // frozen); the stderr line makes the two nulls distinguishable to operators.
  const ref = await resolveRepoForStoreResult({ profile });
  if (ref.kind === 'error') {
    process.stderr.write(
      `  [learning] upsertRepo: repo identity lookup FAILED (${ref.error}) — returning null per the frozen `
      + 'contract, but this is a store failure, NOT an unconfigured store\n',
    );
    return null;
  }
  return ref.kind === 'resolved' ? ref.repoRowId : null;
}

/**
 * **Storage-identity contract (signal-recovery Cluster A, §2.1).** The single
 * seam the audit/plan/learning write path uses to resolve a STABLE repo row.
 *
 * `repo_uuid` (from `resolveRepoIdentity()`) is the stable logical identity —
 * the dedupe key. `audit_repos.id` is the storage FK that every child table's
 * `repo_id` column references. This returns `repoRowId` (= `audit_repos.id`) so
 * callers store THAT in child rows — NOT the raw `repo_uuid` (which would create
 * dangling FKs, R1-H1).
 *
 * Resolution is select-by-uuid → update-profile-or-insert (NOT `ON CONFLICT`):
 * the live `idx_audit_repos_repo_uuid` is a PARTIAL unique index whose predicate
 * the `upsert()` helper can't express (Gemini-G2), and after the unify migration
 * the `fingerprint` column is no longer unique (R2-H2), so a plain INSERT can't
 * collide. Profile telemetry (`stack`/`fileBreakdown`/`focusAreas`/`fingerprint`)
 * is preserved on both branches — switching the key from fingerprint to uuid must
 * not drop the data `upsertRepo` used to persist (Gemini-1).
 *
 * @param {object} [opts]
 * @param {string} [opts.cwd] - repo root to resolve identity from (default cwd)
 * @param {object} [opts.profile] - generateRepoProfile() output (optional)
 * **Null collapses three different facts** — store disabled, no row resolvable,
 * and a thrown DB error all return `null`. That is fine for a caller whose only
 * question is "do I have an id"; it is NOT fine for a caller about to WRITE,
 * because a transient failure then lands a permanently unscoped row that no
 * repo-scoped read will ever return. Those callers use
 * {@link resolveRepoForStoreResult} and fail closed on `kind:'error'`.
 *
 * @param {object} [opts]
 * @param {string} [opts.cwd] - repo root to resolve identity from (default cwd)
 * @param {object} [opts.profile] - generateRepoProfile() output (optional)
 * @returns {Promise<{repoRowId: string, repoUuid: string, name: string} | null>}
 *   null when the store is disabled, unresolvable, OR erroring.
 */
export async function resolveRepoForStore(opts = {}) {
  const r = await resolveRepoForStoreResult(opts);
  return r.kind === 'resolved'
    ? { repoRowId: r.repoRowId, repoUuid: r.repoUuid, name: r.name }
    : null;
}

/**
 * The discriminated form of {@link resolveRepoForStore} — same resolution, but
 * it says WHY it failed instead of collapsing every failure to `null`.
 *
 * This is the single implementation; `resolveRepoForStore` is a thin wrapper so
 * the ~50 existing call sites that only want an id keep their contract exactly.
 *
 * @param {object} [opts] - as {@link resolveRepoForStore}
 * @returns {Promise<
 *   | {kind:'resolved', repoRowId:string, repoUuid:string, name:string}
 *   | {kind:'cloud-off'}
 *   | {kind:'unresolved', repoUuid:string, name:string}
 *   | {kind:'error', error:string, repoUuid:string, name:string}>}
 */
export async function resolveRepoForStoreResult({ cwd, profile } = {}) {
  if (!await isCloudEnabled()) return { kind: 'cloud-off' };
  const { repoUuid, name } = resolveRepoIdentity(cwd);
  const profileCols = profile ? {
    stack:          profile.stack,
    file_breakdown: profile.fileBreakdown,
    focus_areas:    pgArray(profile.focusAreas),   // genuine text[] — not jsonb
    fingerprint:    profile.repoFingerprint,
  } : {};
  try {
    // 1. Existing canonical row → update profile, return its id.
    const existing = await one(
      `SELECT id FROM audit_repos WHERE repo_uuid = $1 LIMIT 1`,
      [repoUuid],
    );
    if (existing?.id) {
      // Only WRITE when a profile was supplied (a real audit). A profile-less
      // call is a pure id lookup (e.g. cross-skill reads) — it must NOT bump
      // last_audited_at or it would corrupt "last audited" into "last touched"
      // on every read (Gemini-r2 finding). See `auditStampCols`.
      if (profile) {
        try {
          await updateWhere(
            'audit_repos',
            { ...profileCols, name, ...auditStampCols(profile) },
            { id: existing.id },
          );
        } catch (e) {
          // Best-effort (identity already resolved) but don't swallow silently —
          // surface schema/permission/connectivity issues.
          process.stderr.write(`  [learning] resolveRepoForStore profile-refresh skipped: ${e.message}\n`);
        }
      }
      return { kind: 'resolved', repoRowId: existing.id, repoUuid, name };
    }
    // 2. No canonical row yet → plain INSERT (fingerprint no longer unique).
    //    Same guard as the UPDATE branch above: a profile-less call vivifying
    //    the row is still a read, so it leaves last_audited_at NULL.
    try {
      const row = await insertReturning(
        'audit_repos',
        {
          repo_uuid:       repoUuid,
          name,
          ...profileCols,
          ...auditStampCols(profile),
        },
        { returning: ['id'] },
      );
      if (row?.id) return { kind: 'resolved', repoRowId: row.id, repoUuid, name };
    } catch (insErr) {
      // Race: a concurrent process inserted the canonical row between our SELECT
      // and INSERT. The partial unique index on repo_uuid rejects the loser —
      // re-SELECT and return the winner's id rather than failing the audit.
      const raced = await one(`SELECT id FROM audit_repos WHERE repo_uuid = $1 LIMIT 1`, [repoUuid]).catch(() => null);
      if (raced?.id) return { kind: 'resolved', repoRowId: raced.id, repoUuid, name };
      throw insErr;
    }
    return { kind: 'unresolved', repoUuid, name };
  } catch (err) {
    process.stderr.write(`  [learning] resolveRepoForStore failed: ${err.message}\n`);
    return { kind: 'error', error: err.message, repoUuid, name };
  }
}

/**
 * Read a repo's identity + active-snapshot pointers by `repo_uuid`.
 *
 * Legacy contract:
 *   - input: repoUuid (string)
 *   - return: { id, name, activeRefreshId, activeEmbeddingModel, activeEmbeddingDim } | null
 *
 * @param {string} repoUuid
 */
export async function getRepoIdByUuid(repoUuid, { strict = false } = {}) {
  if (!await isCloudEnabled()) return null;
  try {
    const row = await one(
      `SELECT id, name, repo_uuid, active_refresh_id,
              active_embedding_model, active_embedding_dim
         FROM audit_repos
        WHERE repo_uuid = $1
        LIMIT 1`,
      [repoUuid]
    );
    if (!row) return null;
    return {
      id: row.id,
      name: row.name,
      activeRefreshId: row.active_refresh_id,
      activeEmbeddingModel: row.active_embedding_model,
      activeEmbeddingDim: row.active_embedding_dim,
    };
  } catch (err) {
    // A genuine "not found" already returned null INSIDE the try (`if (!row)`),
    // so reaching here is a REAL DB error (connection/permission/timeout) — NOT
    // an absent row. Default: swallow → null (read paths that fall back to the
    // repo name tolerate this). `strict`: re-throw so a WRITE caller can
    // fail-closed instead of silently downgrading an explicit-repo lookup to an
    // unscoped (`repo_id` null) write — the transient fail-open this guards.
    if (strict) throw err;
    return null;
  }
}

/**
 * Upsert a repo row keyed on `repo_uuid` (arch/symbol-index path). Two-step:
 * select-by-uuid → plain INSERT when absent. `repo_uuid` is the only identity
 * key (post-unify migration); `fingerprint` is a plain optional attribute.
 *
 * @param {{repoUuid: string, name: string, fingerprint?: string}} input
 * @returns {Promise<{id: string}|null>}
 */
export async function upsertRepoByUuid({ repoUuid, name, fingerprint }) {
  if (!await isCloudEnabled()) return null;
  try {
    // Step 1 — return early if a row with this repo_uuid already exists.
    const existing = await one(
      `SELECT id FROM audit_repos WHERE repo_uuid = $1 LIMIT 1`,
      [repoUuid]
    );
    if (existing?.id) return { id: existing.id };

    // Step 2 — plain INSERT. The fingerprint UNIQUE constraint was dropped by
    // the unify migration, so the old `onConflict: 'fingerprint'` upsert would
    // now throw. `fingerprint` is written as a plain attribute (nullable).
    //
    // `last_audited_at` is deliberately absent: NO caller of this function runs
    // an audit (arch:refresh, security:refresh, azure-doctor, cross-skill
    // plan-registration all just need a repo row), so there is no profile-
    // bearing case here and `auditStampCols` would always return `{}`. The row
    // is left NULL = "never audited" until a real audit resolves it.
    try {
      const row = await insertReturning(
        'audit_repos',
        { repo_uuid: repoUuid, name, fingerprint: fingerprint ?? null },
        { returning: ['id'] },
      );
      if (row?.id) return { id: row.id };
    } catch (insErr) {
      // Race: another process inserted this repo_uuid between SELECT and INSERT;
      // the partial unique index rejects the loser. Re-select the winner.
      const raced = await one(`SELECT id FROM audit_repos WHERE repo_uuid = $1 LIMIT 1`, [repoUuid]).catch(() => null);
      if (raced?.id) return { id: raced.id };
      throw insErr;
    }
    return null;
  } catch (err) {
    process.stderr.write(`  [arch] upsertRepoByUuid failed: ${err.message}\n`);
    return null;
  }
}

/**
 * Read the most recent repo id by human-readable name.
 *
 * Legacy contract:
 *   - input: repoName (string)
 *   - return: id (uuid) | null
 *   - ordering: created_at DESC LIMIT 1 (contract:created_at DESC LIMIT 1)
 *
 * @param {string} repoName
 * @returns {Promise<string|null>}
 */
export async function getRepoIdByName(repoName) {
  if (!repoName || !await isCloudEnabled()) return null;
  try {
    const row = await one(
      `SELECT id, created_at
         FROM audit_repos
        WHERE name = $1
        ORDER BY created_at DESC
        LIMIT 1`,
      [repoName]
    );
    return row?.id ?? null;
  } catch {
    return null;
  }
}

/**
 * List every audit_repos id — used by scripts/symbol-index/prune.mjs to
 * iterate per-repo for rollback-retention demotion.
 *
 * Plan §7 P3 — companion to the 6 raw-client-replacement exports.
 *
 * @returns {Promise<string[]>}
 */
export async function listRepoIds() {
  if (!await isCloudEnabled()) return [];
  try {
    const rows = await many(`SELECT id FROM audit_repos ORDER BY id`);
    return rows.map((r) => r.id);
  } catch (err) {
    process.stderr.write(`  [learning] listRepoIds failed: ${err.message}\n`);
    return [];
  }
}
