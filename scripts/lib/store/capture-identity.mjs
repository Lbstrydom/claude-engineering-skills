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
import { many, one, query } from '../db/query.mjs';
import { isCloudEnabled } from './repo.mjs';
import { columnExists } from './column-probes.mjs';
import { redactSecrets } from '../secret-patterns.mjs';

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

/** Max length of a free-text value written by the capture-v1 writers (rationale, actor). */
export const CAPTURE_TEXT_MAX = 2000;

/**
 * Free-text boundary for the capture-v1 writers (Decision 5): the gentle secret
 * redactor (`secret-patterns.mjs`, as docs/plans/security/ prescribes for prose),
 * then a hard length cap. NOT `sanitizer.mjs`, which blanket-redacts any 20+ char
 * token and would corrupt prose. A non-string or blank value is NULL.
 * @param {unknown} value
 * @returns {string|null}
 */
export function redactAndCapText(value) {
  if (typeof value !== 'string' || !value.trim()) return null;
  return redactSecrets(value).text.slice(0, CAPTURE_TEXT_MAX);
}

/**
 * The run that holds a presented finding's SOURCE row: the latest run of the
 * reviewing run's own audit session at `round` (Decision 4 -- a presented entry
 * can come from any round of the session). A retried round has several rows for
 * one key; the latest `created_at` counts, so a retry counts once.
 *
 * A UNIFIED run (explicit `--run-id`, `audit_round` NULL) is one row spanning
 * every round, so when no per-round row exists and the reviewing run itself has
 * no round, the reviewing run IS the source. Null when nothing resolves -- the
 * caller counts it, never guesses.
 * @param {string} reviewingRunId
 * @param {number} round
 * @returns {Promise<string|null>}
 */
export async function resolveSourceRun(reviewingRunId, round) {
  const rv = await one('SELECT repo_id, audit_session_id, audit_round, capture_epoch FROM audit_runs WHERE id = $1', [reviewingRunId]);
  // A run with no repo cannot be scoped to one, and a run with no epoch has no meaning to match on: both resolve nothing.
  if (!rv?.audit_session_id || !rv.repo_id || !rv.capture_epoch) return null;
  const hit = await one(
    `SELECT id FROM audit_runs
      WHERE repo_id = $1 AND audit_session_id = $2 AND audit_round = $3 AND capture_epoch = $4
      ORDER BY created_at DESC, id DESC LIMIT 1`,
    [rv.repo_id, rv.audit_session_id, round, rv.capture_epoch],
  );
  if (hit?.id) return hit.id;
  return rv.audit_round == null ? reviewingRunId : null;
}

/**
 * Does `fingerprint` have a finding row in `runId` raised in `round`? A run id alone proves nothing about the finding a
 * reversal names, and a unified run holds several rounds: the round is the same key the event writer resolves the row by.
 * @returns {Promise<boolean>}
 */
export async function hasFinding(runId, fingerprint, round) {
  return Boolean(await one(
    'SELECT 1 AS present FROM audit_findings WHERE run_id = $1 AND finding_fingerprint = $2 AND round_raised = $3 LIMIT 1',
    [runId, fingerprint, round],
  ));
}

/**
 * Remove every reviewer event THIS reviewing run wrote, before it writes its current set: a re-run that no longer
 * reverses a finding must not leave the old reversal behind. Events of OTHER reviews are untouched.
 * @param {string} reviewingRunId
 * @returns {Promise<number>} rows removed
 */
export async function clearReviewerEvents(reviewingRunId) {
  const res = await query(
    `DELETE FROM finding_adjudication_events WHERE adjudicator_kind = 'reviewer' AND evidence ->> 'reviewing_run_id' = $1`,
    [reviewingRunId],
  );
  return res?.rowCount ?? 0;
}
