/**
 * @fileoverview Run-level aggregates written to `audit_runs` after the row exists: the run-wide adjudication counts
 * and the round-cap override record. Split from runs-findings.mjs (an oversized file that may not grow).
 *
 * Domain: audit-orchestration (store seam).
 *
 * @module scripts/lib/store/run-aggregates
 */
import { many, one, query, updateWhere, withTx } from '../db/query.mjs';
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
      const { rowCount } = await updateWhere('audit_runs', { accepted_count: counts.accepted, dismissed_count: counts.dismissed, labeled: true }, { id: runId });
      if (rowCount !== 1) throw new Error(`audit_runs ${runId}: ${rowCount} row(s) updated, expected 1`);
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
 * Rounds that share a run id each record their own override and never replace an earlier one: the reason is APPENDED as
 * an `rN: <reason>` line and the card summary is merged under its round number. ONE policy for both: the FIRST record for a
 * round wins (it is the evidence the decision was made on), and re-recording that round, with the same or a different
 * reason, changes neither column.
 *
 * @param {string} runId
 * @param {{reason: string|null, card: object|null, round: number}} record
 * @returns {Promise<{ok: boolean, partial?: boolean, reason?: string}>}
 */
export async function recordPastCap(runId, { reason, card, round }) {
  if (!runId) return { ok: false, reason: 'no-run-id' };
  if (!await isCloudEnabled()) return { ok: false, reason: 'cloud-off' };
  try {
    const sets = [];
    const params = [runId];
    const absent = [];
    const probe = async (col) => {
      const { present } = await probeColumnExistence('audit_runs', col, many, isCloudEnabled);
      if (!present) absent.push(col);
      return present;
    };
    if (reason != null && await probe('past_cap_reason')) {
      // One line per round, always: a reason with its own newlines (or its own "r8:" text) must not be able to forge or
      // hide a record boundary, so the identity the dedup reads is the line START, which only this code writes.
      const oneLine = String(reason).replace(/\s+/g, ' ').trim();
      params.push(`r${round}: ${oneLine}`, `(^|\n)r${round}: `);
      const line = `$${params.length - 1}`;
      const seen = `$${params.length}`;
      sets.push(`past_cap_reason = CASE WHEN COALESCE(past_cap_reason, '') ~ ${seen}::text THEN past_cap_reason `
        + `ELSE COALESCE(past_cap_reason || chr(10), '') || ${line}::text END`);
    }
    if (card != null && await probe('past_cap_card')) {
      params.push(String(round), JSON.stringify(card));
      const key = `$${params.length - 1}::text`;
      sets.push(`past_cap_card = CASE WHEN COALESCE(past_cap_card, '{}'::jsonb) ? ${key} THEN past_cap_card `
        + `ELSE COALESCE(past_cap_card, '{}'::jsonb) || jsonb_build_object(${key}, $${params.length}::jsonb) END`);
    }
    if (absent.length > 0) {
      process.stderr.write(`  [round-cap] store lacks ${absent.join(', ')} (run setup-postgres --migrate); the override is recorded locally only\n`);
    }
    if (sets.length === 0) return { ok: false, partial: true, reason: 'columns-absent' };
    const res = await query(`UPDATE audit_runs SET ${sets.join(', ')} WHERE id = $1`, params);
    return (res.rowCount ?? 0) === 0 ? { ok: false, reason: 'no-row' } : { ok: true, partial: absent.length > 0 };
  } catch (err) {
    process.stderr.write(`  [round-cap] past-cap record not written (${err.message})\n`);
    return { ok: false, reason: err.message };
  }
}
