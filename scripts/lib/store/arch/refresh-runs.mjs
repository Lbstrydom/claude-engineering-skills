/**
 * @fileoverview refresh_runs lifecycle + retention helpers.
 *
 * Owns 10 exports from the original arch-memory.mjs:
 *   openRefreshRun, publishRefreshRun, abortRefreshRun, heartbeatRefreshRun,
 *   getRefreshRun, findStaleRunningRefresh, listPrunableRefreshRuns,
 *   deleteRefreshRuns, demoteRefreshRuns, listRollbacksForRepo
 *
 * GET_REFRESH_RUN_COLUMNS stays file-private (Gemini-r2-G1).
 *
 * Plan: docs/plans/sustainability-cleanup-batch.md (WS1).
 *
 * @module scripts/lib/store/arch/refresh-runs
 */

import crypto from 'node:crypto';
import { many, one, insertReturning, updateWhere } from '../../db/query.mjs';
import { getPool } from '../../db/client.mjs';
import { publishRefreshRun as rpcPublishRefreshRun } from '../../db/rpc.mjs';
import { isCloudEnabled } from '../repo.mjs';
import { describeSchemaFault } from '../../db/errors.mjs';

/**
 * Open a new refresh_run row. Holds the (repo_id, status='running')
 * unique lock until publishRefreshRun or abortRefreshRun resolves.
 *
 * Throws REFRESH_IN_FLIGHT on unique-constraint conflict (existing lock).
 */
export async function openRefreshRun({ repoId, mode, walkStartCommit, ownershipRuleEpoch = null }) {
  const cancellationToken = crypto.randomUUID();
  try {
    const data = await insertReturning('refresh_runs', {
      repo_id: repoId,
      mode,
      walk_start_commit: walkStartCommit || null,
      ownership_rule_epoch: ownershipRuleEpoch || null,
      cancellation_token: cancellationToken,
      last_heartbeat_at: new Date().toISOString(),
    }, { returning: ['id'] });
    return { refreshId: data.id, cancellationToken };
  } catch (err) {
    if (err._normalized?.nativeCode === '23505' || err.code === '23505') {
      const e = new Error('A refresh is already in flight for this repo. Pass --force to abort.');
      e.code = 'REFRESH_IN_FLIGHT';
      throw e;
    }
    throw err;
  }
}

/**
 * Atomic publish via the publish_refresh_run RPC (Gemini-R2 G1):
 * flips refresh_runs.status + audit_repos.active_refresh_id + active
 * embedding model/dim in one server-side transaction.
 */
export async function publishRefreshRun({ repoId, refreshId, activeEmbeddingModel, activeEmbeddingDim }) {
  try {
    return await rpcPublishRefreshRun({ repoId, refreshId, activeEmbeddingModel, activeEmbeddingDim });
  } catch (err) {
    throw new Error(`publish_refresh_run RPC failed: ${err.message}`, { cause: err });
  }
}

/**
 * Mark a refresh_run aborted — workers polling status see this and exit.
 *
 * Scoped by `(id, repo_id, status='running')` — the status predicate is
 * what makes concurrent abort/publish race-safe: a stale/late abort call
 * arriving after the run has already published is a 0-row no-op, never a
 * silent flip of an already-published run back to `aborted`. Paired with
 * `publishRefreshRun`'s own atomic RPC guard (rejects publishing a
 * non-`running` row), the two transitions are mutually exclusive at the
 * database layer regardless of any in-process signal's timing.
 *
 * Returns `{aborted: boolean}` (audit-code round-2 L1) rather than logging
 * directly to stderr and returning void — a store-layer persistence
 * function shouldn't own a CLI logging convention, and a caller silently
 * unable to see whether its abort actually landed can't report accurately
 * (this was a real bug in `refresh-lock.mjs`'s `--force` path, which
 * logged "aborted refresh_run X" unconditionally even on a 0-row no-op).
 */
export async function abortRefreshRun({ refreshId, repoId, reason }) {
  // Guarded by isCloudEnabled() like every sibling in this file (consolidated
  // final-gate shadow finding): without it, a cloud-disabled process reaching
  // this function would let updateWhere() throw instead of a graceful no-op
  // — heartbeatRefreshRun/getRefreshRun already degrade cleanly, this one
  // didn't. `{aborted: false}` is the honest answer (nothing exists to
  // abort when there is no store), distinct from heartbeatRefreshRun's
  // cloud-off `true` (a "never interferes with cancellation" contract
  // specific to that function, not a template for this one).
  if (!await isCloudEnabled()) return { aborted: false };
  try {
    const rows = await updateWhere('refresh_runs',
      {
        status: 'aborted',
        error: reason || null,
        completed_at: new Date().toISOString(),
        retention_class: 'aborted',
      },
      { id: refreshId, repo_id: repoId, status: 'running' },
      { returning: ['id'] }
    );
    return { aborted: rows.length > 0 };
  } catch (err) {
    throw new Error(`abortRefreshRun failed: ${err.message}`, { cause: err });
  }
}

/**
 * Touch heartbeat so --force can detect a live worker. Returns whether
 * the run is still `running` for this repo — a caller uses this as the
 * cancellation signal (a `false` means the run was force-aborted or
 * belongs to a different repo, and should stop).
 *
 * Guarded by `isCloudEnabled()` like every sibling in this file (shadow
 * final-gate finding) — without it, a cloud-disabled process reaching this
 * function would have `updateWhere` throw on every tick (no pool), and
 * `runWithHeartbeat`'s consecutive-failure counter would eventually
 * self-abort the whole pipeline over "no store configured", a
 * configuration state, not a liveness failure. Returns `true` (never
 * interferes) rather than `false` (which would read as "force-aborted")
 * when cloud is disabled — `main()` already exits before this pipeline
 * runs in that case, so this is a defensive/consistency guard, not a
 * currently-reachable path.
 *
 * @returns {Promise<boolean>}
 */
export async function heartbeatRefreshRun({ refreshId, repoId }) {
  if (!await isCloudEnabled()) return true;
  const rows = await updateWhere('refresh_runs',
    { last_heartbeat_at: new Date().toISOString() },
    { id: refreshId, repo_id: repoId, status: 'running' },
    { returning: ['id'] }
  );
  return rows.length > 0;
}

/**
 * Strict allowlist for getRefreshRun(refreshId, {select}). pg parameterises
 * VALUES but not identifiers, so column names are still string-interpolated
 * into the SELECT — without this gate, a caller string containing `"`
 * could escape the quoting and inject SQL.
 *
 * THIS SET MUST NAME ONLY COLUMNS THAT EXIST. It previously listed eight that
 * do not — `commit_sha`, `branch`, `plan_id`, `created_at`, `updated_at`,
 * `parent_run_id`, `rigor_pressure_round`, `round_converged_after` — which
 * inverted the gate's purpose for those names: instead of a clear
 * "unknown column" throw naming the caller's mistake, the request sailed
 * through and Postgres rejected the assembled statement with SQLSTATE 42703,
 * which `getRefreshRun`'s catch then rendered as `null` — indistinguishable
 * from "no such run". An allowlist that admits a phantom is worse than no
 * allowlist, because it converts a loud, local programmer error into a silent,
 * remote empty result.
 *
 * The list is verified mechanically against the committed schema fixture by
 * tests/refresh-runs-column-allowlist.test.mjs — when a migration adds or
 * drops a column here, that test is what tells you to update this set.
 *
 * FILE-PRIVATE — not exported (Gemini-r2-G1). `export *` in the arch-memory
 * barrel means any test seam here would widen the public store surface, and
 * tests/arch-memory-split.test.mjs asserts this name is NOT reachable through
 * it. The allowlist test therefore reads this literal from the source text
 * rather than importing it — one spelling of the list, still file-private.
 */
const GET_REFRESH_RUN_COLUMNS = new Set([
  'id', 'repo_id', 'mode', 'status',
  'walk_start_commit',
  'llm_calls', 'embed_calls', 'cancellation_token',
  'last_heartbeat_at', 'retention_class', 'error',
  'started_at', 'completed_at', 'import_graph_populated',
  // The ownership rule in force when this run walked. Checked against the
  // committed schema by tests/refresh-runs-column-allowlist.test.mjs, so a
  // migration landing without this entry fails rather than reading as absent.
  'ownership_rule_epoch',
]);

/**
 * Read a single refresh_run by id, scoped to the owning repo. `select` is
 * an optional column allowlist.
 *
 * @param {string} refreshId
 * @param {object} [opts]
 * @param {string} opts.repoId - required; the run must belong to this repo.
 * @param {string[]} [opts.select] - columns to project; MUST be from
 *   GET_REFRESH_RUN_COLUMNS. Unknown columns throw — no silent quoting.
 * @returns {Promise<object|null>}
 */
export async function getRefreshRun(refreshId, { repoId, select } = {}) {
  // Validate the `select` allowlist BEFORE checking cloud — invalid column
  // names are programmer errors that must surface deterministically, not
  // get silently masked by cloud-disabled fall-through.
  let cols;
  if (Array.isArray(select) && select.length > 0) {
    const bad = select.filter((c) => typeof c !== 'string' || !GET_REFRESH_RUN_COLUMNS.has(c));
    if (bad.length > 0) {
      throw new Error(`getRefreshRun: unknown column(s) ${JSON.stringify(bad)} — must be one of ${[...GET_REFRESH_RUN_COLUMNS].sort().join(', ')}`);
    }
    cols = select.join(', ');
  } else {
    cols = 'id, repo_id, mode, status, walk_start_commit, started_at, completed_at, retention_class, last_heartbeat_at, import_graph_populated';
  }
  // A missing refreshId/repoId is a call-site programmer error — surfaced
  // deterministically (Gemini final-gate round-2 finding), same treatment
  // as the unknown-column check just above and getImportGraphPopulated's
  // matching guard: a caller that forgot repoId must not be told "not
  // found" (indistinguishable from a real miss), it must be told it made
  // a mistake.
  if (!refreshId || !repoId) {
    throw new Error(`getRefreshRun: refreshId and repoId are both required (got refreshId=${JSON.stringify(refreshId)}, repoId=${JSON.stringify(repoId)})`);
  }
  if (!await isCloudEnabled()) return null;
  try {
    return await one(
      `SELECT ${cols} FROM refresh_runs WHERE id = $1 AND repo_id = $2 LIMIT 1`,
      [refreshId, repoId]
    );
  } catch (err) {
    // A schema fault here is NOT "no such run" — it means the assembled
    // statement can never succeed (a column in GET_REFRESH_RUN_COLUMNS that
    // the table lacks, exactly the defect the allowlist above documents).
    // Still degrades to null, but says so.
    const note = describeSchemaFault(err, 'getRefreshRun');
    if (note) process.stderr.write(note);
    return null;
  }
}

/**
 * Find the most-recent stuck-on-running refresh for a repo. Used by
 * `arch:refresh --force` to know which refresh to abort.
 */
export async function findStaleRunningRefresh(repoId) {
  if (!repoId || !await isCloudEnabled()) return null;
  try {
    return await one(
      `SELECT id, last_heartbeat_at, started_at
         FROM refresh_runs
        WHERE repo_id = $1 AND status = 'running'
        ORDER BY started_at DESC
        LIMIT 1`,
      [repoId]
    );
  } catch (err) {
    // null here reads as "no stale running refresh", which is what --force
    // checks before aborting. A schema fault must not quietly assert that.
    const note = describeSchemaFault(err, 'findStaleRunningRefresh');
    if (note) process.stderr.write(note);
    return null;
  }
}

/**
 * Return refresh_run ids eligible for pruning, given a filter
 * (`status` or `retention_class`) and a retention cutoff in days. Picks
 * up BOTH cleanly-finished runs (completed_at < cutoff) AND crashed runs
 * (completed_at IS NULL AND started_at < cutoff) — closing the
 * Gemini-G3 leak where crashed refreshes lived forever.
 *
 * GLOBAL BY DESIGN — no `repo_id` predicate. The audit-loop's prune
 * policy (status='aborted' >7d, retention_class='transient' >30d,
 * 'weekly_checkpoint' >90d) is uniform across ALL repos in the store.
 * The sole caller `scripts/symbol-index/prune.mjs` is a maintenance
 * script that runs the policy globally. Per-repo retention (e.g.
 * "keep last 4 rollbacks per repo") is handled separately in
 * `listRollbacksForRepo` which DOES take `repoId`. A static analyser
 * may flag this as a missing scope filter — it is not; do not "fix"
 * by adding `repo_id` without first proving the prune policy is
 * intended to be per-repo. See plan §2 "Snapshot retention".
 *
 * @param {{filterCol: 'status'|'retention_class', filterVal: string, retainDays: number}} args
 * @returns {Promise<string[]>}
 */
export async function listPrunableRefreshRuns({ filterCol, filterVal, retainDays }) {
  if (!await isCloudEnabled()) return [];
  // Whitelist the column so the SQL is safe even though it's interpolated.
  if (filterCol !== 'status' && filterCol !== 'retention_class') {
    throw new Error(`listPrunableRefreshRuns: filterCol must be 'status' or 'retention_class' — got ${filterCol}`);
  }
  const cutoffIso = new Date(Date.now() - retainDays * 86400_000).toISOString();
  try {
    const rows = await many(
      `SELECT id FROM refresh_runs
        WHERE "${filterCol}" = $1
          AND (
            completed_at < $2
            OR (completed_at IS NULL AND started_at < $2)
          )`,
      [filterVal, cutoffIso]
    );
    return rows.map((r) => r.id);
  } catch (err) {
    process.stderr.write(`  [arch] listPrunableRefreshRuns failed: ${err.message}\n`);
    return [];
  }
}

/**
 * Bulk delete refresh_runs by id list. Returns count actually deleted.
 */
export async function deleteRefreshRuns(ids) {
  if (!Array.isArray(ids) || ids.length === 0) return 0;
  if (!await isCloudEnabled()) return 0;
  try {
    const pool = await getPool();
    if (!pool) return 0;
    const res = await pool.query(
      `DELETE FROM refresh_runs WHERE id = ANY($1)`,
      [ids]
    );
    return res.rowCount ?? 0;
  } catch (err) {
    process.stderr.write(`  [arch] deleteRefreshRuns failed: ${err.message}\n`);
    return 0;
  }
}

/**
 * Bulk set retention_class for refresh_runs by id list. Used by the
 * rollback-keep-N demotion in scripts/symbol-index/prune.mjs.
 *
 * @param {string[]} ids
 * @param {'transient'|'weekly_checkpoint'|'rollback'|'aborted'} retentionClass
 * @returns {Promise<number>} rows affected
 */
export async function demoteRefreshRuns(ids, retentionClass) {
  if (!Array.isArray(ids) || ids.length === 0) return 0;
  if (!await isCloudEnabled()) return 0;
  try {
    const pool = await getPool();
    if (!pool) return 0;
    const res = await pool.query(
      `UPDATE refresh_runs SET retention_class = $1 WHERE id = ANY($2)`,
      [retentionClass, ids]
    );
    return res.rowCount ?? 0;
  } catch (err) {
    process.stderr.write(`  [arch] demoteRefreshRuns failed: ${err.message}\n`);
    return 0;
  }
}

/**
 * List rollback-class refresh_runs for a repo, ordered newest-first.
 * Powers the keep-last-N rollback retention in
 * scripts/symbol-index/prune.mjs.
 *
 * @param {string} repoId
 * @returns {Promise<Array<{id: string, completed_at: string|null}>>}
 */
export async function listRollbacksForRepo(repoId) {
  if (!repoId || !await isCloudEnabled()) return [];
  try {
    return await many(
      `SELECT id, completed_at FROM refresh_runs
        WHERE repo_id = $1 AND retention_class = 'rollback'
        ORDER BY completed_at DESC NULLS LAST`,
      [repoId]
    );
  } catch (err) {
    process.stderr.write(`  [arch] listRollbacksForRepo failed: ${err.message}\n`);
    return [];
  }
}
