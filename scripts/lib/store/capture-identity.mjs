/**
 * @fileoverview The capture-v1 contract on the store side
 * (docs/plans/audit-telemetry-capture.md Decisions 1-2): the epoch a run row is
 * stamped with, and the one probe that gates every additive capture write.
 *
 * Own module, not inline in `runs-findings.mjs`: that file is over the size
 * ratchet limit and may not grow.
 *
 * Domain: stores.
 *
 * @module scripts/lib/store/capture-identity
 */
import { many } from '../db/query.mjs';
import { isCloudEnabled } from './repo.mjs';
import { columnExists } from './column-probes.mjs';

/** Bumping this changes the eligible cohort of every capture query (they take the epoch set as a parameter). */
export const CAPTURE_EPOCH = 'capture-v1';

let _noticeShown = false;

/**
 * The compatibility gate. `capture_epoch` and the widened adjudicator-kind CHECK
 * arrive in ONE migration, so this probe also proves 'reviewer' is a legal kind.
 * On an un-migrated store only the additive parts are skipped; one stderr notice
 * per process names the remedy.
 * @returns {Promise<boolean>}
 */
export async function captureV1Present() {
  const present = await columnExists('audit_runs', 'capture_epoch', many, isCloudEnabled);
  if (!present && !_noticeShown) {
    _noticeShown = true;
    process.stderr.write('  [learning] audit_runs.capture_epoch absent - audit capture-v1 writes skipped; run setup-postgres --check-drift\n');
  }
  return present;
}

/**
 * Capture-v1 identity columns for a new `audit_runs` row.
 *
 * `audit_round` is NULL for a unified run (an explicit `runId`): that one row
 * spans every round of the audit, so no single round describes it.
 * @param {{auditSessionId?: string|null, auditRound?: number|null, unifiedRun?: boolean}} identity
 * @returns {Promise<object>} columns to spread into the INSERT row
 */
export async function captureIdentityColumns({ auditSessionId, auditRound, unifiedRun = false } = {}) {
  if (!await captureV1Present()) return {};
  if (!auditSessionId) {
    process.stderr.write('  [learning] no audit session id resolved (pass --session-id or use --out <sid>-r<N>-result.json) - run stays unlinked\n');
  }
  return {
    capture_epoch: CAPTURE_EPOCH,
    ...(auditSessionId ? { audit_session_id: auditSessionId } : {}),
    ...(auditSessionId && !unifiedRun && Number.isInteger(auditRound) ? { audit_round: auditRound } : {}),
  };
}
