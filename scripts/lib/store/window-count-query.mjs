/**
 * @fileoverview Shared query-execution helper for the skill-efficacy census's
 * per-skill window-count readers (docs/plans/skill-efficacy-census.md Phase
 * 2, round-1 M13 fix — the four structurally-identical readers
 * duplicated cloud-gating, execution, row normalisation, and error
 * handling; this is the one place that logic lives now).
 *
 * Deliberately does NOT cover every window-count reader: `persona.mjs`'s
 * has a genuinely different scoped/unscoped branch, and
 * `runs-findings.mjs`'s audit-run/conversion-rate readers have a genuinely
 * different multi-metric shape — forcing either through this helper would
 * be the over-engineering cliff, not a DRY win. This covers the four that
 * are actually the same shape: one table, one `repo_id` guard, one
 * optional extra WHERE clause, one `{current, prior, allTime}` triple.
 *
 * Lives BELOW `skill-census.mjs` in the import graph deliberately —
 * `skill-census.mjs` imports the per-skill readers FROM the store modules
 * this helper serves, so a store module importing FROM `skill-census.mjs`
 * would be circular.
 *
 * @module scripts/lib/store/window-count-query
 */
import { many } from '../db/query.mjs';
import { isCloudEnabled } from './repo.mjs';

/**
 * @param {object} opts
 * @param {*} opts.repoGuard falsy → return null without querying (mirrors every reader's `if (!repoId) return null`)
 * @param {string} opts.table
 * @param {string} [opts.extraWhere] additional SQL, ANDed after `repo_id = $1` (e.g. `AND skill = 'plan'`)
 * @param {Array<*>} opts.params `[repoId, currentStart, now, priorStart]`, in that order
 * @param {string} opts.errorLabel logged on failure, e.g. "getShipEventWindowCounts"
 * @returns {Promise<{current: number, prior: number, allTime: number}|null>}
 */
export async function runWindowCountQuery({ repoGuard, table, extraWhere = '', params, errorLabel }) {
  if (!repoGuard || !await isCloudEnabled()) return null;
  // `table`/`extraWhere` are always caller-supplied string LITERALS (never
  // user input — every call site passes a hardcoded value), but this guard
  // costs nothing and closes the pattern-matched risk of a future call site
  // interpolating something it shouldn't.
  if (!/^[a-z_]+$/.test(table)) throw new Error(`runWindowCountQuery: unsafe table name "${table}"`);
  try {
    const row = await many(
      `SELECT
         count(*) FILTER (WHERE created_at >= $2 AND created_at < $3) AS current,
         count(*) FILTER (WHERE created_at >= $4 AND created_at < $2) AS prior,
         count(*) AS all_time
         FROM ${table} WHERE repo_id = $1 ${extraWhere}`,
      params,
    );
    const r = row[0] || {};
    const n = (v) => Number(v) || 0;
    return { current: n(r.current), prior: n(r.prior), allTime: n(r.all_time) };
  } catch (err) {
    process.stderr.write(`  [learning] ${errorLabel} failed: ${err.message}\n`);
    return null;
  }
}
