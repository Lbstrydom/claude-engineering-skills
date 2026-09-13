/**
 * @fileoverview Per-repo running-lock acquisition for `refresh.mjs`.
 *
 * Extracted from `refresh.mjs` (docs/plans/tiered-pipeline-refresh-god-module-decomposition.md).
 *
 * @module scripts/symbol-index/refresh-lock
 */

import * as vcs from '../lib/vcs.mjs';
import { openRefreshRun, findStaleRunningRefresh, abortRefreshRun } from '../learning-store.mjs';
import { RefreshInFlightError, LockAbortError } from './refresh-errors.mjs';

/**
 * How often a live refresh touches `refresh_runs.last_heartbeat_at`. Owned
 * here, next to the staleness budget derived from it, and imported by
 * `refresh.mjs` -- the two must not drift apart.
 */
export const HEARTBEAT_INTERVAL_MS = 15_000;

/**
 * A `running` row whose heartbeat is older than this is a crashed worker,
 * not a live one, and its lock is reclaimed without `--force`.
 *
 * Why the lock needed a clock (upstream report c048c9dc, 2026-09-13): the
 * per-repo lock is the partial-unique index on (repo_id, status='running'),
 * and the ONLY things that ever move a row off `running` are the worker's own
 * publish/abort. A worker that dies without reaching either -- SIGKILL, a
 * closed laptop, an OOM'd runner -- leaves the row `running` forever, and every
 * later `arch:refresh` exits 2 with "already in flight". Measured in this repo
 * 2026-07-20 (a killed dry run stranded the lock) and again by a consumer.
 * `--force` was the only remedy, and `--force` also kills a LIVE worker, so an
 * operator had to guess which case they were in.
 *
 * The heartbeat is a trustworthy liveness signal since WS-LIVE made the
 * pipeline async (`lib/subprocess.mjs`): a live worker ticks every
 * HEARTBEAT_INTERVAL_MS, and one that cannot reach the store self-aborts after
 * three missed ticks (~45s). Twenty intervals is therefore far outside anything
 * a live worker produces, while still short enough that a stranded lock costs
 * one wait rather than a human.
 */
export const HEARTBEAT_STALE_AFTER_MS = 20 * HEARTBEAT_INTERVAL_MS;

/**
 * Is the row currently holding the lock a live worker or a corpse?
 *
 * Pure. `last_heartbeat_at` is the signal; `started_at` stands in for a row
 * opened before heartbeats existed. A row with neither timestamp cannot be
 * shown to be alive, and the cost of a wrong "dead" verdict is bounded -- an
 * honest worker whose row is aborted under it sees `heartbeatRefreshRun`
 * return false on its next tick and stops, and `publish_refresh_run`'s
 * server-side guard refuses a publish from a non-`running` row regardless --
 * so the tie goes to reclaiming the lock.
 *
 * @param {{last_heartbeat_at?: string|null, started_at?: string|null}|null} holder
 * @param {{now?: Date, staleAfterMs?: number}} [opts]
 * @returns {{verdict: 'live'|'stale'|'absent', ageMs: number|null, signal: 'heartbeat'|'started_at'|'none'|null}}
 */
export function classifyHolderLiveness(holder, { now = new Date(), staleAfterMs = HEARTBEAT_STALE_AFTER_MS } = {}) {
  if (!holder) return { verdict: 'absent', ageMs: null, signal: null };
  const pick = (v) => {
    const t = v ? Date.parse(v) : NaN;
    return Number.isFinite(t) ? t : null;
  };
  const beat = pick(holder.last_heartbeat_at);
  const started = pick(holder.started_at);
  if (beat === null && started === null) return { verdict: 'stale', ageMs: null, signal: 'none' };
  const signal = beat !== null ? 'heartbeat' : 'started_at';
  const ageMs = Math.max(0, now.getTime() - (beat ?? started));
  return { verdict: ageMs > staleAfterMs ? 'stale' : 'live', ageMs, signal };
}

function describeAge(liveness) {
  if (liveness.ageMs === null) return 'no heartbeat and no start time recorded';
  const secs = Math.round(liveness.ageMs / 1000);
  const human = secs < 120 ? `${secs}s` : `${Math.round(secs / 60)}min`;
  return `${liveness.signal === 'heartbeat' ? 'last heartbeat' : 'started (no heartbeat recorded)'} ${human} ago`;
}

/**
 * `walkStartCommit` is informational — the snapshot can publish without it.
 * A `!result.ok` result is NOT fatal here (terminal failures like missing-git
 * or not-a-repo surface later when we try to read the diff). Empty repos
 * (no commits yet → BAD_REVISION) are also tolerated so a brand-new repo can
 * publish its first snapshot.
 *
 * @param {string} repoRoot
 * @returns {string|null}
 */
export function resolveWalkStartCommit(repoRoot) {
  const result = vcs.gitCommitSha(repoRoot);
  return result.ok ? result.sha : null;
}

/**
 * Pure classifier for the error `openRefreshRun` threw, given whether
 * `--force` was passed. Mirrors the current bare `if/else if/else` exactly,
 * with no I/O — deterministically unit-testable with constructed fake error
 * objects.
 *
 * @param {{code?: string}} err
 * @param {{force: boolean}} opts
 * @returns {{action: 'exit-in-flight'|'retry-with-abort'|'rethrow'}}
 */
export function classifyLockOpenError(err, { force }) {
  if (err.code === 'REFRESH_IN_FLIGHT' && !force) return { action: 'exit-in-flight' };
  if (err.code === 'REFRESH_IN_FLIGHT' && force) return { action: 'retry-with-abort' };
  return { action: 'rethrow' };
}

/**
 * Acquire the per-repo running lock (`openRefreshRun`), retrying once with a
 * prior-run abort when a refresh is already in-flight AND either `--force` was
 * passed or the holder's heartbeat is older than `HEARTBEAT_STALE_AFTER_MS`
 * (a crashed worker -- see that constant). A live holder without `--force`
 * is still an `exit-in-flight`, now with its heartbeat age in the message. Returns `{ refreshId }` — `cancellationToken` is captured by the
 * original inline code but never read anywhere in `refresh.mjs`, so it is
 * dropped from the return contract (dead state, not live functionality).
 *
 * Throws typed errors instead of calling `process.exit()` directly (same
 * library-module-should-not-terminate-the-process reasoning as
 * `refresh-repo-setup.mjs`): `RefreshInFlightError` on the exit-in-flight
 * classification, `LockAbortError` if the retry-with-abort path's own abort
 * attempt fails. `main()` catches each and performs the exact same
 * `logErr(...); process.exit(2)` behavior it does today for both cases. The
 * `rethrow` classification re-throws the original error unchanged.
 *
 * @param {{repoId: string, mode: string, walkStartCommit: string|null, force: boolean,
 *   logOk: (s: string) => void, ownershipRuleEpoch?: string|null}} args
 * @returns {Promise<{refreshId: string}>}
 */
export async function acquireRefreshLock({
  repoId, mode, walkStartCommit, force, logOk, ownershipRuleEpoch = null,
  // Injectable store seam (same shape as runWithHeartbeat's `beatFn`): the
  // reclaim SEQUENCE is the behaviour under test, and plain named ESM exports
  // offer no other observation point in this codebase.
  store = { open: openRefreshRun, findHolder: findStaleRunningRefresh, abort: abortRefreshRun },
  now = () => new Date(),
} = {}) {
  // ONE construction of the run row, shared by the first attempt and the
  // --force retry below.
  const open = () => store.open({ repoId, mode, walkStartCommit, ownershipRuleEpoch });
  try {
    // The epoch is stamped at OPEN, so the row records the rule this walk ran
    // under. Publishing is what makes it the active snapshot's epoch, so an
    // aborted run never advertises compatibility it did not establish.
    const opened = await open();
    return { refreshId: opened.refreshId };
  } catch (err) {
    let { action } = classifyLockOpenError(err, { force });
    if (action === 'rethrow') throw err;

    // Whoever holds the lock: read it ONCE, and decide live-vs-crashed from
    // its heartbeat. Before this, `exit-in-flight` fired on the mere existence
    // of a `running` row -- a crashed worker held the lock until a human
    // passed --force, and --force could not tell it from a live one.
    let holder = null;
    try {
      holder = await store.findHolder(repoId);
    } catch (lookupErr) {
      throw new LockAbortError(`could not read the in-flight refresh row: ${lookupErr.message}`);
    }
    const liveness = classifyHolderLiveness(holder, { now: now() });
    let reason = 'aborted by --force';

    if (action === 'exit-in-flight') {
      if (liveness.verdict === 'live') {
        throw new RefreshInFlightError(`${err.message} (refresh_run ${holder.id}: ${describeAge(liveness)} -- a live worker; `
          + '--force would kill it)');
      }
      if (liveness.verdict === 'stale') {
        logOk(`reclaiming the per-repo lock: refresh_run ${holder.id} is still marked running but its `
          + `${describeAge(liveness)} (budget ${Math.round(HEARTBEAT_STALE_AFTER_MS / 1000)}s) -- the worker crashed without aborting`);
        reason = `heartbeat stale (${describeAge(liveness)}) -- worker presumed crashed; lock reclaimed by a later refresh`;
      } else {
        // `absent`: the lock cleared between our insert and the lookup. One retry.
        logOk('the in-flight refresh finished while we looked -- retrying openRefreshRun');
      }
      action = 'retry-with-abort';
    } else {
      // --force: the operator asked for the abort whatever the holder's state.
      // Say which state that was, so killing a live worker is a known act.
      logOk(`--force: aborting prior in-flight refresh for repo ${repoId}`
        + (holder ? ` (refresh_run ${holder.id}: ${describeAge(liveness)})` : ''));
    }

    if (action === 'retry-with-abort') {
      // Abort the prior in-flight run, then retry openRefreshRun.
      // Partial-unique index on (repo_id, status='running') guarantees at
      // most one row to clear. If the holder is in fact alive, its own
      // heartbeat tick observes this abort within one interval and calls its
      // AbortController — the tick's next `heartbeatRefreshRun` call
      // returns false (this row is no longer `running`), which is what
      // actually stops the in-flight worker's pipeline (not a status
      // poll inside this file).
      try {
        if (holder) {
          const { aborted } = await store.abort({ refreshId: holder.id, repoId, reason });
          logOk(aborted
            ? `aborted refresh_run ${holder.id}`
            : `refresh_run ${holder.id} was already terminal by the time abort ran — proceeding`);
        }
      } catch (abortErr) {
        throw new LockAbortError(`failed to abort prior run: ${abortErr.message}`);
      }
      // The SAME construction as the first attempt. Spelling the arguments out
      // twice is how `ownershipRuleEpoch` came to be present on the first open
      // and absent on the retry — so a `--force` refresh wrote a NULL epoch,
      // and the NEXT run read that as "unverified" and promoted to a full walk
      // it did not need. Every future field is added once, by construction.
      // A second 23505 here means another worker won the lock in the gap --
      // that one is live by construction (it just opened), so surface it.
      try {
        const opened = await open();
        return { refreshId: opened.refreshId };
      } catch (retryErr) {
        if (retryErr.code === 'REFRESH_IN_FLIGHT') {
          throw new RefreshInFlightError(`${retryErr.message} (another refresh took the lock while this one was reclaiming it)`);
        }
        throw retryErr;
      }
    }
    throw err;
  }
}
