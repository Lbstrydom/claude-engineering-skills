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
 * prior-run abort when `--force` was passed and a refresh is already
 * in-flight. Returns `{ refreshId }` — `cancellationToken` is captured by the
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
export async function acquireRefreshLock({ repoId, mode, walkStartCommit, force, logOk, ownershipRuleEpoch = null }) {
  // ONE construction of the run row, shared by the first attempt and the
  // --force retry below.
  const open = () => openRefreshRun({ repoId, mode, walkStartCommit, ownershipRuleEpoch });
  try {
    // The epoch is stamped at OPEN, so the row records the rule this walk ran
    // under. Publishing is what makes it the active snapshot's epoch, so an
    // aborted run never advertises compatibility it did not establish.
    const opened = await open();
    return { refreshId: opened.refreshId };
  } catch (err) {
    const { action } = classifyLockOpenError(err, { force });
    if (action === 'exit-in-flight') {
      throw new RefreshInFlightError(err.message);
    }
    if (action === 'retry-with-abort') {
      // Abort the prior in-flight run, then retry openRefreshRun.
      // Partial-unique index on (repo_id, status='running') guarantees at
      // most one row to clear. The aborted worker's own heartbeat tick
      // observes this abort within one interval and calls its
      // AbortController — the tick's next `heartbeatRefreshRun` call
      // returns false (this row is no longer `running`), which is what
      // actually stops the in-flight worker's pipeline (not a status
      // poll inside this file).
      logOk(`--force: aborting prior in-flight refresh for repo ${repoId}`);
      try {
        const stale = await findStaleRunningRefresh(repoId);
        if (stale) {
          const { aborted } = await abortRefreshRun({ refreshId: stale.id, repoId, reason: 'aborted by --force' });
          logOk(aborted
            ? `--force: aborted refresh_run ${stale.id}`
            : `--force: refresh_run ${stale.id} was already terminal by the time abort ran — proceeding`);
        } else {
          logOk(`--force: no in-flight row found, retrying openRefreshRun`);
        }
      } catch (abortErr) {
        throw new LockAbortError(`--force: failed to abort prior run: ${abortErr.message}`);
      }
      // The SAME construction as the first attempt. Spelling the arguments out
      // twice is how `ownershipRuleEpoch` came to be present on the first open
      // and absent on the retry — so a `--force` refresh wrote a NULL epoch,
      // and the NEXT run read that as "unverified" and promoted to a full walk
      // it did not need. Every future field is added once, by construction.
      const opened = await open();
      return { refreshId: opened.refreshId };
    }
    throw err;
  }
}
