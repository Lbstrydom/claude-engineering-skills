/**
 * @fileoverview `ship_events` — the /ship outcome record.
 *
 * Split out of `plans-ship.mjs` (cross-skill-command-registry Phase 6). That
 * module is now a re-export barrel and remains the import name every consumer
 * uses; this file is where the ship-event domain actually lives.
 *
 * @module scripts/lib/store/ship-events
 */

import { isCloudEnabled } from './repo.mjs';
import { many, insertReturning } from '../db/query.mjs';
import { runWindowCountQuery } from './window-count-query.mjs';
// Single oracle for "is this string a plausible audit_repos row id" — the same
// UUID_RE campaign.mjs's CLI and bandit-fp.mjs's own writers already gate on.
// Reusing it here rather than re-deriving the regex is what keeps a typo'd or
// non-UUID repoId (a repo fingerprint hash, an empty string, a stray object)
// from being written straight through as `repo_id`.
import { isSyncableRepoId } from './bandit-fp.mjs';

// ── ship_events ────────────────────────────────────────────────────────────

/**
 * Record a /ship outcome.
 *
 * Returns a discriminated status for the same reason as
 * `recordRegressionSpecRun` (now `./regression-specs.mjs`) — it used to swallow
 * write errors and return `undefined` while its sole caller emitted an
 * unconditional `{ok:true}`.
 *
 * @returns {Promise<{ok:boolean, cloud:boolean, reason?:string, error?:string}>}
 */
export async function recordShipEvent(repoId, event) {
  if (!event?.outcome) return { ok: false, cloud: false, reason: 'missing-outcome' };
  // A provided-but-implausible repoId (a repo fingerprint hash, a typo, a
  // stray object) must be REFUSED, not silently written as-is or coerced to
  // null — `repo_id || null` used to accept anything truthy, so a caller
  // passing the wrong kind of id wrote garbage into a real FK column with no
  // signal that the write was scoped to nothing (or to the wrong repo, if the
  // string happened to collide). `repoId` being absent entirely is fine
  // (global/unscoped event); only a PRESENT-but-invalid value is refused.
  if (repoId != null && !isSyncableRepoId(repoId)) {
    return { ok: false, cloud: false, reason: 'invalid-repo-id', error: `recordShipEvent: repoId "${String(repoId)}" is not a valid audit_repos UUID` };
  }
  if (!await isCloudEnabled()) return { ok: true, cloud: false, reason: 'cloud-off' };
  try {
    await insertReturning('ship_events', {
      repo_id: repoId || null,
      commit_sha: event.commitSha || null,
      branch: event.branch || null,
      outcome: event.outcome,
      block_reasons: event.blockReasons || [], // jsonb — serialized by the db-layer seam
      open_p0_count: event.openP0Count || 0,
      open_p1_count: event.openP1Count || 0,
      missing_spec_count: event.missingSpecCount || 0,
      overridden_by_user: !!event.overriddenByUser,
      override_flag: event.overrideFlag || null,
      stack_detected: event.stackDetected || null,
      framework: event.framework || null,
      duration_ms: event.durationMs || null,
    });
    return { ok: true, cloud: true };
  } catch (err) {
    process.stderr.write(`  [learning] recordShipEvent failed: ${err.message}\n`);
    return { ok: false, cloud: true, reason: 'write-failed', error: err.message };
  }
}

/**
 * Read ship-event health for a repo (Cluster D / Phase 7 dashboard).
 * Returns per-outcome counts + the most recent events, or null when cloud is
 * off / the query fails. Repo-scoped (the caller resolves the canonical id).
 *
 * @param {string} repoId
 * @param {{limit?: number}} [opts]
 * @returns {Promise<{byOutcome: Array<{outcome:string,count:number}>, recent: object[]}|null>}
 */
export async function readShipEvents(repoId, { limit = 10 } = {}) {
  if (!repoId || !await isCloudEnabled()) return null;
  // Clamp before it reaches `LIMIT $2` (audit MED — d36ea2b0-adjacent finding
  // 57c819d9): `null`/`NaN`/omitted-but-falsy all collapse to the same
  // "unbounded history" read in Postgres (`LIMIT NULL` = no limit), and a huge
  // caller-supplied value reads the whole table. Same clamp shape
  // `resolveNudgePage` (ship-nudges.mjs) already uses for this reader's
  // siblings — this one predates that helper and never got it.
  const n = Number.isFinite(Number(limit)) && Number(limit) > 0
    ? Math.min(Math.floor(Number(limit)), 100)
    : 10;
  try {
    const byOutcome = await many(
      `SELECT outcome, count(*)::int AS count FROM ship_events
        WHERE repo_id = $1 GROUP BY outcome ORDER BY count DESC`,
      [repoId],
    );
    const recent = await many(
      `SELECT outcome, branch, commit_sha, overridden_by_user, created_at
         FROM ship_events WHERE repo_id = $1 ORDER BY created_at DESC LIMIT $2`,
      [repoId, n],
    );
    return { byOutcome, recent };
  } catch (err) {
    process.stderr.write(`  [learning] readShipEvents failed: ${err.message}\n`);
    return null;
  }
}

/**
 * Window-scoped row counts for the skill-efficacy census
 * (docs/plans/skill-efficacy-census.md Phase 2). Purpose-built rather than
 * reusing `readShipEvents` — that reader returns a bounded recent-events list
 * + an outcome breakdown, not an arbitrary current/prior timestamp-window
 * aggregate.
 *
 * @param {string} repoId
 * @param {{currentStart: string, priorStart: string, now: string}} bounds ISO timestamps
 * @returns {Promise<{current: number, prior: number, allTime: number}|null>}
 */
export async function getShipEventWindowCounts(repoId, { currentStart, priorStart, now }) {
  return runWindowCountQuery({
    repoGuard: repoId, table: 'ship_events',
    params: [repoId, currentStart, now, priorStart],
    errorLabel: 'getShipEventWindowCounts',
  });
}
