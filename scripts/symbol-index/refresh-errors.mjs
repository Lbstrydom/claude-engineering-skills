/**
 * @fileoverview Typed errors thrown by `refresh-repo-setup.mjs` / `refresh-lock.mjs`
 * and caught by `refresh.mjs`'s `main()` — the canonical, single home for
 * this contract so it exists in exactly one place rather than being
 * implicitly defined by whichever file happens to construct it first.
 *
 * Each class carries only a `message` (no extra fields — none of the three
 * original inline branches carried structured data beyond the log string)
 * and preserves the EXACT current message text verbatim. `main()`
 * distinguishes which happened by `instanceof`, not by an error code,
 * matching this file's existing convention for `throwVcsError`-shaped errors
 * elsewhere (those use `.code`/`.vcsCode` specifically because ONE generic
 * catch needs to branch on many VCS outcomes; these three each have exactly
 * one meaning and one `instanceof` check is simpler and equally sufficient).
 *
 * Extracted from `refresh.mjs` (docs/plans/tiered-pipeline-refresh-god-module-decomposition.md).
 *
 * @module scripts/symbol-index/refresh-errors
 */

/** Thrown when `upsertRepoByUuid` returns null — the repo could not be registered. */
export class RepoRegistrationError extends Error {}

/** Thrown when a refresh is already running for this repo and `--force` was not passed. */
export class RefreshInFlightError extends Error {}

/** Thrown when `--force`'s abort-and-retry attempt itself fails. */
export class LockAbortError extends Error {}

/**
 * Thrown when `runWithHeartbeat`'s AbortController signal fires — either
 * because a concurrent `--force` invocation aborted this run's row, or
 * because the heartbeat could not confirm `running` status for
 * `MAX_CONSECUTIVE_HEARTBEAT_FAILURES` consecutive ticks. `main()` treats
 * this as "stop early, do not publish" — the row itself may already be
 * `aborted` (the common case) or still `running` (the sustained-DB-outage
 * case), and the catch block's own `abortRefreshRun` call handles either.
 */
export class RefreshAbortedError extends Error {}
