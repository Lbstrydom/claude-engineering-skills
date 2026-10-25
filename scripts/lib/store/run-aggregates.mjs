/**
 * @fileoverview Run-level aggregates written to `audit_runs` after the row exists: the run-wide adjudication counts
 * and the round-cap override record. Split from runs-findings.mjs (an oversized file that may not grow).
 *
 * Domain: audit-orchestration (store seam).
 *
 * @module scripts/lib/store/run-aggregates
 */
import { many, one, updateWhere, withTx } from '../db/query.mjs';
import { isCloudEnabled } from './repo.mjs';
import { probeColumnExistence } from './column-probes.mjs';

/**
 * Recompute a run's `accepted_count` / `dismissed_count` from its adjudicated findings, once, under a row lock.
 *
 * Why this exists: `writeCloudOutcomes` used to stamp the counts of the ONE round it had just labelled. Rounds that
 * share a `--run-id` (audit-loop, /cycle) then overwrote each other, so a run's aggregate described only its last
 * round. The aggregate is now a pure function of the findings table, recomputed in full:
 *
 *  - `SELECT … FOR UPDATE` on the run row serializes refreshes per run. Postgres READ COMMITTED takes a fresh snapshot
 *    per statement, so a refresh that waited on the lock counts AFTER the earlier holder committed — a stale last
 *    writer cannot happen (a count-then-update pair without the lock can: A counts, B commits and writes the fresh
 *    total, A overwrites it with the stale one).
 *  - Run scoping is structural: `finding_adjudication_events.finding_id` is the run-scoped `audit_findings.id`, and
 *    `recordAdjudicationEvent` writes the denormalised `audit_findings.adjudication_outcome` in the same transaction as
 *    the event, so counting that column `WHERE run_id = $1` can only see this run's findings.
 *  - On any failure nothing is written: the previous aggregate stays, and a per-round count is never substituted.
 *
 * The counts are adjudicated finding ROWS: a concern raised in two rounds is two rows and counts twice.
 *
 * @param {string} runId
 * @param {{_afterCount?: (counts: object) => Promise<void>}} [opts] - test seam, awaited between the count and the
 *   UPDATE; production passes nothing
 * @returns {Promise<{ok: true, accepted: number, dismissed: number} | {ok: false, reason: string}>}
 */
export async function refreshRunAdjudicationCounts(runId, { _afterCount } = {}) {
  if (!runId) return { ok: false, reason: 'no-run-id' };
  if (!await isCloudEnabled()) return { ok: false, reason: 'cloud-off' };
  try {
    let counts = null;
    await withTx(async () => {
      const locked = await one('SELECT id FROM audit_runs WHERE id = $1 FOR UPDATE', [runId]);
      if (!locked) throw new Error(`audit_runs ${runId} not found`);
      counts = await one(
        `SELECT count(*) FILTER (WHERE adjudication_outcome = 'accepted')::int  AS accepted,
                count(*) FILTER (WHERE adjudication_outcome = 'dismissed')::int AS dismissed
           FROM audit_findings WHERE run_id = $1`,
        [runId],
      );
      if (_afterCount) await _afterCount(counts);
      await updateWhere('audit_runs', { accepted_count: counts.accepted, dismissed_count: counts.dismissed, labeled: true }, { id: runId });
    });
    return { ok: true, accepted: counts.accepted, dismissed: counts.dismissed };
  } catch (err) {
    process.stderr.write(`  [outcome-sync] run counts not refreshed (${err.message}); previous aggregate kept\n`);
    return { ok: false, reason: err.message };
  }
}

/**
 * Record a round-cap override on the run: why a round ran past the soft cap, and the structural-or-stop card summary
 * computed for it (migration 20261025120000). Each column is probe-guarded, because consumer stores are migrated at
 * different times and a past-cap round must not fail on an unmigrated one: the absent column is named on stderr, the
 * authoritative local record (`_roundCap` on the round result, plus the card JSON) is kept, and the round proceeds.
 *
 * @param {string} runId
 * @param {{reason: string|null, card: object|null}} record
 * @returns {Promise<{ok: boolean, partial?: boolean, reason?: string}>}
 */
export async function recordPastCap(runId, { reason, card }) {
  if (!runId) return { ok: false, reason: 'no-run-id' };
  if (!await isCloudEnabled()) return { ok: false, reason: 'cloud-off' };
  try {
    const update = {};
    const absent = [];
    for (const [col, value] of [['past_cap_reason', reason], ['past_cap_card', card]]) {
      if (value == null) continue;
      const { present } = await probeColumnExistence('audit_runs', col, many, isCloudEnabled);
      if (present) update[col] = value; else absent.push(col);
    }
    if (absent.length > 0) {
      process.stderr.write(`  [round-cap] store lacks ${absent.join(', ')} (run setup-postgres --migrate); the override is recorded locally only\n`);
    }
    if (Object.keys(update).length === 0) return { ok: false, partial: true, reason: 'columns-absent' };
    const { rowCount } = await updateWhere('audit_runs', update, { id: runId });
    return rowCount === 0 ? { ok: false, reason: 'no-row' } : { ok: true, partial: absent.length > 0 };
  } catch (err) {
    process.stderr.write(`  [round-cap] past-cap record not written (${err.message})\n`);
    return { ok: false, reason: err.message };
  }
}
