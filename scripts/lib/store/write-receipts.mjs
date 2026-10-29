/**
 * @fileoverview Late write receipts on `audit_runs.write_outcomes`
 * (docs/plans/audit-telemetry-capture.md Decisions 2, 4, 6).
 *
 * `run_status` covers only the writes made INSIDE the audit run. Outcome-sync
 * (next round / finalize), the final reviewer and the equivalence links all write
 * AFTER it, so each records its own receipt under its own key
 * (`outcome_sync`, `reviewer`, `equivalence`) and a query names the receipt it
 * requires. A key is replaced whole -- the receipt describes the latest attempt.
 *
 * Domain: stores.
 *
 * @module scripts/lib/store/write-receipts
 */
import { query, one, withTx } from '../db/query.mjs';
import { isCloudEnabled } from './repo.mjs';
import { captureV1Present } from './capture-identity.mjs';

/** The receipt keys a writer may record. Closed, so a typo cannot mint a silent new key. */
export const RECEIPT_KEYS = Object.freeze(['outcome_sync', 'reviewer', 'equivalence']);

/**
 * Merge one receipt into `audit_runs.write_outcomes`, leaving every other key
 * untouched. Skipped (not failed) on an un-migrated store or cloud-off.
 * @param {string} runId
 * @param {'outcome_sync'|'reviewer'|'equivalence'} key
 * @param {object} receipt - passed RAW; the jsonb write seam serialises it
 * @param {{accumulate?: boolean}} [opts] - `accumulate` SUMS numeric fields into the stored receipt instead of replacing it:
 *   the equivalence receipt takes several batches per run (ledger writer, semantic-suppress), and a later clean batch
 *   must not erase an earlier batch's losses.
 * @returns {Promise<{applied: boolean, reason?: string}>}
 */
export async function recordWriteReceipt(runId, key, receipt, { accumulate = false } = {}) {
  if (!runId || !RECEIPT_KEYS.includes(key)) return { applied: false, reason: 'bad-input' };
  if (!await isCloudEnabled()) return { applied: false, reason: 'cloud-off' };
  if (!await captureV1Present()) return { applied: false, reason: 'unmigrated' };
  try {
    if (accumulate) return await accumulateReceipt(runId, key, receipt);
    const res = await query(
      `UPDATE audit_runs
          SET write_outcomes = COALESCE(write_outcomes, '{}'::jsonb) || jsonb_build_object($2::text, $3::jsonb)
        WHERE id = $1`,
      [runId, key, JSON.stringify(receipt)],
    );
    return { applied: (res?.rowCount ?? 0) > 0, ...((res?.rowCount ?? 0) > 0 ? {} : { reason: 'run-row-absent' }) };
  } catch (err) {
    process.stderr.write(`  [learning] recordWriteReceipt(${key}) failed: ${err.message}\n`);
    return { applied: false, reason: 'db-error' };
  }
}

/** Sum `receipt`'s numeric fields into the stored receipt for `key`, under a row lock so two batches cannot lose an update. */
async function accumulateReceipt(runId, key, receipt) {
  return withTx(async () => {
    const row = await one('SELECT write_outcomes -> $2::text AS prior FROM audit_runs WHERE id = $1 FOR UPDATE', [runId, key]);
    if (!row) return { applied: false, reason: 'run-row-absent' };
    const merged = { ...(row.prior ?? {}) };
    for (const [k, v] of Object.entries(receipt)) merged[k] = typeof v === 'number' ? (Number(merged[k]) || 0) + v : v;
    const res = await query(
      `UPDATE audit_runs SET write_outcomes = COALESCE(write_outcomes, '{}'::jsonb) || jsonb_build_object($2::text, $3::jsonb) WHERE id = $1`,
      [runId, key, JSON.stringify(merged)],
    );
    return (res?.rowCount ?? 0) > 0 ? { applied: true } : { applied: false, reason: 'run-row-absent' };
  });
}
