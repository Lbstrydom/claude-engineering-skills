/**
 * @fileoverview The `audit.runDiff` writer: persist a run's prepared diff
 * artefact (see `scripts/lib/audit/diff-capture.mjs`) and its capture outcome
 * (docs/plans/own-model-telemetry-slice-1.md, gap 1).
 *
 * Idempotent by construction, which is what licenses a spill/replay: the
 * content row is `INSERT … ON CONFLICT (diff_ref) DO NOTHING` (content
 * addressed) and the run row is a keyed UPDATE. Truncation / redaction count /
 * capture status are written to `audit_runs`, never to the shared content row.
 *
 * Receipt-shaped (`{applied, rows, reason?, error?}`) like its siblings in
 * `learning-decisions.mjs`, so `durableWrite` reads the truth.
 *
 * @module scripts/lib/store/run-diffs
 */
import { query, withTx, many } from '../db/query.mjs';
import { isCloudEnabled } from './repo.mjs';
import { strictColumnExists } from './column-probes.mjs';
import { DIFF_CAPTURE_STATUSES } from '../adjudication-vocab.mjs';

let _warnedUnmigrated = false;

/**
 * @param {string} runId
 * @param {{baseSha?: string|null, artifact: import('../audit/diff-capture.mjs').DiffArtifact}} payload
 * @returns {Promise<{ok: boolean, applied: boolean, rows: number, reason?: string, error?: Error}>}
 */
export async function recordRunDiff(runId, payload) {
  if (!runId) return { ok: true, applied: false, rows: 0, reason: 'no-run-id' };
  if (!await isCloudEnabled()) return { ok: true, applied: false, rows: 0, reason: 'cloud-off' };
  const artifact = payload?.artifact;
  if (!artifact || !DIFF_CAPTURE_STATUSES.includes(artifact.status)) {
    return { ok: false, applied: false, rows: 0, error: new Error(`recordRunDiff: invalid artifact status ${JSON.stringify(artifact?.status)}`) };
  }
  // A consumer store migrated later must not turn every audit `incomplete`: this
  // is a DECLINE (nothing attempted), loud once, and the census reports UNMIGRATED.
  if (!await strictColumnExists('audit_runs', 'diff_capture_status', many, isCloudEnabled)) {
    if (!_warnedUnmigrated) {
      _warnedUnmigrated = true;
      process.stderr.write('  [diff-capture] store lacks 20261026120000 — run diff NOT persisted (setup-postgres.mjs --migrate)\n');
    }
    return { ok: true, applied: false, rows: 0, reason: 'store-not-migrated' };
  }
  try {
    // No content for a repo that is explicitly NOT training-eligible (coordinator rule
    // 2026-10-25: capture no storyline content). NULL (undecided) still captures; export
    // is refused for it by training-eligibility.mjs. The check sits at the writer, so it
    // holds for a spilled replay too.
    const rows = await withTx(async () => {
      // Lookup and write share ONE transaction, and an absent run row stops here:
      // no content row is ever committed without a run to attach it to.
      const run = await query(
        `SELECT ar.id, r.training_eligible FROM audit_runs ar
           JOIN audit_repos r ON r.id = ar.repo_id WHERE ar.id = $1 FOR UPDATE OF ar FOR SHARE OF r`, [runId]);
      if (!run.rows?.length) return 0;
      const effective = artifact.status === 'captured' && run.rows[0].training_eligible === false
        ? { status: 'repo-excluded', redactions: 0 } : artifact;
      const captured = effective.status === 'captured';
      if (captured) {
        await query(
          `INSERT INTO audit_run_diffs (diff_ref, diff_text, bytes) VALUES ($1, $2, $3)
             ON CONFLICT (diff_ref) DO NOTHING`,
          [artifact.ref, artifact.text, artifact.bytes],
        );
      }
      const res = await query(
        `UPDATE audit_runs
            SET diff_ref = $2, diff_base_sha = $3, diff_bytes = $4, diff_truncated = $5,
                diff_redactions = $6, diff_capture_status = $7
          WHERE id = $1`,
        [runId, captured ? artifact.ref : null, payload.baseSha ?? null,
          captured ? artifact.bytes : null, captured ? artifact.truncated : null,
          effective.redactions ?? 0, effective.status],
      );
      // The run row is locked above, so this must match exactly one row; anything else
      // rolls the content insert back with it rather than committing an orphan.
      if (res?.rowCount !== 1) throw new Error(`audit_runs ${runId}: ${res?.rowCount} row(s) updated, expected 1`);
      return 1;
    });
    // 0 rows = the run row is absent: attempted and did not land, so it keeps the
    // spilled/lost treatment (same reading as `audit.runComplete`).
    return rows === 0
      ? { ok: false, applied: false, rows: 0, reason: 'run-row-absent' }
      : { ok: true, applied: true, rows };
  } catch (err) {
    return { ok: false, applied: false, rows: 0, error: err };
  }
}
