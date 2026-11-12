/**
 * @fileoverview Read-only `audit_runs` fetch for the convergence metrics (item 8d).
 *
 * Returns RAW rows; grouping and definitions live in
 * `lib/audit/convergence-metrics.mjs`. A query failure THROWS: a broken query
 * and an empty window must never leave here as the same value (AGENTS.md,
 * "a schema error is not an empty result"). Only cloud-off is a soft result.
 *
 * @module scripts/lib/store/convergence
 */

import { many } from '../db/query.mjs';
import { isCloudEnabled } from './repo.mjs';

/**
 * @param {{days?:number, lookbackDays?:number}} [opts]
 * @returns {Promise<{cloud:boolean, rows:Array<object>, windowStartMs:number, fetchStartMs:number, asOfMs:number}>}
 */
export async function readConvergenceRows({ days = 30, lookbackDays = 14 } = {}) {
  // ONE clock read: the query's upper bound, window membership and the open/settled test all use asOfMs.
  const asOfMs = Date.now();
  const windowStartMs = asOfMs - days * 86_400_000;
  if (!await isCloudEnabled()) return { cloud: false, rows: [], windowStartMs, fetchStartMs: windowStartMs, asOfMs };
  const fetchStartMs = windowStartMs - lookbackDays * 86_400_000;
  const rows = await many(
    `SELECT r.id, r.repo_id, p.name AS repo_name, r.plan_file, r.mode, r.rounds, r.branch,
            r.run_status, r.gemini_verdict, r.round_converged_after, r.audit_session_id, r.audit_round,
            r.assignment_id, r.arm_eval_run_id, r.phase, r.created_at
       FROM audit_runs r
       LEFT JOIN audit_repos p ON p.id = r.repo_id
      WHERE r.created_at >= $1 AND r.created_at <= $2
      ORDER BY r.created_at, r.id`,
    [new Date(fetchStartMs).toISOString(), new Date(asOfMs).toISOString()],
  );
  return { cloud: true, rows: rows.map((r, ord) => ({ ...r, ord })), windowStartMs, fetchStartMs, asOfMs };
}
