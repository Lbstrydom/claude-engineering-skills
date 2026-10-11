/**
 * @fileoverview Ship-train provenance read — the audit runs that could cover a
 * PR, found by content (audited tree) or ancestry (audited sha).
 *
 * Read-only: no write, so not a durable-write registration. Plan:
 * docs/plans/ship-trains.md §2.3 (binding) and round-1 H4 (one query returns
 * both kinds, kept apart by `matchKind`).
 *
 * Failure is never an empty result. A cloud-off store, an unresolvable repo and
 * a failed query come back as `{ok:false, reason}` — the caller turns that into
 * a `store-unavailable` binding, which refuses a non-ride-along PR. A SCHEMA
 * fault additionally carries `fatal:true`: a broken query is not an absent
 * store, so the caller stops instead of degrading. `[]` means only "the query
 * ran and nothing matched".
 *
 * @module scripts/lib/store/train-provenance
 */

import { many, one } from '../db/query.mjs';
import { describeSchemaFault } from '../db/errors.mjs';
import { isCloudEnabled, getRepoIdByUuid } from './repo.mjs';
import { resolveRepoIdentity } from '../repo-identity.mjs';

const OID_RE = /^[0-9a-f]{40}$/;
/** A PR with more commits than this is refused, not silently truncated. */
export const MAX_PR_COMMITS = 250;

/**
 * Resolve the CURRENT repo's `audit_repos.id` for a read. Never creates a row
 * (unlike `resolveRepoForStore`): a repo the store has never seen has no runs.
 *
 * @param {string} [cwd]
 * @returns {Promise<{ok: true, repoRowId: string} | {ok: false, reason: string}>}
 */
export async function resolveRepoRowIdForRead(cwd) {
  if (!await isCloudEnabled()) return { ok: false, reason: 'cloud-off' };
  let repoUuid;
  try {
    ({ repoUuid } = resolveRepoIdentity(cwd));
  } catch (err) {
    return { ok: false, reason: `repo identity unresolved: ${err.message}` };
  }
  try {
    const row = await getRepoIdByUuid(repoUuid, { strict: true });
    return row?.id ? { ok: true, repoRowId: row.id } : { ok: false, reason: 'repo-not-in-store' };
  } catch (err) {
    const fault = describeSchemaFault(err, 'resolveRepoRowIdForRead');
    if (fault) {
      process.stderr.write(fault);
      return { ok: false, fatal: true, reason: `schema-fault: ${err.code ?? err.cause?.code ?? 'unknown'}` };
    }
    return { ok: false, reason: `repo lookup failed: ${err.message}` };
  }
}

/**
 * Code-mode runs whose audited tree is one of `trees` OR whose audited sha is
 * one of `oids`, for one repo. A row matching both is reported once, as `tree`.
 *
 * @param {object} input
 * @param {string} input.repoRowId
 * @param {string[]} input.trees — the PR commits' trees
 * @param {string[]} input.oids — the PR commits' oids, EXCLUDING the merge-base
 * @param {{many?: Function, isCloudEnabled?: Function}} [deps] — injectable for the failure-branch tests
 * @returns {Promise<{ok: true, rows: Array<{id: string, auditedSha: string|null, auditedTree: string|null,
 *   roundConvergedAfter: number|null, createdAt: string, finalReviewModel: string|null, authorModel: string|null,
 *   auditorModels: string[], matchKind: 'tree'|'sha-only'}>} | {ok: false, reason: string}>}
 */
export async function findCodeRunCandidates({ repoRowId, trees, oids }, deps = {}) {
  const { many: manyFn = many, isCloudEnabled: cloudFn = isCloudEnabled } = deps;
  if (!repoRowId) return { ok: false, reason: 'no-repo-row-id' };
  const t = [...new Set(trees ?? [])];
  const o = [...new Set(oids ?? [])];
  if (t.length > MAX_PR_COMMITS || o.length > MAX_PR_COMMITS) {
    return { ok: false, reason: `pr-too-large: more than ${MAX_PR_COMMITS} commits` };
  }
  if (![...t, ...o].every((v) => OID_RE.test(v))) return { ok: false, reason: 'malformed-object-id' };
  if (t.length === 0 && o.length === 0) return { ok: true, rows: [] };
  if (!await cloudFn()) return { ok: false, reason: 'cloud-off' };
  try {
    const rows = await manyFn(
      `SELECT ar.id,
              ar.audited_sha,
              ar.audited_tree,
              ar.round_converged_after,
              ar.created_at,
              ar.final_review_model,
              ar.author_model,
              ARRAY(SELECT DISTINCT ps.source_model COLLATE "C"
                      FROM audit_pass_stats ps
                     WHERE ps.run_id = ar.id AND ps.source_model IS NOT NULL
                     ORDER BY 1) AS auditor_models,
              CASE WHEN ar.audited_tree = ANY($2::text[]) THEN 'tree' ELSE 'sha-only' END AS match_kind
         FROM audit_runs ar
        WHERE ar.repo_id = $1
          AND ar.mode = 'code'
          AND (ar.audited_tree = ANY($2::text[]) OR ar.audited_sha = ANY($3::text[]))
        ORDER BY ar.created_at DESC, ar.id DESC`,
      [repoRowId, t, o],
    );
    return {
      ok: true,
      rows: rows.map((r) => ({
        id: r.id,
        auditedSha: r.audited_sha ?? null,
        auditedTree: r.audited_tree ?? null,
        roundConvergedAfter: r.round_converged_after ?? null,
        createdAt: r.created_at instanceof Date ? r.created_at.toISOString() : String(r.created_at),
        finalReviewModel: r.final_review_model ?? null,
        authorModel: r.author_model ?? null,
        auditorModels: Array.isArray(r.auditor_models) ? r.auditor_models : [],
        matchKind: r.match_kind,
      })),
    };
  } catch (err) {
    const fault = describeSchemaFault(err, 'findCodeRunCandidates');
    if (fault) {
      process.stderr.write(fault);
      return { ok: false, fatal: true, reason: `schema-fault: ${err.code}` };
    }
    return { ok: false, reason: `query-failed: ${err.message}` };
  }
}

/**
 * Resolve ONE run named by a commit's `AI-Run-ID`, scoped to the current
 * repository AND to code mode — the single lookup every audit-backed claim is
 * judged through (plan §2.8, R5 H1). Another repository's run, a plan-mode run
 * or no row all come back as `{ok:true, run:null}`: the claim is then false.
 * A schema fault is fatal, never a silent "no run".
 *
 * @param {{repoRowId: string, runId: string}} input
 * @param {{one?: Function, isCloudEnabled?: Function}} [deps]
 * @returns {Promise<{ok: true, run: null | {id: string, auditedSha: string|null, auditedTree: string|null,
 *   roundConvergedAfter: number|null}} | {ok: false, fatal?: true, reason: string}>}
 */
export async function findCodeRunForRepo({ repoRowId, runId }, deps = {}) {
  const { one: oneFn = one, isCloudEnabled: cloudFn = isCloudEnabled } = deps;
  if (!repoRowId) return { ok: false, reason: 'no-repo-row-id' };
  // audit_runs.id is a uuid; a run id of any other shape cannot name a row.
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(runId ?? ''))) return { ok: true, run: null };
  if (!await cloudFn()) return { ok: false, reason: 'cloud-off' };
  try {
    const row = await oneFn(
      `SELECT id, audited_sha, audited_tree, round_converged_after
         FROM audit_runs
        WHERE id = $1::uuid AND repo_id = $2 AND mode = 'code'`,
      [String(runId), repoRowId],
    );
    return {
      ok: true,
      run: row ? {
        id: String(row.id),
        auditedSha: row.audited_sha ?? null,
        auditedTree: row.audited_tree ?? null,
        roundConvergedAfter: row.round_converged_after ?? null,
      } : null,
    };
  } catch (err) {
    const fault = describeSchemaFault(err, 'findCodeRunForRepo');
    if (fault) {
      process.stderr.write(fault);
      return { ok: false, fatal: true, reason: `schema-fault: ${err.code}` };
    }
    return { ok: false, reason: `query-failed: ${err.message}` };
  }
}
