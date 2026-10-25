/**
 * @fileoverview Close ONE audit finding by row id, from outside a live audit
 * round — the writer behind `cross-skill.mjs close-finding`.
 *
 * `/ship` Step 0.5e prints `final-review-record-fix` as the way to close an
 * unremediated acceptance, but that command (and `final-review-adjudicate`)
 * is scoped to `pass_name IN ('final-review','final-review-shadow')`. Every
 * row the `unremediated_acceptances` view returned on 2026-10-02 — 142 of
 * them — came from an ordinary audit pass, so the printed command could not
 * close a single one, and `finalize-outcomes` needs a live round's ledger.
 * An obligation with no way to discharge it is a queue that only grows.
 *
 * Three dispositions, each routed through the writer that already owns that
 * state — this module adds the by-id, repo-scoped entry point, not a second
 * write path:
 *   - `fixed`              → `markFindingsRemediation` (row-id path; it
 *                            enforces repo ownership in its own UPDATE).
 *   - `dismissed`          → `recordAdjudicationEvent`, outcome `dismissed`,
 *                            ruling `overrule` (the CHECK-constrained value
 *                            for "the finding was not right").
 *   - `accepted-permanent` → `user_action`, the disposition the view's
 *                            `is_open_disposition` already reads.
 *
 * @module scripts/lib/store/finding-disposition
 */
import { isCloudEnabled } from './repo.mjs';
import { many } from '../db/query.mjs';
import { markFindingsRemediation, recordAdjudicationEvent } from './runs-findings.mjs';
import { columnExists } from './column-probes.mjs';
import { isDismissReasonClass } from '../adjudication-vocab.mjs';

export const FINDING_DISPOSITIONS = Object.freeze(['fixed', 'dismissed', 'accepted-permanent']);

/**
 * `reason` lands in `audit_findings.dismiss_reason` for both non-fix
 * dispositions — the finding's only free-text disposition column, despite its
 * name — and `commitSha` in `fix_commit_sha` for a fix.
 *
 * @param {{repoId: string, findingId: string, disposition: string, reason?: string, commitSha?: string|null}} a
 * @returns {Promise<{ok: true, disposition: string, findingId: string} | {ok: false, reason: string, detail?: string}>}
 */
export async function closeFindingById({ repoId, findingId, disposition, reason = '', commitSha = null, reasonClass = null }) {
  if (!repoId || !findingId) throw new Error('closeFindingById: repoId and findingId are required');
  if (!FINDING_DISPOSITIONS.includes(disposition)) {
    throw new Error(`closeFindingById: disposition must be one of ${FINDING_DISPOSITIONS.join('|')}, got "${disposition}"`);
  }
  // A dismissal or a permanent acceptance is a CLAIM about the code; without
  // its reason nobody can check it later. A fix carries its evidence in git.
  // `reason ?? ''`: the parameter default covers only `undefined`, and
  // String(null) is the truthy text "null" - a null reason must read as absent.
  const why = String(reason ?? '').trim();
  if (disposition !== 'fixed' && !why) {
    return { ok: false, reason: 'reason-required' };
  }
  // ...and a fix carries its evidence in git, so the WRITER requires the commit
  // too: the CLI checks it, but this entry point is exported and a caller that
  // skipped the CLI would otherwise mark a finding fixed with nothing to check.
  if (disposition === 'fixed' && !String(commitSha ?? '').trim()) {
    return { ok: false, reason: 'commit-required' };
  }
  // The class is what makes a dismissal countable (own-model telemetry gap 3);
  // the free-text reason above is for a human reader. `unclassified` is a
  // producer fallback, not something a person may choose here.
  if (disposition !== 'fixed' && (!isDismissReasonClass(reasonClass) || reasonClass === 'unclassified')) {
    return { ok: false, reason: 'reason-class-required' };
  }
  if (!await isCloudEnabled()) return { ok: false, reason: 'cloud-disabled' };

  // Repo-scoped by construction: a finding id from another repository simply
  // does not resolve here, and nothing below writes by an unscoped id.
  const rows = await many(
    `SELECT f.id, f.run_id, f.finding_fingerprint, f.pass_name, f.round_raised, f.remediation_state
       FROM audit_findings f JOIN audit_runs r ON r.id = f.run_id
      WHERE f.id = $1 AND r.repo_id = $2`,
    [findingId, repoId],
  );
  const row = rows[0];
  if (!row) return { ok: false, reason: 'not-found-in-repo' };

  // EVIDENCE FIRST, discharge second. The two are separate statements (each
  // writer owns its own state), so one order must be chosen: discharge-then-stamp
  // can leave a finding OUT of the open set with no commit/reason recorded - a
  // claim nobody can check, reported as success. Stamp-then-discharge can only
  // leave the finding still OPEN with its evidence stamped, and the same call
  // retried writes the same values. Success is returned only when both landed.
  if (disposition === 'fixed') {
    const evidence = await stampEvidence(row.id, repoId, 'fix_commit_sha', String(commitSha).trim());
    if (!evidence.ok) return evidence;
    const res = await markFindingsRemediation(repoId, [{ id: row.id, findingFingerprint: row.finding_fingerprint, state: 'fixed' }]);
    if (res.updated !== 1) {
      return { ok: false, reason: 'write-failed', detail: `markFindingsRemediation updated ${res.updated}/${res.attempted ?? 1}; the commit is stamped but the finding is still open - retry is safe` };
    }
    return { ok: true, disposition, findingId: row.id, commitRecorded: true };
  }

  if (disposition === 'dismissed') {
    const evidence = await stampEvidence(row.id, repoId, 'dismiss_reason', why);
    if (!evidence.ok) return evidence;
    const res = await recordAdjudicationEvent(row.run_id, row.finding_fingerprint, {
      adjudicationOutcome: 'dismissed',
      // The event column is NOT NULL; a dismissed finding has nothing to
      // remediate, which the existing rows record as 'pending'.
      remediationState: row.remediation_state ?? 'pending',
      ruling: 'overrule',
      rulingRationale: why,
      adjudicatorKind: 'human',
      dismissReasonClass: reasonClass,
      passName: row.pass_name,
      round: row.round_raised ?? 1,
    });
    if (!res.ok) {
      return { ok: false, reason: res.reason, detail: `${res.detail ? `${res.detail}; ` : ''}the reason is stamped but the finding is still open - retry is safe` };
    }
    return { ok: true, disposition, findingId: row.id, reasonRecorded: true };
  }

  const classColumn = await columnExists('audit_findings', 'dismiss_reason_class', many, isCloudEnabled);
  const updated = await many(
    `UPDATE audit_findings f SET user_action = 'accepted-permanent', dismiss_reason = $3${
        classColumn ? ', dismiss_reason_class = $4' : ''}
       FROM audit_runs r
      WHERE f.id = $1 AND r.id = f.run_id AND r.repo_id = $2
      RETURNING f.id`,
    classColumn ? [row.id, repoId, why, reasonClass] : [row.id, repoId, why],
  );
  return updated.length === 1
    ? { ok: true, disposition, findingId: row.id }
    : { ok: false, reason: 'write-failed', detail: `${updated.length} row(s) updated, expected 1` };
}

/**
 * Repo-scoped single-column evidence stamp. A thrown query or a stamp that
 * touched anything but exactly one row is a refusal, never a quiet `false`:
 * the caller stops before it discharges the finding.
 */
async function stampEvidence(findingId, repoId, column, value) {
  if (column !== 'fix_commit_sha' && column !== 'dismiss_reason') throw new Error(`stampEvidence: unexpected column ${column}`);
  let rows;
  try {
    rows = await many(
      `UPDATE audit_findings f SET ${column} = $3 FROM audit_runs r
        WHERE f.id = $1 AND r.id = f.run_id AND r.repo_id = $2 RETURNING f.id`,
      [findingId, repoId, value],
    );
  } catch (err) {
    return { ok: false, reason: 'write-failed', detail: `evidence not recorded, finding untouched: ${err.message}` };
  }
  return rows.length === 1
    ? { ok: true }
    : { ok: false, reason: 'write-failed', detail: `evidence not recorded, finding untouched: ${rows.length} row(s) updated, expected 1` };
}
