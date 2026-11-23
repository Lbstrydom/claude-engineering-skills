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
import { CAPTURE_EPOCH } from '../capture-epoch.mjs';
import { resolveLinkage } from '../telemetry/linkage.mjs';

/** Bumping this changes the eligible cohort of every capture query (they take the epoch set as a parameter). Defined in the leaf
 *  `lib/capture-epoch.mjs` so `telemetry/capture-queries.mjs` (shared-lib, may not import the store) reads the SAME constant. */
export { CAPTURE_EPOCH };

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
 * `standaloneReason` declares a run deliberately outside any session (a key of `STANDALONE_REASONS`); a bad or contradictory
 * declaration is recorded as `unlinked` with the reason, never thrown (the run row must not be lost).
 * @param {{auditSessionId?: string|null, auditRound?: number|null, unifiedRun?: boolean, standaloneReason?: string|null}} identity
 * @returns {Promise<object>} columns to spread into the INSERT row
 */
export async function captureIdentityColumns({ auditSessionId, auditRound, unifiedRun = false, standaloneReason = null } = {}) {
  if (!await captureV1Present()) return {};
  // The linkage resolver is the ONE decision: an undeclared missing session is the explicit `unlinked` state, never a bare NULL.
  let link;
  try {
    link = resolveLinkage({ auditSessionId, auditRound, unifiedRun, standaloneReason });
  } catch (err) {
    // A bad declaration must not lose the run (`recordRunStart` never throws), and must not discard identity the caller DID
    // supply: resolve again WITHOUT the declaration, so a real session still links. Only a run left with no session is
    // `unlinked`, and its reason says the declaration was invalid.
    link = resolveLinkage({ auditSessionId, auditRound, unifiedRun });
    process.stderr.write(`  [learning] ${err.message} - declaration ignored\n`);
    if (link.state === 'unlinked') link = { ...link, reason: `invalid-declaration: ${err.message}`.slice(0, 200) };
  }
  if (link.state === 'unlinked' && link.reason === 'undeclared') {
    process.stderr.write('  [learning] no audit session id resolved (pass --session-id or use --out <sid>-r<N>-result.json) - run recorded as linkage_state=unlinked\n');
  }
  // Probed apart from capture_epoch: the linkage columns arrive in a later migration, and an older store keeps working.
  const hasState = await columnExists('audit_runs', 'linkage_state', many, isCloudEnabled);
  return {
    capture_epoch: CAPTURE_EPOCH,
    ...(link.auditSessionId ? { audit_session_id: link.auditSessionId } : {}),
    ...(link.auditSessionId && link.auditRound != null ? { audit_round: link.auditRound } : {}),
    ...(hasState ? { linkage_state: link.state, linkage_reason: link.reason } : {}),
  };
}

/**
 * A run row REUSED by an explicit run id (a unified audit's later rounds, a coordinator's worker) was written by an earlier
 * process, possibly before any identity was known. Reuse must not leave it silently unlinked while the caller now holds a
 * session: an unlinked/legacy row adopts the supplied session; a row already linked to a DIFFERENT session is left alone and
 * the conflict is named (a wrong session id merges two audits in every query). Never throws; returns the run id.
 * @param {{id: string, audit_session_id?: string|null, linkage_state?: string|null}} existing
 * @param {{auditSessionId?: string|null}} identity
 * @returns {Promise<string>}
 */
export async function reconcileReusedRunLinkage(existing, { auditSessionId } = {}) {
  const sid = typeof auditSessionId === 'string' && auditSessionId.trim() ? auditSessionId.trim() : null;
  try {
    if (!sid || !await captureV1Present()) return existing.id;
    const row = await one('SELECT audit_session_id FROM audit_runs WHERE id = $1', [existing.id]);
    if (row?.audit_session_id && row.audit_session_id !== sid) {
      process.stderr.write(`  [learning] run ${existing.id} is linked to session "${row.audit_session_id}", not "${sid}" - reuse refused (a mis-threaded run id would attribute this session's telemetry to the other)\n`);
      return null;
    }
    if (row?.audit_session_id) return existing.id;
    const hasState = await columnExists('audit_runs', 'linkage_state', many, isCloudEnabled);
    await query(`UPDATE audit_runs SET audit_session_id = $2${hasState ? ", linkage_state = 'linked', linkage_reason = NULL" : ''} WHERE id = $1 AND audit_session_id IS NULL`, [existing.id, sid]);
  } catch (err) {
    process.stderr.write(`  [learning] reconcile linkage on reuse of ${existing.id} failed: ${err.message}\n`);
  }
  return existing.id;
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
