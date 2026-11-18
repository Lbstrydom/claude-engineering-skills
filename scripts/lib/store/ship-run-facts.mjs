/**
 * @fileoverview The two store READS the coordinator batch re-check needs about an audit run
 * (docs/plans/coordinator-aggregate-ship.md section 2.3, `evidence` and `final-review` rows): the run's own row, and this
 * repository's row id. Both say WHY when they have no answer, so a store that failed, a cloud that is off and a run that does
 * not exist are three reasons in the refusal and never one silent null.
 *
 * Own module, not inline in `runs-findings.mjs`: that file is over the size ratchet and may not grow.
 *
 * @module scripts/lib/store/ship-run-facts
 */
import { one } from '../db/query.mjs';
import { isCloudEnabled, resolveRepoForStoreResult } from './repo.mjs';
import { getRunMeta } from './runs-findings.mjs';

const errWhy = (e) => e?.code || e?.message || 'error';

/**
 * The run row as the batch re-check judges it: the repository it belongs to, whether it converged, the audited identity it
 * recorded and the final-review verdict written back to it.
 *
 * @param {string} runId
 * @param {{isCloudEnabled?: Function, getRunMeta?: Function, one?: Function}} [deps] test seams
 * @returns {Promise<{row: {repoId: string|null, roundConvergedAfter: number|null, auditedSha: string|null, auditedTree: string|null, geminiVerdict: string|null, branch: string|null}|null, why: string|null}>}
 */
export async function getShipRunFacts(runId, deps = {}) {
  const { isCloudEnabled: cloud = isCloudEnabled, getRunMeta: meta = getRunMeta, one: oneFn = one } = deps;
  if (!runId) return { row: null, why: 'no run id' };
  let enabled;
  try { enabled = await cloud(); } catch (e) { return { row: null, why: `the store configuration could not be read (${errWhy(e)})` }; }
  if (!enabled) return { row: null, why: 'cloud store is off' };
  let m;
  let repo;
  try {
    m = await meta(runId);
    repo = m ? await oneFn('SELECT repo_id FROM audit_runs WHERE id = $1', [runId]) : null;
  } catch (e) { return { row: null, why: `the store query failed (${errWhy(e)})` }; }
  if (!m) return { row: null, why: 'no audit_runs row for that run id' };
  return {
    row: {
      repoId: repo?.repo_id ?? null,
      roundConvergedAfter: Number.isInteger(m.roundConvergedAfter) ? m.roundConvergedAfter : null,
      auditedSha: m.auditedSha ?? null,
      auditedTree: m.auditedTree ?? null,
      geminiVerdict: m.geminiVerdict ?? null,
      branch: m.branch ?? null,
    },
    why: null,
  };
}

/**
 * This repository's row id in the store, resolved from the checkout at `cwd` exactly as every other repo-scoped read does.
 * @param {string} cwd
 * @param {{resolve?: Function}} [deps] test seam
 * @returns {Promise<{repoId: string|null, why: string|null}>}
 */
export async function getShipRepoId(cwd, deps = {}) {
  const { resolve = resolveRepoForStoreResult } = deps;
  let r;
  try { r = await resolve({ cwd }); } catch (e) { return { repoId: null, why: `the repository could not be resolved (${errWhy(e)})` }; }
  if (r?.kind === 'resolved') return { repoId: r.repoRowId, why: null };
  return { repoId: null, why: r?.kind === 'cloud-off' ? 'cloud store is off' : `the repository could not be resolved (${r?.kind ?? 'unknown'})` };
}
