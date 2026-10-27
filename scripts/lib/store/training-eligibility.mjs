/**
 * @fileoverview Training-corpus eligibility: default-DENY by repo
 * (docs/plans/own-model-telemetry-slice-1.md gap 6; memo §6.5).
 *
 * `audit_repos.training_eligible` is NULL until someone decides, and NULL is
 * refused. Only an explicit `true` passes. An export that cannot PROVE
 * eligibility refuses: an unresolvable repo id, a repo row that is missing, and a
 * lookup that throws are all refusals, never a pass. A repo-name `if` is not the
 * control — the stored, reasoned flag is.
 *
 * This is also the only module (with the diff writer and the census) allowed to
 * read `audit_run_diffs` content; `tests/own-model-diff-readers.test.mjs` fails
 * if a new reader appears that does not go through here.
 *
 * @module scripts/lib/store/training-eligibility
 */
import { many, query, withTx } from '../db/query.mjs';

/**
 * PURE. Decide over already-loaded repo rows.
 * @param {string[]} wantedRepoIds - every repo the export touches
 * @param {Array<{id: string, name?: string, training_eligible: boolean|null}>} rows
 * @returns {{ok: boolean, refused: Array<{repoId: string, name: string|null, reason: 'unknown-repo'|'undecided'|'ineligible'}>}}
 */
export function assertTrainingEligible(wantedRepoIds, rows) {
  const byId = new Map((rows || []).map((r) => [r.id, r]));
  const refused = [];
  const raw = wantedRepoIds || [];
  const ids = [...new Set(raw.filter(Boolean))];
  // An export naming no repo proves nothing, and one naming a blank/null id alongside
  // valid ones must not pass on the valid subset: refuse the whole collection.
  if (ids.length === 0 || raw.some((x) => !x)) {
    return { ok: false, refused: [{ repoId: '', name: null, reason: 'unknown-repo' }] };
  }
  for (const id of ids) {
    const r = byId.get(id);
    if (!r) refused.push({ repoId: id, name: null, reason: 'unknown-repo' });
    else if (r.training_eligible === true) continue;
    else if (r.training_eligible === false) refused.push({ repoId: id, name: r.name ?? null, reason: 'ineligible' });
    else refused.push({ repoId: id, name: r.name ?? null, reason: 'undecided' });
  }
  return { ok: refused.length === 0, refused };
}

/**
 * Load + decide. A lookup failure is a refusal (fail closed), carrying the error.
 * @param {string[]} repoIds
 * @returns {Promise<{ok: boolean, refused: object[], error?: string}>}
 */
export async function checkReposEligibleForExport(repoIds) {
  if (!Array.isArray(repoIds) || repoIds.length === 0 || repoIds.some((x) => !x)) return assertTrainingEligible(Array.isArray(repoIds) ? repoIds : [], []);
  const ids = [...new Set(repoIds)];
  try {
    const rows = await many(
      'SELECT id, name, training_eligible FROM audit_repos WHERE id = ANY($1::uuid[])', [ids]);
    return assertTrainingEligible(ids, rows);
  } catch (err) {
    return { ok: false, refused: ids.map((repoId) => ({ repoId, name: null, reason: 'unknown-repo' })), error: err.message };
  }
}

/**
 * Flip a repo's flag. The reason AND the approver are REQUIRED: an unexplained or
 * unattributed eligibility is a claim nobody can check later. The change is also
 * appended to `training_eligibility_events` in the SAME transaction, so the consent
 * history is never overwritten (memo 6.8 row 12).
 * @param {{repoName: string, eligible: boolean, reason: string, approvedBy: string}} a
 */
export async function setTrainingEligibility({ repoName, eligible, reason, approvedBy }) {
  const why = String(reason ?? '').trim();
  const who = String(approvedBy ?? '').trim();
  if (!repoName) return { ok: false, reason: 'repo-required' };
  if (typeof eligible !== 'boolean') return { ok: false, reason: 'eligible-must-be-boolean' };
  if (!why) return { ok: false, reason: 'reason-required' };
  if (!who) return { ok: false, reason: 'approved-by-required' };
  const found = await many('SELECT id FROM audit_repos WHERE name = $1', [repoName]);
  if (found.length !== 1) return { ok: false, reason: found.length === 0 ? 'repo-not-found' : 'repo-ambiguous' };
  const repoId = found[0].id;
  const wrote = await withTx(async () => {
    const res = await query(
      `UPDATE audit_repos SET training_eligible = $2, training_eligibility_reason = $3,
              training_eligibility_approved_by = $4, training_eligibility_set_at = now()
        WHERE id = $1`, [repoId, eligible, why, who]);
    if (res.rowCount !== 1) return false;
    await query(
      `INSERT INTO training_eligibility_events (repo_id, eligible, reason, approved_by, set_at)
         VALUES ($1, $2, $3, $4, now())`, [repoId, eligible, why, who]);
    return true;
  });
  return wrote ? { ok: true, repoId } : { ok: false, reason: 'write-failed' };
}

/** All repos with their stored decision (NULL = undecided = refused). */
export async function listTrainingEligibility() {
  return many(`SELECT name, training_eligible, training_eligibility_reason
                 FROM audit_repos WHERE fingerprint IS DISTINCT FROM 'GLOBAL_SENTINEL' ORDER BY name`);
}
